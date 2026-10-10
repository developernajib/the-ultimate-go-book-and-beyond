## 55.5 Caching Layer (Pillar 2: Infrastructure)

The difference between the legacy system's 91% cache hit rate and the rewrite's 23% was the single largest contributor to the performance gap. This section implements a Redis-backed cache layer that wraps every operation with Prometheus latency and hit/miss counters, so you can track your actual hit rate in production rather than guessing. The `GetOrSet` method implements the cache-aside pattern: try the cache first, fall back to the loader function on a miss, and populate the cache with the result.

```go
// backend/internal/cache/redis.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
    "dashboard/internal/observability"
)

type RedisCache struct {
    client  *redis.Client
    prefix  string
    ttl     time.Duration
    metrics *observability.DashboardMetrics
}

func NewRedisCache(url, prefix string, ttl time.Duration, metrics *observability.DashboardMetrics) (*RedisCache, error) {
    opts, err := redis.ParseURL(url)
    if err != nil {
        return nil, fmt.Errorf("parsing redis URL: %w", err)
    }

    client := redis.NewClient(opts)

    // Verify connection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("connecting to redis: %w", err)
    }

    return &RedisCache{
        client:  client,
        prefix:  prefix,
        ttl:     ttl,
        metrics: metrics,
    }, nil
}

func (c *RedisCache) key(k string) string {
    return fmt.Sprintf("%s:%s", c.prefix, k)
}

// Get retrieves a value from cache
func (c *RedisCache) Get(ctx context.Context, key string, dest any) error {
    start := time.Now()
    defer func() {
        c.metrics.CacheLatency.WithLabelValues("get", "redis").Observe(time.Since(start).Seconds())
    }()

    data, err := c.client.Get(ctx, c.key(key)).Bytes()
    if err == redis.Nil {
        c.metrics.CacheMisses.WithLabelValues("redis", keyPattern(key)).Inc()
        return ErrCacheMiss
    }
    if err != nil {
        return fmt.Errorf("redis get: %w", err)
    }

    c.metrics.CacheHits.WithLabelValues("redis", keyPattern(key)).Inc()

    if err := json.Unmarshal(data, dest); err != nil {
        return fmt.Errorf("unmarshaling cached data: %w", err)
    }

    return nil
}

// Set stores a value in cache
func (c *RedisCache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    start := time.Now()
    defer func() {
        c.metrics.CacheLatency.WithLabelValues("set", "redis").Observe(time.Since(start).Seconds())
    }()

    if ttl == 0 {
        ttl = c.ttl
    }

    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling value: %w", err)
    }

    if err := c.client.Set(ctx, c.key(key), data, ttl).Err(); err != nil {
        return fmt.Errorf("redis set: %w", err)
    }

    return nil
}

// Delete removes a value from cache
func (c *RedisCache) Delete(ctx context.Context, key string) error {
    return c.client.Del(ctx, c.key(key)).Err()
}

// DeletePattern removes all keys matching a pattern
func (c *RedisCache) DeletePattern(ctx context.Context, pattern string) error {
    iter := c.client.Scan(ctx, 0, c.key(pattern), 100).Iterator()
    var keys []string

    for iter.Next(ctx) {
        keys = append(keys, iter.Val())
    }

    if err := iter.Err(); err != nil {
        return fmt.Errorf("scanning keys: %w", err)
    }

    if len(keys) > 0 {
        if err := c.client.Del(ctx, keys...).Err(); err != nil {
            return fmt.Errorf("deleting keys: %w", err)
        }
    }

    return nil
}

// GetOrSet tries to get from cache, if miss, calls loader and caches result
func (c *RedisCache) GetOrSet(ctx context.Context, key string, dest any, ttl time.Duration, loader func() (any, error)) error {
    if err := c.Get(ctx, key, dest); err == nil {
        return nil // Cache hit
    }

    // Cache miss - load data
    value, err := loader()
    if err != nil {
        return err
    }

    // Cache the result
    if err := c.Set(ctx, key, value, ttl); err != nil {
        // Log but don't fail - data was loaded successfully
        // This is a graceful degradation pattern
    }

    // Copy loaded value to dest
    data, _ := json.Marshal(value)
    return json.Unmarshal(data, dest)
}

var ErrCacheMiss = fmt.Errorf("cache miss")

// keyPattern extracts a pattern from a key for metrics labeling
func keyPattern(key string) string {
    // Extract pattern like "metrics:*" or "dashboard:*" for grouping
    for i, c := range key {
        if c == ':' {
            return key[:i+1] + "*"
        }
    }
    return key
}
```

### Multi-Tier Caching Strategy

A multi-tier cache (in-process LRU for the hottest keys, Redis for shared state across instances) reduces database load by an order of magnitude for dashboard queries that many users issue simultaneously. The cache-aside pattern, where a miss populates the cache from the database, is simpler to reason about than write-through when the underlying data changes via external writers. The implementation below composes both layers behind a single interface so the dashboard service doesn't need to know which tier served a particular response.

```go
// backend/internal/cache/tiered.go
package cache

import (
    "context"
    "encoding/json"
    "sync"
    "time"

    "dashboard/internal/observability"
)

// TieredCache implements a multi-tier caching strategy
// L1: In-memory (fastest, smallest)
// L2: Redis (fast, larger)
// This mirrors the 3-tier caching the legacy system had
type TieredCache struct {
    l1      *LocalCache
    l2      *RedisCache
    metrics *observability.DashboardMetrics
}

// LocalCache is an in-memory LRU cache
type LocalCache struct {
    items    map[string]*cacheItem
    mu       sync.RWMutex
    maxItems int
    ttl      time.Duration
}

type cacheItem struct {
    value     any
    expiresAt time.Time
}

func NewLocalCache(maxItems int, ttl time.Duration) *LocalCache {
    c := &LocalCache{
        items:    make(map[string]*cacheItem),
        maxItems: maxItems,
        ttl:      ttl,
    }
    go c.cleanup()
    return c
}

func (c *LocalCache) Get(key string) (any, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    item, ok := c.items[key]
    if !ok || time.Now().After(item.expiresAt) {
        return nil, false
    }
    return item.value, true
}

func (c *LocalCache) Set(key string, value any) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Simple eviction: if at capacity, remove oldest
    if len(c.items) >= c.maxItems {
        c.evictOne()
    }

    c.items[key] = &cacheItem{
        value:     value,
        expiresAt: time.Now().Add(c.ttl),
    }
}

func (c *LocalCache) evictOne() {
    var oldestKey string
    var oldestTime time.Time

    for k, v := range c.items {
        if oldestKey == "" || v.expiresAt.Before(oldestTime) {
            oldestKey = k
            oldestTime = v.expiresAt
        }
    }

    if oldestKey != "" {
        delete(c.items, oldestKey)
    }
}

func (c *LocalCache) cleanup() {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        c.mu.Lock()
        now := time.Now()
        for k, v := range c.items {
            if now.After(v.expiresAt) {
                delete(c.items, k)
            }
        }
        c.mu.Unlock()
    }
}

// NewTieredCache creates a new multi-tier cache
func NewTieredCache(l2 *RedisCache, l1MaxItems int, l1TTL time.Duration, metrics *observability.DashboardMetrics) *TieredCache {
    return &TieredCache{
        l1:      NewLocalCache(l1MaxItems, l1TTL),
        l2:      l2,
        metrics: metrics,
    }
}

// Get tries L1, then L2, populating L1 on L2 hit
func (c *TieredCache) Get(ctx context.Context, key string, dest any) error {
    // Try L1
    if value, ok := c.l1.Get(key); ok {
        c.metrics.CacheHits.WithLabelValues("l1", keyPattern(key)).Inc()
        // Type assertion/copy to dest
        data, _ := json.Marshal(value)
        return json.Unmarshal(data, dest)
    }
    c.metrics.CacheMisses.WithLabelValues("l1", keyPattern(key)).Inc()

    // Try L2
    if err := c.l2.Get(ctx, key, dest); err == nil {
        // Populate L1
        c.l1.Set(key, dest)
        return nil
    }

    return ErrCacheMiss
}

// Set writes to both tiers
func (c *TieredCache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    c.l1.Set(key, value)
    return c.l2.Set(ctx, key, value, ttl)
}
```

---

### Junior -> FAANG: Cache Fundamentals You Must Be Able to Explain Out Loud

Three cache concepts come up in almost every senior backend interview: cache-aside vs write-through, TTL strategy, and the thundering herd.

Cache-aside (also called lazy loading) is what `GetOrSet` implements: check the cache, miss, query the database, write the result to the cache. The downside is that the first request after a cache miss or expiration always hits the database. If many concurrent requests arrive after an expiry, they all miss simultaneously and all hit the database. This is the thundering herd.

Write-through means writing to the cache and the database simultaneously on every write. It prevents cold misses but doubles write latency and keeps the cache warm even for data that is never read. Neither pattern is always correct. The right choice depends on your read-to-write ratio.

TTL strategy is the question of how long cached data should live before expiring. A TTL that is too short means frequent misses. A TTL that is too long means stale data. For a metrics dashboard, a 30-second TTL on aggregated values is a reasonable starting point because the data changes every few seconds and a 30-second lag is imperceptible to users. If your team does not have a documented TTL rationale for each cache key pattern, add one.

First-job habit: always log on cache miss (at DEBUG level), and always expose a cache hit rate gauge. If you cannot see your cache hit rate in a dashboard, you cannot defend your caching strategy to anyone.

### Senior @ FAANG: Cache Architecture Governance and Failure Mode Thinking

The `TieredCache` design here is correct for a single-service deployment. At FAANG scale, the concerns shift to cache invalidation consistency, failure mode handling, and cost modeling.

**Cache invalidation consistency across instances:** The L1 cache (in-process) is not shared between service instances. If instance A writes a new metric value and populates its L1 cache, instance B's L1 cache still holds the old value. The L2 Redis cache is shared, so instance B will get the new value on its next L2 hit. But if instance B's L1 cache has not expired yet, it will serve the old value from L1 even though L2 has the new one. For a metrics dashboard, this is probably acceptable (a few seconds of stale data on one of ten server instances is not an incident). For a permissions or pricing cache, it is not. The decision about which data can tolerate per-instance L1 staleness must be made explicitly and documented per cache key pattern.

**The `GetOrSet` thundering herd and the single-flight pattern:** The current `GetOrSet` implementation does not prevent thundering herds. If 500 concurrent requests arrive after the TTL expires, all 500 will miss the cache and call the loader function simultaneously. The correct mitigation is `golang.org/x/sync/singleflight`, which deduplicates concurrent calls with the same key so only one actually calls the loader and the others wait for its result. Wrapping `GetOrSet` with `singleflight.Group.Do` is a one-line change with significant impact at scale.

**Redis failure handling:** The current `GetOrSet` implementation silently ignores the cache `Set` error with a comment. This is the right behavior for a cache write failure (the data was loaded successfully, so serve it). But a Redis read failure is different from a cache miss. If Redis is unavailable, `c.Get` will return a network error, not `ErrCacheMiss`. The current code returns that error to the caller, which will bubble up as a 500. The more resilient pattern is to distinguish between `ErrCacheMiss` and a Redis connectivity error and fall through to the loader on connectivity errors, accepting degraded cache performance during a Redis outage rather than returning errors to users. This is a deliberate tradeoff that should be documented.

**Cost modeling for multi-tier caching:** At FAANG, Redis is not free. A cache that stores large JSON blobs with high write rates generates significant memory and network costs. A staff engineer owns the cache cost model: estimated memory per key type, estimated write rate, and the resulting monthly Redis cost. This model informs TTL decisions (longer TTL means fewer writes and less cost, at the expense of staleness) and cache eviction policy choices (LRU vs LFU). Without this model, TTLs are chosen by intuition and cache costs grow invisibly until they show up in a quarterly infrastructure review.
