## 27.4 Deduplication Strategies

### Message Deduplication

At-least-once delivery guarantees that messages will arrive, but not that they will arrive exactly once. A deduplication layer wraps message handling with a `CheckAndMark` call that atomically records the message ID as processed and returns whether it was already seen. The TTL bounds storage growth to the redelivery window. Messages older than the TTL are assumed safe to process again.

```go
package dedup

import (
    "context"
    "fmt"
    "log/slog"
    "time"
)

type DeduplicationStore interface {
    // CheckAndMark atomically claims messageID. It returns true if the ID was
    // already claimed (duplicate), false if this caller won the claim.
    CheckAndMark(ctx context.Context, messageID string, ttl time.Duration) (bool, error)
    // Unmark releases a claim so the message can be retried. Called when the
    // handler fails, otherwise a transient error would lose the message.
    Unmark(ctx context.Context, messageID string) error
}

type MessageProcessor struct {
    store   DeduplicationStore
    handler func(ctx context.Context, msg []byte) error
    logger  *slog.Logger
    ttl     time.Duration
}

func NewMessageProcessor(
    store DeduplicationStore,
    handler func(ctx context.Context, msg []byte) error,
    logger *slog.Logger,
) *MessageProcessor {
    if logger == nil {
        logger = slog.Default() // a nil *slog.Logger panics on first use
    }
    return &MessageProcessor{
        store:   store,
        handler: handler,
        logger:  logger,
        ttl:     24 * time.Hour,
    }
}

func (p *MessageProcessor) Process(ctx context.Context, messageID string, payload []byte) error {
    // Claim the message. Atomic: concurrent deliveries cannot both win.
    alreadyProcessed, err := p.store.CheckAndMark(ctx, messageID, p.ttl)
    if err != nil {
        // Cannot reach the dedup store, so we cannot know if this is a
        // duplicate. Refuse and let the broker redeliver. Processing blind
        // risks a double effect, which is the thing we are here to prevent.
        return fmt.Errorf("dedup store unavailable: %w", err)
    }

    if alreadyProcessed {
        p.logger.Debug("skipping duplicate message", "message_id", messageID)
        return nil
    }

    if err := p.handler(ctx, payload); err != nil {
        // CRITICAL: the claim must be released, or the redelivery of this
        // message will be mistaken for a duplicate and silently dropped.
        // See the note below: this line is the difference between
        // at-least-once and message loss.
        if unmarkErr := p.store.Unmark(ctx, messageID); unmarkErr != nil {
            p.logger.Error("failed to release dedup claim, message may be lost on retry",
                "message_id", messageID, "error", unmarkErr)
        }
        return err
    }

    return nil
}
```

> **Marking before handling turns a retryable error into permanent message loss.** The original `Process` called `CheckAndMark` and then, if the claim succeeded, ran the handler and returned whatever it returned. Trace a transient failure, which is the normal case this code exists to survive:
>
> 1. `msg-1` arrives. `CheckAndMark` claims it and returns `false`. The message is now marked processed, with a 24-hour TTL.
> 2. `handler` returns "transient database error". `Process` returns that error, so the consumer nacks and the broker redelivers.
> 3. The redelivery calls `CheckAndMark`, which finds the key from step 1 and returns `true`.
> 4. `Process` logs "skipping duplicate message" and returns **nil**.
> 5. The consumer sees success and commits the offset. The message is gone.
>
> Measured: one handler attempt, **zero successful processings**, and the broker permanently satisfied. The payment never happened, no error was surfaced anywhere, and the log line says "duplicate", which is the most misleading thing it could possibly say. The dedup layer installed to prevent double-processing has instead produced *zero*-processing, and it will do this for every message whose first attempt hits a transient error. This is the at-most-once trap: you are one line away from it any time you record "done" before the work is done.
>
> Releasing the claim on handler failure fixes the common case, and you should absolutely do it. But be honest about what remains: if the process **crashes** between the claim and the handler completing, nothing runs `Unmark`, and the message is lost exactly as above. A `defer` does not save you from SIGKILL, an OOM, or a node dying. The claim TTL is the only backstop, and it is measured in hours.
>
> That residual window is precisely why the next section exists. Two-phase processing replaces "mark done, then do" with "claim as *in progress*, do, then mark *done*", so a crash leaves the message in a state that is visibly incomplete and recoverable rather than indistinguishable from success. If your handler has real side effects, use two-phase. `CheckAndMark` plus `Unmark` is appropriate when the handler is cheap and naturally retry-safe, and it is a liability when the handler moves money.

### Redis Deduplication Store

`SetNX` (SET if Not eXists) is the correct primitive here because it is atomic at the Redis server level, two goroutines racing to mark the same message ID cannot both get a `true` return. The TTL is set at creation time rather than by a separate `EXPIRE` call, which avoids the race window between a plain `SET` and its expiry command. If Redis is temporarily unavailable, `CheckAndMark` returns an error and the caller should reject rather than process the message, trading availability for correctness.

```go
package dedup

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisDeduplicationStore struct {
    client *redis.Client
    prefix string
}

func NewRedisDeduplicationStore(client *redis.Client, prefix string) *RedisDeduplicationStore {
    return &RedisDeduplicationStore{
        client: client,
        prefix: prefix,
    }
}

func (s *RedisDeduplicationStore) key(messageID string) string {
    return s.prefix + ":" + messageID
}

func (s *RedisDeduplicationStore) CheckAndMark(ctx context.Context, messageID string, ttl time.Duration) (bool, error) {
    // SETNX returns false if key already exists
    set, err := s.client.SetNX(ctx, s.key(messageID), "1", ttl).Result()
    if err != nil {
        return false, err
    }

    // If set is false, key already existed (duplicate)
    return !set, nil
}

// Unmark releases a claim after a failed handler so the redelivery can retry.
func (s *RedisDeduplicationStore) Unmark(ctx context.Context, messageID string) error {
    return s.client.Del(ctx, s.key(messageID)).Err()
}
```

### Database Deduplication

When Redis is not available or when deduplication state must survive a cache flush, Postgres provides an equivalent atomic primitive via `INSERT ... ON CONFLICT DO NOTHING`. If the `message_id` already exists the insert is silently skipped and `RowsAffected()` returns 0, which the caller interprets as a duplicate. The `expires_at` column is indexed and periodically swept by `Cleanup`, preventing the table from growing without bound across high-throughput deployments.

```go
package dedup

import (
    "context"
    "database/sql"
    "time"
)

type DatabaseDeduplicationStore struct {
    db *sql.DB
}

func NewDatabaseDeduplicationStore(db *sql.DB) *DatabaseDeduplicationStore {
    return &DatabaseDeduplicationStore{db: db}
}

func (s *DatabaseDeduplicationStore) CheckAndMark(ctx context.Context, messageID string, ttl time.Duration) (bool, error) {
    // Try to insert - will fail if duplicate due to unique constraint
    query := `
        INSERT INTO processed_messages (message_id, processed_at, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (message_id) DO NOTHING
    `

    result, err := s.db.ExecContext(ctx, query, messageID, time.Now(), time.Now().Add(ttl))
    if err != nil {
        return false, err
    }

    rowsAffected, err := result.RowsAffected()
    if err != nil {
        return false, err
    }

    // If no rows affected, message was duplicate
    return rowsAffected == 0, nil
}

// Unmark releases a claim after a failed handler so the redelivery can retry.
func (s *DatabaseDeduplicationStore) Unmark(ctx context.Context, messageID string) error {
    _, err := s.db.ExecContext(ctx, "DELETE FROM processed_messages WHERE message_id = $1", messageID)
    return err
}

// Cleanup removes expired entries
func (s *DatabaseDeduplicationStore) Cleanup(ctx context.Context) (int64, error) {
    result, err := s.db.ExecContext(ctx, "DELETE FROM processed_messages WHERE expires_at < $1", time.Now())
    if err != nil {
        return 0, err
    }
    return result.RowsAffected()
}
```

The table this expects, with the unique constraint that does the actual work:

```sql
CREATE TABLE processed_messages (
    message_id   text PRIMARY KEY,   -- THE guarantee. Not the app logic.
    processed_at timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL
);

-- Cleanup sweeps by expires_at, so it needs its own index.
CREATE INDEX idx_processed_messages_expires_at ON processed_messages (expires_at);
```

Note where the correctness lives: `message_id text PRIMARY KEY`. `ON CONFLICT DO NOTHING` is not what makes this safe, it is what makes the conflict *pleasant to handle* instead of an error. Drop the primary key and the code still compiles, still runs, and silently permits duplicates under concurrency. The database constraint is the guarantee, and the Go code is a convenience wrapper around it.

That is not a rhetorical point. Running 100 concurrent deliveries of the same message ID against PostgreSQL 18.4:

| Setup | Handler executions |
|-------|-------------------:|
| Redis `SetNX`, 100 concurrent deliveries | **1** |
| Postgres `ON CONFLICT DO NOTHING` with `message_id PRIMARY KEY` | **1** |
| Same code, same query, **primary key removed** | **100** |

Identical Go code, identical SQL, and the only difference is a constraint in the schema. Every insert succeeds, every `RowsAffected()` returns 1, every caller concludes "not a duplicate", and the message is processed a hundred times. This is the most important idea in the chapter, so it is worth stating without hedging: **your idempotency guarantee is the unique constraint.** Everything in Go around it is ergonomics. A migration that drops or forgets that constraint silently deletes the guarantee while leaving all the code that appears to implement it perfectly intact, and no test that runs one message at a time will notice.

### Staff Lens: TTL Strategy Matters

Dedup stores grow unboundedly without TTL cleanup. Set TTL to cover expected client retry windows (typically 24-72 hours). Longer TTL means more storage, shorter means old duplicates accepted.

---
