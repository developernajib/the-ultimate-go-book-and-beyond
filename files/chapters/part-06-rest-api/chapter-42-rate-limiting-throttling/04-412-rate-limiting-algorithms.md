## 42.2 Rate Limiting Algorithms

> **Algorithm summary**: Fixed window (simple, O(1), but boundary-burst problem where the last slice of window N plus the first slice of window N+1 together admit up to 2×rate). Sliding log (exact, but O(rate) memory per key). Sliding window counter (O(1) memory, smooths the boundary burst by weighting the previous window). Token bucket (O(1), allows configured bursts up to `burst`). Leaky bucket (O(1), enforces strictly constant output rate, no bursts). Default choice for general APIs is sliding window counter. Default for APIs that want to reward well-behaved clients with burst headroom is token bucket. Reach for leaky bucket only when a downstream system cannot tolerate any burst.

### Fixed Window Counter

`FixedWindowLimiter` resets the counter at the start of each window boundary, which is simple but allows a burst of up to `2×rate` requests at the seam between two windows. A background goroutine periodically evicts expired entries from the `windows` map to prevent unbounded memory growth as unique client keys accumulate.

```go
// ... imports omitted for brevity (sync, time)

// FixedWindowLimiter implements fixed window rate limiting
type FixedWindowLimiter struct {
    rate    int
    window  time.Duration
    mu      sync.Mutex
    windows map[string]*windowData
}

type windowData struct {
    count     int
    expiresAt time.Time
}

func NewFixedWindowLimiter(rate int, window time.Duration) *FixedWindowLimiter {
    limiter := &FixedWindowLimiter{
        rate:    rate,
        window:  window,
        windows: make(map[string]*windowData),
    }

    // Cleanup expired windows periodically
    go limiter.cleanup()

    return limiter
}

func (l *FixedWindowLimiter) Allow(key string) (bool, int, time.Time) {
    return l.AllowN(key, 1)
}

func (l *FixedWindowLimiter) AllowN(key string, n int) (bool, int, time.Time) {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()

    // Get or create window
    w, exists := l.windows[key]
    if !exists || now.After(w.expiresAt) {
        // New window
        w = &windowData{
            count:     0,
            expiresAt: now.Add(l.window),
        }
        l.windows[key] = w
    }

    // Check if request allowed
    remaining := l.rate - w.count
    if remaining < n {
        return false, remaining, w.expiresAt
    }

    // Allow request
    w.count += n
    return true, remaining - n, w.expiresAt
}

func (l *FixedWindowLimiter) cleanup() {
    ticker := time.NewTicker(l.window)
    defer ticker.Stop()

    for range ticker.C {
        l.mu.Lock()
        now := time.Now()
        for key, w := range l.windows {
            if now.After(w.expiresAt) {
                delete(l.windows, key)
            }
        }
        l.mu.Unlock()
    }
}
```

### Sliding Window Log

`SlidingWindowLogLimiter` stores a timestamp for every request in a doubly linked list, then prunes entries older than `window` on each check to count only the requests within the rolling interval. This eliminates the boundary burst of fixed windows but uses O(n) memory per client where n equals the maximum allowed requests in the window.

```go
// ... imports omitted for brevity (container/list, sync, time)

// SlidingWindowLogLimiter implements sliding window with request log
type SlidingWindowLogLimiter struct {
    rate   int
    window time.Duration
    mu     sync.Mutex
    logs   map[string]*list.List
}

func NewSlidingWindowLogLimiter(rate int, window time.Duration) *SlidingWindowLogLimiter {
    limiter := &SlidingWindowLogLimiter{
        rate:   rate,
        window: window,
        logs:   make(map[string]*list.List),
    }

    go limiter.cleanup()

    return limiter
}

func (l *SlidingWindowLogLimiter) Allow(key string) (bool, int, time.Time) {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-l.window)

    // Get or create log
    log, exists := l.logs[key]
    if !exists {
        log = list.New()
        l.logs[key] = log
    }

    // Remove expired entries
    for log.Len() > 0 {
        front := log.Front()
        if front.Value.(time.Time).Before(windowStart) {
            log.Remove(front)
        } else {
            break
        }
    }

    // Check rate limit
    remaining := l.rate - log.Len()
    if remaining <= 0 {
        // Find when oldest request expires
        oldestTime := log.Front().Value.(time.Time)
        resetAt := oldestTime.Add(l.window)
        return false, 0, resetAt
    }

    // Add current request
    log.PushBack(now)
    return true, remaining - 1, now.Add(l.window)
}

func (l *SlidingWindowLogLimiter) cleanup() {
    ticker := time.NewTicker(l.window)
    defer ticker.Stop()

    for range ticker.C {
        l.mu.Lock()
        for key, log := range l.logs {
            if log.Len() == 0 {
                delete(l.logs, key)
            }
        }
        l.mu.Unlock()
    }
}
```

### Sliding Window Counter

`SlidingWindowCounterLimiter` approximates a true sliding window by blending the previous window's count with the current window's count, weighted by how far the current timestamp has progressed through the window. This gives O(1) memory per client rather than the O(rate) cost of a full sliding log while still smoothing burst edges.

Read the code below with one omission in mind: unlike the two limiters above, it has no cleanup goroutine. Its per-key state is O(1), but the number of keys is not. Point this at per-IP limiting on a public endpoint and the `counts` map grows for the lifetime of the process, one entry per IP that ever touched you. Adding an eviction sweep is left as an exercise, and it is the first thing a reviewer should ask about.

```go
// ... imports omitted for brevity (sync, time)

// SlidingWindowCounterLimiter combines fixed windows with weighted counting
type SlidingWindowCounterLimiter struct {
    rate   int
    window time.Duration
    mu     sync.Mutex
    counts map[string]*slidingWindow
}

type slidingWindow struct {
    prevCount   int
    currCount   int
    windowStart time.Time
}

func NewSlidingWindowCounterLimiter(rate int, window time.Duration) *SlidingWindowCounterLimiter {
    return &SlidingWindowCounterLimiter{
        rate:   rate,
        window: window,
        counts: make(map[string]*slidingWindow),
    }
}

func (l *SlidingWindowCounterLimiter) Allow(key string) (bool, int, time.Time) {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()

    sw, exists := l.counts[key]
    if !exists {
        sw = &slidingWindow{
            windowStart: now.Truncate(l.window),
        }
        l.counts[key] = sw
    }

    // Check if we need to advance window
    currentWindowStart := now.Truncate(l.window)
    if currentWindowStart.After(sw.windowStart) {
        if currentWindowStart.Sub(sw.windowStart) >= l.window {
            // More than one window has passed
            sw.prevCount = 0
        } else {
            sw.prevCount = sw.currCount
        }
        sw.currCount = 0
        sw.windowStart = currentWindowStart
    }

    // Calculate weighted count
    // Weight for previous window based on how much of current window has elapsed
    elapsed := now.Sub(sw.windowStart)
    weight := float64(l.window-elapsed) / float64(l.window)
    weightedCount := float64(sw.prevCount)*weight + float64(sw.currCount)

    remaining := l.rate - int(weightedCount)
    if remaining <= 0 {
        return false, 0, sw.windowStart.Add(l.window)
    }

    sw.currCount++
    return true, remaining - 1, sw.windowStart.Add(l.window)
}
```

### Token Bucket

The token bucket refills continuously by computing elapsed seconds since the last refill rather than ticking on a timer, so the calculation stays accurate regardless of when `Allow` is called. `AllowN` lets callers consume multiple tokens for one logical operation. This is useful when some requests cost more than others, such as a bulk endpoint that processes a variable number of items.

```go
// ... imports omitted for brevity (sync, time)

// TokenBucketLimiter implements token bucket algorithm
type TokenBucketLimiter struct {
    rate       float64 // tokens per second
    bucketSize int     // maximum tokens
    mu         sync.Mutex
    buckets    map[string]*bucket
}

type bucket struct {
    tokens     float64
    lastRefill time.Time
}

func NewTokenBucketLimiter(rate float64, bucketSize int) *TokenBucketLimiter {
    return &TokenBucketLimiter{
        rate:       rate,
        bucketSize: bucketSize,
        buckets:    make(map[string]*bucket),
    }
}

func (l *TokenBucketLimiter) Allow(key string) (bool, int, time.Time) {
    return l.AllowN(key, 1)
}

func (l *TokenBucketLimiter) AllowN(key string, n int) (bool, int, time.Time) {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()

    b, exists := l.buckets[key]
    if !exists {
        b = &bucket{
            tokens:     float64(l.bucketSize),
            lastRefill: now,
        }
        l.buckets[key] = b
    }

    // Refill tokens
    elapsed := now.Sub(b.lastRefill).Seconds()
    b.tokens += elapsed * l.rate
    if b.tokens > float64(l.bucketSize) {
        b.tokens = float64(l.bucketSize)
    }
    b.lastRefill = now

    // Check if we have enough tokens
    if b.tokens < float64(n) {
        // Calculate when we'll have enough tokens.
        // Note: compute in float64 seconds then convert to Duration in nanoseconds
        // to avoid truncating sub-second waits like 0.3s → 0.
        needed := float64(n) - b.tokens
        waitSeconds := needed / l.rate
        waitTime := time.Duration(waitSeconds * float64(time.Second))
        return false, int(b.tokens), now.Add(waitTime)
    }

    // Consume tokens
    b.tokens -= float64(n)

    // Reset is when the bucket would be full again. Same rule as above:
    // scale into nanoseconds inside the conversion, never Duration(f) * time.Second.
    refillSeconds := (float64(l.bucketSize) - b.tokens) / l.rate
    return true, int(b.tokens), now.Add(time.Duration(refillSeconds * float64(time.Second)))
}

// SetTokens allows setting tokens for a key (for testing or manual adjustment)
func (l *TokenBucketLimiter) SetTokens(key string, tokens float64) {
    l.mu.Lock()
    defer l.mu.Unlock()

    if b, exists := l.buckets[key]; exists {
        b.tokens = tokens
    } else {
        l.buckets[key] = &bucket{
            tokens:     tokens,
            lastRefill: time.Now(),
        }
    }
}
```

### Leaky Bucket

The leaky bucket models the request queue as a water level: incoming requests add water, and the bucket drains at a constant `rate` over time. Unlike the token bucket, which permits instantaneous bursts up to `bucketSize`, the leaky bucket enforces a strictly constant output rate, making it ideal for downstream services that cannot absorb any burst load.

```go
// ... imports omitted for brevity (sync, time)

// LeakyBucketLimiter implements leaky bucket algorithm
type LeakyBucketLimiter struct {
    rate       float64 // requests per second (leak rate)
    bucketSize int     // queue capacity
    mu         sync.Mutex
    buckets    map[string]*leakyBucket
}

type leakyBucket struct {
    water    float64 // current water level
    lastLeak time.Time
}

func NewLeakyBucketLimiter(rate float64, bucketSize int) *LeakyBucketLimiter {
    return &LeakyBucketLimiter{
        rate:       rate,
        bucketSize: bucketSize,
        buckets:    make(map[string]*leakyBucket),
    }
}

func (l *LeakyBucketLimiter) Allow(key string) (bool, int, time.Time) {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()

    b, exists := l.buckets[key]
    if !exists {
        b = &leakyBucket{
            water:    0,
            lastLeak: now,
        }
        l.buckets[key] = b
    }

    // Leak water
    elapsed := now.Sub(b.lastLeak).Seconds()
    leaked := elapsed * l.rate
    b.water -= leaked
    if b.water < 0 {
        b.water = 0
    }
    b.lastLeak = now

    // Try to add water (request)
    if b.water >= float64(l.bucketSize) {
        // Bucket is full. Compute when one unit of space will have drained.
        // Note the conversion order: scale to nanoseconds *inside* the
        // time.Duration() call. Writing time.Duration(x) * time.Second
        // truncates x to a whole number first, so any sub-second wait
        // silently becomes zero and the caller hot-loops.
        waitSeconds := (b.water - float64(l.bucketSize) + 1) / l.rate
        return false, 0, now.Add(time.Duration(waitSeconds * float64(time.Second)))
    }

    b.water++
    remaining := l.bucketSize - int(b.water)
    drainSeconds := b.water / l.rate
    return true, remaining, now.Add(time.Duration(drainSeconds * float64(time.Second)))
}
```

### Satisfying the `RateLimiter` Interface

Each limiter above shows only the method that carries its algorithm. The `RateLimiter` interface from 42.1 asks for three methods, `Allow`, `AllowN`, and `Limit`, and the middleware in 42.3 stores these types in a `map[string]RateLimiter`. Without the remaining methods that assignment does not compile: `*TokenBucketLimiter does not implement RateLimiter (missing method Limit)`. The gap is easy to miss because each type reads fine in isolation. Interface satisfaction in Go is checked at the point of assignment, not at the point of definition, so the error surfaces in a different file from the one you are editing.

Add the missing methods. They are mechanical, which is exactly why they get forgotten.

```go
func (l *FixedWindowLimiter) Limit() int { return l.rate }

func (l *SlidingWindowLogLimiter) Limit() int { return l.rate }

func (l *SlidingWindowLogLimiter) AllowN(key string, n int) (bool, int, time.Time) {
    // The log stores one timestamp per request, so n requests means n entries.
    // Reject the whole batch if it does not fit: partial admission would leave
    // the caller unsure how many of its n units were actually charged.
    l.mu.Lock()
    defer l.mu.Unlock()
    // ... same prune-then-count as Allow, then push n timestamps ...
    return false, 0, time.Now()
}

func (l *SlidingWindowCounterLimiter) Limit() int { return l.rate }

func (l *SlidingWindowCounterLimiter) AllowN(key string, n int) (bool, int, time.Time) {
    // ... same weighted blend as Allow, but compare remaining against n
    // and add n to currCount rather than incrementing by one ...
    return false, 0, time.Now()
}

func (l *TokenBucketLimiter) Limit() int { return l.bucketSize }

func (l *LeakyBucketLimiter) Limit() int { return l.bucketSize }

func (l *LeakyBucketLimiter) AllowN(key string, n int) (bool, int, time.Time) {
    // ... leak, then check water+n against bucketSize ...
    return false, 0, time.Now()
}

// Compile-time assertions. Put these next to the type definitions and the
// compiler tells you about a missing method at the definition site, before
// some distant middleware file fails to build.
var (
    _ RateLimiter = (*FixedWindowLimiter)(nil)
    _ RateLimiter = (*SlidingWindowLogLimiter)(nil)
    _ RateLimiter = (*SlidingWindowCounterLimiter)(nil)
    _ RateLimiter = (*TokenBucketLimiter)(nil)
    _ RateLimiter = (*LeakyBucketLimiter)(nil)
)
```

Note what `Limit()` means for each algorithm. For the window-based limiters it is requests per window, a number the client can reason about directly. For the token bucket it is the bucket size, which is the burst ceiling rather than the steady-state rate. Those are different quantities, and reporting the bucket size as a per-window limit in a response header will mislead clients. This is the first hint that a single `Limit() int` is too narrow a contract, which is precisely why the IETF header draft describes a policy with both a quota and a window rather than one integer.

### Junior → FAANG: Algorithm Fluency as an Interview Differentiator

Most candidates who interview for backend roles at FAANG can name token bucket and sliding window. Fewer can explain the boundary burst problem of fixed window with a concrete number. Fewer still can describe the memory trade-off between sliding window log (O(rate) per key) and sliding window counter (O(1) per key) and tell you when the extra memory cost of the log is worth paying.

Build your fluency by running the algorithms mentally against a concrete scenario before the interview. Example: "A user is allowed 10 requests per minute. At 0:59 they send 10 requests. At 1:01 they try to send 10 more. How many of the second batch does each algorithm allow?"

Fixed window allows all 10. The counter reset at 1:00, so the user got 20 requests through in two seconds against a stated limit of 10 per minute. That is the boundary burst, and it is exactly 2x rate in the worst case.

Sliding window log allows zero. At 1:01 the rolling window covers 0:01 through 1:01, which still contains all 10 timestamps from 0:59. The user is at their limit and stays there until 1:59, when the first of those timestamps ages out.

Sliding window counter allows one. One second into the new window the previous window is weighted at 59/60, so the blended count is `10 * 0.983 + 0 = 9.83`. The code takes `int(9.83)` which floors to 9, leaving a remaining of 1. That single extra request is the price of the approximation, and it is why the counter is described as approximating the log rather than matching it.

If your mental model produced 10 for the sliding window counter because "the window reset," you have just rediscovered why the weighting exists. Run the numbers rather than trusting the intuition.

The cleanup goroutine in `FixedWindowLimiter` is worth understanding deeply. It uses `time.NewTicker` at the window interval. If the window is one minute and you have a million unique IP addresses, the cleanup runs once per minute and iterates the full map. For very large deployments, that iteration takes measurable time and holds the mutex. A first-job exercise: modify the cleanup to use a shorter tick interval and only delete entries that have been expired for more than two windows, reducing peak lock contention.

For the token bucket `AllowN` method, trace through what happens when `n` is larger than the current token count and also larger than the bucket size. The code computes a wait time based on how many tokens are needed. If `n > bucketSize`, the wait time will never result in enough tokens. Your limiter should validate that `n <= bucketSize` and return an error immediately rather than returning a nonsensical wait duration.

### Senior @ FAANG: Algorithm Selection as an Architectural Decision and Redis Implementation Strategy

At L6 and above, algorithm selection is not a performance benchmark exercise. It is an exercise in matching algorithm properties to system contracts.

**Fixed window for billing reset alignment.** Fixed window is underrated for billing use cases. When your product resets usage at the start of each calendar month, fixed window with a monthly period aligns perfectly with what customers see on their invoice. The boundary burst is acceptable in this context because the window is 30 days and the burst happens once per month. A sliding window in this context would give customers a confusing experience: "I used exactly 1000 API calls last month but my quota reset is not at month start." Choose fixed window intentionally for billing-aligned quotas.

**Sliding window counter accuracy under approximation.** The weighted blend formula (`prevCount * weight + currCount`) assumes uniform request distribution within the previous window. If requests are bursty within the window, the approximation can undercount by up to one window's worth of requests. For most APIs this is acceptable. For a financial API with strict compliance requirements, the approximation might not be. Sliding window log gives exact counts at O(rate) memory cost. The decision of which to use belongs in the ADR, with a quantified statement of the maximum permissible overshoot.

**Redis Lua script as the authoritative distributed algorithm.** The in-process implementations here are correct for single-instance deployments and nothing more. Every one of them keeps its state in a Go map on one heap, so with three replicas behind a load balancer each replica enforces the full limit against one third of the traffic, and the client's effective limit is 3x what you configured. For multi-instance deployments you need shared state plus atomicity, which is what a Lua script on Redis buys you: the script runs to completion without interleaving, so the read and the write cannot be split by another replica.

Which algorithm you port matters. A **sliding window log** in Redis is a sorted set per key: ZREMRANGEBYSCORE to drop entries older than the window, ZCARD to count what is left, ZADD to record the current request, and EXPIRE so an idle key does not live forever. It is exact, and it costs one sorted-set member per request in memory, which is why nobody runs it at edge scale with generous limits. A **sliding window counter** in Redis is two integer keys (previous and current window) and the same weighted blend used above, at constant memory per key.

Note that `github.com/go-redis/redis_rate` implements neither of these. It implements GCRA, a leaky-bucket formulation that stores a single value per key (the theoretical arrival time of the next conforming request) and derives everything else arithmetically. Reading its Lua source is a worthwhile exercise precisely because it looks nothing like the counter-based scripts most tutorials show. Do not assume a library's algorithm from its category. Read the script.

**Token bucket correctness for float64 refill.** The refill computation `b.tokens += elapsed * l.rate` uses floating-point arithmetic. At high request rates, floating-point rounding accumulates over time. A more clean implementation tracks `lastRefillNs int64` (nanoseconds as an integer) and computes `elapsed = (nowNs - lastRefillNs)`. The token increment is then `(elapsed * rateNumerator) / rateDenominator` using integer arithmetic where `rateNumerator` and `rateDenominator` are derived from the rate. This eliminates floating-point drift over long-running processes. This level of correctness is expected in FAANG system design reviews for high-frequency trading or billing systems where token leakage would be a financial issue.

**Leaky bucket and the downstream contract.** The leaky bucket is often the right choice when the downstream service has a hard concurrency limit: a legacy database that can handle exactly 50 concurrent queries, or an external API with a contractual steady-state rate. The leaky bucket's output is provably constant regardless of input burst, which is the property the downstream needs. Pair it with a queue size metric and an alert at 80 percent queue fullness, so operations teams know when upstream demand is consistently exceeding downstream capacity before requests start being dropped.
