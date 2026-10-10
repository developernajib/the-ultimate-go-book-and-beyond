## Interview Questions

### Question 1: How would you implement leader election in a distributed system?

**What FAANG expects:** Name the three practical approaches (consensus via Raft/etcd, lease-based with fencing tokens, external coordinator like Kubernetes' `coordination.k8s.io/Lease`), and the one invariant that matters: the storage layer must reject stale fencing tokens, otherwise a zombie leader corrupts data. Bonus for citing Kleppmann's "How to do distributed locking" and for knowing `go.etcd.io/etcd/client/v3/concurrency` Election API.

**Answer:**

Leader election is a consensus problem where multiple nodes must agree on a single leader. The most reliable approaches use:

1. **Raft Consensus**: Provides strong consistency guarantees
2. **Lease-based**: Simple but requires careful clock handling
3. **External coordination**: etcd, ZooKeeper, Consul

```go
// Lease-based leader election with fencing tokens
type LeaderElection struct {
    client        *redis.Client
    nodeID        string
    leaseKey      string
    leaseDuration time.Duration

    // State
    isLeader     atomic.Bool
    fencingToken atomic.Int64
    stopCh       chan struct{}
}

func NewLeaderElection(client *redis.Client, nodeID, leaseKey string) *LeaderElection {
    return &LeaderElection{
        client:        client,
        nodeID:        nodeID,
        leaseKey:      leaseKey,
        leaseDuration: 15 * time.Second,
        stopCh:        make(chan struct{}),
    }
}

func (le *LeaderElection) Start(ctx context.Context) {
    go le.electionLoop(ctx)
}

func (le *LeaderElection) electionLoop(ctx context.Context) {
    ticker := time.NewTicker(le.leaseDuration / 3) // Renew at 1/3 intervals
    defer ticker.Stop()

    // Contend immediately, waiting a full tick would leave the cluster
    // leaderless for leaseDuration/3 after startup.
    le.tryBecomeLeader(ctx)

    for {
        select {
        case <-ctx.Done():
            le.resign()
            return
        case <-le.stopCh:
            le.resign()
            return
        case <-ticker.C:
            le.tryBecomeLeader(ctx)
        }
    }
}

func (le *LeaderElection) tryBecomeLeader(ctx context.Context) {
    // Lua script for atomic leader election with fencing token
    script := redis.NewScript(`
        local current = redis.call('GET', KEYS[1])
        local nodeID = ARGV[1]
        local ttl = tonumber(ARGV[2])

        if current == false or current == nodeID then
            -- No leader or we're renewing our lease
            local token = redis.call('INCR', KEYS[2])
            redis.call('SET', KEYS[1], nodeID, 'PX', ttl)
            return token
        end

        return -1  -- Someone else is leader
    `)

    result, err := script.Run(ctx, le.client,
        []string{le.leaseKey, le.leaseKey + ":token"},
        le.nodeID,
        le.leaseDuration.Milliseconds(),
    ).Int64()

    if err != nil {
        le.isLeader.Store(false)
        return
    }

    if result > 0 {
        le.isLeader.Store(true)
        le.fencingToken.Store(result)
    } else {
        le.isLeader.Store(false)
    }
}

func (le *LeaderElection) resign() {
    if le.isLeader.Load() {
        // Only delete if we're the leader
        script := redis.NewScript(`
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
        `)
        script.Run(context.Background(), le.client, []string{le.leaseKey}, le.nodeID)
        le.isLeader.Store(false)
    }
}

// IsLeader checks if this node is the current leader
func (le *LeaderElection) IsLeader() bool {
    return le.isLeader.Load()
}

// GetFencingToken returns the current fencing token
// Use this token when performing leader-only operations
func (le *LeaderElection) GetFencingToken() int64 {
    return le.fencingToken.Load()
}
```

**Follow-ups:**
- *What happens during a network partition?* You can have "split-brain" where multiple nodes think they are leader. The fencing token prevents data corruption: every leader-only operation includes the token, and the storage layer rejects stale ones.
- *Why is a Redis lease weaker than etcd/Raft for leader election?* Redis replicates asynchronously by default. A failover can promote a replica that has not seen the latest lease write, so two leaders can legitimately hold "current" leases simultaneously. Use Redlock with extreme caution, or prefer etcd/Consul/ZK.
- *How do you pick the lease duration?* Long enough to survive a GC pause or network blip (multi-second), short enough that a crashed leader's grip releases fast. Kubernetes defaults to 15s lease + 10s renewal deadline. Production RAFT systems typically use 500ms-2s.

### Question 2: Explain the differences between optimistic and pessimistic locking in distributed systems.

**What FAANG expects:** Optimistic = version/CAS retry (good for low contention, reads >> writes). Pessimistic = acquire lock first (good for high contention, long critical sections). Know the failure modes: optimistic can livelock under contention. pessimistic can deadlock and needs distributed lock management. Bonus for naming Postgres `SELECT FOR UPDATE` vs version-column CAS, and for calling out that Cassandra's lightweight transactions (LWT) are optimistic CAS over Paxos.

**Answer:**

**Pessimistic Locking**: Acquire exclusive lock before reading/writing. Prevents conflicts but reduces concurrency.

**Optimistic Locking**: Read with version, write only if version matches. Higher concurrency but requires conflict resolution.

```go
// Pessimistic locking - acquire lock before any operation
type PessimisticStore struct {
    redis *redis.Client
    db    *sql.DB
}

func (s *PessimisticStore) UpdateWithPessimisticLock(ctx context.Context, key string, update func(current int) int) error {
    // 1. Acquire distributed lock
    lock, err := s.acquireLock(ctx, "lock:"+key, 30*time.Second)
    if err != nil {
        return fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer lock.Release()

    // 2. Read current value (safe - we have exclusive access)
    var current int
    err = s.db.QueryRowContext(ctx, "SELECT value FROM data WHERE key = $1", key).Scan(&current)
    if err != nil {
        return err
    }

    // 3. Compute new value
    newValue := update(current)

    // 4. Write new value (safe - we have exclusive access)
    _, err = s.db.ExecContext(ctx, "UPDATE data SET value = $1 WHERE key = $2", newValue, key)
    return err
}

// Optimistic locking - use versioning for conflict detection
type OptimisticStore struct {
    db *sql.DB
}

func (s *OptimisticStore) UpdateWithOptimisticLock(ctx context.Context, key string, update func(current int) int) error {
    maxRetries := 3

    for attempt := 0; attempt < maxRetries; attempt++ {
        // 1. Read current value WITH version
        var current int
        var version int64
        err := s.db.QueryRowContext(ctx,
            "SELECT value, version FROM data WHERE key = $1", key,
        ).Scan(&current, &version)
        if err != nil {
            return err
        }

        // 2. Compute new value
        newValue := update(current)

        // 3. Write with version check (atomic compare-and-swap)
        result, err := s.db.ExecContext(ctx,
            "UPDATE data SET value = $1, version = $2 WHERE key = $3 AND version = $4",
            newValue, version+1, key, version,
        )
        if err != nil {
            return err
        }

        rowsAffected, _ := result.RowsAffected()
        if rowsAffected == 1 {
            return nil // Success!
        }

        // Version mismatch - someone else updated, retry
        // Add exponential backoff
        time.Sleep(time.Duration(attempt*10) * time.Millisecond)
    }

    return fmt.Errorf("failed to update after %d retries (too much contention)", maxRetries)
}
```

**When to use each:**
- **Pessimistic**: High contention, long operations, can't afford retry logic
- **Optimistic**: Low contention, short operations, reads >> writes

**Follow-ups:**
- *How do you prevent livelock under high contention with optimistic locking?* Bounded retries plus jittered backoff. If you retry more than ~5 times, the workload is wrong for optimistic. switch to pessimistic or partition the contended resource.
- *What is the right primitive for Postgres specifically?* `SELECT FOR UPDATE` (pessimistic, row-level), or a `version` column + conditional UPDATE (optimistic). For a single row with high contention, `FOR UPDATE SKIP LOCKED` shines for queue-like workloads.
- *Does MVCC eliminate the need for either?* No. MVCC prevents readers from blocking writers but does not prevent write-write conflicts. You still need one of these schemes.

### Question 3: How would you design a distributed rate limiter for an API gateway serving millions of requests per second?

**What FAANG expects:** Hybrid local + distributed: per-instance token bucket for hot path, periodic sync to a shared store (Redis, DynamoDB) for global accuracy. Trade-off: local-first means occasional over-allow during sync intervals, which is acceptable because rate limiters enforce SLOs, not strict caps. Bonus for Google SRE's retry-budget framing and Envoy's distributed rate-limit filter pattern (dedicated rate-limit service).

**Answer:**

A distributed rate limiter needs to balance accuracy, performance, and availability. The key trade-offs are:

1. **Exact vs Approximate**: Exact counting requires coordination, and approximate is faster
2. **Local vs Global**: Local is fast but inaccurate, and global is accurate but slow
3. **Synchronous vs Asynchronous**: Sync blocks requests, and async might over-allow

```go
// Hybrid rate limiter: local token bucket + periodic sync with Redis
type HybridRateLimiter struct {
    redis      *redis.Client
    keyPrefix  string

    // Local state per client
    localBuckets sync.Map

    // Global config
    ratePerSecond int64
    burstSize     int64
    syncInterval  time.Duration
}

type localBucket struct {
    mu           sync.Mutex
    tokens       float64
    lastUpdate   time.Time
    lastSync     time.Time
    pendingTakes int64
}

func NewHybridRateLimiter(redis *redis.Client, rate, burst int64) *HybridRateLimiter {
    rl := &HybridRateLimiter{
        redis:         redis,
        keyPrefix:     "ratelimit:",
        ratePerSecond: rate,
        burstSize:     burst,
        syncInterval:  100 * time.Millisecond, // Sync every 100ms
    }

    // Start background sync
    go rl.syncLoop()

    return rl
}

func (rl *HybridRateLimiter) Allow(ctx context.Context, clientID string) (bool, error) {
    bucket := rl.getOrCreateBucket(clientID)

    bucket.mu.Lock()
    defer bucket.mu.Unlock()

    // Refill tokens based on elapsed time
    now := time.Now()
    elapsed := now.Sub(bucket.lastUpdate).Seconds()
    bucket.tokens = min(float64(rl.burstSize), bucket.tokens+elapsed*float64(rl.ratePerSecond))
    bucket.lastUpdate = now

    // Try to take a token
    if bucket.tokens >= 1 {
        bucket.tokens--
        bucket.pendingTakes++
        return true, nil
    }

    return false, nil
}

func (rl *HybridRateLimiter) getOrCreateBucket(clientID string) *localBucket {
    if bucket, ok := rl.localBuckets.Load(clientID); ok {
        return bucket.(*localBucket)
    }

    bucket := &localBucket{
        tokens:     float64(rl.burstSize),
        lastUpdate: time.Now(),
        lastSync:   time.Now(),
    }
    actual, _ := rl.localBuckets.LoadOrStore(clientID, bucket)
    return actual.(*localBucket)
}

func (rl *HybridRateLimiter) syncLoop() {
    ticker := time.NewTicker(rl.syncInterval)
    defer ticker.Stop()

    for range ticker.C {
        rl.syncAll()
    }
}

func (rl *HybridRateLimiter) syncAll() {
    rl.localBuckets.Range(func(key, value any) bool {
        clientID := key.(string)
        bucket := value.(*localBucket)

        bucket.mu.Lock()
        pendingTakes := bucket.pendingTakes
        bucket.pendingTakes = 0
        bucket.mu.Unlock()

        if pendingTakes > 0 {
            // Sync with Redis using Lua for atomicity
            script := redis.NewScript(`
                local key = KEYS[1]
                local takes = tonumber(ARGV[1])
                local rate = tonumber(ARGV[2])
                local burst = tonumber(ARGV[3])
                local now = tonumber(ARGV[4])

                local data = redis.call('HMGET', key, 'tokens', 'last_update')
                local tokens = tonumber(data[1]) or burst
                local lastUpdate = tonumber(data[2]) or now

                -- Refill tokens
                local elapsed = now - lastUpdate
                tokens = math.min(burst, tokens + elapsed * rate)

                -- Deduct takes
                tokens = math.max(0, tokens - takes)

                -- Store updated state
                redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
                redis.call('EXPIRE', key, 3600)

                return tokens
            `)

            ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
            newTokens, err := script.Run(ctx, rl.redis,
                []string{rl.keyPrefix + clientID},
                pendingTakes,
                rl.ratePerSecond,
                rl.burstSize,
                time.Now().Unix(),
            ).Float64()
            cancel()

            if err == nil {
                // Update local bucket with global state
                bucket.mu.Lock()
                bucket.tokens = newTokens
                bucket.lastSync = time.Now()
                bucket.mu.Unlock()
            }
        }

        return true
    })
}

// Note: Uses builtin min() available since Go 1.21
```

**Why this design works at scale:**
1. **Local first**: 99% of requests served from local memory (microseconds)
2. **Eventual consistency**: Periodic sync ensures global accuracy within sync interval
3. **Graceful degradation**: If Redis is down, local rate limiting continues
4. **No hot keys**: Each client has separate Redis key

**Follow-ups:**
- *How do you handle a hot tenant that dominates one Redis shard?* Pre-shard the rate-limit key space by hashing `tenant_id % shard_count`. For extreme outliers (one whale tenant), carve out a dedicated limiter instance.
- *Fail-open or fail-closed on the distributed store?* Fail-open with a conservative local bucket. A rate limiter that brings down the fleet because Redis blipped is a worse outage than the one it was preventing.
- *Where does this live in practice, in-process, sidecar, or dedicated service?* Envoy's external rate-limit service is the canonical design: one rate-limit service behind the data plane. Keeps rate-limit logic out of every app and centralizes quota management.

### Junior -> FAANG: Preparing for Distributed Systems Interview Questions

FAANG interviews on distributed systems follow a predictable structure: a scenario question ("design a distributed rate limiter"), a follow-up probing your understanding of failure modes ("what happens if Redis goes down?"), and a second follow-up probing your understanding of trade-offs ("how does this change if you need exact enforcement vs approximate?").

The three questions in this section cover the most commonly asked patterns: leader election, locking primitives, and rate limiting. For each, practice giving a 90-second verbal answer that covers the problem statement, one or two concrete approaches with trade-offs, and the key failure mode. Then practice the follow-up answers.

A common mistake is jumping to implementation details before establishing the problem. "I would use Redis `SET NX`" is not an answer to "how does leader election work." Start with the requirement (a single node must be authoritative at any time), then the constraints (what guarantees do you need: safety, liveness, latency), then the approaches (lease-based vs Raft-based), then the trade-offs.

For the leader election question specifically, be able to draw the lease renewal timeline: a node acquires a lease for T seconds, renews it at T/3 intervals, and the lease expires if the node fails to renew (allowing another node to take over) after T seconds. Know that T is a trade-off between availability (smaller T means faster failover) and safety (larger T gives more buffer for network delays during renewal).

### Senior @ FAANG: Bar-Raiser Level Answers to These Three Questions

At the bar-raiser level, the interviewers are not checking whether you know the algorithms. They assume you do. They are checking whether you understand the operational and organizational implications.

For leader election: the bar-raiser question is "how do you test that your leader election is correct?" Unit tests cannot test distributed scenarios. The answer requires talking about deterministic simulation testing (using a fake clock and network), chaos engineering (killing the leader pod and verifying that election completes within the target window), and monitoring (a metric that tracks the time between leader loss and new leader established, with an alert if it exceeds 30 seconds in production). If you cannot describe how you validate correctness, you do not own the feature.

For optimistic vs pessimistic locking: the bar-raiser question is "you have a table with 10,000 writes per second to the same row. Which approach works?" Neither, in their naive forms. Optimistic locking at 10k wps to the same row will livelock: almost every write will fail the version check and retry. Pessimistic locking will serialize all 10k writes, creating a queue. The correct answer is "partition the problem": split the single hot row into N independent rows (sharded counters) and aggregate lazily. This is the CRDTs (conflict-free replicated data types) insight applied to a relational context.

For distributed rate limiting: the bar-raiser question is "your rate limit service is down. What happens?" Fail-open means all traffic passes, which defeats the purpose of rate limiting. Fail-closed means all traffic is rejected, which is worse than the service being slow. The correct answer is fail-open with a local conservative limit: each instance falls back to its local token bucket with a limit that is a conservative fraction of the global limit divided by the fleet size. This requires knowing your fleet size, which requires the instances to be aware of their peer count (from a service discovery system). The full answer demonstrates understanding of graceful degradation as a first-class system property.

---
