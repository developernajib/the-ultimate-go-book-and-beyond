## Distributed Cache Pitfalls: When Cache Makes Things Worse

### Pitfall 1: Cache Avalanche When Multiple Keys Expire Together

**Incident Report**: Flash sale items were all cached with same 1-hour TTL set at 9 AM. At 10 AM, all cache entries expired simultaneously, causing 100,000 concurrent database queries that crashed the database.

```go
// WRONG: Fixed TTL for all items
func (c *Cache) Set(key string, value any) {
    c.redis.Set(ctx, key, value, 1*time.Hour)  // All expire at same time
}

// CORRECT: Jittered TTL to spread expiration
func (c *Cache) Set(key string, value any, baseTTL time.Duration) {
    // Add random jitter (±20% of base TTL)
    jitter := time.Duration(rand.Int64N(int64(baseTTL) / 5))
    if rand.IntN(2) == 0 {
        jitter = -jitter
    }
    ttl := baseTTL + jitter

    c.redis.Set(ctx, key, value, ttl)
}

type DatabaseClient interface {
    Get(ctx context.Context, key string) (string, error)
}

// Even better: Layered caching with staggered TTLs
type LayeredCache struct {
    l1Cache *LocalCache   // In-process, short TTL
    l2Cache *redis.Client // Distributed, medium TTL
    db      DatabaseClient
}

func (c *LayeredCache) Get(ctx context.Context, key string) (any, error) {
    // L1: In-process cache (very short TTL, jittered)
    if val, ok := c.l1Cache.Get(key); ok {
        return val, nil
    }

    // L2: Redis (medium TTL, jittered)
    val, err := c.l2Cache.Get(ctx, key).Result()
    if err == nil {
        // Populate L1 with shorter TTL + jitter
        l1TTL := 30*time.Second + time.Duration(rand.IntN(10))*time.Second
        c.l1Cache.Set(key, val, l1TTL)
        return val, nil
    }

    // L3: Database
    val, err = c.db.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Populate both caches with jittered TTLs
    l2TTL := 5*time.Minute + time.Duration(rand.IntN(60))*time.Second
    c.l2Cache.Set(ctx, key, val, l2TTL)

    l1TTL := 30*time.Second + time.Duration(rand.IntN(10))*time.Second
    c.l1Cache.Set(key, val, l1TTL)

    return val, nil
}
```

### Pitfall 2: Cache Inconsistency from Race Conditions

**Incident Report**: User updated their profile, but old data kept appearing. Investigation revealed a race condition where stale data was being cached after the update.

```go
// WRONG: Update then invalidate (race condition)
func (s *UserService) UpdateProfile(ctx context.Context, userID string, profile *Profile) error {
    // 1. Update database
    err := s.db.UpdateProfile(ctx, userID, profile)
    if err != nil {
        return err
    }

    // 2. Invalidate cache
    s.cache.Delete(ctx, "user:"+userID)

    return nil
    // Problem: Between steps 1 and 2, another request might:
    // - Read old data from DB (transaction isolation)
    // - Cache the old data
    // Now cache has stale data!
}

// CORRECT: Cache invalidation with write-through
func (s *UserService) UpdateProfile(ctx context.Context, userID string, profile *Profile) error {
    cacheKey := "user:" + userID

    // 1. Delete cache FIRST (or set a tombstone)
    s.cache.Delete(ctx, cacheKey)

    // 2. Update database
    err := s.db.UpdateProfile(ctx, userID, profile)
    if err != nil {
        return err
    }

    // 3. Update cache with new value
    s.cache.Set(ctx, cacheKey, profile, 5*time.Minute)

    return nil
}

// EVEN BETTER: Distributed lock to prevent concurrent updates
func (s *UserService) UpdateProfileSafe(ctx context.Context, userID string, profile *Profile) error {
    cacheKey := "user:" + userID
    lockKey := "lock:" + cacheKey

    // Acquire distributed lock
    lock, err := s.cache.Lock(ctx, lockKey, 10*time.Second)
    if err != nil {
        return fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer lock.Release(ctx)

    // Delete cache
    s.cache.Delete(ctx, cacheKey)

    // Update database
    err = s.db.UpdateProfile(ctx, userID, profile)
    if err != nil {
        return err
    }

    // Update cache with version
    versioned := &VersionedProfile{
        Profile:   profile,
        Version:   time.Now().UnixNano(),
        UpdatedAt: time.Now(),
    }
    s.cache.Set(ctx, cacheKey, versioned, 5*time.Minute)

    return nil
}

// Alternative: Cache-aside with version check
func (s *UserService) GetProfile(ctx context.Context, userID string) (*Profile, error) {
    cacheKey := "user:" + userID

    // Try cache
    cached, err := s.cache.Get(ctx, cacheKey)
    if err == nil {
        versioned := cached.(*VersionedProfile)

        // Check if cache is recent enough (avoid serving very stale data)
        if time.Since(versioned.UpdatedAt) < 1*time.Minute {
            return versioned.Profile, nil
        }

        // Old cache - refresh in background, return stale data
        go s.refreshCache(context.Background(), userID)
        return versioned.Profile, nil
    }

    // Cache miss - load from DB
    profile, err := s.db.GetProfile(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Cache with version
    versioned := &VersionedProfile{
        Profile:   profile,
        Version:   time.Now().UnixNano(),
        UpdatedAt: time.Now(),
    }
    s.cache.Set(ctx, cacheKey, versioned, 5*time.Minute)

    return profile, nil
}
```

### Pitfall 3: Hot Key Problem Overwhelming Single Cache Node

**Incident Report**: Celebrity product launch caused 50,000 QPS to a single cache key. The cache node handling that key became overloaded and crashed, causing cascading failures.

```go
// WRONG: Single key for hot data
func (c *ProductCache) Get(ctx context.Context, productID string) (*Product, error) {
    // All requests for hot product go to same key (same cache node)
    key := "product:" + productID
    return c.redis.Get(ctx, key).Result()
}

// CORRECT: Replicate hot keys across multiple slots
type HotKeyCache struct {
    redis    *redis.ClusterClient
    replicas int  // Number of replicas for hot keys
    hotKeys  *HotKeyDetector
}

func (c *HotKeyCache) Get(ctx context.Context, key string) (string, error) {
    if c.hotKeys.IsHot(key) {
        // Spread load across replicas
        replica := rand.IntN(c.replicas)
        replicaKey := fmt.Sprintf("%s:replica:%d", key, replica)

        val, err := c.redis.Get(ctx, replicaKey).Result()
        if err == nil {
            return val, nil
        }

        // Replica miss, try primary
        val, err = c.redis.Get(ctx, key).Result()
        if err == nil {
            // Populate replica
            go c.redis.Set(context.Background(), replicaKey, val, 30*time.Second)
        }
        return val, err
    }

    // Normal key
    return c.redis.Get(ctx, key).Result()
}

func (c *HotKeyCache) Set(ctx context.Context, key string, value string, ttl time.Duration) error {
    // Set primary
    err := c.redis.Set(ctx, key, value, ttl).Err()
    if err != nil {
        return err
    }

    if c.hotKeys.IsHot(key) {
        // Replicate to all replica keys
        for i := 0; i < c.replicas; i++ {
            replicaKey := fmt.Sprintf("%s:replica:%d", key, i)
            c.redis.Set(ctx, replicaKey, value, ttl-5*time.Second)  // Slightly shorter TTL
        }
    }

    return nil
}

// Hot key detection
type HotKeyDetector struct {
    counts    map[string]*atomic.Int64
    threshold int64
    window    time.Duration
    mu        sync.RWMutex
}

func (d *HotKeyDetector) Record(key string) {
    d.mu.RLock()
    counter, exists := d.counts[key]
    d.mu.RUnlock()

    if !exists {
        d.mu.Lock()
        // Re-check under the write lock: two goroutines can both miss
        // under the read lock, and blindly storing here would replace
        // the first counter and split the count across two objects.
        if counter, exists = d.counts[key]; !exists {
            counter = &atomic.Int64{}
            d.counts[key] = counter

            // Schedule cleanup
            time.AfterFunc(d.window, func() {
                d.mu.Lock()
                delete(d.counts, key)
                d.mu.Unlock()
            })
        }
        d.mu.Unlock()
    }

    counter.Add(1)
}

func (d *HotKeyDetector) IsHot(key string) bool {
    d.mu.RLock()
    defer d.mu.RUnlock()

    if counter, exists := d.counts[key]; exists {
        return counter.Load() > d.threshold
    }
    return false
}
```

### Pitfall 4: Memory Exhaustion from Unbounded Cache Growth

**Incident Report**: Cache server crashed with OOM after 48 hours of operation. Investigation revealed cache had no size limit, and long-tail items were never evicted.

```go
// WRONG: No memory limits
type UnboundedCache struct {
    data map[string]any
    mu   sync.RWMutex
}

func (c *UnboundedCache) Set(key string, value any) {
    c.mu.Lock()
    c.data[key] = value  // Grows forever
    c.mu.Unlock()
}

// CORRECT: Bounded cache with eviction
type BoundedCache struct {
    data      map[string]*cacheEntry
    evictList *list.List
    maxSize   int
    currSize  int
    mu        sync.RWMutex
    metrics   *CacheMetrics
}

type cacheEntry struct {
    key     string
    value   any
    size    int
    element *list.Element
    ttl     time.Time
}

func (c *BoundedCache) Set(key string, value any) bool {
    size := c.estimateSize(value)

    c.mu.Lock()
    defer c.mu.Unlock()

    // Check if update
    if existing, ok := c.data[key]; ok {
        c.currSize -= existing.size
        c.evictList.MoveToFront(existing.element)
        existing.value = value
        existing.size = size
        c.currSize += size
        return true
    }

    // Evict until we have space
    for c.currSize+size > c.maxSize && c.evictList.Len() > 0 {
        c.evictOldest()
    }

    // Still no space? Reject
    if c.currSize+size > c.maxSize {
        c.metrics.Rejected.Inc()
        return false
    }

    // Add new entry
    entry := &cacheEntry{
        key:   key,
        value: value,
        size:  size,
        ttl:   time.Now().Add(5 * time.Minute),
    }
    entry.element = c.evictList.PushFront(entry)
    c.data[key] = entry
    c.currSize += size

    return true
}

func (c *BoundedCache) evictOldest() {
    elem := c.evictList.Back()
    if elem == nil {
        return
    }

    entry := elem.Value.(*cacheEntry)
    c.evictList.Remove(elem)
    delete(c.data, entry.key)
    c.currSize -= entry.size
    c.metrics.Evictions.Inc()
}

func (c *BoundedCache) estimateSize(value any) int {
    // Estimate memory size of value
    switch v := value.(type) {
    case string:
        return len(v)
    case []byte:
        return len(v)
    default:
        // JSON serialize and measure
        data, _ := json.Marshal(v)
        return len(data) + 50  // overhead estimate
    }
}

// Periodic cleanup of expired entries
func (c *BoundedCache) StartCleanup(interval time.Duration) {
    ticker := time.NewTicker(interval)
    go func() {
        for range ticker.C {
            c.cleanupExpired()
        }
    }()
}

func (c *BoundedCache) cleanupExpired() {
    now := time.Now()
    c.mu.Lock()
    defer c.mu.Unlock()

    for key, entry := range c.data {
        if entry.ttl.Before(now) {
            c.evictList.Remove(entry.element)
            delete(c.data, key)
            c.currSize -= entry.size
            c.metrics.Expired.Inc()
        }
    }
}
```

### Quick Reference: Distributed Cache Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Cache avalanche | Database overload at expiry | Jittered TTL, layered caching |
| Race condition | Stale data after update | Delete-first, distributed locks |
| Hot key | Single node overload | Key replication, local caching |
| Memory exhaustion | OOM crashes | Size limits, eviction policies |

### Junior -> FAANG: Why Incident Reports Are the Best Learning Material

The four pitfalls in this file are presented as incident reports because real production failures teach caching lessons better than abstract principles. FAANG interviewers frequently describe a failure scenario and ask "what went wrong and how would you fix it?" Recognizing the pattern from an incident framing is a skill that requires practice.

Cache avalanche (all keys expiring simultaneously) is the most common production cache failure mode because it emerges from the most natural implementation: set the same TTL on all keys of the same type. The fix (jittered TTL) is simple but requires you to recognize the failure mode first. Practice this: when you write any cache `Set` call, ask "could many keys expire at the same time?" If yes, add jitter.

Cache inconsistency from race conditions trips up developers who understand write-through and cache-aside conceptually but have not thought through the concurrent execution order. Draw the race condition timeline: request A reads the database and is about to cache the result, request B updates the database and deletes the cache, request A caches the stale result. Now the cache has a value that the database has already invalidated. The double-delete pattern and distributed locks both close this race window. Practice explaining which one you would choose and why (locks are stronger but add latency, double-delete is cheaper but has a short race window).

Hot key detection with `sync.Map` and `atomic.Int64` is the correct Go implementation. A common first-job mistake is using a `sync.Mutex`-protected regular map for the counts, which creates a global lock contention point on every cache operation. `sync.Map` is specifically designed for the read-heavy, write-occasionally pattern of hot key tracking.

### Senior @ FAANG: Failure Modes as Design Requirements

Senior engineers do not treat pitfalls as mistakes to avoid. They treat them as invariants to enforce, and they design systems that make violation of the invariant detectable or impossible rather than just documenting that you should not do the wrong thing.

**ADR: Making cache avalanche architecturally impossible instead of just documented**

The jitter pattern is a convention that developers must remember to apply. A senior engineer proposes making the correct behavior the only behavior by centralizing TTL assignment. The `Set` method on a cache client library should accept a `TTLPolicy` enum (UserProfile, ProductCatalog, Inventory, etc.) rather than a raw duration, and the library applies appropriate jitter internally. Teams cannot accidentally set a fixed TTL for a high-volume key because the API does not expose raw durations for named data types. This is an interface design decision that makes the pit of success deeper than the pit of failure.

**The race condition surface area grows with replication lag**

The cache inconsistency race condition described in pitfall 2 has a window measured in the time between the database write commit and the cache invalidation. In a single-region setup with a synchronous primary database, this window is milliseconds. In a multi-region setup with asynchronous replication, a read in the secondary region can fetch data from a replica that is seconds behind the primary, and cache that stale value. The double-delete pattern's 500ms delay is calibrated for single-region replication lag. For multi-region, you need either a global distributed lock (expensive), a version-based read that refuses to cache values older than a threshold, or a region-local cache that is invalidated by a cross-region invalidation topic. A staff engineer explicitly documents the race window SLO in the cache platform's architecture document.

**Hot key economics: when replication makes things worse**

The hot key replication pattern (creating `key:replica:0` through `key:replica:N`) increases write cost by a factor of N+1 on every update. For a key that receives 100K reads per second but 50K updates per second, replication provides minimal read benefit (reads are spread across N+1 copies) while multiplying the write cost by N+1. The correct analysis is the read/write ratio: replication is beneficial only when reads significantly outnumber writes. For write-heavy hot keys, the correct approach is to move the data to an in-process structure with async flush, not to replicate across Redis nodes.

**Memory exhaustion governance: the multi-tenant problem**

The bounded cache implementation in pitfall 4 correctly limits total memory. In a multi-tenant shared Redis cluster, the problem is that one tenant's unbounded key growth evicts another tenant's entries. Redis 6+ `OBJECT FREQ` and eviction policy `allkeys-lfu` approximate fair eviction, but there is no tenant-level memory quota in open-source Redis. The correct platform answer is Redis Cluster with per-service shard assignment (each service gets a dedicated set of shards with independent eviction), or a quota enforcement proxy that counts bytes per namespace and rejects writes above quota. A principal engineer proposes the sharding approach and writes the ADR explaining why the proxy approach is cheaper initially but becomes a bottleneck at high throughput.

---
