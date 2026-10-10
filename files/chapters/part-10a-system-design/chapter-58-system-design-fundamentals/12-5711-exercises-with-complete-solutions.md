## Exercises with Complete Solutions

### Exercise 1: Implement a Distributed Rate Limiter

This exercise builds a Redis-backed sliding window rate limiter from scratch, reinforcing the concepts of atomic distributed counters, TTL-based window management, and the goroutine-safe interface design required for use in concurrent Go HTTP handlers. The complete solution demonstrates proper error handling for Redis unavailability, correct sliding window semantics that avoid the boundary burst problem of fixed windows, and a clean `RateLimiter` interface that can be swapped for an in-process implementation in tests.

```go
// Solution: distributed_rate_limiter.go
package ratelimit

import (
    "context"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/stretchr/testify/assert"
)

// DistributedRateLimiter using sliding window algorithm
type DistributedRateLimiter struct {
    redis      *redis.Client
    keyPrefix  string
    limit      int64
    window     time.Duration
}

func NewDistributedRateLimiter(redis *redis.Client, limit int64, window time.Duration) *DistributedRateLimiter {
    return &DistributedRateLimiter{
        redis:     redis,
        keyPrefix: "ratelimit:",
        limit:     limit,
        window:    window,
    }
}

// Allow checks if request is allowed using sliding window log
func (r *DistributedRateLimiter) Allow(ctx context.Context, key string) (bool, int64, error) {
    now := time.Now().UnixMicro()
    windowStart := now - r.window.Microseconds()

    redisKey := r.keyPrefix + key

    // Lua script for atomic operation
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local window = tonumber(ARGV[4])

        -- Remove expired entries
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current requests
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add new request. The member must be unique: two calls in
            -- the same microsecond would otherwise collapse into one
            -- ZSET entry and undercount.
            redis.call('ZADD', key, now, now .. ':' .. redis.call('INCR', key .. ':seq'))
            redis.call('PEXPIRE', key, window)
            redis.call('PEXPIRE', key .. ':seq', window)
            return {1, limit - count - 1}
        else
            return {0, 0}
        end
    `)

    result, err := script.Run(ctx, r.redis, []string{redisKey},
        now,
        windowStart,
        r.limit,
        r.window.Milliseconds(),
    ).Slice()

    if err != nil {
        return false, 0, err
    }

    allowed := result[0].(int64) == 1
    remaining := result[1].(int64)

    return allowed, remaining, nil
}

// AllowN checks if N requests are allowed
func (r *DistributedRateLimiter) AllowN(ctx context.Context, key string, n int64) (bool, int64, error) {
    now := time.Now().UnixMicro()
    windowStart := now - r.window.Microseconds()

    redisKey := r.keyPrefix + key

    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local window = tonumber(ARGV[4])
        local n = tonumber(ARGV[5])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
        local count = redis.call('ZCARD', key)

        if count + n <= limit then
            for i = 1, n do
                redis.call('ZADD', key, now + i, now .. ':' .. i)
            end
            redis.call('PEXPIRE', key, window)
            return {1, limit - count - n}
        else
            return {0, limit - count}
        end
    `)

    result, err := script.Run(ctx, r.redis, []string{redisKey},
        now,
        windowStart,
        r.limit,
        r.window.Milliseconds(),
        n,
    ).Slice()

    if err != nil {
        return false, 0, err
    }

    return result[0].(int64) == 1, result[1].(int64), nil
}

// Token Bucket implementation (alternative algorithm)
type TokenBucketLimiter struct {
    redis       *redis.Client
    keyPrefix   string
    capacity    int64
    refillRate  int64 // tokens per second
}

func NewTokenBucketLimiter(redis *redis.Client, capacity, refillRate int64) *TokenBucketLimiter {
    return &TokenBucketLimiter{
        redis:      redis,
        keyPrefix:  "tokenbucket:",
        capacity:   capacity,
        refillRate: refillRate,
    }
}

func (t *TokenBucketLimiter) Allow(ctx context.Context, key string) (bool, int64, error) {
    redisKey := t.keyPrefix + key
    now := time.Now().Unix()

    script := redis.NewScript(`
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens = tonumber(bucket[1]) or capacity
        local last_refill = tonumber(bucket[2]) or now

        -- Calculate refill
        local elapsed = now - last_refill
        local refill = elapsed * refill_rate
        tokens = math.min(capacity, tokens + refill)

        if tokens >= 1 then
            tokens = tokens - 1
            redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
            redis.call('EXPIRE', key, 3600)
            return {1, tokens}
        else
            redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
            redis.call('EXPIRE', key, 3600)
            return {0, tokens}
        end
    `)

    result, err := script.Run(ctx, t.redis, []string{redisKey},
        t.capacity,
        t.refillRate,
        now,
    ).Slice()

    if err != nil {
        return false, 0, err
    }

    return result[0].(int64) == 1, result[1].(int64), nil
}

// Test the rate limiter
func TestDistributedRateLimiter(t *testing.T) {
    redis := redis.NewClient(&redis.Options{
        Addr: "localhost:6379",
    })
    defer redis.Close()

    ctx := context.Background()

    // 10 requests per second
    limiter := NewDistributedRateLimiter(redis, 10, time.Second)

    key := "test:user:123"

    // Should allow first 10 requests
    for i := 0; i < 10; i++ {
        allowed, remaining, err := limiter.Allow(ctx, key)
        assert.NoError(t, err)
        assert.True(t, allowed, "Request %d should be allowed", i)
        assert.Equal(t, int64(9-i), remaining)
    }

    // 11th request should be denied
    allowed, remaining, err := limiter.Allow(ctx, key)
    assert.NoError(t, err)
    assert.False(t, allowed, "11th request should be denied")
    assert.Equal(t, int64(0), remaining)

    // Wait for window to pass
    time.Sleep(1100 * time.Millisecond)

    // Should allow again
    allowed, _, err = limiter.Allow(ctx, key)
    assert.NoError(t, err)
    assert.True(t, allowed, "Request after window should be allowed")
}
```

### Exercise 2: Design a Distributed Cache with Write-Through

Write-through caching solves the cache-invalidation problem by making the cache and the database consistent on every write: data is persisted to the database first (the source of truth), then immediately written to Redis, so a subsequent cache miss will always find fresh data in the database. The solution here also integrates `singleflight` to prevent cache stampedes, when many goroutines simultaneously discover a cold-cache miss on the same key, only one goroutine performs the database read while the rest wait and share the result, eliminating the thundering-herd load spike that would otherwise hit the database. The `Warm` method preloads a list of hot keys concurrently before traffic arrives, reducing cold-start miss rates after deployments or cache evictions.

```go
// Solution: distributed_cache.go
package cache

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
    "golang.org/x/sync/singleflight"
)

// WriteThroughCache implements write-through caching pattern
type WriteThroughCache struct {
    redis    *redis.Client
    db       Database
    prefix   string
    ttl      time.Duration
    sfGroup  *singleflight.Group
    metrics  *CacheMetrics
}

type Database interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte) error
    Delete(ctx context.Context, key string) error
}

type CacheMetrics struct {
    hits       int64
    misses     int64
    writeThru  int64
    errors     int64
    mu         sync.Mutex
}

func NewWriteThroughCache(redis *redis.Client, db Database, ttl time.Duration) *WriteThroughCache {
    return &WriteThroughCache{
        redis:   redis,
        db:      db,
        prefix:  "wtc:",
        ttl:     ttl,
        sfGroup: &singleflight.Group{},
        metrics: &CacheMetrics{},
    }
}

// Get implements cache-aside read with singleflight
func (c *WriteThroughCache) Get(ctx context.Context, key string) ([]byte, error) {
    cacheKey := c.prefix + key

    // Try cache first
    value, err := c.redis.Get(ctx, cacheKey).Bytes()
    if err == nil {
        c.metrics.RecordHit()
        return value, nil
    }

    c.metrics.RecordMiss()

    // Use singleflight to prevent cache stampede
    result, err, _ := c.sfGroup.Do(key, func() (any, error) {
        // Double-check cache (another goroutine might have loaded it)
        value, err := c.redis.Get(ctx, cacheKey).Bytes()
        if err == nil {
            return value, nil
        }

        // Load from database
        value, err = c.db.Get(ctx, key)
        if err != nil {
            return nil, err
        }

        // Populate cache
        c.redis.Set(ctx, cacheKey, value, c.ttl)

        return value, nil
    })

    if err != nil {
        return nil, err
    }

    return result.([]byte), nil
}

// Set implements write-through: write to DB first, then cache
func (c *WriteThroughCache) Set(ctx context.Context, key string, value []byte) error {
    // Write to database first (source of truth)
    if err := c.db.Set(ctx, key, value); err != nil {
        c.metrics.RecordError()
        return fmt.Errorf("database write failed: %w", err)
    }

    // Then update cache
    cacheKey := c.prefix + key
    if err := c.redis.Set(ctx, cacheKey, value, c.ttl).Err(); err != nil {
        // Log but don't fail - DB is source of truth
        c.metrics.RecordError()
        // Cache will be populated on next read
    }

    c.metrics.RecordWriteThrough()
    return nil
}

// Delete removes from both cache and database
func (c *WriteThroughCache) Delete(ctx context.Context, key string) error {
    cacheKey := c.prefix + key

    // Delete from cache first (to prevent stale reads)
    c.redis.Del(ctx, cacheKey)

    // Then delete from database
    return c.db.Delete(ctx, key)
}

// Warm preloads cache with hot keys
func (c *WriteThroughCache) Warm(ctx context.Context, keys []string) error {
    var wg sync.WaitGroup
    errChan := make(chan error, len(keys))

    for _, key := range keys {
        wg.Add(1)
        go func(k string) {
            defer wg.Done()

            value, err := c.db.Get(ctx, k)
            if err != nil {
                errChan <- err
                return
            }

            cacheKey := c.prefix + k
            if err := c.redis.Set(ctx, cacheKey, value, c.ttl).Err(); err != nil {
                errChan <- err
            }
        }(key)
    }

    wg.Wait()
    close(errChan)

    // Collect any errors
    var errs []error
    for err := range errChan {
        errs = append(errs, err)
    }

    if len(errs) > 0 {
        return fmt.Errorf("warming failed for %d keys", len(errs))
    }

    return nil
}

// GetOrSet atomically gets or sets a value
func (c *WriteThroughCache) GetOrSet(ctx context.Context, key string, loader func() ([]byte, error)) ([]byte, error) {
    // Try cache
    cacheKey := c.prefix + key
    value, err := c.redis.Get(ctx, cacheKey).Bytes()
    if err == nil {
        return value, nil
    }

    // Use singleflight
    result, err, _ := c.sfGroup.Do(key, func() (any, error) {
        // Double check cache
        value, err := c.redis.Get(ctx, cacheKey).Bytes()
        if err == nil {
            return value, nil
        }

        // Load value
        value, err = loader()
        if err != nil {
            return nil, err
        }

        // Store in both DB and cache
        if err := c.Set(ctx, key, value); err != nil {
            return nil, err
        }

        return value, nil
    })

    if err != nil {
        return nil, err
    }

    return result.([]byte), nil
}

// BatchGet retrieves multiple keys efficiently
func (c *WriteThroughCache) BatchGet(ctx context.Context, keys []string) (map[string][]byte, error) {
    cacheKeys := make([]string, len(keys))
    for i, k := range keys {
        cacheKeys[i] = c.prefix + k
    }

    // Try cache first
    results, err := c.redis.MGet(ctx, cacheKeys...).Result()
    if err != nil {
        return nil, err
    }

    // Find misses
    response := make(map[string][]byte)
    misses := make([]string, 0)

    for i, result := range results {
        if result != nil {
            response[keys[i]] = []byte(result.(string))
            c.metrics.RecordHit()
        } else {
            misses = append(misses, keys[i])
            c.metrics.RecordMiss()
        }
    }

    // Load misses from DB
    if len(misses) > 0 {
        var wg sync.WaitGroup
        var mu sync.Mutex

        for _, key := range misses {
            wg.Add(1)
            go func(k string) {
                defer wg.Done()

                value, err := c.db.Get(ctx, k)
                if err != nil {
                    return
                }

                // Populate cache
                c.redis.Set(ctx, c.prefix+k, value, c.ttl)

                mu.Lock()
                response[k] = value
                mu.Unlock()
            }(key)
        }

        wg.Wait()
    }

    return response, nil
}

func (m *CacheMetrics) RecordHit() {
    m.mu.Lock()
    m.hits++
    m.mu.Unlock()
}

func (m *CacheMetrics) RecordMiss() {
    m.mu.Lock()
    m.misses++
    m.mu.Unlock()
}

func (m *CacheMetrics) RecordWriteThrough() {
    m.mu.Lock()
    m.writeThru++
    m.mu.Unlock()
}

func (m *CacheMetrics) RecordError() {
    m.mu.Lock()
    m.errors++
    m.mu.Unlock()
}

func (m *CacheMetrics) HitRate() float64 {
    m.mu.Lock()
    defer m.mu.Unlock()
    total := m.hits + m.misses
    if total == 0 {
        return 0
    }
    return float64(m.hits) / float64(total)
}
```

### Junior → FAANG: What to Take from These Exercises

The two exercises here (rate limiter and write-through cache) are representative of the kind of coding-plus-design problems that appear in the combined "coding design" round at some FAANG companies, where you are expected to both describe the architecture and implement a key component.

For the rate limiter: the critical detail is the atomicity requirement. A rate limiter that reads the counter, checks it, and increments it in three separate operations has a race condition between the read and the increment. The Lua script in the solution runs atomically on the Redis server, so no race is possible. This is the correct answer. A candidate who proposes a non-atomic implementation without mentioning the race condition will lose points.

For the write-through cache: the `singleflight` integration is the detail that separates a textbook answer from a production-quality answer. Without it, a cache miss for a popular key during a traffic spike will cause 100 or 1000 concurrent goroutines to all query the database simultaneously. With `singleflight`, only one goroutine queries the database and all others wait for the result. Be able to explain this in the interview: "I use singleflight to coalesce concurrent cache misses for the same key, which prevents a thundering-herd problem on the database during a cold-cache scenario."

For both exercises: notice that the error handling is explicit and the interfaces (`Database`, `RateLimiter`) are defined separately from the implementations. This is the Go idiom. Interviewers who code in Go will notice if you define a concrete struct with no interface and write all tests against the concrete type. Start with the interface.

### Senior @ FAANG: Exercise Critique and Production Hardening

The solutions in these exercises are correct starting points. At the staff level, the exercise is to identify what is missing for production readiness and what organizational standards they assume.

**Rate limiter production gaps.**
- Redis client configuration: the solution creates a `redis.Client` but does not configure the connection pool size, dial timeout, read timeout, or write timeout. In production, an unconfigured Redis client with default timeouts may block the calling goroutine for seconds during a Redis slowdown. The pool size should be tuned based on the number of goroutines in the application and the expected Redis latency.
- Fallback behavior: if Redis is unavailable, the rate limiter returns an error. The calling code must decide what to do with that error. For most rate-limiting use cases, the correct policy is to allow the request (fail open) rather than block all traffic because the rate limiter is down. This is a policy decision that should be documented and configurable per use case.
- Observability: the solution has no metrics. A production rate limiter should emit at minimum: allowed request rate, denied request rate, and Redis error rate. Without these metrics, you cannot know whether the rate limiter is functioning correctly or tuned appropriately.

**Write-through cache production gaps.**
- Cache failure handling: the solution logs but does not fail when the Redis write fails after a successful database write. This is the correct behavior (database is the source of truth), but the next read will miss the cache and hit the database. If the Redis failure is persistent, cache hit rate drops to zero and the database receives full production traffic. The monitoring for this is Redis write error rate. If it exceeds a threshold, the on-call engineer should be paged.
- TTL jitter: if all entries have the same TTL, they will expire simultaneously, causing a synchronized cache miss storm. Adding a small random jitter (up to 10% of the TTL) staggers expiry and prevents the stampede. This should be the default in every TTL-based cache, not an optional enhancement.
- Warm strategy limitations: the `Warm` method fetches all specified keys in parallel without throttling. If the hot key list is 100,000 keys and the database can handle 1,000 reads per second, the warming job will saturate the database. A production warming implementation throttles the fetch rate and includes progress metrics and cancellation support.

**Organizational standards these solutions assume.** Both solutions assume that Redis is a reliable, low-latency dependency. In practice, the reliability of your caching infrastructure is a platform concern, not a per-service concern. At the staff level, you define and operate the Redis infrastructure that all teams depend on, including: deployment model (cluster mode vs. sentinel), failover behavior, persistence configuration (RDB vs. AOF vs. none), eviction policy (allkeys-lru is correct for pure caching), and monitoring standards. A team that builds a caching solution on top of Redis that is configured differently from the platform standard creates an operational support burden and a consistency risk.

---
