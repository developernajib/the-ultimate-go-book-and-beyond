## Interview Questions

### Question 1: How would you design a cache to handle hot keys?

**What FAANG expects:** Three mitigation layers: local in-process cache to absorb reads before they hit Redis, key sharding (`key:N` with random suffix) to spread across Redis nodes, and read replicas for fanout. Bonus for naming Redis-specific tools: `redis-cli --hotkeys` for detection, `CLIENT TRACKING` for server-assisted invalidation (Redis 6+), and the observation that one hot key can saturate a single Redis node's CPU (~1M ops/sec ceiling).

**Answer:**

Hot keys, cache entries receiving disproportionately high request rates, create bottlenecks because a single cache node becomes the exclusive handler for all reads and writes of that key, potentially exceeding its memory bandwidth or network capacity. The standard mitigations are local in-process caching (absorbs reads at the application layer before they reach Redis), key sharding by appending a random suffix (spreads reads across multiple cache entries), and read replicas (horizontal scaling for read-heavy hot keys). `HotKeyCache` pairs a `HotKeyDetector` (which counts accesses per key in a sliding window using `sync.Map` and `atomic.Int64`) with a local `LocalCache` fallback, so once a key crosses the detection threshold it is served entirely from process memory until the access rate drops.

```go
// Hot key handling with local caching and replication
type HotKeyCache struct {
    distributed *redis.ClusterClient
    local       *LocalCache
    hotKeys     *HotKeyDetector
    replicator  *HotKeyReplicator
}

type HotKeyDetector struct {
    counts    sync.Map
    threshold int64
    window    time.Duration
}

func (d *HotKeyDetector) RecordAccess(key string) bool {
    now := time.Now()
    windowKey := fmt.Sprintf("%s:%d", key, now.Unix()/int64(d.window.Seconds()))

    val, _ := d.counts.LoadOrStore(windowKey, &atomic.Int64{})
    count := val.(*atomic.Int64).Add(1)

    return count > d.threshold
}

func (c *HotKeyCache) Get(ctx context.Context, key string) ([]byte, error) {
    // Check local cache for hot keys
    if value, ok := c.local.Get(key); ok {
        return value, nil
    }

    // Get from distributed cache
    value, err := c.distributed.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    // Detect and handle hot keys
    if c.hotKeys.RecordAccess(key) {
        // Promote to local cache
        c.local.Set(key, value, time.Minute)

        // Replicate to multiple Redis nodes for load distribution
        go c.replicator.Replicate(key, value)
    }

    return value, nil
}

// HotKeyReplicator creates read replicas for hot keys
type HotKeyReplicator struct {
    client     *redis.ClusterClient
    replicaCount int
}

func (r *HotKeyReplicator) Replicate(key string, value []byte) {
    // Create multiple copies with different suffixes
    for i := 0; i < r.replicaCount; i++ {
        replicaKey := fmt.Sprintf("%s:replica:%d", key, i)
        r.client.Set(context.Background(), replicaKey, value, time.Hour)
    }
}

func (r *HotKeyReplicator) GetRandom(ctx context.Context, key string) ([]byte, error) {
    // Randomly select a replica to distribute load
    replicaIdx := rand.IntN(r.replicaCount + 1)

    if replicaIdx == 0 {
        return r.client.Get(ctx, key).Bytes()
    }

    replicaKey := fmt.Sprintf("%s:replica:%d", key, replicaIdx-1)
    return r.client.Get(ctx, replicaKey).Bytes()
}
```

**Follow-ups:**
- *What detection threshold do you use?* Typically > 1000 req/sec per key, or > 10x the p99 access rate across all keys. Static thresholds miss slow leaks. Rate-based detection catches trending-hot keys early.
- *What is the dual of a hot key, and why do you care?* Big key: one value that is megabytes. A big key causes network-bandwidth hotspots and slow serialization. Audit with `redis-cli --bigkeys` and break up into chunks (hash with sub-fields).
- *How do you avoid the thundering-herd on the local cache when a hot key expires?* `singleflight` to dedupe concurrent fetches, and jittered TTLs so 10k clients don't refetch on the same millisecond.

### Question 2: How do you ensure cache consistency in a distributed system?

**What FAANG expects:** The cache invalidation hierarchy: write-through (synchronous), write-behind (async with risk of loss), write-around (skip cache on write), cache-aside (lazy population, invalidate on write). Versioning with optimistic CAS for concurrent writes. Bonus for explaining the classic read-after-write race: update DB → invalidate cache → another reader repopulates cache from a stale replica. Solution: version tokens or retry after replication-lag window.

**Answer:**

```go
// Cache consistency with versioning and conditional updates
type ConsistentCache struct {
    cache    *redis.ClusterClient
    database *sql.DB
    pubsub   *redis.PubSub
}

type VersionedValue struct {
    Data    []byte `json:"data"`
    Version int64  `json:"version"`
}

// Set with optimistic locking
func (c *ConsistentCache) SetIfVersion(ctx context.Context, key string, value []byte, expectedVersion int64) error {
    script := redis.NewScript(`
        local current = redis.call('GET', KEYS[1])
        if current then
            local decoded = cjson.decode(current)
            if decoded.version ~= tonumber(ARGV[1]) then
                return 0  -- Version mismatch
            end
        end
        redis.call('SET', KEYS[1], ARGV[2])
        return 1
    `)

    newValue := VersionedValue{
        Data:    value,
        Version: expectedVersion + 1,
    }
    encoded, _ := json.Marshal(newValue)

    result, err := script.Run(ctx, c.cache, []string{key}, expectedVersion, encoded).Int64()
    if err != nil {
        return err
    }

    if result == 0 {
        return ErrVersionMismatch
    }

    // Broadcast invalidation
    c.broadcastInvalidation(ctx, key)

    return nil
}

// Read-your-writes consistency
type SessionConsistentCache struct {
    cache      *redis.ClusterClient
    writeCache sync.Map // sessionID -> map[key]value
}

func (c *SessionConsistentCache) Get(ctx context.Context, sessionID, key string) ([]byte, error) {
    // Check session's write cache first (read-your-writes)
    if writes, ok := c.writeCache.Load(sessionID); ok {
        writeMap := writes.(map[string][]byte)
        if value, exists := writeMap[key]; exists {
            return value, nil
        }
    }

    // Fall back to distributed cache
    return c.cache.Get(ctx, key).Bytes()
}

func (c *SessionConsistentCache) Set(ctx context.Context, sessionID, key string, value []byte) error {
    // Store in session's write cache. Note: the inner map is not
    // synchronized, two concurrent requests in the same session would
    // race on it. A real implementation guards each session map with
    // its own mutex or uses a nested sync.Map.
    writes, _ := c.writeCache.LoadOrStore(sessionID, make(map[string][]byte))
    writeMap := writes.(map[string][]byte)
    writeMap[key] = value

    // Async write to distributed cache
    go c.cache.Set(context.Background(), key, value, time.Hour)

    return nil
}
```

**Follow-ups:**
- *What is the "double-delete" pattern?* For cache-aside: delete cache → update DB → delete cache again after a small delay. The second delete removes any stale value that readers repopulated from a slow replica.
- *When is write-through dangerous?* When the cache write can succeed and the DB write can fail (or vice versa), leaving them out of sync. Use a transactional outbox pattern or write to the DB first and let CDC update the cache.
- *Read-your-writes across a cluster of Redis nodes?* Pin the user's requests to a single Redis shard with consistent hashing, or use a session-write cache (as in the sample) that merges until replication catches up.

### Question 3: Design a multi-tier caching architecture

**What FAANG expects:** L1 in-process (sub-µs, per-instance), L2 distributed (sub-ms, shared), L3 source of truth (ms). Know the trade-offs of each tier: L1 is stale across instances, L2 adds a network hop, L3 is expensive per miss. Bonus for mentioning Facebook McDipper/mcrouter architecture and Netflix EVCache for real-world references, and for discussing cache stampede protection (singleflight, probabilistic early expiration).

**Answer:**

```go
// Multi-tier cache: L1 (in-process) -> L2 (Redis) -> L3 (database)
type MultiTierCache struct {
    l1       *LocalCache        // In-process, fastest
    l2       *redis.ClusterClient // Distributed, shared
    l3       Database            // Source of truth
    metrics  *CacheMetrics
}

type LocalCache struct {
    data      sync.Map
    maxSize   int64
    eviction  *LRUPolicy
}

func NewMultiTierCache(redisClient *redis.ClusterClient, db Database) *MultiTierCache {
    return &MultiTierCache{
        l1:      NewLocalCache(100 * 1024 * 1024), // 100MB local
        l2:      redisClient,
        l3:      db,
        metrics: NewCacheMetrics(),
    }
}

func (c *MultiTierCache) Get(ctx context.Context, key string) ([]byte, error) {
    start := time.Now()

    // L1: In-process cache (sub-microsecond)
    if value, ok := c.l1.Get(key); ok {
        c.metrics.RecordL1Hit(time.Since(start))
        return value, nil
    }

    // L2: Redis (sub-millisecond)
    value, err := c.l2.Get(ctx, key).Bytes()
    if err == nil {
        c.metrics.RecordL2Hit(time.Since(start))
        c.l1.Set(key, value, time.Minute) // Promote to L1
        return value, nil
    }

    // L3: Database (milliseconds)
    value, err = c.l3.Get(ctx, key)
    if err != nil {
        c.metrics.RecordL3Miss(time.Since(start))
        return nil, err
    }

    c.metrics.RecordL3Hit(time.Since(start))

    // Populate caches (back-fill)
    go func() {
        bgCtx := context.Background()
        c.l2.Set(bgCtx, key, value, time.Hour)
        c.l1.Set(key, value, time.Minute)
    }()

    return value, nil
}

func (c *MultiTierCache) Set(ctx context.Context, key string, value []byte) error {
    // Write to all tiers
    c.l1.Set(key, value, time.Minute)

    if err := c.l2.Set(ctx, key, value, time.Hour).Err(); err != nil {
        return err
    }

    return c.l3.Set(ctx, key, value)
}

func (c *MultiTierCache) Invalidate(ctx context.Context, key string) error {
    // Invalidate all tiers
    c.l1.Delete(key)
    c.l2.Del(ctx, key)

    // Broadcast to other instances
    return c.broadcastInvalidation(ctx, key)
}

// CacheMetrics tracks hit rates per tier
func (m *CacheMetrics) GetStats() TierStats {
    // Convert before dividing: integer division would truncate every
    // hit rate below 100% straight to zero.
    total := float64(max(m.totalRequests.Load(), 1))
    return TierStats{
        L1HitRate: float64(m.l1Hits.Load()) / total,
        L2HitRate: float64(m.l2Hits.Load()) / total,
        L3HitRate: float64(m.l3Hits.Load()) / total,
        AvgL1Latency: m.l1LatencySum.Load() / max(m.l1Hits.Load(), 1),
        AvgL2Latency: m.l2LatencySum.Load() / max(m.l2Hits.Load(), 1),
        AvgL3Latency: m.l3LatencySum.Load() / max(m.l3Hits.Load(), 1),
    }
}
```

**Follow-ups:**
- *How do you invalidate L1 caches across instances without a broadcast storm?* Redis 6+ `CLIENT TRACKING` (server pushes invalidations to subscribed clients), or a Pub/Sub invalidation channel. Cost: a WS connection per instance, but cheaper than polling.
- *What is probabilistic early expiration?* Instead of expiring exactly at TTL, compute an "effective expiry" that nudges earlier with random probability as the key ages. Spreads refresh load across time, eliminates the post-TTL thundering herd.
- *What L1 cache library do you reach for in Go?* `maypok86/otter/v2` (adaptive W-TinyLFU, generic, best hit rate), `dgraph-io/ristretto/v2` (still popular), or `hashicorp/golang-lru/v2` for simple LRU. All three beat `sync.Map` for caching workloads.

### Junior -> FAANG: Interview Preparation Habits for Caching Questions

Caching is one of the highest-frequency topics in FAANG system design interviews. The three questions in this file cover the full range of what interviewers probe: hot key handling tests operational depth, cache consistency tests distributed systems understanding, and multi-tier design tests architecture breadth.

For hot key handling, the entry-level answer is "use Redis replicas." The mid-level answer adds local in-process caching. The strong answer explains the hot key detection mechanism (sliding window counter), the promotion threshold, and the replica key naming scheme, and mentions that you would also alert when a key crosses the hot threshold so the team can investigate why a single key is receiving extreme traffic.

For cache consistency, the entry-level answer is "invalidate on write." The mid-level answer introduces write-through and cache-aside patterns. The strong answer explains the read-after-write race (update DB, invalidate cache, reader repopulates from stale replica), names the double-delete mitigation, and discusses why write-through is dangerous when cache and DB writes can fail independently.

For multi-tier caching, practice explaining the latency and cost tradeoffs at each tier out loud: "L1 is sub-microsecond but per-instance and stale across instances. L2 is sub-millisecond, shared, and coherent across instances but costs a network hop. L3 is authoritative but costs a database query." Being able to cite `maypok86/otter/v2` or `dgraph-io/ristretto/v2` as L1 implementations signals that you keep up with the Go ecosystem.

A first-job interview preparation habit: practice explaining cache invalidation with a concrete timeline drawing. Draw two concurrent requests on a whiteboard, show where the race condition occurs, and show where each mitigation cuts the race window. Verbal explanations of race conditions are much harder to follow than visual ones.

### Senior @ FAANG: What Bar-Raisers Probe Beyond the Standard Questions

Bar-raisers at FAANG use follow-up questions to find the boundary of a candidate's knowledge. Knowing the follow-ups in this file is not enough. You must also know the follow-ups to the follow-ups.

**Hot key: beyond detection and replication**

The standard hot key answer (detect, promote to local cache, replicate to multiple Redis keys) satisfies L5 candidates. A bar-raiser then asks: "What happens when the hot key value is updated? How do you invalidate all the replicas?" The correct answer involves a fanout invalidation: write the new value to the primary key, then delete all replica keys (or write the new value to all replicas if you need read-your-writes). The invalidation fanout is itself a write amplification problem: with 10 replicas and 100K hot key updates per second, you are issuing 1M Redis commands per second just for invalidation. The L6 answer proposes replica TTLs short enough to self-expire during low-update periods, combined with active fanout only during high-update bursts, reducing the steady-state invalidation cost.

**Cache consistency: the CAP tradeoff is not binary**

Most candidates frame cache consistency as a binary choice between strong consistency (write-through) and eventual consistency (cache-aside with invalidation). A bar-raiser pushes for nuance: "In practice, write-through still has a consistency window because the cache write and DB write are not atomic. How do you close that window?" The correct answer introduces a transactional outbox or CDC-based approach where the cache is updated by observing the committed database state, not by the application code that performed the write. This is the only approach that is consistent with the database's actual committed state, because the cache update is driven by the same WAL entry that persists the write.

**Multi-tier: L1 invalidation across instances at scale**

The standard L1 invalidation answer is Redis Pub/Sub (broadcast invalidation messages to all instances). A bar-raiser asks: "What is the failure mode of Pub/Sub for cache invalidation?" The answer: Pub/Sub is at-most-once. If a subscriber is disconnected when an invalidation message is broadcast, it never receives the message and its L1 cache serves stale data indefinitely. The correct production approach is Redis 6+ Client Tracking (server-push invalidations that survive reconnect) or a version-based L1 (each L1 entry includes a version number fetched from L2, so stale entries are detected on first access rather than relying on a received invalidation).

**Staff-level: the economics of multi-tier caching**

A principal engineer question: "You are proposing a 100MB in-process L1 cache per instance across a fleet of 500 instances. That is 50GB of RAM dedicated to caching data that is already in Redis. How do you justify this cost?" The answer requires a cost model: each L2 hit costs a network round trip (typically 0.5-2ms), while each L1 hit is sub-microsecond. At 1M cache reads per second per instance, saving 1ms per read saves 1,000 CPU-seconds per instance per second. At 500 instances, the L1 cache saves roughly 500,000 CPU-seconds per second of peak traffic. The RAM cost of 100MB per instance is trivial compared to the CPU and network cost avoided. But this calculation is only valid when the L1 hit rate is high enough: if the working set exceeds 100MB, the L1 is just adding complexity without value, and the correct answer is to increase Redis capacity instead.

---
