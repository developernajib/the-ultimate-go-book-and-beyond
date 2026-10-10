## 33.8 Advisory Locks

### Distributed Locking

Advisory locks are application-defined locks managed by PostgreSQL. Unlike row-level locks that protect specific table rows, advisory locks operate on arbitrary integer keys that your application assigns meaning to. They are useful for coordinating work across multiple service instances: ensuring only one worker processes a given job, preventing concurrent schema migrations, or serializing access to an external resource.

PostgreSQL offers two flavors. Session-level locks (`pg_advisory_lock`) persist until explicitly released or the session disconnects. Transaction-level locks (`pg_advisory_xact_lock`) release automatically when the transaction commits or rolls back. The `pg_try_advisory_lock` variant returns immediately with `false` instead of blocking if the lock is already held.

> **Senior track**: Prefer `pg_advisory_xact_lock` whenever you already have a transaction in hand. It cannot leak if the goroutine panics, a context times out, or the pool evicts the connection, the locks are released with the transaction. Session-scoped locks require strict discipline: the acquire, all protected work, and the unlock must run on the exact same physical connection, which is why you must `Acquire` from the pool once and reuse that handle throughout. Lock IDs are `bigint` (64-bit): namespace them by hashing a stable key (`lower-32 bits = feature, upper-32 bits = entity id`) to avoid collisions across subsystems.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "hash/fnv"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

func hashToInt64(s string) int64 {
    h := fnv.New64a()
    _, _ = h.Write([]byte(s))
    return int64(h.Sum64())
}

func doJobWork(jobID int64) error {
    return nil
}

func withAdvisoryLock(ctx context.Context, pool *pgxpool.Pool, lockID int64, fn func() error) error {
    // Advisory locks are session-level, so we must use the same connection
    // for both acquiring and releasing the lock.
    conn, err := pool.Acquire(ctx)
    if err != nil {
        return err
    }
    defer conn.Release()

    // Acquire lock
    var acquired bool
    err = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", lockID).Scan(&acquired)
    if err != nil {
        return err
    }

    if !acquired {
        return errors.New("could not acquire lock")
    }

    // Ensure unlock on the same connection
    defer conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", lockID)

    return fn()
}

// Session-level lock
func withSessionLock(ctx context.Context, conn *pgxpool.Conn, lockID int64, fn func() error) error {
    _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockID)
    if err != nil {
        return err
    }
    defer conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", lockID)

    return fn()
}

// Transaction-level lock (automatically released on commit/rollback)
func withTransactionLock(ctx context.Context, tx pgx.Tx, lockID int64, fn func() error) error {
    _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
    if err != nil {
        return err
    }
    return fn()
}

// Example: Prevent duplicate job processing
func processJobOnce(ctx context.Context, pool *pgxpool.Pool, jobID int64) error {
    lockID := hashToInt64(fmt.Sprintf("job:%d", jobID))

    return withAdvisoryLock(ctx, pool, lockID, func() error {
        // Check if job already processed. Any pooled connection is fine
        // for these reads/writes: the lock itself lives on the acquiring
        // connection inside withAdvisoryLock and is released there.
        var processed bool
        err := pool.QueryRow(ctx, "SELECT processed FROM jobs WHERE id = $1", jobID).Scan(&processed)
        if err != nil {
            return err
        }

        if processed {
            return nil // Already done
        }

        // Process job
        if err := doJobWork(jobID); err != nil {
            return err
        }

        // Mark as processed
        _, err = pool.Exec(ctx, "UPDATE jobs SET processed = true WHERE id = $1", jobID)
        return err
    })
}
```

### Junior → FAANG: what advisory locks actually guard

Row locks protect rows. Table locks protect tables. Advisory locks protect concepts. You pick a 64-bit integer, you call `pg_advisory_lock(id)`, and from that moment any other session that asks for the same integer blocks until you release it. Postgres itself does not interpret the integer, it just tracks who holds it.

Worked example. You run three replicas of a backend service and each starts a periodic job at the top of the hour. Without coordination all three run the job and race. With advisory locks the pattern is:

```sql
SELECT pg_try_advisory_lock(hashtextextended('hourly_report_job', 0));
```

Exactly one replica gets `true` and runs the job. The others get `false` and skip. When the winner exits the session, Postgres releases the lock. This is the cheapest leader election you can build, and it requires no extra infrastructure.

Naming the integer. The lock ID is arbitrary but global. Collisions are silent and dangerous. The standard technique is to hash a descriptive string into a `bigint` with `hashtextextended('job:hourly_report', 0)`. For per-entity locks, pack two 32-bit numbers: upper 32 bits identify the subsystem, lower 32 bits identify the entity. This keeps domain A's locks from accidentally blocking domain B's locks.

Interview entry-point. Know the difference between `pg_advisory_lock` (blocks, session scope) and `pg_try_advisory_lock` (non-blocking, returns bool), and between session-scoped and transaction-scoped (`_xact_`) variants. Know that session locks survive transaction rollback and are released only by explicit unlock or disconnect. Know that advisory locks do not interact with MVCC or row visibility at all.

### Senior @ FAANG: patterns, pitfalls, and visibility

Session vs transaction scope, decided properly. The default recommendation "prefer transaction scope" is correct for most work, but there are two legitimate session-scope use cases. One is long-running background loops where the work is not a single transaction (a job runner that processes many items, each its own transaction, while holding a single leader lock). Two is holding a lock across a conversational protocol that spans many round trips, such as a schema-migration tool coordinating across services. For everything else, `pg_advisory_xact_lock` is safer because Go context cancellation, network errors, and panics all eventually kill the transaction and release the lock, while session locks require you to run the unlock yourself on the same connection.

Connection pooling traps. Session-scoped advisory locks require the same backend connection for acquire and release. Through pgBouncer in transaction mode this is impossible, because the connection you get on release might not be the one that acquired. You must either use session pooling (rare), bypass the pooler for lock-holding code, or switch to transaction-scoped locks. pgx with pgxpool works as long as you hold the `*pgxpool.Conn` handle across acquire and release. Returning the connection to the pool between operations silently breaks the pattern and the lock will not be released until the session times out.

Queue lock pattern. For a durable job queue inside Postgres without a separate broker, the combination is `SELECT FOR UPDATE SKIP LOCKED` to pick work plus a transaction-scoped advisory lock to serialize side effects that must not run concurrently even across different jobs. Example: two jobs process different users but both call an external API that rate-limits by API key. Wrap the API call with `pg_advisory_xact_lock(hashtextextended('vendor_x_api_key:' || key, 0))` so only one job at a time talks to that vendor key, even though many jobs run in parallel overall. This is cheaper and more precise than a semaphore in a separate service.

Leader election for schedulers. The production pattern for "exactly one instance runs this cron" is a short transaction that acquires a transaction-scoped lock, inserts a heartbeat into `scheduler_leader(id, leader_pod, last_heartbeat)`, commits, then loops with another short transaction every few seconds. This keeps the lock held only briefly and lets Postgres decide leadership via lock contention. Longer-lived leadership should use session scope with an aggressive `tcp_keepalives_*` configuration and a dead-man's-switch heartbeat in the application that panics if heartbeats fail, so Kubernetes restarts the pod and the backend session dies.

Visibility and debugging. `pg_locks` with `locktype = 'advisory'` shows who holds what. The interesting columns are `classid` and `objid` (the two halves of the 64-bit key when you use the two-argument form) or `objid` for the single `bigint` form, plus `pid` and `granted`. A blocked session shows up as `granted = false` with the same key. Join to `pg_stat_activity` on `pid` to see what query the holder is running. Build a dashboard that shows the top 10 advisory locks by hold duration. Long-held advisory locks are almost always a bug, either a session that forgot to unlock or a job that stalled inside the critical section.

Anti-patterns. Using `pg_advisory_lock` (blocking) in a request handler, which causes request pileup under contention instead of backpressure. Using advisory locks for correctness-critical mutual exclusion across datacenters, which does not work because advisory locks are per-cluster and a failover to a replica loses them. Using advisory locks to protect data that should be protected by row locks and proper transaction design, which hides the real concurrency model from reviewers. Hardcoding lock integers like `42` instead of hashing a named string, which creates silent collisions when someone else picks `42` later.

Shipping rules. Every advisory lock in the codebase must have a code comment naming the concept it protects, a helper function that owns the acquire-release lifecycle, a metric for acquisition latency and failure count, and a timeout on the acquisition path (for blocking variants wrap with `statement_timeout` or use the `_try_` variant with an explicit retry loop). Review rejects any advisory lock without all four.

---
