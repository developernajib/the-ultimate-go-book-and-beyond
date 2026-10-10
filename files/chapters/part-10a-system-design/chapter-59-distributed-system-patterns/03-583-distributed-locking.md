## 59.3 Distributed Locking

Distributed locks coordinate access to shared resources across multiple processes or machines. Unlike in-process mutexes, distributed locks must handle network partitions, clock drift, and process crashes, failure modes that can leave a lock held indefinitely or, worse, grant it to two holders simultaneously. The implementations below demonstrate three approaches with increasing safety guarantees: Redis-based Redlock for high-performance locking, etcd-based locking for strong consistency, and fencing tokens for protection against stale lock holders.

### Redis-based Distributed Lock (Redlock)

The Redlock algorithm acquires a lock by successfully setting a key on a strict majority (quorum) of independent Redis instances within a single TTL window, ensuring no single node failure can silently grant the lock twice. Clock drift between instances is accounted for by subtracting a small percentage of the requested TTL from the validity period, so callers always see a conservative estimate of how long they actually hold the lock.

```go
// redlock/lock.go
package redlock

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrLockNotAcquired = errors.New("lock not acquired")
    ErrLockNotHeld     = errors.New("lock not held")
)

// RedLock implements the Redlock algorithm
type RedLock struct {
    clients     []*redis.Client
    quorum      int
    retryCount  int
    retryDelay  time.Duration
    clockDrift  float64 // Factor to account for clock drift
}

// Lock represents an acquired lock
type Lock struct {
    resource string
    value    string
    validity time.Duration
}

// NewRedLock creates a new RedLock instance
func NewRedLock(clients []*redis.Client) *RedLock {
    return &RedLock{
        clients:    clients,
        quorum:     len(clients)/2 + 1,
        retryCount: 3,
        retryDelay: 200 * time.Millisecond,
        clockDrift: 0.01, // 1% clock drift factor
    }
}

// generateValue creates a unique lock value
func generateValue() (string, error) {
    b := make([]byte, 16)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.StdEncoding.EncodeToString(b), nil
}

// Acquire attempts to acquire a lock
func (r *RedLock) Acquire(ctx context.Context, resource string, ttl time.Duration) (*Lock, error) {
    value, err := generateValue()
    if err != nil {
        return nil, err
    }

    for attempt := 0; attempt < r.retryCount; attempt++ {
        if attempt > 0 {
            time.Sleep(r.retryDelay)
        }

        lock, err := r.tryAcquire(ctx, resource, value, ttl)
        if err == nil {
            return lock, nil
        }
    }

    return nil, ErrLockNotAcquired
}

func (r *RedLock) tryAcquire(ctx context.Context, resource, value string, ttl time.Duration) (*Lock, error) {
    start := time.Now()
    acquired := 0

    // Try to acquire on all instances
    for _, client := range r.clients {
        if r.acquireInstance(ctx, client, resource, value, ttl) {
            acquired++
        }
    }

    // Calculate validity time
    elapsed := time.Since(start)
    drift := time.Duration(float64(ttl) * r.clockDrift)
    validity := ttl - elapsed - drift

    // Check if we have quorum and validity time is positive
    if acquired >= r.quorum && validity > 0 {
        return &Lock{
            resource: resource,
            value:    value,
            validity: validity,
        }, nil
    }

    // Failed to acquire - release any locks we got
    r.releaseAll(ctx, resource, value)
    return nil, ErrLockNotAcquired
}

func (r *RedLock) acquireInstance(ctx context.Context, client *redis.Client, resource, value string, ttl time.Duration) bool {
    result, err := client.SetNX(ctx, resource, value, ttl).Result()
    return err == nil && result
}

// Release releases a lock
func (r *RedLock) Release(ctx context.Context, lock *Lock) error {
    if lock == nil {
        return ErrLockNotHeld
    }

    r.releaseAll(ctx, lock.resource, lock.value)
    return nil
}

func (r *RedLock) releaseAll(ctx context.Context, resource, value string) {
    // Lua script ensures we only delete if we hold the lock
    script := redis.NewScript(`
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `)

    for _, client := range r.clients {
        script.Run(ctx, client, []string{resource}, value)
    }
}

// Extend extends a lock's TTL
func (r *RedLock) Extend(ctx context.Context, lock *Lock, ttl time.Duration) (*Lock, error) {
    if lock == nil {
        return nil, ErrLockNotHeld
    }

    extended := 0
    start := time.Now()

    // Lua script to extend only if we hold the lock
    script := redis.NewScript(`
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
        else
            return 0
        end
    `)

    for _, client := range r.clients {
        result, err := script.Run(ctx, client, []string{lock.resource}, lock.value, ttl.Milliseconds()).Int()
        if err == nil && result == 1 {
            extended++
        }
    }

    elapsed := time.Since(start)
    drift := time.Duration(float64(ttl) * r.clockDrift)
    validity := ttl - elapsed - drift

    if extended >= r.quorum && validity > 0 {
        return &Lock{
            resource: lock.resource,
            value:    lock.value,
            validity: validity,
        }, nil
    }

    return nil, ErrLockNotAcquired
}
```

### etcd-based Distributed Lock

etcd's concurrency package builds distributed mutexes on top of its strongly consistent Raft-based storage, making them safer than Redis-based approaches in the face of network partitions. The implementation below uses etcd sessions with a TTL so the lock is automatically released if the process holding it crashes or loses connectivity, preventing indefinite resource starvation.

```go
// etcdlock/lock.go
package etcdlock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// EtcdLock provides distributed locking using etcd
type EtcdLock struct {
    client  *clientv3.Client
    prefix  string
    timeout time.Duration
}

// Lock represents an acquired lock
type Lock struct {
    session *concurrency.Session
    mutex   *concurrency.Mutex
    key     string
}

// NewEtcdLock creates a new etcd lock manager
func NewEtcdLock(endpoints []string, prefix string) (*EtcdLock, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        return nil, err
    }

    return &EtcdLock{
        client:  client,
        prefix:  prefix,
        timeout: 30 * time.Second,
    }, nil
}

// Acquire acquires a distributed lock
func (e *EtcdLock) Acquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error) {
    // Create session with TTL
    session, err := concurrency.NewSession(
        e.client,
        concurrency.WithTTL(int(ttl.Seconds())),
    )
    if err != nil {
        return nil, fmt.Errorf("create session: %w", err)
    }

    // Create mutex
    lockKey := fmt.Sprintf("%s/%s", e.prefix, key)
    mutex := concurrency.NewMutex(session, lockKey)

    // Acquire lock with timeout
    ctx, cancel := context.WithTimeout(ctx, e.timeout)
    defer cancel()

    if err := mutex.Lock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("acquire lock: %w", err)
    }

    return &Lock{
        session: session,
        mutex:   mutex,
        key:     lockKey,
    }, nil
}

// TryAcquire attempts to acquire a lock without blocking
func (e *EtcdLock) TryAcquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error) {
    session, err := concurrency.NewSession(
        e.client,
        concurrency.WithTTL(int(ttl.Seconds())),
    )
    if err != nil {
        return nil, fmt.Errorf("create session: %w", err)
    }

    lockKey := fmt.Sprintf("%s/%s", e.prefix, key)
    mutex := concurrency.NewMutex(session, lockKey)

    if err := mutex.TryLock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("try lock: %w", err)
    }

    return &Lock{
        session: session,
        mutex:   mutex,
        key:     lockKey,
    }, nil
}

// Release releases an acquired lock
func (e *EtcdLock) Release(ctx context.Context, lock *Lock) error {
    if lock == nil {
        return nil
    }

    if err := lock.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("unlock: %w", err)
    }

    return lock.session.Close()
}

// WithLock executes a function while holding a lock
func (e *EtcdLock) WithLock(ctx context.Context, key string, ttl time.Duration, fn func() error) error {
    lock, err := e.Acquire(ctx, key, ttl)
    if err != nil {
        return err
    }
    defer e.Release(ctx, lock)

    return fn()
}

// Close closes the etcd client
func (e *EtcdLock) Close() error {
    return e.client.Close()
}
```

### Distributed Lock with Fencing Tokens

A lock that expires while the holder is still processing a long operation creates a window where two processes believe they own the resource simultaneously. Fencing tokens solve this by pairing each lock acquisition with a monotonically increasing integer. Downstream services reject any write carrying a token lower than the highest they have seen, making stale lock holders harmless even if they never discover they have lost the lock.

```go
// fencedlock/lock.go
package fencedlock

import (
    "context"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

// FencedLock provides distributed locking with fencing tokens
// Fencing tokens prevent issues with lock expiration during long operations
type FencedLock struct {
    client *redis.Client
    prefix string
}

// Token represents a fencing token
type Token struct {
    Resource string
    Value    int64
    Holder   string
}

// Lock represents an acquired lock with a fencing token
type Lock struct {
    resource string
    holder   string
    token    int64
    validity time.Duration
}

// NewFencedLock creates a new fenced lock manager
func NewFencedLock(client *redis.Client, prefix string) *FencedLock {
    return &FencedLock{
        client: client,
        prefix: prefix,
    }
}

// Acquire acquires a lock with a monotonically increasing fencing token
func (f *FencedLock) Acquire(ctx context.Context, resource, holder string, ttl time.Duration) (*Lock, error) {
    lockKey := f.prefix + ":lock:" + resource
    tokenKey := f.prefix + ":token:" + resource

    // Lua script to atomically:
    // 1. Try to set the lock
    // 2. If successful, increment and return the fencing token
    script := redis.NewScript(`
        local lockKey = KEYS[1]
        local tokenKey = KEYS[2]
        local holder = ARGV[1]
        local ttl = tonumber(ARGV[2])

        -- Try to acquire lock
        local acquired = redis.call("SET", lockKey, holder, "NX", "PX", ttl)
        if not acquired then
            return nil
        end

        -- Increment and get fencing token
        local token = redis.call("INCR", tokenKey)
        return token
    `)

    result, err := script.Run(ctx, f.client, []string{lockKey, tokenKey}, holder, ttl.Milliseconds()).Int64()
    if err == redis.Nil {
        return nil, errors.New("lock not acquired")
    }
    if err != nil {
        return nil, err
    }

    return &Lock{
        resource: resource,
        holder:   holder,
        token:    result,
        validity: ttl,
    }, nil
}

// ValidateToken checks if a token is still valid for operations
func (f *FencedLock) ValidateToken(ctx context.Context, resource string, token int64) (bool, error) {
    tokenKey := f.prefix + ":token:" + resource

    current, err := f.client.Get(ctx, tokenKey).Int64()
    if err == redis.Nil {
        return false, nil // No token exists
    }
    if err != nil {
        return false, err
    }

    // Token is valid if it matches the current token
    return token == current, nil
}

// Release releases the lock
func (f *FencedLock) Release(ctx context.Context, lock *Lock) error {
    lockKey := f.prefix + ":lock:" + lock.resource

    // Only release if we still hold the lock
    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        end
        return 0
    `)

    _, err := script.Run(ctx, f.client, []string{lockKey}, lock.holder).Result()
    return err
}

// Token returns the fencing token
func (l *Lock) Token() int64 {
    return l.token
}
```

### Junior -> FAANG: What Distributed Locks Actually Guarantee

The biggest misconception juniors bring to distributed locking is that acquiring a lock means you have exclusive access for its entire TTL. You do not. You have exclusive access until either (a) you release it or (b) the TTL expires, whichever comes first. If your critical section takes longer than the TTL (because of a slow database query, a GC pause, or a debugging breakpoint), the lock expires, another process acquires it, and both processes now believe they are the exclusive holder.

This is not a Redis bug. It is an inherent property of lease-based locking. The correct mental model is: a distributed lock gives you a time-limited suggestion of exclusivity. For truly safe mutual exclusion, pair the lock with a fencing token and have your storage layer reject stale writers.

For interview prep, understand the three building blocks: `SET NX PX` (atomic set-if-not-exists with expiry), a random value stored as the lock value (so you can safely delete only your own lock via the Lua compare-and-delete script), and fencing tokens (monotonic integers that let storage reject stale holders). Be able to explain why checking the key's value and then deleting it in two separate Redis commands is wrong: another process can acquire the lock between your GET and your DEL.

Worked example: `GET lock -> "token-A"`, then a context switch happens, another process acquires and releases the lock, a third process acquires it with `"token-B"`. Now your DEL fires and deletes `"token-B"`. The Lua script prevents this by atomically checking and deleting in a single round-trip to Redis.

### Senior @ FAANG: Choosing the Right Locking Primitive and Governing Its Use

At the senior level, the architectural decision is which locking substrate to use, and that choice is driven by your failure mode tolerance.

Redis Redlock: acquires on a quorum of independent Redis instances. Fast (single network round-trip per instance in parallel), but Martin Kleppmann's critique is valid: even with quorum, a process can believe it holds the lock after its clock skips forward or after a Redis instance loses durability (if AOF is not enabled or if the instance restarts before it can flush). The recommendation for Redlock is: use it for best-effort coordination where the cost of occasional duplicate execution is acceptable (cache population, job scheduling) and pair it with application-level idempotency for correctness.

etcd-based locking: built on Raft, which means every lock acquisition is durably committed to a majority before being acknowledged. Significantly safer than Redis for correctness-critical workloads. The trade-off is latency (a Raft round-trip is 2-5ms minimum vs Redis's sub-millisecond), and etcd's operational complexity is higher. Use this for leader election, schema migrations, and any lock where duplicate execution would cause data corruption.

DynamoDB conditional writes: suitable for locking at the row level when you already have DynamoDB in your stack. The condition expression (`attribute_not_exists(pk) OR expires_at < :now`) gives you atomic test-and-set semantics with the durability guarantees of DynamoDB. Heartbeat renewal via `UpdateItem` with a version-number condition prevents stale renewals. The limitation is that you cannot do cross-partition locking efficiently because each partition key is an independent unit of consistency.

Governance concern: distributed locks are a global resource. If every team in your organization implements their own lock key naming conventions, you get collisions. Define a standard prefix hierarchy: `svc-name:resource-type:resource-id`. Make lock acquisition and release emit structured log events with the key, holder ID, TTL, and outcome so that lock contention is visible in your observability platform without reading code.

Staff-level signal: you can articulate the difference between fencing tokens (monotonic integers, validated at the storage layer) and lock values (random UUIDs, validated at the lock layer). Fencing tokens are the correct defense against GC pauses and clock skew because the storage layer enforces the invariant even if the lock holder has no idea its TTL expired.

---
