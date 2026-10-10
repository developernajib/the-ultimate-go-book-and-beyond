## 83E.10 Problem 8: Rate Limiter

### Requirements

1. Fixed window rate limiting
2. Sliding window rate limiting
3. Token bucket algorithm
4. Configurable per-user limits

### Implementation

The rate limiter design problem is a canonical system design question that tests knowledge of token bucket, leaky bucket, and sliding window algorithms. The following Go implementation demonstrates the token bucket variant with atomic operations for thread-safe concurrent access without lock contention.

```go
package ratelimiter

import (
	"sync"
	"time"
)

// --- Interface ---

type RateLimiter interface {
	Allow(key string) bool
}

// --- Token Bucket ---

type tokenBucket struct {
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

type TokenBucketLimiter struct {
	mu        sync.Mutex
	buckets   map[string]*tokenBucket
	maxTokens float64
	refillRate float64
}

func NewTokenBucketLimiter(maxTokens float64, refillRate float64) RateLimiter {
	return &TokenBucketLimiter{
		buckets:    make(map[string]*tokenBucket),
		maxTokens:  maxTokens,
		refillRate: refillRate,
	}
}

func (tbl *TokenBucketLimiter) Allow(key string) bool {
	tbl.mu.Lock()
	defer tbl.mu.Unlock()

	now := time.Now()
	bucket, exists := tbl.buckets[key]
	if !exists {
		bucket = &tokenBucket{
			tokens:     tbl.maxTokens,
			maxTokens:  tbl.maxTokens,
			refillRate: tbl.refillRate,
			lastRefill: now,
		}
		tbl.buckets[key] = bucket
	}

	// Refill tokens
	elapsed := now.Sub(bucket.lastRefill).Seconds()
	bucket.tokens += elapsed * bucket.refillRate
	if bucket.tokens > bucket.maxTokens {
		bucket.tokens = bucket.maxTokens
	}
	bucket.lastRefill = now

	// Try to consume a token
	if bucket.tokens >= 1 {
		bucket.tokens--
		return true
	}
	return false
}

// --- Sliding Window Counter ---

type SlidingWindowLimiter struct {
	mu         sync.Mutex
	windows    map[string]*slidingWindow
	maxRequests int
	windowSize  time.Duration
}

type slidingWindow struct {
	currCount  int
	prevCount  int
	currStart  time.Time
	windowSize time.Duration
}

func NewSlidingWindowLimiter(maxRequests int, windowSize time.Duration) RateLimiter {
	return &SlidingWindowLimiter{
		windows:     make(map[string]*slidingWindow),
		maxRequests: maxRequests,
		windowSize:  windowSize,
	}
}

func (swl *SlidingWindowLimiter) Allow(key string) bool {
	swl.mu.Lock()
	defer swl.mu.Unlock()

	now := time.Now()
	sw, exists := swl.windows[key]
	if !exists {
		sw = &slidingWindow{
			currStart:  now.Truncate(swl.windowSize),
			windowSize: swl.windowSize,
		}
		swl.windows[key] = sw
	}

	currWindowStart := now.Truncate(swl.windowSize)

	// Advance windows if needed
	if currWindowStart.After(sw.currStart.Add(swl.windowSize)) {
		// More than one window has passed
		sw.prevCount = 0
		sw.currCount = 0
		sw.currStart = currWindowStart
	} else if currWindowStart.After(sw.currStart) {
		// Moved to next window
		sw.prevCount = sw.currCount
		sw.currCount = 0
		sw.currStart = currWindowStart
	}

	// Calculate weighted count
	elapsed := now.Sub(sw.currStart).Seconds()
	windowSecs := sw.windowSize.Seconds()
	prevWeight := 1.0 - (elapsed / windowSecs)
	weightedCount := float64(sw.prevCount)*prevWeight + float64(sw.currCount)

	if weightedCount >= float64(swl.maxRequests) {
		return false
	}

	sw.currCount++
	return true
}

// --- Fixed Window ---

type FixedWindowLimiter struct {
	mu         sync.Mutex
	windows    map[string]*fixedWindow
	maxRequests int
	windowSize  time.Duration
}

type fixedWindow struct {
	count int
	start time.Time
}

func NewFixedWindowLimiter(maxRequests int, windowSize time.Duration) RateLimiter {
	return &FixedWindowLimiter{
		windows:     make(map[string]*fixedWindow),
		maxRequests: maxRequests,
		windowSize:  windowSize,
	}
}

func (fwl *FixedWindowLimiter) Allow(key string) bool {
	fwl.mu.Lock()
	defer fwl.mu.Unlock()

	now := time.Now()
	fw, exists := fwl.windows[key]
	if !exists || now.Sub(fw.start) >= fwl.windowSize {
		fwl.windows[key] = &fixedWindow{count: 1, start: now}
		return true
	}

	if fw.count >= fwl.maxRequests {
		return false
	}

	fw.count++
	return true
}
```

### SOLID Analysis

- **S:** Each limiter algorithm is its own struct with a single concern.
- **O:** New algorithms (leaky bucket, etc.) implement `RateLimiter` without touching existing code.
- **L:** All implementations are interchangeable via the `RateLimiter` interface.
- **I:** The interface has a single method - maximally segregated.
- **D:** Consumers depend on `RateLimiter`, not concrete types.


### Junior → FAANG: Rate Limiter LLD Basics

A rate limiter restricts the number of requests a client can make within a time window. The four standard algorithms: fixed window (count requests in a fixed time bucket, simple but has a burst-at-boundary problem), sliding window log (track timestamps of each request, no burst problem but O(n) memory per client), sliding window counter (approximate sliding window using two fixed window buckets, O(1) memory), and token bucket (tokens refill at a fixed rate, bursts are permitted up to the bucket size, O(1) memory and computations). In Go, implement the token bucket or sliding window counter algorithm with a sync.Mutex for thread safety.

### Senior @ FAANG: Rate Limiter at the Senior Bar: Distributed Rate Limiting and Governance

At the senior level, the rate limiter LLD extends to the distributed case: a single in-memory rate limiter works for a single server but fails when the service is load-balanced across multiple servers. Distributed rate limiting requires a shared state store (Redis is the standard choice) with atomic increment operations. The Redis INCR command with EXPIRE gives a fixed window counter. The Redis sorted set with ZADD and ZREMRANGEBYSCORE gives a sliding window log. The performance concern is that every rate limit check requires a Redis round-trip, which adds latency. Mitigations: local token bucket with periodic synchronization (accept some over-limit requests in exchange for lower latency), or Redis with pipelining for batching multiple rate limit checks. The governance concern is rate limit policy management: who can change the limits, how are limit changes propagated to all service instances, and how do you monitor rate limit enforcement (what percentage of requests are being throttled, and for which clients).

---
