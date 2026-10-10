## 35.4 Distributed Locking

### Simple Lock

A distributed lock coordinates access to a shared resource across multiple processes or servers. Redis implements this with `SetNX` (SET if Not eXists): the first caller to set the key acquires the lock, and all subsequent callers see the key already exists and know the lock is held. The `TTL` parameter acts as a safety net - if the lock holder crashes without releasing, the key expires automatically and the lock becomes available again.

**The honest correctness story.** Salvatore Sanfilippo (antirez) published the Redlock algorithm for multi-master Redis distributed locking. Martin Kleppmann countered in "How to do distributed locking" that Redlock assumes a semi-synchronous system with bounded clock drift and bounded process pauses, neither of which holds in practice - a GC pause longer than the lock TTL allows two clients to believe they hold the lock simultaneously, and wall-clock jumps (NTP corrections, VM suspension) break the multi-node vote. Antirez rebutted in "Is Redlock safe?" arguing the assumptions are reasonable for most workloads and that fencing tokens are an orthogonal concern. The pragmatic takeaway for Go services: **a single-node `SET NX EX` lock plus a UUID-owner check is sufficient for coordinating non-critical work** (deduplicating a job, debouncing a webhook, serializing a cron runner). For correctness-critical mutual exclusion over a resource that tolerates no double-execution (financial transfers, unique ID allocation) use the resource's own atomicity (database row locks, Postgres advisory locks, or a fencing token that the protected resource validates). Redlock is rarely the right answer in 2026.

The critical detail is the `Release` method. A naive `DEL` would release anyone's lock, so the implementation uses a Lua script to atomically check that the stored UUID matches before deleting. This prevents a slow process from accidentally releasing a lock that another process acquired after the original TTL expired. The `Extend` method uses the same ownership check to safely push the expiration forward for long-running operations.

```go
type DistributedLock struct {
    rdb    *redis.Client
    key    string
    value  string
    ttl    time.Duration
}

func NewLock(rdb *redis.Client, key string, ttl time.Duration) *DistributedLock {
    return &DistributedLock{
        rdb:   rdb,
        key:   "lock:" + key,
        value: uuid.New().String(),
        ttl:   ttl,
    }
}

func (l *DistributedLock) Acquire(ctx context.Context) (bool, error) {
    return l.rdb.SetNX(ctx, l.key, l.value, l.ttl).Result()
}

func (l *DistributedLock) Release(ctx context.Context) error {
    // Only release if we own the lock
    script := redis.NewScript(`
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `)

    _, err := script.Run(ctx, l.rdb, []string{l.key}, l.value).Result()
    return err
}

func (l *DistributedLock) Extend(ctx context.Context, extra time.Duration) (bool, error) {
    script := redis.NewScript(`
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
        else
            return 0
        end
    `)

    result, err := script.Run(ctx, l.rdb, []string{l.key}, l.value, int64(extra.Milliseconds())).Int()
    return result == 1, err
}
```

### Lock with Retry

In practice, a single lock attempt often fails because another worker holds the lock temporarily. `AcquireWithRetry` polls with a configurable delay between attempts, respecting the caller's context for cancellation. The `select` on `ctx.Done()` ensures the retry loop exits immediately if the parent context is canceled or its deadline passes, avoiding wasted retries on a request that has already timed out. The usage example below shows the typical pattern: acquire with retry, defer release, then perform the protected work.

```go
func (l *DistributedLock) AcquireWithRetry(ctx context.Context, maxRetries int, retryDelay time.Duration) (bool, error) {
    for i := 0; i < maxRetries; i++ {
        acquired, err := l.Acquire(ctx)
        if err != nil {
            return false, err
        }
        if acquired {
            return true, nil
        }

        select {
        case <-ctx.Done():
            return false, ctx.Err()
        case <-time.After(retryDelay):
        }
    }
    return false, nil
}

// Usage
func processJob(ctx context.Context, rdb *redis.Client, jobID string) error {
    lock := NewLock(rdb, "job:"+jobID, 30*time.Second)

    acquired, err := lock.AcquireWithRetry(ctx, 5, 100*time.Millisecond)
    if err != nil {
        return err
    }
    if !acquired {
        return errors.New("could not acquire lock")
    }
    defer lock.Release(ctx)

    // Process job...
    return nil
}
```

### Junior to FAANG: what to learn before the interview

If you have never written a distributed lock, start with the mental model. A lock is a rendezvous. Two processes race to the same Redis key and exactly one wins. The winner owns a short time window in which it is safe to touch the protected resource. Everything else in the chapter is a consequence of that sentence. Prerequisites you should be solid on before a FAANG coding round touches locks: atomicity of `SET NX EX`, why `GETSET` is insufficient (non-atomic check-then-set), why plain `DEL` on release is a footgun, context cancellation in Go, and UUID generation cost.

Worked example. A webhook from Stripe fires three retries in one second because your handler is slow. Without a lock you charge the user three times. The fix is a lock keyed by the webhook event ID with a 60 second TTL. Every replica of your handler calls `Acquire`. Two replicas lose and return 200 immediately so Stripe stops retrying. The winner runs the idempotent handler and releases.

First-job context. Most production lock usage at a mid-sized company is not Redlock. It is `SET NX EX` on a single Redis primary, good enough to deduplicate webhooks, debounce emails, and serialize cron runs. If the interviewer asks you to design a lock for money movement, do not reach for Redis. Name a real mutual exclusion primitive: Postgres `SELECT FOR UPDATE` on the account row, a Postgres advisory lock, or a serializable transaction. This answer scores more points than reciting Redlock.

Interview entry point. The classic question is "implement a distributed lock in Go." The rubric they score on: (1) ownership token in the value so only the owner can release, (2) Lua script for atomic compare-and-delete, (3) TTL so a crashed holder does not livelock the system, (4) explicit acknowledgment that `Extend` exists for long jobs, (5) mention fencing tokens even if you do not implement them. Finish by saying "I would not use this for anything that must not double-execute, I would use the database."

### Senior at FAANG: the lock debate, fencing tokens, and picking the right primitive

The 2016 Kleppmann and Antirez exchange has not aged. It has only become more relevant because cloud environments make the assumptions Kleppmann attacked (bounded GC pauses, bounded clock drift, bounded network delay) demonstrably false. A Java service on a burst-balance-exhausted EC2 instance can pause for 20 seconds. A Go service can be scheduled off CPU for 500 ms under memory pressure. A VM live-migration can freeze a process for seconds. Any algorithm that assumes "if my TTL is 30 s and I just acquired, I still hold the lock 5 s later" is wrong in the way that loses money.

The Kleppmann counter-proposal is the fencing token. The lock service hands the holder a monotonically increasing integer. The protected resource (storage, a database, a queue) refuses writes whose token is below the highest token it has ever seen. This is the only design that is safe under arbitrary pauses. Redis cannot give you fencing tokens natively. You can simulate them with `INCR` alongside the lock, but you still have to propagate the token to the resource and the resource has to validate it. Zookeeper, etcd, and Chubby give you fencing for free because they expose a linearizable epoch or zxid. If a candidate proposes Redlock for a correctness-critical problem in a staff interview, that is a red flag. The correct staff answer is: "pick the primitive the resource itself offers, only reach for external coordination when no resource-local primitive exists, and when you do need external coordination use a CP system."

Practical matrix for 2026. Use `SET NX EX` with Lua release for non-critical deduplication, cron singleton, debouncing, warmup guards. Use Postgres advisory locks (`pg_try_advisory_lock`) when your app already talks to Postgres and the protected resource is database state, the lock dies with the session so there is no orphan problem. Use etcd leases with lease-tied keys for Kubernetes-style leader election and for coordination between services that need to survive Postgres failover. Use Zookeeper only if you are already running it. Use Redlock only if you have already exhausted the above and you are willing to own the operational burden of multi-master Redis plus the known failure modes.

Extend-with-heartbeat pattern. For jobs whose duration is unpredictable, do not pick a large TTL and hope. Pick a short TTL (say 10 seconds) and launch a heartbeat goroutine that calls `Extend` every 3 seconds. If the goroutine blocks or the process pauses, the lock expires and someone else takes over. The job itself must be idempotent or checkpointed, because the pause that caused your heartbeat to stall may not have stopped the work. Senior engineers build the protected workload to tolerate lock loss. Junior engineers assume the lock holds.

Observability for locks. Count acquisitions, acquisition failures, release-mismatch events (someone else owned the key when you tried to release, this means your TTL is too short for your workload), and extend failures. A rising release-mismatch rate is the single clearest signal that your lock is not actually providing mutual exclusion. Page on it.

Staff ADR framing. When you write the ADR that proposes Redis locks, the decision record must state: (1) the consistency requirement of the protected resource, (2) why a resource-local lock was rejected, (3) the failure mode you accept (occasional double-execution under pause), (4) the idempotency story for the protected workload, (5) the monitoring plan for detecting the failure mode. Reviewers who have been burned will reject an ADR that omits (4) and (5). The lock is not the guarantee. The lock plus idempotent workload plus monitoring is the guarantee.

---
