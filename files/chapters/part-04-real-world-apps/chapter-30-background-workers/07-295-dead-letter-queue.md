## 30.5 Dead Letter Queue

### Dead Letter Handling

The dead letter queue receives jobs that have exceeded their maximum retry count, preserving them for manual inspection or replay rather than discarding them silently. Each job moved to the DLQ carries its full history: original payload, failure reason, retry count, and timestamps of each attempt, giving operators the context needed to diagnose systematic failures. A separate consumer on the DLQ can replay jobs back to the main queue after an operator fixes the underlying bug, providing a recovery path without redeployment.

**Operational rules every DLQ design must enforce.**

1. **Bound retries.** Pick a `max_attempts` per job type. Payment captures might retry 10 times over 24 hours with exponential backoff + jitter. A webhook fanout job might retry 3 times in 5 minutes. No job should retry forever.
2. **Classify errors before retrying.** Permanent errors (`400 Bad Request`, validation failure, not-found on a resource the caller owns) should skip straight to the DLQ. Transient errors (network timeout, `503`, row-level lock contention) are the ones retries exist for. Retrying a poison message N times just wastes compute and keeps the queue head blocked.
3. **Alert on DLQ growth, not individual failures.** A single failure is noise. A DLQ-depth rate-of-change alert (`increase(dlq_depth[5m]) > 50`) is signal. Route it to whichever team owns the job type, via a label on the job.
4. **Idempotent handlers are non-negotiable.** At-least-once delivery means every handler will, sooner or later, see the same job twice. Use an idempotency key derived from the business event (order ID, webhook delivery ID) and persist `(key, result)` in a table with a unique constraint. On replay, read the cached result instead of re-executing the side effect.
5. **Replay safely.** Before bulk-replaying DLQ items after a bugfix, verify the original payloads still reference live entities (the customer was not deleted, the order was not already refunded through a manual process). A blind `RetryAll` after a long outage is how you double-charge customers.

```go
package queue

import (
    "context"
    "encoding/json"
    "log/slog"
    "time"
)

type DeadLetter struct {
    OriginalJob *Job            `json:"original_job"`
    Error       string          `json:"error"`
    Attempts    int             `json:"attempts"`
    FailedAt    time.Time       `json:"failed_at"`
    Queue       string          `json:"queue"`
}

type DeadLetterQueue struct {
    repo   DeadLetterRepository
    logger *slog.Logger
}

type DeadLetterRepository interface {
    Store(ctx context.Context, dl *DeadLetter) error
    List(ctx context.Context, queue string, limit, offset int) ([]*DeadLetter, error)
    Get(ctx context.Context, id string) (*DeadLetter, error)
    Delete(ctx context.Context, id string) error
    Retry(ctx context.Context, id string) error
}

func NewDeadLetterQueue(repo DeadLetterRepository, logger *slog.Logger) *DeadLetterQueue {
    return &DeadLetterQueue{
        repo:   repo,
        logger: logger,
    }
}

func (dlq *DeadLetterQueue) Add(ctx context.Context, job *Job, err error) error {
    dl := &DeadLetter{
        OriginalJob: job,
        Error:       err.Error(),
        Attempts:    job.Attempts,
        FailedAt:    time.Now(),
        Queue:       job.Queue,
    }

    dlq.logger.Warn("job moved to dead letter queue",
        "job_id", job.ID,
        "queue", job.Queue,
        "error", err,
        "attempts", job.Attempts,
    )

    return dlq.repo.Store(ctx, dl)
}

func (dlq *DeadLetterQueue) Retry(ctx context.Context, id string) error {
    return dlq.repo.Retry(ctx, id)
}

func (dlq *DeadLetterQueue) RetryAll(ctx context.Context, queue string) (int, error) {
    count := 0
    offset := 0
    limit := 100

    for {
        items, err := dlq.repo.List(ctx, queue, limit, offset)
        if err != nil {
            return count, err
        }

        if len(items) == 0 {
            break
        }

        for _, item := range items {
            if err := dlq.repo.Retry(ctx, item.OriginalJob.ID.String()); err != nil {
                dlq.logger.Error("failed to retry job", "id", item.OriginalJob.ID, "error", err)
                continue
            }
            count++
        }

        offset += limit
    }

    return count, nil
}
```

### Junior to FAANG: the DLQ is where bugs hide

Your first DLQ will fill up and nobody will notice for two weeks. That is the rite of passage. Once noticed, the DLQ will contain a mix of. (1) jobs that failed because of a deploy bug fixed 3 days ago, replayable. (2) jobs that failed because the user was deleted, archiveable. (3) jobs that failed because the payload schema changed, replayable only after migration. (4) poison messages that will fail forever, archive and move on.

Concrete junior workflow for a DLQ triage.

1. Sort DLQ by failure reason. Group by error message prefix.
2. For each group, identify the largest. That is usually one deploy regression.
3. For the largest group, inspect 3 payloads by hand. Is the data still valid.
4. If yes, replay the group. If no, mark archive with reason.
5. Repeat for the next-largest group.

Poison pill walkthrough. A bad job enters the queue. It fails deterministically (nil dereference on malformed payload). The worker retries 5 times, exhausts attempts, lands in DLQ. Without DLQ, the worker would loop forever on that one message, starving everything behind it. The DLQ is specifically the escape hatch for this.

Classification logic in the handler is the key junior lesson.

```go
func (h *Handler) Process(ctx context.Context, job *Job) Result {
    if err := h.do(ctx, job); err != nil {
        if errors.Is(err, ErrInvalidPayload) || errors.Is(err, ErrUserDeleted) {
            return Result{Status: PermanentFailure, Reason: err.Error()}
        }
        return Result{Status: RetryableFailure, Reason: err.Error()}
    }
    return Result{Status: Success}
}
```

Permanent failures go to DLQ on attempt 1. Retryable failures retry with backoff. Without this distinction, you waste compute retrying unrecoverable errors and your DLQ fills with noise.

Interview entry point. "What is a dead letter queue and when do you use one." A strong answer mentions poison-pill protection, classification of permanent versus retryable errors, alerting on DLQ growth, and a replay workflow.

### Senior at FAANG: DLQ is a product, not a table

At FAANG scale, DLQ is a full product with a UI, RBAC, SLAs for triage, and a distinct on-call rotation for the platform. Staff engineers own the DLQ product roadmap.

**DLQ taxonomy.** A single DLQ is inadequate. Production DLQs at Stripe and Netflix have internal states. `QUARANTINED` (recent, awaiting triage), `TRIAGED` (owner has acknowledged, reason classified), `REPLAYABLE` (owner has confirmed a fix is deployed, safe to replay), `REPLAYED` (replay attempted, terminal), `ARCHIVED` (not replayable, archived with reason). State transitions are auditable.

**RBAC.** Replaying a DLQ item can reissue a charge, re-send notifications, or mutate prod data. Replay must be gated by RBAC. Who can trigger, who can trigger in bulk, and for which job_types. Stripe requires two-person approval for replays exceeding a threshold. Role-based permissions are, `dlq.read`, `dlq.replay.single`, `dlq.replay.bulk`, `dlq.archive`.

**Triage SLA.** Every job_type has an owning team. DLQ items are tagged by job_type on enqueue. The DLQ product enforces triage SLA per tier. Tier-0, 1 hour. Tier-1, 24 hours. Tier-2, 1 week. Un-triaged items past SLA generate a ticket to the owning team.

**Replay tooling.** Bulk replay needs. (1) Filters (by error_message_prefix, by time_window, by tenant_id). (2) Dry-run mode that counts matches without replaying. (3) Rate limiting (replay at N per second to avoid overwhelming downstream). (4) Idempotency check (replay is a no-op if the original side effect eventually succeeded). (5) Diff mode for comparing original output to replayed output on a sample.

**Poison-pill handling.** A job that fails deterministically for a reason the code cannot detect (e.g. a serialization format the handler does not support) should not enter the retry loop. The platform should offer a "circuit break" per job_type. If the failure rate for a job_type exceeds a threshold, new jobs for that type go directly to DLQ with the circuit-open reason, preserving worker capacity for other job_types.

**Schema versioning.** Jobs in DLQ may have payloads in an old schema. When the handler schema evolves, the DLQ contains "archaeological" data. The platform contract must require job_type versioning. `(job_type, version)` as the identity. Handlers must be backwards-compatible for N versions, or the replay tool must run a migration on the payload before replay. At Amazon, this is enforced via a registered protobuf schema per job_type with Semver rules.

**Exactly-once via handler-side idempotency.** DLQ replay implies you may re-execute a handler whose first attempt had partial side effects. The only safe way to replay is handlers keyed on an idempotency key. Stripe's API is the canonical reference. Every POST takes an `Idempotency-Key` header, and the server stores `(key, response)` for 24 hours. On replay, the server returns the stored response without re-executing. Your handlers should do the same for their downstream calls.

**Outbox-CDC interaction.** If the DLQ is persisted in a different store than the source queue, you need transactional write. For Postgres-backed queues, DLQ is a table. For Redis-backed queues, DLQ is typically a Redis list (asynq archived set). For Kafka, DLQ is a separate topic. Each has durability trade-offs that should match the source queue tier.

**Cost of DLQ storage.** DLQ items are usually retained 30 days minimum for audit. At FAANG scale, retaining full payloads is expensive. The pattern is, DLQ row contains metadata and a reference to the payload in object storage (S3) with lifecycle rules for expiry. Payloads over 1MB must be stored externally.

**DLQ metric contract.** Every DLQ emits, `dlq_depth` by job_type, `dlq_arrival_rate`, `dlq_age_oldest_seconds`, `dlq_replay_success_rate`, `dlq_replay_duration_seconds`. Burn-rate alerts fire on `dlq_arrival_rate` exceeding baseline by 3-sigma.

**Game-day exercise.** A staff engineer schedules quarterly DLQ drills. Inject synthetic poison pills. Measure time-to-detect, time-to-triage, time-to-replay. Publish the result. Teams that fail the SLA get a remediation ticket. This turns DLQ from "where dead jobs rot" into an operational muscle.

**ADR on retry classification.** A specific ADR every job platform should have. "Retryable versus permanent error taxonomy". Defines a shared `error.Kind` enum across the company. `Kind.Transient`, `Kind.PermanentInvalid`, `Kind.PermanentNotFound`, `Kind.PermanentUnauthorized`, `Kind.ResourceExhausted` (retry with backoff), `Kind.Unknown` (treat as transient, log loudly). Every handler returns typed errors that the platform classifies. This is what Google's internal error-taxonomy does, and it unifies retry logic across services.

---
