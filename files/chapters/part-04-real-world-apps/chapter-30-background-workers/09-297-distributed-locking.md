## 30.7 Distributed Locking

### Which lock do you actually need?

Before reaching for Redis, be honest about what "distributed lock" means for your use case. There are two very different problems hiding behind the same phrase.

- **Efficiency locks** prevent two replicas from doing the *same* expensive work at the same time (a cron job that emails daily summaries, a cache warm-up, a scheduled report). Duplicate execution is wasteful but not incorrect, your business logic can tolerate the rare double-run. A single-node Redis `SET key value NX PX ttl` is fine here.
- **Correctness locks** enforce that only one actor mutates a resource at a time (only one worker may finalize an order, only one process may advance a state machine). Duplicate execution corrupts data. You need *fencing tokens*, monotonically increasing numbers the downstream resource checks before applying the write, or you need transactional guarantees inside the datastore itself.

The implementation below is an efficiency lock. Do not use it to protect correctness-critical invariants unless the protected resource also validates a fencing token on every write.

### The RedLock debate, briefly

Redsync (`github.com/go-redsync/redsync/v4`) implements the RedLock algorithm, where a client acquires the lock on a majority of N independent Redis nodes. Salvatore Sanfilippo ("antirez") designed it to tolerate node failures without a single point of coordination. Martin Kleppmann's "How to do distributed locking" (2016) argued that RedLock relies on assumptions about bounded clock drift and process-pause duration that do not hold in real systems, and that without fencing tokens it cannot be safely used for correctness. Antirez pushed back in "Is Redlock safe?", and the debate has never been fully resolved.

The practical conclusion: if you are building a correctness lock, do not rely on a TTL-based Redis lock in isolation. Either use a real consensus system (etcd, ZooKeeper, or a Raft-backed queue that issues fencing tokens), or lean on a database your data already lives in, see Postgres advisory locks below.

### Redis Lock for Job Coordination

The `DistributedLock` struct wraps a Redis client and uses `SET key value NX PX ttl` to atomically acquire a named lock, the NX flag ensures only one caller succeeds when multiple workers race simultaneously. The lock value is a caller-supplied token (typically a UUID) that the release script validates before deleting, preventing a slow holder from releasing a lock that has already expired and been re-acquired by another worker. The TTL bounds the maximum time the lock can be held even if the holder crashes without calling `Unlock`, preventing indefinite exclusion.

```go
package lock

import (
    "context"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrLockNotAcquired = errors.New("lock not acquired")

type DistributedLock struct {
    client *redis.Client
    key    string
    value  string
    ttl    time.Duration
}

func NewDistributedLock(client *redis.Client, key string, ttl time.Duration) *DistributedLock {
    return &DistributedLock{
        client: client,
        key:    "lock:" + key,
        value:  generateID(),
        ttl:    ttl,
    }
}

func (l *DistributedLock) Acquire(ctx context.Context) error {
    ok, err := l.client.SetNX(ctx, l.key, l.value, l.ttl).Result()
    if err != nil {
        return err
    }
    if !ok {
        return ErrLockNotAcquired
    }
    return nil
}

func (l *DistributedLock) Release(ctx context.Context) error {
    // Only release if we own the lock
    script := `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `
    _, err := l.client.Eval(ctx, script, []string{l.key}, l.value).Result()
    return err
}

func (l *DistributedLock) Extend(ctx context.Context, extra time.Duration) error {
    script := `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
        else
            return 0
        end
    `
    result, err := l.client.Eval(ctx, script, []string{l.key}, l.value, int64(extra.Milliseconds())).Int()
    if err != nil {
        return err
    }
    if result == 0 {
        return ErrLockNotAcquired
    }
    return nil
}

// WithLock executes function while holding lock
func WithLock(ctx context.Context, client *redis.Client, key string, ttl time.Duration, fn func() error) error {
    lock := NewDistributedLock(client, key, ttl)

    if err := lock.Acquire(ctx); err != nil {
        return err
    }
    defer lock.Release(ctx)

    return fn()
}
```

### Postgres Advisory Locks, the Boring-But-Correct Alternative

If your workers already talk to Postgres, you probably do not need a separate lock service. Postgres advisory locks are a 64-bit keyed lock primitive held inside a session or transaction. They are released automatically when the connection drops (no TTL drift, no stale locks after a crash) and participate in the same MVCC guarantees as the rest of your data.

```go
// pg_try_advisory_xact_lock returns true if we got the lock, false otherwise.
// The lock is released automatically at COMMIT or ROLLBACK, no Release() call needed.
func WithPgAdvisoryLock(ctx context.Context, db *sql.DB, key int64, fn func(tx *sql.Tx) error) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    var got bool
    if err := tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", key).Scan(&got); err != nil {
        return err
    }
    if !got {
        return ErrLockNotAcquired
    }

    if err := fn(tx); err != nil {
        return err
    }
    return tx.Commit()
}
```

Advisory locks are the right tool for: "only one replica should run this cron tick", "only one worker should be finalizing this specific order ID at a time", "serialize schema migrations across replicas". They are the wrong tool for: locks that must survive a network partition, or locks held for minutes while doing slow external I/O (tying up a Postgres connection that long is a separate problem).

### Redsync (RedLock) Quick Reference

For teams that have already decided on RedLock despite the caveats above, `github.com/go-redsync/redsync/v4` is the maintained Go implementation:

```go
import "github.com/go-redsync/redsync/v4"
import "github.com/go-redsync/redsync/v4/redis/goredis/v9"

pool := goredis.NewPool(redisClient)
rs := redsync.New(pool)
mu := rs.NewMutex("resource-key",
    redsync.WithExpiry(10*time.Second),
    redsync.WithTries(3),
)
if err := mu.LockContext(ctx); err != nil { /* ... */ }
defer mu.UnlockContext(ctx)
```

Pair it with a fencing token stored in the protected resource (e.g. an `expected_version` column checked on every `UPDATE`) if correctness matters.

### Junior to FAANG: before you use a lock, question whether you need one

Locks are the wrong answer more often than the right answer. Three scenarios where juniors reach for a lock and the correct answer is something else.

1. **"I want only one worker to process this job."** You do not need a lock. You need at-most-once dequeue semantics, which `FOR UPDATE SKIP LOCKED` or SQS already provide. Adding a lock on top is redundant.

2. **"I want to prevent double-charging a customer."** You do not need a lock. You need idempotency. Store the idempotency key `(charge_id)` with a unique constraint and make the handler a no-op on duplicate key. A lock would make the system slower and not safer, because network partitions can break any TTL-based lock.

3. **"I want to serialize access to a resource."** Sometimes this is real. Usually it is a sign the data model is wrong. An order should not need a lock to be mutated. It should have optimistic concurrency control (`WHERE version = expected`) and the retry loop handles contention.

Legitimate uses of locks in a job system.

- Cron dedup (efficiency lock, duplicate run is wasteful but not corrupting).
- Leader election for schedulers.
- Serializing work across a bounded resource (e.g. "only one worker talks to this printer").

Walkthrough of a subtle bug. Worker acquires lock with 30s TTL. Handler takes 45s because downstream is slow. At 30s, lock expires. Another worker acquires. Both now run. Original worker finishes and calls `Release`. Lua script sees the value does not match (second worker has overwritten) and does nothing. Good. But both handlers ran. If handler was not idempotent, damage is done. Lock is not safety. Idempotency is safety. Lock is an optimization.

Interview entry point. "Explain the RedLock controversy." Expected answer. RedLock assumes bounded clock drift and bounded GC pauses. Kubernetes violates both occasionally (clock skew across nodes, Go GC pauses under memory pressure, OS scheduler delays in a noisy neighbor). Therefore for correctness, prefer consensus (etcd, ZooKeeper) plus fencing tokens. For efficiency, RedLock is adequate.

### Senior at FAANG: distributed coordination at scale

At FAANG, distributed locks are one of the top sources of SEV-1s when misused. Staff engineers publish anti-pattern docs specifically to steer teams away from them.

**The fencing token canon.** Kleppmann's argument is not just "RedLock is unsafe". It is "any lock without fencing is unsafe, because any process can be paused arbitrarily long by the OS or GC, and when it wakes up it still thinks it holds the lock". The fix is a monotonically increasing token issued by the lock service. Every write to the protected resource includes the token. The resource rejects writes with stale tokens. ZooKeeper zxid, etcd revision, and Spanner commit timestamps all provide fencing. Redis SET NX PX does not.

**When to use each technology.**

- Postgres advisory locks. You already use Postgres. Lock scope is within a transaction or session. TTL is automatic (connection death releases). Good for cron dedup within a single datacenter, for schema migration serialization, for per-row coordination when the row is too hot for optimistic concurrency control.
- etcd leases. You need leader election across datacenters. etcd provides consensus. Leases renew automatically. ttl-based, but with stronger consistency than Redis. Used by Kubernetes controller-manager, CoreDNS, every control plane at scale. The default for staff-level "I need leader election".
- ZooKeeper. Same class as etcd. Older, more battle-tested, used by Kafka, HBase, Solr. Operationally heavier than etcd. New systems pick etcd.
- Temporal/Cadence workflow signals. If the coordination is workflow-shaped (step A must finish before step B), use a workflow engine, not a lock. Workflows internally serialize execution per-workflow-id.
- Spanner/CockroachDB locks. If you are on a strongly-consistent DB, use its native locks. They have fencing via commit timestamps.
- Redsync (RedLock). Only when you need cross-region Redis-based dedup for efficiency, and the handler is idempotent. Never for correctness.

**Lease-based coordination.** The FAANG default for "single-writer" semantics is a lease, not a lock. A lease is a time-bounded grant from a consensus store. The holder periodically renews. If renewal fails (network partition, GC pause), the holder voluntarily stops writing. A new leader is elected after the lease expires. etcd client libraries implement this (`clientv3.NewLease`, `KeepAlive`). This is how Kubernetes controllers behave.

**Lock-free alternatives.** Many "I need a lock" problems dissolve into lock-free solutions.

- Instead of "only one worker processes this order", use `UPDATE orders SET state = 'processing' WHERE id = X AND state = 'pending'`. Rows affected = 1 means you won.
- Instead of "only one worker runs this cron", use a `cron_runs(schedule, fire_time)` table with a unique constraint on `(schedule, fire_time)`. First worker to INSERT wins.
- Instead of "serialize writes to this counter", use `UPDATE counters SET value = value + 1`. DB handles concurrency.

These are optimistic concurrency patterns. They scale better than locks because there is no blocking. Staff engineers coach teams to prefer them.

**ADR template for lock adoption.** A staff-level lock ADR specifies. (1) Is the requirement correctness or efficiency. (2) If correctness, what fencing token flows to the resource. (3) What happens if the lock service is unavailable (fail open, fail closed, degrade). (4) What is the blast radius if a duplicate execution occurs. (5) Is there a lock-free alternative that was rejected, and why.

**Reviewing lock code.** When reviewing a PR that introduces a distributed lock, the staff-engineer checklist is.

1. TTL tuned to handler P99.9 plus safety margin.
2. Lease renewal during long handlers, or handler aborts if renewal fails.
3. Release script checks ownership token (Lua compare-and-delete).
4. Idempotent handler regardless of lock, because lock is not a correctness guarantee.
5. Metric on lock acquisition rate, lock wait time, lock contention.
6. Alert on lock acquisition failure rate.
7. Runbook entry for "lock service is down".

**Redlock production posture at FAANG.** None of the big FAANGs use Redlock for correctness-critical work in their own infrastructure. They use ZooKeeper (LinkedIn, Twitter), etcd (Kubernetes-native services), Paxos (Google Chubby), or DynamoDB conditional writes (Amazon). Redlock appears in smaller companies and in OSS tools. The FAANG lesson is, if you are at scale, you have access to a consensus system. Use it.

**Game-day exercise.** Annually, simulate lock service outages. Verify degrade paths. Verify handlers remain correct. Verify monitoring detects. This is how you find out your "opportunistic lock" turned into a hidden correctness dependency.

---
