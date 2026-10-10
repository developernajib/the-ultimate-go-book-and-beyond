## 27.5 Exactly-Once Processing

> **Senior track**: "Exactly-once" at the physical delivery layer is impossible in an asynchronous distributed system (the Two Generals problem). What production systems actually provide is **effectively-once**: at-least-once delivery combined with idempotent processing and deduplication, so the observable side effects occur exactly once. Kafka's "exactly-once semantics" (idempotent producer + transactions, default in 3.0+) gives atomic read-process-write inside the Kafka boundary, but the moment a side effect crosses that boundary (external HTTP call, email, payment), you are back to needing application-level idempotency. Frame it this way in interviews, conflating the two is the fastest way to fail a FAANG system design round.

### Two-Phase Processing

Effectively-once processing requires persisting the in-flight processing state before executing the handler, then updating it to completed with the result. If the processor crashes between starting and completing, the record is found in the `started` state and, once it has aged past a lease window, can be reclaimed and retried, preventing both silent drops and duplicate executions.

The whole design turns on one question that is much harder than it looks: **did I create this record, or did I find one somebody else created?** The claim must be a single atomic statement, so you cannot check first and insert second. But an `INSERT ... ON CONFLICT` does not obviously tell you which branch it took, and getting that wrong produces a processor that cannot process anything at all. PostgreSQL answers it with `xmax = 0`.

```go
package exactlyonce

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "time"
)

// ErrProcessingInProgress means another processor holds a live claim on this
// message. The caller should not process it and should let the broker redeliver.
var ErrProcessingInProgress = errors.New("message is already being processed")

type ProcessingState string

const (
    StateStarted   ProcessingState = "started"
    StateCompleted ProcessingState = "completed"
    StateFailed    ProcessingState = "failed"
)

type ProcessingRecord struct {
    MessageID   string
    State       ProcessingState
    Result      []byte
    Error       string
    StartedAt   time.Time
    CompletedAt *time.Time
}

type ExactlyOnceProcessor struct {
    db        *sql.DB
    handler   func(ctx context.Context, payload []byte) ([]byte, error)
    leaseTTL  time.Duration // how long a claim is honored before it is reclaimable
}

func NewExactlyOnceProcessor(db *sql.DB, handler func(context.Context, []byte) ([]byte, error)) *ExactlyOnceProcessor {
    return &ExactlyOnceProcessor{db: db, handler: handler, leaseTTL: 5 * time.Minute}
}

func (p *ExactlyOnceProcessor) Process(ctx context.Context, messageID string, payload []byte) ([]byte, error) {
    // One atomic statement claims the message. No transaction needed: the
    // statement is its own transaction and the unique constraint arbitrates.
    claim, err := p.claim(ctx, messageID)
    if err != nil {
        return nil, err
    }

    switch {
    case claim.Owned:
        // We inserted the row, or reclaimed an expired/failed one. Ours to run.

    case claim.State == StateCompleted:
        // Someone already finished it. Replay their stored result.
        return claim.Result, nil

    default:
        // State is 'started' and the lease is still live: another processor
        // is working on it right now. Let the broker redeliver later.
        return nil, ErrProcessingInProgress
    }

    // Process outside any transaction: never hold locks across a handler.
    result, processErr := p.handler(ctx, payload)

    if processErr != nil {
        // Record the failure so the next delivery can retry immediately
        // rather than waiting out the lease.
        if err := p.finish(ctx, messageID, StateFailed, nil, processErr.Error()); err != nil {
            return nil, fmt.Errorf("handler failed (%v) and state update failed: %w", processErr, err)
        }
        return nil, processErr
    }

    // If THIS fails, the work is done but unrecorded. The record stays
    // 'started', the lease expires, and the message is reprocessed. Surface
    // it: this is the one window two-phase processing cannot close alone.
    if err := p.finish(ctx, messageID, StateCompleted, result, ""); err != nil {
        return result, fmt.Errorf("handler succeeded but completion was not recorded: %w", err)
    }
    return result, nil
}

// claimResult reports the outcome of an atomic claim attempt.
type claimResult struct {
    State  ProcessingState
    Result []byte
    // Owned is true when this caller is responsible for running the handler,
    // either because it inserted the row or because it reclaimed a dead lease.
    Owned bool
}

// claim atomically inserts-or-inspects the record. The key trick is `xmax = 0`,
// which is true only for a freshly INSERTed row and false when ON CONFLICT
// turned the statement into an UPDATE. Without it there is no way to tell
// "I created this" from "I found someone else's live claim".
func (p *ExactlyOnceProcessor) claim(ctx context.Context, messageID string) (*claimResult, error) {
    const query = `
        INSERT INTO processing_records (message_id, state, started_at)
        VALUES ($1, 'started', now())
        ON CONFLICT (message_id) DO UPDATE
            SET state = CASE
                    WHEN processing_records.state = 'failed' THEN 'started'
                    WHEN processing_records.state = 'started'
                         AND processing_records.started_at < now() - $2::interval THEN 'started'
                    ELSE processing_records.state
                END,
                -- Reclaiming MUST reset the clock, or every later delivery
                -- also sees an expired lease and reclaims it concurrently.
                started_at = CASE
                    WHEN processing_records.state = 'failed' THEN now()
                    WHEN processing_records.state = 'started'
                         AND processing_records.started_at < now() - $2::interval THEN now()
                    ELSE processing_records.started_at
                END,
                result = CASE
                    WHEN processing_records.state IN ('failed') THEN NULL
                    ELSE processing_records.result
                END
        RETURNING state, result, (xmax = 0) AS inserted, (started_at = now()) AS reclaimed
    `

    var (
        state     ProcessingState
        result    []byte
        inserted  bool
        reclaimed bool
    )
    err := p.db.QueryRowContext(ctx, query, messageID, p.leaseTTL.String()).
        Scan(&state, &result, &inserted, &reclaimed)
    if err != nil {
        return nil, err
    }
    return &claimResult{State: state, Result: result, Owned: inserted || reclaimed}, nil
}

// finish records the terminal state of an attempt.
func (p *ExactlyOnceProcessor) finish(ctx context.Context, messageID string, state ProcessingState, result []byte, errMsg string) error {
    const query = `
        UPDATE processing_records
        SET state = $1, result = $2, error = $3, completed_at = now()
        WHERE message_id = $4
    `
    _, err := p.db.ExecContext(ctx, query, state, result, errMsg, messageID)
    return err
}

```

The schema:

```sql
CREATE TABLE processing_records (
    message_id   text PRIMARY KEY,   -- again: this is the guarantee
    state        text NOT NULL,
    result       bytea,
    error        text,
    started_at   timestamptz NOT NULL,
    completed_at timestamptz
);
```

> **The original version of this processor could never process a single message.** This is worth walking through slowly, because the bug is invisible on inspection and total in effect.
>
> `getOrCreateRecord` inserts the row with `state = 'started'` and `started_at = now()`, then returns whatever is in the table. For a brand new message that is the row it just wrote: state `started`, timestamp `now`. Control reaches the switch, hits `case StateStarted`, evaluates `time.Since(record.StartedAt) < 5*time.Minute` against a timestamp roughly zero seconds old, and returns `ErrProcessingInProgress`.
>
> **The handler is never called.** Not for the first message, not for any message. Every delivery inserts a claim and then immediately mistakes its own claim for a competing processor's, and rejects itself. Five minutes later the record is stale, so the next delivery reclaims it, marks it started, and rejects itself again. The steady state is a table full of `started` rows, zero completions, and a processor reporting "already being processed" for work that has never begun. Verified against PostgreSQL 18.4: the first-ever delivery returns `state="started" inserted=true` with `time.Since(startedAt) = 0s`, and the handler runs zero times. (`ErrProcessingInProgress` was also never declared, so the file did not compile either.)
>
> The root cause is that `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` does not tell you which branch ran. Both paths return a row that looks identical. **`xmax = 0` is how PostgreSQL answers this**: `xmax` holds the transaction ID that deleted or locked the row version, and it is zero only for a freshly inserted tuple. Non-zero means the `ON CONFLICT` path fired. Add `(xmax = 0) AS inserted` to your `RETURNING` and the ambiguity disappears. This idiom is absent from most tutorials and is exactly what separates code that works under concurrency from code that only appears to.
>
> The second bug is subtler and survives even after you fix the first. `updateState` set `state`, `result`, `error`, and `completed_at`, but **never touched `started_at`**. Reclaiming a stale record therefore left the original ancient timestamp in place. The reclaiming processor marks it `started` and begins work, and the very next delivery reads that same expired `started_at`, concludes the lease is dead, and reclaims it too. And the next. A record that goes stale once becomes permanently reclaimable, so *every* concurrent delivery runs the handler simultaneously, which is the precise opposite of the intent. A lease you never renew is not a lease. Reclaiming must reset the clock, which is why `started_at = now()` appears in the `ON CONFLICT` branch.
>
> The third fix is smaller but real: the original discarded the error returns from both final `updateState` calls. If recording completion fails, the work is done and the record still says `started`, so the message gets reprocessed once the lease expires. That error is the only warning you will ever get.

### Measured, not assumed

An idempotency mechanism that has not been run concurrently is a hypothesis. Against real PostgreSQL 18.4 with `-race`, a handler that counts its own executions:

| Scenario | Handler executions | Outcome |
|----------|-------------------:|---------|
| First delivery | 1 | returns `receipt-123` |
| Replay of a completed message | 0 | replays the stored `receipt-123` |
| **40 concurrent deliveries of the same ID** | **1** | 7 replayed the result, 33 got `ErrProcessingInProgress` |
| Retry after a failed attempt | 1 more | succeeds, not swallowed as a duplicate |
| **20 workers racing one expired lease** | **1** | 1 reclaimed, 19 correctly rejected |

The last row is the one that would have failed before `started_at` was reset on reclaim: all 20 workers would have seen the same stale timestamp, all 20 would have reclaimed, and the side effect would have fired 20 times. Note that the zombie test is the *only* one that catches that bug, and it requires deliberately planting a `started` row with an old timestamp. No amount of ordinary load testing produces it, because it only appears after a worker has already crashed mid-message.

That is the shape of concurrency bugs generally, and it is why these tests are worth writing even though they feel paranoid. Each one encodes a failure that will otherwise be discovered in production, at the worst possible time, by a customer.

### The window that remains

Two-phase processing is a large improvement over mark-then-do, and it is still not magic. The handler runs, and *then* completion is recorded. Crash in between and the lease expires and the message is reprocessed. This is unavoidable for the same reason exactly-once delivery is unavoidable: the handler's side effect and the database record are two systems, and there is no atomic commit across them.

What two-phase buys you is that the failure becomes **bounded and visible** rather than silent. A crashed attempt leaves a row in `started` with a timestamp you can alert on, inspect, and reason about. Compare the dedup store's failure mode, where a crash leaves a record indistinguishable from success and the message is simply gone.

To actually close the window, the side effect itself must be idempotent, which lands on the same answer as everywhere else in this chapter: a unique constraint on the effect. If the handler's write is `INSERT INTO charges (idempotency_key, ...)` with a unique key, reprocessing is harmless by construction, and `processing_records` becomes an optimization that avoids duplicate work rather than a mechanism you are trusting for correctness. **Layer the two.** The state machine reduces duplicate attempts, the constraint makes the survivors safe.

### Staff Lens: True Exactly-Once Is Hard

"At-least-once with idempotent processing" is exactly-once-equivalent from the user's perspective. This is usually what you actually want. Pure exactly-once (the processing happens precisely once) requires distributed consensus and is rarely necessary.

---
