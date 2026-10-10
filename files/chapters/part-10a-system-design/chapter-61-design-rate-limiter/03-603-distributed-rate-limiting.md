## 61.3 Distributed Rate Limiting

### Redis-Based Token Bucket

A Redis-based token bucket extends the single-process implementation to enforce rate limits across multiple service instances, using a Lua script executed atomically on the Redis server to fetch, check, and update the token count in a single round trip. Lua scripts run atomically in Redis, eliminating the race condition that would exist if the read-modify-write were performed as separate commands from the Go client. The script accepts bucket capacity, refill rate, and the current timestamp as arguments so the token calculation happens server-side without additional client-server round trips.

```go
// distributed/redis_token_bucket.go
package distributed

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisTokenBucket implements distributed token bucket using Redis
type RedisTokenBucket struct {
    client     *redis.Client
    keyPrefix  string
    capacity   float64
    rate       float64 // Tokens per second
}

// NewRedisTokenBucket creates a new Redis-based token bucket
func NewRedisTokenBucket(client *redis.Client, prefix string, capacity, rate float64) *RedisTokenBucket {
    return &RedisTokenBucket{
        client:    client,
        keyPrefix: prefix,
        capacity:  capacity,
        rate:      rate,
    }
}

// Allow checks if a request is allowed
func (tb *RedisTokenBucket) Allow(ctx context.Context, key string, tokens float64) (bool, *RateLimitResult, error) {
    redisKey := fmt.Sprintf("%s:%s", tb.keyPrefix, key)

    // Lua script for atomic token bucket operation
    script := redis.NewScript(`
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local requested = tonumber(ARGV[4])

        -- Get current state
        local data = redis.call("HMGET", key, "tokens", "last_refill")
        local tokens = tonumber(data[1])
        local last_refill = tonumber(data[2])

        -- Initialize if not exists
        if tokens == nil then
            tokens = capacity
            last_refill = now
        end

        -- Refill tokens
        local elapsed = (now - last_refill) / 1000  -- Convert to seconds
        tokens = math.min(capacity, tokens + (elapsed * rate))

        -- Check if we can fulfill the request
        local allowed = 0
        local remaining = tokens
        local retry_after = 0

        if tokens >= requested then
            tokens = tokens - requested
            allowed = 1
            remaining = tokens
        else
            -- Calculate retry after
            local deficit = requested - tokens
            retry_after = math.ceil(deficit / rate * 1000)  -- milliseconds
        end

        -- Save state
        redis.call("HMSET", key, "tokens", tokens, "last_refill", now)
        redis.call("PEXPIRE", key, math.ceil(capacity / rate * 1000) + 1000)

        return {allowed, remaining, retry_after}
    `)

    now := time.Now().UnixMilli()
    result, err := script.Run(ctx, tb.client, []string{redisKey},
        tb.capacity, tb.rate, now, tokens).Slice()

    if err != nil {
        return false, nil, err
    }

    allowed := result[0].(int64) == 1
    remaining := result[1].(int64)
    retryAfter := time.Duration(result[2].(int64)) * time.Millisecond

    return allowed, &RateLimitResult{
        Allowed:    allowed,
        Remaining:  remaining,
        RetryAfter: retryAfter,
        Limit:      int64(tb.capacity),
    }, nil
}

// RateLimitResult contains rate limit status
type RateLimitResult struct {
    Allowed    bool
    Remaining  int64
    RetryAfter time.Duration
    Limit      int64
    ResetAt    time.Time
}
```

### Redis Sliding Window

The sliding window algorithm avoids the boundary spike problem of fixed windows, where a client can send twice the allowed requests by splitting them across a window boundary. This Redis implementation uses a sorted set where each member's score is its arrival timestamp in milliseconds. Expired entries outside the current window are pruned with `ZREMRANGEBYSCORE` before counting, so the rate check always reflects only the requests that fall within the rolling time window. The unique member value (`timestamp + random`) prevents collisions when two requests arrive in the same millisecond.

```go
// distributed/redis_sliding_window.go
package distributed

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisSlidingWindow implements distributed sliding window rate limiting
type RedisSlidingWindow struct {
    client     *redis.Client
    keyPrefix  string
    limit      int64
    windowSize time.Duration
}

// NewRedisSlidingWindow creates a new Redis sliding window limiter
func NewRedisSlidingWindow(client *redis.Client, prefix string, limit int64, window time.Duration) *RedisSlidingWindow {
    return &RedisSlidingWindow{
        client:     client,
        keyPrefix:  prefix,
        limit:      limit,
        windowSize: window,
    }
}

// Allow checks if a request is allowed
func (sw *RedisSlidingWindow) Allow(ctx context.Context, key string) (bool, *RateLimitResult, error) {
    redisKey := fmt.Sprintf("%s:%s", sw.keyPrefix, key)

    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local window_start = now - window_ms

        -- Remove old entries
        redis.call("ZREMRANGEBYSCORE", key, "-inf", window_start)

        -- Count current entries
        local count = redis.call("ZCARD", key)

        if count < limit then
            -- Add new entry with score = timestamp
            redis.call("ZADD", key, now, now .. "-" .. math.random())
            redis.call("PEXPIRE", key, window_ms)
            return {1, limit - count - 1, 0}
        end

        -- Calculate retry after (oldest entry in window)
        local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
        local retry_after = 0
        if #oldest > 0 then
            retry_after = oldest[2] + window_ms - now
        end

        return {0, 0, retry_after}
    `)

    now := time.Now().UnixMilli()
    result, err := script.Run(ctx, sw.client, []string{redisKey},
        sw.limit, sw.windowSize.Milliseconds(), now).Slice()

    if err != nil {
        return false, nil, err
    }

    allowed := result[0].(int64) == 1
    remaining := result[1].(int64)
    retryAfter := time.Duration(result[2].(int64)) * time.Millisecond

    return allowed, &RateLimitResult{
        Allowed:    allowed,
        Remaining:  remaining,
        RetryAfter: retryAfter,
        Limit:      sw.limit,
        ResetAt:    time.Now().Add(sw.windowSize),
    }, nil
}
```

### Distributed Counter with Sharding

A single Redis node becomes a bottleneck when the rate limiter must process hundreds of thousands of `INCR` operations per second across many unique keys. The `ShardedRateLimiter` distributes keys across multiple independent Redis instances using FNV hash routing, so each instance handles a fraction of the total request volume and the aggregate throughput scales linearly with the number of shards. The `AllowBatch` method further reduces latency by checking multiple keys concurrently with goroutines, which is critical for request pipelines that must validate several independent rate limit dimensions in parallel.

```go
// distributed/sharded_counter.go
package distributed

import (
    "context"
    "fmt"
    "hash/fnv"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// ShardedRateLimiter distributes rate limiting across multiple Redis instances
type ShardedRateLimiter struct {
    clients    []*redis.Client
    numShards  int
    keyPrefix  string
    limit      int64
    windowSize time.Duration
    mu         sync.RWMutex
}

// NewShardedRateLimiter creates a new sharded rate limiter
func NewShardedRateLimiter(clients []*redis.Client, prefix string, limit int64, window time.Duration) *ShardedRateLimiter {
    return &ShardedRateLimiter{
        clients:    clients,
        numShards:  len(clients),
        keyPrefix:  prefix,
        limit:      limit,
        windowSize: window,
    }
}

// getShard returns the shard for a key
func (s *ShardedRateLimiter) getShard(key string) *redis.Client {
    h := fnv.New32a()
    h.Write([]byte(key))
    return s.clients[h.Sum32()%uint32(s.numShards)]
}

// Allow checks if a request is allowed
func (s *ShardedRateLimiter) Allow(ctx context.Context, key string) (bool, *RateLimitResult, error) {
    client := s.getShard(key)
    redisKey := fmt.Sprintf("%s:%s", s.keyPrefix, key)

    now := time.Now()
    windowKey := fmt.Sprintf("%s:%d", redisKey, now.Truncate(s.windowSize).Unix())

    // Use simple INCR with EXPIRE
    pipe := client.Pipeline()
    incrCmd := pipe.Incr(ctx, windowKey)
    pipe.Expire(ctx, windowKey, s.windowSize*2)
    _, err := pipe.Exec(ctx)

    if err != nil {
        return false, nil, err
    }

    count := incrCmd.Val()
    allowed := count <= s.limit

    return allowed, &RateLimitResult{
        Allowed:   allowed,
        Remaining: s.limit - count,
        Limit:     s.limit,
        ResetAt:   now.Truncate(s.windowSize).Add(s.windowSize),
    }, nil
}

// AllowBatch checks multiple keys in parallel
func (s *ShardedRateLimiter) AllowBatch(ctx context.Context, keys []string) (map[string]*RateLimitResult, error) {
    results := make(map[string]*RateLimitResult)
    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, key := range keys {
        wg.Add(1)
        go func(k string) {
            defer wg.Done()
            allowed, result, err := s.Allow(ctx, k)
            if err != nil {
                return
            }
            result.Allowed = allowed
            mu.Lock()
            results[k] = result
            mu.Unlock()
        }(key)
    }

    wg.Wait()
    return results, nil
}
```

---

### Junior → FAANG: Redis Atomicity and the Lua Script Pattern

Distributed rate limiting requires atomic state management. The Lua script pattern is the standard Redis solution, and understanding it is essential for implementing correct distributed rate limiters.

**Why not MULTI/EXEC transactions?** Redis supports transactions via `MULTI/EXEC`, which allows batching commands. However, `MULTI/EXEC` cannot perform conditional logic: you cannot read a value, branch based on it, and write a different value, all atomically. Lua scripts can. The token bucket script reads the current token count, computes the refill amount based on elapsed time, checks if the request can be fulfilled, and either decrements the count or computes the retry-after delay. All of this happens in a single atomic operation on the Redis server.

**The Lua script receives KEYS and ARGV arrays.** In the Redis Lua scripting convention, `KEYS[1]` is the first key argument and `ARGV[1]` is the first value argument. This separation matters for Redis Cluster: the cluster routes keys to specific nodes, and all keys used in a script must be on the same node. By separating keys from arguments, Redis Cluster can validate that all keys in a script hash to the same slot. The scripts in this section use a single key per call, which is always cluster-safe.

**Understand what the token bucket Lua script does line by line.** The script: loads the current token count and last refill time from a Redis hash, computes elapsed seconds and adds `elapsed * rate` tokens (capped at capacity), checks if `tokens >= requested`, decrements if allowed or computes retry-after if not, saves the new state back to the hash, and sets a TTL so orphaned keys expire. Being able to walk through this script in an interview shows that you understand the algorithm, not just the pattern.

**AllowBatch enables parallel multi-dimensional rate limiting.** A request might need to pass three independent rate limit checks: per-user, per-IP, and per-endpoint. `AllowBatch` checks all three concurrently, returning all results in parallel. This reduces the latency of multi-dimensional checking to the latency of the slowest single check, rather than the sum of all checks. Know that the goroutines in `AllowBatch` share a context that can be canceled if one check returns early (though the implementation above does not implement this optimization).

---

### Senior @ FAANG: Distributed Rate Limiting Architecture Under Scale and Failure

At L6/L7, distributed rate limiting is not just "put the state in Redis." It is a system with its own capacity model, failure modes, and scaling strategy that must be designed independently of the application it protects.

**Redis cluster capacity for rate limiting keys.** Each rate limit key in a sliding window implementation is a Redis sorted set. A sorted set with N members consumes approximately 50 + N * 32 bytes in Redis. For 1 million unique users each allowed 100 requests per minute, the per-user sorted set has 100 members and consumes approximately 3.2 KB. Total memory: 3.2 GB for the rate limit state alone. A single Redis instance with 8 GB memory can hold approximately 2.5 million such keys. Plan the Redis cluster size based on the number of unique rate limit keys and the window size.

**Sharding for rate limit throughput.** The `ShardedRateLimiter` distributes keys across multiple Redis instances. The throughput of each Redis instance is bounded by its CPU (single-threaded Lua execution). A Redis 6.x instance running on modern hardware can execute approximately 100,000-200,000 Lua script calls per second. For a system handling 10 million requests per second, you need at least 50-100 Redis shards for rate limiting alone. This is a significant infrastructure investment. At FAANG scale, rate limiting infrastructure is owned by a dedicated platform team.

**Cross-datacenter rate limiting introduces a fundamental trade-off.** A rate limiter that uses Redis in datacenter A cannot correctly rate limit requests that arrive at datacenter B without a network round trip to datacenter A, adding 50-100ms of latency. The practical alternatives: (1) per-region quotas (split the global limit across regions, accept some under-utilization), (2) local-only limiting with asynchronous global sync (allow some over-limit traffic during sync lag), (3) sticky routing (hash the client key to a single datacenter). Each alternative has a different accuracy/latency trade-off. Document the chosen approach, the accuracy guarantee it provides, and the maximum over-limit traffic that can occur during a datacenter sync delay.
