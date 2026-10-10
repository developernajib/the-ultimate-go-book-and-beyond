## Exercises with Complete Solutions

### Exercise 1: Implement a Leaky Bucket Rate Limiter

The leaky bucket algorithm processes requests at a constant rate regardless of how many arrive, making it ideal for smoothing bursty input into a steady output stream. Unlike token bucket which allows accumulated tokens to be spent in a burst, leaky bucket enforces strict constant throughput by queuing excess requests and draining them at a fixed rate. Implement the struct, its `Add` method for enqueuing work, and a background goroutine that drains the bucket at the configured rate.

```go
// exercise_leaky_bucket.go
package ratelimit

import (
    "context"
    "sync"
    "time"
)

// LeakyBucket implements rate limiting that smooths out bursts
type LeakyBucket struct {
    mu sync.Mutex

    // Bucket configuration
    capacity   int           // Maximum queue size
    leakRate   float64       // Requests leaked per second
    lastLeak   time.Time

    // Current state
    water      float64       // Current water level (pending requests)
}

func NewLeakyBucket(capacity int, leakRate float64) *LeakyBucket {
    return &LeakyBucket{
        capacity: capacity,
        leakRate: leakRate,
        lastLeak: time.Now(),
    }
}

// Allow checks if a request can be added to the bucket
func (lb *LeakyBucket) Allow() bool {
    lb.mu.Lock()
    defer lb.mu.Unlock()

    // Leak water based on elapsed time
    now := time.Now()
    elapsed := now.Sub(lb.lastLeak).Seconds()
    leaked := elapsed * lb.leakRate
    lb.water = max(0, lb.water-leaked)
    lb.lastLeak = now

    // Check if we can add a request
    if lb.water < float64(lb.capacity) {
        lb.water++
        return true
    }

    return false
}

// WaitTime returns how long to wait before a request can be allowed
func (lb *LeakyBucket) WaitTime() time.Duration {
    lb.mu.Lock()
    defer lb.mu.Unlock()

    if lb.water < float64(lb.capacity) {
        return 0
    }

    // Calculate wait time
    overflow := lb.water - float64(lb.capacity) + 1
    waitSeconds := overflow / lb.leakRate
    return time.Duration(waitSeconds * float64(time.Second))
}

// AllowWithWait waits until the request can be allowed or context is canceled
func (lb *LeakyBucket) AllowWithWait(ctx context.Context) error {
    for {
        if lb.Allow() {
            return nil
        }

        waitTime := lb.WaitTime()
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(waitTime):
            // Try again
        }
    }
}

// Note: Uses builtin max() available since Go 1.21

// Test
func TestLeakyBucket() {
    bucket := NewLeakyBucket(10, 5.0) // 10 capacity, 5 req/sec leak rate

    // Should allow initial burst
    for i := 0; i < 10; i++ {
        if !bucket.Allow() {
            panic("should allow first 10 requests")
        }
    }

    // 11th should be rejected
    if bucket.Allow() {
        panic("should reject 11th request")
    }

    // Wait for some leakage
    time.Sleep(500 * time.Millisecond) // 2.5 requests leaked

    // Should allow 2 more
    if !bucket.Allow() || !bucket.Allow() {
        panic("should allow after leak")
    }
}
```

### Exercise 2: Distributed Rate Limiter with Redis Cluster

A single in-process rate limiter breaks down in a horizontally scaled deployment where each pod tracks its own independent counters, allowing the aggregate request rate to be a multiple of the intended limit. This exercise uses a Redis Cluster client so that all nodes share the same atomic counters, and implements a sliding window approximation via a Lua script to guarantee that the read-increment-expire sequence executes atomically on the Redis server without race conditions. The weighted blending of the previous and current window counts (`prev_count * (1 - window_progress) + curr_count`) avoids the traffic spike that fixed-window counters produce at window boundaries.

```go
// exercise_distributed_limiter.go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
)

// DistributedRateLimiter provides rate limiting across multiple nodes
type DistributedRateLimiter struct {
    client    *redis.ClusterClient
    keyPrefix string
    limit     int64
    window    time.Duration
    algorithm string // "fixed_window", "sliding_window", "token_bucket"
}

func NewDistributedRateLimiter(client *redis.ClusterClient, keyPrefix string, limit int64, window time.Duration) *DistributedRateLimiter {
    return &DistributedRateLimiter{
        client:    client,
        keyPrefix: keyPrefix,
        limit:     limit,
        window:    window,
        algorithm: "sliding_window",
    }
}

// Allow checks if a request should be allowed using sliding window counter
func (rl *DistributedRateLimiter) Allow(ctx context.Context, identifier string) (*RateLimitInfo, error) {
    // The braces are a Redis Cluster hash tag. The Lua script derives
    // per-window subkeys from this base key, and without the tag those
    // subkeys would hash to different slots and fail with CROSSSLOT.
    key := fmt.Sprintf("{%s:%s}", rl.keyPrefix, identifier)

    // Sliding window counter with Lua script
    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        -- Calculate window boundaries
        local window_start = now - (now % window_ms)
        local prev_window_start = window_start - window_ms

        -- Get counts for current and previous windows
        local prev_key = key .. ":" .. prev_window_start
        local curr_key = key .. ":" .. window_start

        local prev_count = tonumber(redis.call("GET", prev_key) or "0")
        local curr_count = tonumber(redis.call("GET", curr_key) or "0")

        -- Calculate weighted count
        local window_progress = (now - window_start) / window_ms
        local estimated_count = prev_count * (1 - window_progress) + curr_count

        if estimated_count >= limit then
            -- Calculate reset time
            local reset_at = window_start + window_ms
            return {0, math.floor(limit - estimated_count), reset_at, math.floor(estimated_count)}
        end

        -- Increment current window
        redis.call("INCR", curr_key)
        redis.call("PEXPIRE", curr_key, window_ms * 2)  -- Keep for 2 windows

        return {1, math.floor(limit - estimated_count - 1), window_start + window_ms, math.floor(estimated_count + 1)}
    `)

    result, err := script.Run(ctx, rl.client,
        []string{key},
        rl.limit,
        rl.window.Milliseconds(),
        time.Now().UnixMilli(),
    ).Int64Slice()

    if err != nil {
        // Fail open with warning
        return &RateLimitInfo{
            Allowed:   true,
            Remaining: rl.limit,
            ResetAt:   time.Now().Add(rl.window),
            Used:      0,
        }, fmt.Errorf("rate limit check failed: %w", err)
    }

    return &RateLimitInfo{
        Allowed:   result[0] == 1,
        Remaining: result[1],
        ResetAt:   time.UnixMilli(result[2]),
        Used:      result[3],
    }, nil
}

type RateLimitInfo struct {
    Allowed   bool
    Remaining int64
    ResetAt   time.Time
    Used      int64
}

// SetHeaders adds rate limit headers to HTTP response
func (info *RateLimitInfo) SetHeaders(w interface{ Header() http.Header }) {
    w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", info.Used+info.Remaining))
    w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", info.Remaining))
    w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", info.ResetAt.Unix()))

    if !info.Allowed {
        retryAfter := time.Until(info.ResetAt).Seconds()
        if retryAfter < 0 {
            retryAfter = 1
        }
        w.Header().Set("Retry-After", fmt.Sprintf("%.0f", retryAfter))
    }
}
```

---

### Junior → FAANG: Implementation Exercises as Interview Preparation

These two exercises are close to what you might be asked to implement in a FAANG coding interview. The leaky bucket exercise tests your understanding of time-based state management. The distributed rate limiter exercise tests your ability to write a correct Redis Lua script.

**Leaky bucket: the key is computing the leak correctly.** The `Allow` method computes `leaked = elapsed * leakRate` and subtracts it from `water`. The `max(0, water - leaked)` prevents `water` from going negative (you cannot have negative water in the bucket). The `lastLeak` timestamp must be updated on every call, not just when the bucket is non-empty. If you skip updating `lastLeak` when the bucket is empty, the next call will compute a very large elapsed time and subtract a very large amount from an already-empty bucket. The result is still correct (water stays at 0 due to `max`), but the logic is cleaner if you always update `lastLeak`.

**Distributed rate limiter: the Lua script is the algorithm.** The sliding window counter Lua script in Exercise 2 computes `window_progress = (now - window_start) / window_ms` and uses it to weight the previous window's count. This is the same formula as the in-process implementation, translated to Lua. The key additions: `PEXPIRE curr_key (window_ms * 2)` keeps the key alive for two full windows (current and next), and the fail-open return value (`{1, rl.limit, ...}`) when Redis errors ensures the service remains available during Redis failures.

**Extend Exercise 2 to add observability.** After completing the exercise, add: a `prometheus.CounterVec` with labels `{allowed: "true/false", fallback: "true/false"}` counting every rate limit decision, a `prometheus.Histogram` measuring the latency of the Lua script execution, and a structured log line for every denied request (key, current count, limit, reset time). These additions are required for any production rate limiter and demonstrate production readiness beyond correctness.

---

### Senior @ FAANG: Production Extension of the Exercises

At L6/L7, the exercises are starting points for a production implementation, not the complete solution. Here is what a production-grade version of each exercise requires beyond the solution code.

**Exercise 1 (leaky bucket) production extensions.** The `AllowWithWait` method polls using `time.After(waitTime)`. In a high-concurrency scenario, many goroutines may call `AllowWithWait` simultaneously, all sleeping and then all waking up at approximately the same time, causing a burst on the `Allow` method. Production implementations use a dedicated goroutine that wakes up at the next available slot and sends a signal to waiting goroutines, eliminating the polling. This is the "token reservation" pattern: callers reserve a slot in the future rather than polling until one is available. Additionally, the `WaitTime` method acquires the lock but does not update `lastLeak`, which means calling `WaitTime` immediately before `Allow` may return a stale estimate. The production fix is to compute `WaitTime` using the same `lastLeak` value that `Allow` will use when it is eventually called.

**Exercise 2 (distributed rate limiter) production extensions.** The `SetHeaders` method on `RateLimitInfo` assumes `w` implements `Header() http.Header`. This interface is not the standard `http.ResponseWriter` interface. It is a custom interface that only works with response writers. A production implementation uses `http.ResponseWriter` directly and is called from the middleware layer, not from the domain object. Moving `SetHeaders` out of `RateLimitInfo` and into the middleware keeps the domain model clean (it does not know about HTTP). Additionally, the `algorithm` field in `DistributedRateLimiter` is a string constant that is never used in the implementation. A production rate limiter that supports multiple algorithms uses the Strategy pattern: the algorithm is an interface, and the concrete implementation (fixed window, sliding window, token bucket) is injected at construction time. The middleware does not need to know which algorithm is being used.
