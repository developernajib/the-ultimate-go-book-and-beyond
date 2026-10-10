## 30.2 Job Queue with Database

> **Production shortcut: `riverqueue/river`.** Everything below, the schema, `FOR UPDATE SKIP LOCKED`, retry state machine, scheduled jobs, periodic jobs, unique jobs, is already implemented by `riverqueue/river` with better ergonomics and a maintained UI. River also uses Postgres `LISTEN`/`NOTIFY` so workers pick up new jobs in milliseconds instead of waiting for the next poll interval. Its killer feature is **transactional enqueue**: you insert the job in the same `pgx.Tx` as your business write, so either both commit or neither does, which removes the need for the outbox pattern in many systems. Read the rest of this section to understand the primitives. reach for river in real code.

### Job Schema

A PostgreSQL-backed job queue stores every job as a row with status tracking, priority, retry counts, and timestamps. The partial index on `status = 'pending'` keeps the dequeue query fast even as completed jobs accumulate, and the composite index on `(queue, status, priority, scheduled_at)` supports efficient polling sorted by priority and age.

```sql
CREATE TABLE jobs (
    id UUID PRIMARY KEY,
    queue VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    priority INT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    failed_at TIMESTAMP WITH TIME ZONE,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status ON jobs(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_jobs_queue ON jobs(queue, status, priority DESC, scheduled_at);
```

### Job Repository

The repository implementation translates domain method calls into SQL queries, isolating the service layer from database-specific concerns. Each method accepts a context to propagate deadlines and cancellation into the query execution.

```go
package queue

import (
    "context"
    "database/sql"
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

type JobStatus string

const (
    StatusPending   JobStatus = "pending"
    StatusRunning   JobStatus = "running"
    StatusCompleted JobStatus = "completed"
    StatusFailed    JobStatus = "failed"
)

type Job struct {
    ID          uuid.UUID
    Queue       string
    Payload     json.RawMessage
    Status      JobStatus
    Priority    int
    Attempts    int
    MaxAttempts int
    ScheduledAt time.Time
    StartedAt   *time.Time
    CompletedAt *time.Time
    FailedAt    *time.Time
    Error       *string
    CreatedAt   time.Time
}

type JobRepository struct {
    db *sql.DB
}

func NewJobRepository(db *sql.DB) *JobRepository {
    return &JobRepository{db: db}
}

func (r *JobRepository) Enqueue(ctx context.Context, queue string, payload any, opts ...EnqueueOption) (*Job, error) {
    job := &Job{
        ID:          uuid.New(),
        Queue:       queue,
        Status:      StatusPending,
        Priority:    0,
        Attempts:    0,
        MaxAttempts: 3,
        ScheduledAt: time.Now(),
        CreatedAt:   time.Now(),
    }

    for _, opt := range opts {
        opt(job)
    }

    payloadBytes, err := json.Marshal(payload)
    if err != nil {
        return nil, err
    }
    job.Payload = payloadBytes

    query := `
        INSERT INTO jobs (id, queue, payload, status, priority, max_attempts, scheduled_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `
    _, err = r.db.ExecContext(ctx, query,
        job.ID, job.Queue, job.Payload, job.Status,
        job.Priority, job.MaxAttempts, job.ScheduledAt, job.CreatedAt,
    )
    if err != nil {
        return nil, err
    }

    return job, nil
}

func (r *JobRepository) Dequeue(ctx context.Context, queue string, limit int) ([]*Job, error) {
    query := `
        UPDATE jobs
        SET status = $1, started_at = NOW(), attempts = attempts + 1, updated_at = NOW()
        WHERE id IN (
            SELECT id FROM jobs
            WHERE queue = $2
              AND status = $3
              AND scheduled_at <= NOW()
            ORDER BY priority DESC, scheduled_at
            FOR UPDATE SKIP LOCKED
            LIMIT $4
        )
        RETURNING id, queue, payload, status, priority, attempts, max_attempts,
                  scheduled_at, started_at, created_at
    `

    rows, err := r.db.QueryContext(ctx, query, StatusRunning, queue, StatusPending, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var jobs []*Job
    for rows.Next() {
        job := &Job{}
        var startedAt sql.NullTime
        err := rows.Scan(
            &job.ID, &job.Queue, &job.Payload, &job.Status,
            &job.Priority, &job.Attempts, &job.MaxAttempts,
            &job.ScheduledAt, &startedAt, &job.CreatedAt,
        )
        if err != nil {
            return nil, err
        }
        if startedAt.Valid {
            job.StartedAt = &startedAt.Time
        }
        jobs = append(jobs, job)
    }

    return jobs, rows.Err()
}

func (r *JobRepository) Complete(ctx context.Context, jobID uuid.UUID) error {
    query := `
        UPDATE jobs
        SET status = $1, completed_at = NOW(), updated_at = NOW()
        WHERE id = $2
    `
    _, err := r.db.ExecContext(ctx, query, StatusCompleted, jobID)
    return err
}

func (r *JobRepository) Fail(ctx context.Context, jobID uuid.UUID, errMsg string) error {
    query := `
        UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN $1 ELSE $2 END,
            failed_at = NOW(),
            error = $3,
            updated_at = NOW()
        WHERE id = $4
    `
    _, err := r.db.ExecContext(ctx, query, StatusFailed, StatusPending, errMsg, jobID)
    return err
}

type EnqueueOption func(*Job)

func WithPriority(priority int) EnqueueOption {
    return func(j *Job) {
        j.Priority = priority
    }
}

func WithDelay(delay time.Duration) EnqueueOption {
    return func(j *Job) {
        j.ScheduledAt = time.Now().Add(delay)
    }
}

func WithMaxAttempts(max int) EnqueueOption {
    return func(j *Job) {
        j.MaxAttempts = max
    }
}
```

### Queue Consumer

The consumer polls the repository on a configurable interval, dequeues a batch of jobs, and fans them out to a fixed pool of worker goroutines through a channel. Each worker calls the registered `JobHandler` function and marks the job as completed or failed based on the result. The `batchSize` parameter controls how many rows the `FOR UPDATE SKIP LOCKED` query claims per poll cycle, balancing throughput against lock contention.

```go
package queue

import (
    "context"
    "encoding/json"
    "log/slog"
    "sync"
    "time"
)

type JobHandler func(ctx context.Context, payload json.RawMessage) error

type Consumer struct {
    repo         *JobRepository
    queue        string
    handler      JobHandler
    logger       *slog.Logger
    batchSize    int
    pollInterval time.Duration
    concurrency  int
}

type ConsumerConfig struct {
    Queue        string
    Handler      JobHandler
    BatchSize    int
    PollInterval time.Duration
    Concurrency  int
}

func NewConsumer(repo *JobRepository, config ConsumerConfig, logger *slog.Logger) *Consumer {
    if config.BatchSize == 0 {
        config.BatchSize = 10
    }
    if config.PollInterval == 0 {
        config.PollInterval = time.Second
    }
    if config.Concurrency == 0 {
        config.Concurrency = 1
    }

    return &Consumer{
        repo:         repo,
        queue:        config.Queue,
        handler:      config.Handler,
        logger:       logger,
        batchSize:    config.BatchSize,
        pollInterval: config.PollInterval,
        concurrency:  config.Concurrency,
    }
}

func (c *Consumer) Start(ctx context.Context) {
    jobsChan := make(chan *Job, c.batchSize)

    // Start workers
    var wg sync.WaitGroup
    for i := 0; i < c.concurrency; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            c.worker(ctx, workerID, jobsChan)
        }(i)
    }

    // Poll for jobs
    go func() {
        ticker := time.NewTicker(c.pollInterval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                close(jobsChan)
                return
            case <-ticker.C:
                c.fetchJobs(ctx, jobsChan)
            }
        }
    }()

    wg.Wait()
}

func (c *Consumer) fetchJobs(ctx context.Context, jobsChan chan<- *Job) {
    jobs, err := c.repo.Dequeue(ctx, c.queue, c.batchSize)
    if err != nil {
        c.logger.Error("failed to dequeue jobs", "error", err)
        return
    }

    for _, job := range jobs {
        select {
        case jobsChan <- job:
        case <-ctx.Done():
            return
        }
    }
}

func (c *Consumer) worker(ctx context.Context, id int, jobs <-chan *Job) {
    for job := range jobs {
        c.processJob(ctx, job)
    }
}

func (c *Consumer) processJob(ctx context.Context, job *Job) {
    logger := c.logger.With(
        "job_id", job.ID,
        "queue", job.Queue,
        "attempt", job.Attempts,
    )

    logger.Debug("processing job")

    if err := c.handler(ctx, job.Payload); err != nil {
        logger.Error("job failed", "error", err)
        if err := c.repo.Fail(ctx, job.ID, err.Error()); err != nil {
            logger.Error("failed to mark job as failed", "error", err)
        }
        return
    }

    if err := c.repo.Complete(ctx, job.ID); err != nil {
        logger.Error("failed to mark job as complete", "error", err)
        return
    }

    logger.Debug("job completed")
}
```

### Junior to FAANG: the Postgres queue is deceptively simple

The `FOR UPDATE SKIP LOCKED` pattern is the single most quoted Postgres feature for queues. It is correct. The gotchas are in the surrounding code.

1. **Missing lease timeout.** If the worker crashes after `Dequeue` flips status to `running`, the job is stuck forever. Add a `leased_until TIMESTAMP` column and a recovery query `UPDATE jobs SET status = 'pending' WHERE status = 'running' AND leased_until < NOW()`. Lease duration should be 2x to 3x handler P99.

2. **No idempotency.** `Complete` marks the row complete but the handler's side effect (charging a card, sending an email) may have run twice if the first run succeeded and the `Complete` UPDATE failed. The handler itself must be idempotent. This is why Stripe introduced idempotency keys for external API calls. Your handler should accept the job_id as the idempotency key and pass it to downstream services.

3. **Retry without backoff.** `Fail` flips back to `pending` and the next poll picks it up immediately. You will hot-loop on a deterministic failure until `max_attempts` is hit, saturating a worker. Fix by computing `scheduled_at = NOW() + backoff(attempts)` in the Fail query.

4. **Polling latency is the P99 floor.** With 1 second poll, enqueue-to-start P99 is above 1 second even when the queue is empty. Postgres `LISTEN`/`NOTIFY` on insert wakes the consumer in under 10ms. River does this by default.

5. **Vacuum pain.** Completed rows accumulate. The partial index on `status = 'pending'` stays small, but the table grows, and MVCC bloat makes `SKIP LOCKED` scans slow. Production fix is to archive completed rows to a history table and `DELETE` them from `jobs` within 24 hours, or to partition `jobs` by day.

Worked exercise. Given a queue with P95 enqueue rate of 500/sec and P95 handler latency of 200ms, how many worker goroutines do you need, what batch size for `Dequeue`, and what lease duration. Steady-state concurrency is `500 * 0.2 = 100` concurrent handlers. Batch size should match the round-trip cost of a dequeue versus the idle time between polls. Typical answer is `batch_size = 20, poll_interval = 100ms, concurrency = 100, lease = 1s`. Write it out before reading further.

Interview entry point. "Implement a job queue on Postgres." Candidates who write `SELECT status = pending` without `FOR UPDATE SKIP LOCKED` fail. Candidates who add `FOR UPDATE SKIP LOCKED` pass. Candidates who mention lease timeouts and idempotency move to the next round.

### Senior at FAANG: Postgres queues as a platform tier

Postgres queues are the right default for tier-0 correctness-critical work under roughly 10k jobs per second per service. Above that, the storage layer becomes the bottleneck and the architecture shifts. Staff-level decisions:

**Transactional enqueue is the killer feature.** The reason Stripe, Linear, and many smaller FAANG-track companies have moved to river or home-grown Postgres queues is that the enqueue happens in the same `BEGIN; ... COMMIT;` as the business write. Either both persist or neither does. No outbox needed, no CDC needed, no dual-write inconsistency. The moment you reach for Redis or SQS, you reintroduce the dual-write problem and must adopt the outbox pattern.

**Scaling past 10k/sec.** The single-table pattern bottlenecks on index contention during `Dequeue`. Scale moves:

- Partition by hash of `queue` to distribute write and lock contention.
- Shard by `tenant_id` to support multi-tenant isolation and per-tenant throughput guarantees.
- Split hot job_types into dedicated tables with dedicated indexes.
- Move to logical replicas for DLQ queries and analytics, keeping the write primary narrow.

With hash partitioning (typically 8 to 16 ways) a Postgres-backed queue can reach several tens of thousands of jobs per second before the fan-out tier is better served by Kafka.

**LISTEN/NOTIFY at scale.** `NOTIFY` payloads are bounded at 8KB and notifications are per-connection. At high fan-in, the notification queue inside Postgres becomes a bottleneck, and missed notifications are undetectable (pg_notify is best-effort). The pattern is NOTIFY as a wake-up hint, with a fallback poll every second to catch missed notifications. Treat NOTIFY as latency optimization, not correctness.

**Lease renewal versus visibility timeout.** Two equivalent models. Redis and SQS use visibility timeout. Postgres naturally uses `leased_until` columns. Equivalent correctness, different ergonomics. Visibility timeout scales on the server side (SQS handles it). Leases put the recovery query on you, but give you full control. At FAANG scale, a dedicated "recovery worker" runs the lease-expiry UPDATE every 5 seconds. You must monitor how often it recovers leases, because a high rate indicates either handler crashes or misconfigured lease duration.

**Migration zero-downtime.** Migrating the `jobs` table schema is risky because workers are actively reading and writing. The pattern is additive. Add new columns with defaults, deploy workers that write to both, backfill, deploy workers that read from new, drop old. Never `ALTER TABLE jobs DROP COLUMN` on a hot queue without a 24-hour soak on the additive change.

**Blast radius isolation.** One misbehaving tenant should not starve the others. With a single `jobs` table, a tenant running 1M jobs in a minute fills the prefetch queue. Mitigation is per-tenant row-level quotas enforced in the `Dequeue` query. One approach is to add a CTE that picks up to N jobs per tenant per batch, using a window function `ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY priority, scheduled_at)`. This gives weighted fair scheduling at the SQL layer.

**Recovery playbook for a wedged queue.** On SEV-1 "queue is falling behind", the runbook is specific. (1) Check `pg_stat_activity` for long-running locks. `SKIP LOCKED` hides waiting queries, but not held locks. (2) Check `leased_until` recovery rate (if high, workers are crashing). (3) Check handler P99 (if high, downstream is slow, not the queue). (4) Temporarily triple the worker pool (if bottleneck is handler-bound). (5) If rate of growth is catastrophic, selectively DLQ by priority to shed load, after on-call approval. Document this and drill it quarterly.

**ADR on queue technology.** A real Architecture Decision Record for a FAANG team evaluating Postgres-backed versus Redis-backed versus Kafka at 20k jobs per second typically ends up at:

- Postgres via river for tier-0 (billing, ledger). Transactional enqueue is non-negotiable.
- Redis via asynq for tier-1 (emails, notifications). Ops simplicity wins.
- Kafka for tier-2 (analytics, search indexing). Fan-out and replay are native.

The anti-pattern is "one queue for everything." The pattern is tiered queues matched to workload semantics.

---
