## Common Mistakes and How to Avoid Them

### 1. Not Handling Clock Drift in Distributed Systems

Distributed rate limiters that compare `time.Now()` across multiple application servers are subtly broken: NTP drift of even a few milliseconds can cause one server to accept a request that another would reject, making the effective rate limit higher than intended. The correct fix is to source the current time from the Redis server itself using the `TIME` command, giving all application instances a consistent clock reference regardless of local system clock accuracy.

```go
// Wrong: Assuming synchronized clocks
func (sw *SlidingWindow) Allow(key string) bool {
    now := time.Now().UnixMilli()
    // Problem: Different servers have different "now"
}

// Correct: Use Redis server time or NTP
func (sw *SlidingWindow) Allow(ctx context.Context, key string) (bool, error) {
    // Use Redis TIME command for consistent time
    serverTime, err := sw.client.Time(ctx).Result()
    if err != nil {
        return false, err
    }
    now := serverTime.UnixMilli()
    // Use this consistent time for all operations
}
```

### 2. Race Conditions in Check-Then-Act

A non-atomic check-then-act sequence lets multiple concurrent goroutines read the same count, all see a value below the limit, and all increment it, allowing far more requests through than intended. The window between `GET` and `INCR` is a classic TOCTOU (time-of-check/time-of-use) race that worsens under high concurrency. The Lua script below eliminates this by executing the `INCR` and `EXPIRE` atomically on the Redis server so no other client can interleave between the read and the write.

```go
// Wrong: Non-atomic check and increment
func (l *Limiter) Allow(key string) bool {
    count := l.redis.Get(key)  // Check
    if count < limit {
        l.redis.Incr(key)      // Act
        return true            // Race condition!
    }
    return false
}

// Correct: Use Lua script for atomicity
script := `
    local count = redis.call("INCR", KEYS[1])
    if count == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
    end
    return count <= tonumber(ARGV[2])
`
```

### 3. Not Considering Burst Traffic

Rate limiters that enforce a strict per-second average without allowing any burst reject legitimate traffic during normal usage patterns such as batch uploads, page loads that trigger multiple API calls, or retries after a brief service disruption. Token bucket handles this by decoupling the sustained refill rate from the bucket capacity: a larger capacity allows short bursts while still enforcing the long-term average rate.

```go
// Wrong: Only per-second limiting
limiter := NewTokenBucket(100, 100) // 100/sec

// Correct: Allow controlled bursts
limiter := NewTokenBucket(200, 100) // 200 burst, 100/sec sustained
```

### 4. Single Point of Failure in Rate Limiter

A rate limiter that returns errors when its backing store is unavailable and blocks all traffic as a result is worse than having no rate limiter, it becomes the primary cause of outages rather than a protection mechanism. The correct approach is fail-open: when the primary limiter is down, fall back to a local in-memory limiter that enforces a more conservative limit, ensuring traffic still flows while preventing the worst abuse.

```go
// ❌ Wrong: Rate limiter failure blocks all traffic
func (mw *RateLimitMiddleware) Handle(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        allowed, err := mw.limiter.Allow(r.Context(), getClientID(r))
        if err != nil {
            http.Error(w, "Rate limiter unavailable", http.StatusServiceUnavailable)
            return // All traffic blocked when limiter is down!
        }
        if !allowed {
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

```go
// ✅ Correct: Graceful degradation with fallback
type ResilientRateLimiter struct {
    primary       RateLimiter
    fallback      RateLimiter  // Local in-memory fallback
    circuitBreaker *CircuitBreaker
}

func (rl *ResilientRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    // Try primary with circuit breaker
    if rl.circuitBreaker.Allow() {
        allowed, err := rl.primary.Allow(ctx, key)
        if err == nil {
            rl.circuitBreaker.RecordSuccess()
            return allowed, nil
        }
        rl.circuitBreaker.RecordFailure()
    }

    // Fallback to local limiter (may allow slightly more, but keeps service running)
    return rl.fallback.Allow(ctx, key)
}

func (mw *RateLimitMiddleware) Handle(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        allowed, err := mw.limiter.Allow(r.Context(), getClientID(r))
        if err != nil {
            // Log but don't block - fail open
            log.Warn("rate limiter error, allowing request", "error", err)
            allowed = true
        }
        if !allowed {
            w.Header().Set("Retry-After", "60")
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### 5. Memory Leaks from Unbounded State

In-memory rate limiters that create a new bucket for every unique key (IP address, user ID, API key) without any eviction policy will consume memory proportional to the number of distinct clients seen over the process lifetime. For a public-facing API, this can mean millions of entries from one-time visitors that never return. The fix is LRU eviction capped at a maximum entry count, combined with periodic TTL-based cleanup for stale entries that have not been accessed recently.

```go
// ❌ Wrong: Unbounded memory growth
type LeakyRateLimiter struct {
    buckets map[string]*TokenBucket // Grows forever!
}

func (rl *LeakyRateLimiter) Allow(key string) bool {
    if _, ok := rl.buckets[key]; !ok {
        rl.buckets[key] = NewTokenBucket(100, 10)
    }
    return rl.buckets[key].Allow()
}
// Problem: Every unique IP/user creates an entry that's never cleaned up
```

```go
// ✅ Correct: LRU eviction and TTL
type BoundedRateLimiter struct {
    mu       sync.RWMutex
    buckets  map[string]*boundedBucket
    maxSize  int
    eviction *list.List // LRU order
    lruMap   map[string]*list.Element
}

type boundedBucket struct {
    key        string
    bucket     *TokenBucket
    lastAccess time.Time
}

func (rl *BoundedRateLimiter) Allow(key string) bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    // Get or create bucket
    if entry, ok := rl.buckets[key]; ok {
        entry.lastAccess = time.Now()
        // Move to front of LRU
        rl.eviction.MoveToFront(rl.lruMap[key])
        return entry.bucket.Allow()
    }

    // Create new bucket
    if len(rl.buckets) >= rl.maxSize {
        // Evict oldest
        oldest := rl.eviction.Back()
        if oldest != nil {
            evictKey := oldest.Value.(*boundedBucket).key
            delete(rl.buckets, evictKey)
            delete(rl.lruMap, evictKey)
            rl.eviction.Remove(oldest)
        }
    }

    entry := &boundedBucket{
        key:        key,
        bucket:     NewTokenBucket(100, 10),
        lastAccess: time.Now(),
    }
    rl.buckets[key] = entry
    elem := rl.eviction.PushFront(entry)
    rl.lruMap[key] = elem

    return entry.bucket.Allow()
}

// Also run periodic cleanup for stale entries
func (rl *BoundedRateLimiter) cleanup() {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    cutoff := time.Now().Add(-1 * time.Hour)
    for key, entry := range rl.buckets {
        if entry.lastAccess.Before(cutoff) {
            delete(rl.buckets, key)
            if elem, ok := rl.lruMap[key]; ok {
                rl.eviction.Remove(elem)
                delete(rl.lruMap, key)
            }
        }
    }
}
```

---

### Junior → FAANG: Common Mistakes as Interview Signals

The mistakes in this section are exactly the issues that FAANG interviewers look for when they probe a candidate's rate limiter design. Knowing what is wrong with each anti-pattern before the interview means you can proactively address them rather than having them pointed out.

**Clock drift is a failure mode, not a theoretical concern.** NTP synchronization on Linux has typical accuracy of 1-10ms. On virtualized hardware (cloud instances), it can drift by 100ms or more. For a sliding window rate limiter with a 1-second window, a 100ms clock discrepancy between pods means the effective window size varies between 900ms and 1100ms. This allows up to 10% more requests than the nominal limit. For most use cases this is acceptable. For billing-critical limits, it is not. The mitigation (using Redis `TIME` for a consistent clock reference) is correct. Know when to apply it.

**The check-then-act TOCTOU race is the canonical distributed systems bug.** Read the value, check if it is below the limit, increment if yes. Between the read and the increment, another process increments the same value. Both processes read 99, both check that 99 < 100, both increment to 100. Now the count is 100 but two requests were allowed at the 99 boundary. The Lua script eliminates this by making the read-check-increment atomic. This is not just a rate limiter bug: TOCTOU races appear in inventory systems, auction systems, and any system where multiple concurrent actors compete for a finite resource.

**Memory leaks in in-process rate limiters are a slow-motion disaster.** The unbounded map grows by one entry for every unique client IP or user ID ever seen. For a public API, this means the map grows continuously with the internet's IP space. After 24 hours of traffic, the map may contain millions of entries, consuming gigabytes of memory and causing GC pauses that add latency to every request. The LRU-bounded implementation with a maximum entry count and periodic cleanup is the correct solution. Know the `container/list` LRU pattern: maintain a doubly-linked list in LRU order (most recently used at front, least recently used at back) and a map from key to list element for O(1) access.

---

### Senior @ FAANG: Root Cause Analysis and Systematic Defense

At L6/L7, the common mistakes in this section are not just coding errors. They are architectural failure modes that require systematic defenses: code review checklists, automated detection, and monitoring alerts that catch the failure before it becomes an incident.

**Clock drift must be a monitored operational metric.** The mitigation for clock drift is to use Redis TIME. But what if the code change is reverted in a future refactor? The correct defense-in-depth: (1) use Redis TIME in the rate limiter code, (2) add a clock drift monitor that runs as a sidecar and measures the difference between the pod's `time.Now()` and Redis's `TIME` command, emitting a metric `rate_limiter.clock_drift_ms`, (3) alert when this metric exceeds 50ms for any pod, (4) add a CI lint rule that fails if `time.Now()` is used in rate limiter code (instead of the injected clock interface). Three independent layers ensure the clock drift problem cannot reappear silently.

**The TOCTOU race requires a code review invariant.** Every distributed rate limiter that touches Redis must use a Lua script for any read-modify-write sequence. Enforce this as a code review requirement: any Redis operation in the rate limiter that involves a read followed by a write must use a Lua script or a Redis transaction with WATCH. Document this invariant in the codebase's CONTRIBUTING.md and in the code review checklist. Add a linter that flags any sequence of `redis.Get` followed by `redis.Incr` without an intervening Lua script evaluation.

**Memory leak detection requires runtime monitoring.** The bounded LRU implementation is correct, but the `maxSize` parameter must be tuned against available memory. If `maxSize` is set to 10 million entries and each entry consumes 200 bytes, the map consumes 2 GB at capacity. Monitor the Go runtime's heap size and the rate limiter's bucket count as metrics. Alert when bucket count approaches `maxSize * 0.9` (90% full), which means the LRU eviction is actively running and the map is at capacity. Also monitor eviction rate: if evictions are happening frequently for keys that were only seen once (high-entropy attacker IPs from a DDoS), the LRU is being used as a general-purpose deduplicator rather than a working-set cache, and the `maxSize` may need to be reduced to prevent a memory cliff.
