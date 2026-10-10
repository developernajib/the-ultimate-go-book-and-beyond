## 61.2 Rate Limiting Algorithms

### Algorithm Comparison

| Algorithm | Memory | Accuracy | Burst Handling | Complexity |
|-----------|--------|----------|----------------|------------|
| Token Bucket | O(1) | High | Allows bursts up to bucket size | Medium |
| Leaky Bucket | O(1) | High | Smooths out bursts | Medium |
| Fixed Window | O(1) | Medium | Double rate at boundaries | Low |
| Sliding Window Log | O(n) | Very High | Accurate | High |
| Sliding Window Counter | O(1) | High | Good approximation | Medium |

### Token Bucket Algorithm

The token bucket algorithm allows controlled bursting: tokens accumulate in the bucket at a fixed refill rate up to a maximum capacity, and each request consumes one token. This models real-world traffic patterns where short bursts above the sustained rate are acceptable, distinguishing it from the leaky bucket which enforces a strict constant output rate. The Go implementation uses atomic operations or a mutex-protected struct to track token count and last refill time, refilling fractional tokens on each request based on elapsed time.

```go
// algorithms/token_bucket.go
package algorithms

import (
    "sync"
    "time"
)

// TokenBucket implements the token bucket algorithm
type TokenBucket struct {
    mu         sync.Mutex
    capacity   float64       // Maximum tokens
    tokens     float64       // Current tokens
    rate       float64       // Tokens per second
    lastRefill time.Time     // Last refill time
}

// NewTokenBucket creates a new token bucket
func NewTokenBucket(capacity float64, rate float64) *TokenBucket {
    return &TokenBucket{
        capacity:   capacity,
        tokens:     capacity, // Start full
        rate:       rate,
        lastRefill: time.Now(),
    }
}

// Allow checks if n tokens are available and consumes them
func (tb *TokenBucket) Allow(n float64) bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    tb.refill()

    if tb.tokens >= n {
        tb.tokens -= n
        return true
    }
    return false
}

// refill adds tokens based on elapsed time
func (tb *TokenBucket) refill() {
    now := time.Now()
    elapsed := now.Sub(tb.lastRefill).Seconds()
    tb.lastRefill = now

    tb.tokens += elapsed * tb.rate
    if tb.tokens > tb.capacity {
        tb.tokens = tb.capacity
    }
}

// AllowN checks if a request should be allowed and returns status
func (tb *TokenBucket) AllowN(n float64) (allowed bool, remaining float64, resetAfter time.Duration) {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    tb.refill()

    if tb.tokens >= n {
        tb.tokens -= n
        return true, tb.tokens, 0
    }

    // Calculate time until enough tokens are available
    deficit := n - tb.tokens
    resetAfter = time.Duration(deficit/tb.rate*1000) * time.Millisecond

    return false, 0, resetAfter
}

// Tokens returns current available tokens
func (tb *TokenBucket) Tokens() float64 {
    tb.mu.Lock()
    defer tb.mu.Unlock()
    tb.refill()
    return tb.tokens
}
```

### Leaky Bucket Algorithm

Unlike the token bucket, the leaky bucket enforces a strictly constant output rate by treating incoming requests as water poured into a bucket that drains at a fixed pace, bursts fill the bucket rather than being served immediately. When the bucket is full, new requests are rejected outright, giving the algorithm strong backpressure properties that protect downstream systems from traffic spikes at the cost of higher latency during bursts. The Go struct tracks the current water level as a `float64` and subtracts the amount that has leaked since the last call on every `Allow` invocation, keeping the implementation stateless between requests.

```go
// algorithms/leaky_bucket.go
package algorithms

import (
    "sync"
    "time"
)

// LeakyBucket implements the leaky bucket algorithm
// Provides smooth, constant rate output regardless of burst input
type LeakyBucket struct {
    mu        sync.Mutex
    capacity  int           // Maximum queue size
    rate      float64       // Requests per second (leak rate)
    water     float64       // Current water level
    lastLeak  time.Time     // Last leak time
}

// NewLeakyBucket creates a new leaky bucket
func NewLeakyBucket(capacity int, rate float64) *LeakyBucket {
    return &LeakyBucket{
        capacity: capacity,
        rate:     rate,
        water:    0,
        lastLeak: time.Now(),
    }
}

// Allow checks if a request can be added to the bucket
func (lb *LeakyBucket) Allow() bool {
    lb.mu.Lock()
    defer lb.mu.Unlock()

    lb.leak()

    if lb.water < float64(lb.capacity) {
        lb.water++
        return true
    }
    return false
}

// leak removes water based on elapsed time
func (lb *LeakyBucket) leak() {
    now := time.Now()
    elapsed := now.Sub(lb.lastLeak).Seconds()
    lb.lastLeak = now

    lb.water -= elapsed * lb.rate
    if lb.water < 0 {
        lb.water = 0
    }
}

// Status returns current bucket status
func (lb *LeakyBucket) Status() (currentLevel float64, available int) {
    lb.mu.Lock()
    defer lb.mu.Unlock()
    lb.leak()
    return lb.water, lb.capacity - int(lb.water)
}
```

### Fixed Window Counter

The fixed window counter divides time into discrete, non-overlapping windows of a configured duration and resets the request count to zero at each boundary. This is the simplest algorithm to implement and reason about, but it suffers from a well-known boundary burst problem: a client can send `limit` requests just before a window closes and another `limit` requests just after it opens, effectively doubling the allowed rate over any short interval that straddles the boundary. The implementation detects a new window by truncating the current timestamp to the window size and comparing it to the stored `windowStart`, resetting the counter atomically under the mutex.

```go
// algorithms/fixed_window.go
package algorithms

import (
    "sync"
    "time"
)

// FixedWindow implements fixed window rate limiting
type FixedWindow struct {
    mu         sync.Mutex
    limit      int64         // Max requests per window
    windowSize time.Duration // Window duration
    count      int64         // Current window count
    windowStart time.Time    // Current window start
}

// NewFixedWindow creates a new fixed window limiter
func NewFixedWindow(limit int64, windowSize time.Duration) *FixedWindow {
    return &FixedWindow{
        limit:       limit,
        windowSize:  windowSize,
        count:       0,
        windowStart: time.Now().Truncate(windowSize),
    }
}

// Allow checks if a request is allowed
func (fw *FixedWindow) Allow() bool {
    fw.mu.Lock()
    defer fw.mu.Unlock()

    now := time.Now()
    windowStart := now.Truncate(fw.windowSize)

    // Check if we're in a new window
    if windowStart.After(fw.windowStart) {
        fw.windowStart = windowStart
        fw.count = 0
    }

    if fw.count < fw.limit {
        fw.count++
        return true
    }
    return false
}

// Status returns current window status
func (fw *FixedWindow) Status() (remaining int64, resetAt time.Time) {
    fw.mu.Lock()
    defer fw.mu.Unlock()

    now := time.Now()
    windowStart := now.Truncate(fw.windowSize)

    if windowStart.After(fw.windowStart) {
        return fw.limit, windowStart.Add(fw.windowSize)
    }

    remaining = fw.limit - fw.count
    if remaining < 0 {
        remaining = 0
    }
    return remaining, fw.windowStart.Add(fw.windowSize)
}
```

### Sliding Window Log

The sliding window log stores the exact timestamp of every accepted request in an ordered list and, on each incoming request, prunes entries older than `windowSize` before counting what remains. This gives perfectly accurate rate limiting with no boundary burst anomaly, but it consumes O(n) memory proportional to the number of allowed requests in the window, making it impractical at very high throughput where the log could hold millions of entries. The `container/list` structure allows O(1) front-removal during cleanup, since expired entries are always at the head of the chronologically ordered list.

```go
// algorithms/sliding_window_log.go
package algorithms

import (
    "container/list"
    "sync"
    "time"
)

// SlidingWindowLog implements sliding window with request log
type SlidingWindowLog struct {
    mu         sync.Mutex
    limit      int64
    windowSize time.Duration
    log        *list.List // List of timestamps
}

// NewSlidingWindowLog creates a new sliding window log limiter
func NewSlidingWindowLog(limit int64, windowSize time.Duration) *SlidingWindowLog {
    return &SlidingWindowLog{
        limit:      limit,
        windowSize: windowSize,
        log:        list.New(),
    }
}

// Allow checks if a request is allowed
func (sw *SlidingWindowLog) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-sw.windowSize)

    // Remove old entries
    for sw.log.Len() > 0 {
        front := sw.log.Front()
        if front.Value.(time.Time).Before(windowStart) {
            sw.log.Remove(front)
        } else {
            break
        }
    }

    if int64(sw.log.Len()) < sw.limit {
        sw.log.PushBack(now)
        return true
    }
    return false
}

// Count returns current request count in window
func (sw *SlidingWindowLog) Count() int64 {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-sw.windowSize)

    // Count valid entries
    count := int64(0)
    for e := sw.log.Front(); e != nil; e = e.Next() {
        if e.Value.(time.Time).After(windowStart) {
            count++
        }
    }
    return count
}
```

### Sliding Window Counter

The sliding window counter approximates the sliding log's accuracy with O(1) memory by keeping only two values: the count in the current fixed window and the count in the previous one. It estimates the number of requests in the true sliding window by weighting the previous window's count by the fraction of the current window period that has not yet elapsed, producing a smooth interpolation that eliminates the hard boundary burst of the plain fixed window counter. The `previousWeight` calculation, `1.0 minus elapsed fraction`, means that as the window slides forward, the influence of the previous window decays linearly to zero, closely approximating a rolling count without storing individual timestamps.

```go
// algorithms/sliding_window_counter.go
package algorithms

import (
    "sync"
    "time"
)

// SlidingWindowCounter implements sliding window with counters
// More memory efficient than log-based approach
type SlidingWindowCounter struct {
    mu             sync.Mutex
    limit          int64
    windowSize     time.Duration
    currentCount   int64
    previousCount  int64
    currentStart   time.Time
}

// NewSlidingWindowCounter creates a new sliding window counter
func NewSlidingWindowCounter(limit int64, windowSize time.Duration) *SlidingWindowCounter {
    return &SlidingWindowCounter{
        limit:        limit,
        windowSize:   windowSize,
        currentStart: time.Now().Truncate(windowSize),
    }
}

// Allow checks if a request is allowed
func (sw *SlidingWindowCounter) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    currentWindowStart := now.Truncate(sw.windowSize)

    // Check if we need to slide the window. Adjacent windows differ by
    // exactly windowSize (both are truncated to multiples of it), so
    // the skip check must be strictly greater: using >= here would
    // zero previousCount on every normal slide and silently degrade
    // this into a plain fixed-window counter.
    if currentWindowStart.After(sw.currentStart) {
        if currentWindowStart.Sub(sw.currentStart) > sw.windowSize {
            // Skipped one or more whole windows: nothing recent to carry
            sw.previousCount = 0
        } else {
            sw.previousCount = sw.currentCount
        }
        sw.currentCount = 0
        sw.currentStart = currentWindowStart
    }

    // Calculate weighted count
    elapsedInWindow := now.Sub(sw.currentStart)
    previousWeight := 1.0 - (float64(elapsedInWindow) / float64(sw.windowSize))
    weightedCount := float64(sw.previousCount)*previousWeight + float64(sw.currentCount)

    if int64(weightedCount) < sw.limit {
        sw.currentCount++
        return true
    }
    return false
}

// Status returns current status
func (sw *SlidingWindowCounter) Status() (remaining int64, count int64) {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    elapsedInWindow := now.Sub(sw.currentStart)
    previousWeight := 1.0 - (float64(elapsedInWindow) / float64(sw.windowSize))
    weightedCount := int64(float64(sw.previousCount)*previousWeight + float64(sw.currentCount))

    remaining = sw.limit - weightedCount
    if remaining < 0 {
        remaining = 0
    }
    return remaining, weightedCount
}
```

---

### Junior → FAANG: Algorithm Selection and Mathematical Intuition

The five algorithms in this section represent a progression from simple to accurate, each with a distinct mathematical property. FAANG interviewers expect you to be able to select the right algorithm for a given use case and explain why.

**Fixed window is only correct for non-adversarial clients.** The fixed window counter allows 2x the nominal rate at window boundaries. For internal services where clients are trusted, this is often acceptable. For public APIs where clients may deliberately exploit boundary bursts, it is not. Know this limitation and always mention it when you propose fixed window: "Fixed window is simple but allows up to 2x the limit at window boundaries. If clients can observe window boundaries, I would use sliding window instead."

**Token bucket is the right choice when bursting is acceptable.** A mobile app that fetches data in batches when the device comes back online should be allowed to send 20 requests in quick succession after a period of inactivity, as long as the sustained rate stays within limits. Token bucket handles this naturally: tokens accumulate during the quiet period and are spent during the batch. Know this use case and use it to explain why you would choose token bucket for mobile API rate limiting.

**Sliding window counter's `previousWeight` calculation is the algorithm.** The formula `(1.0 - elapsedFraction) * previousCount + currentCount` is an approximation of the true sliding window count. At the start of a window (elapsed = 0), the previous window counts fully. At the end of a window (elapsed = window size), the previous window counts zero. This linear interpolation may overestimate or underestimate the true count by at most 1/2 request per request in the previous window, which is negligible for practical rate limits. Be able to explain this approximation and its error bound.

**Know the memory cost of each algorithm.** Fixed window, token bucket, leaky bucket: O(1) per key. Sliding window counter: O(1) per key with two values. Sliding window log: O(n) per key where n is the allowed request count per window. At 1000 requests per minute per user with 10 million users, sliding window log would require 10 billion timestamp entries. This is why sliding window counter is preferred for large-scale deployments.

---

### Senior @ FAANG: Algorithm Selection Under Adversarial Conditions and Mathematical Guarantees

At L6/L7, algorithm selection for rate limiting must be justified in terms of mathematical guarantees under adversarial conditions, not just average-case behavior.

**The boundary burst attack requires quantitative analysis.** For a fixed window limiter with limit L and window W, an adversary can send L requests in the last epsilon seconds of window k and L more requests in the first epsilon seconds of window k+1, for a burst rate of 2L / (2*epsilon) requests per second. As epsilon approaches zero, the instantaneous burst rate approaches infinity. For a sliding window counter, the maximum burst is L requests in any window-sized interval, period. The sliding window counter provides a bounded burst guarantee that fixed window does not. Document this guarantee in the rate limiter's specification.

**Token bucket burst sizing requires domain knowledge.** The burst capacity of a token bucket is not just "how many tokens can accumulate." It is a contractual commitment to downstream services. If your token bucket has capacity 1000 and rate 100/second, a single client can burst 1000 requests before any throttling occurs. If your downstream database can handle 500 concurrent queries, a burst of 1000 simultaneous requests from a single client will overwhelm it. Burst capacity must be sized against downstream capacity. Document the downstream capacity model and the maximum burst that it can safely absorb.

**Algorithm correctness under clock skew in distributed environments.** All five algorithms in this section use `time.Now()` to measure elapsed time. In a distributed deployment, different pods may have different clock values due to NTP drift. For token bucket, a pod with a clock 100ms ahead of the actual time will compute a slightly larger elapsed time and refill slightly more tokens than it should. This over-refills by `100ms * rate` tokens, which is a small percentage of the bucket capacity for typical configurations. Document the clock skew budget: "The system assumes NTP-synchronized clocks with maximum drift of 100ms. Clock drift beyond this budget may allow up to `0.1 * rate` additional requests per pod per second, which is within the 1% accuracy tolerance defined in the SLA." This quantitative analysis is what distinguishes an L6 design from one that hand-waves at the problem.
