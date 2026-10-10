## 61.7 Graceful Degradation

A distributed rate limiter that depends on Redis will fail open (allowing all requests) or fail closed (rejecting all requests) when the Redis connection is unavailable, both of which are problematic in production. The fallback pattern switches transparently to an in-process limiter when the primary distributed backend fails, maintaining approximate rate limiting behavior without creating a hard dependency on Redis availability. The fallback limiter tracks failures using an exponential backoff circuit breaker, periodically retrying the primary backend to restore distributed enforcement when Redis recovers.

```go
// fallback/fallback.go
package fallback

import (
    "context"
    "sync"
    "time"

    "yourproject/distributed"
)

// RateLimiter is the primary limiter interface (see 61.5)
type RateLimiter interface {
    Allow(ctx context.Context, key string) (bool, *distributed.RateLimitResult, error)
}

// FallbackRateLimiter provides fallback when distributed backend fails
type FallbackRateLimiter struct {
    primary   RateLimiter
    fallback  *LocalRateLimiter
    healthCh  chan bool
    healthy   bool
    mu        sync.RWMutex
}

// NewFallbackRateLimiter creates a rate limiter with fallback
func NewFallbackRateLimiter(primary RateLimiter, fallbackConfig LocalConfig) *FallbackRateLimiter {
    fl := &FallbackRateLimiter{
        primary:  primary,
        fallback: NewLocalRateLimiter(fallbackConfig),
        healthCh: make(chan bool, 10),
        healthy:  true,
    }

    go fl.healthMonitor()
    return fl
}

// Allow tries primary, falls back to local if primary fails
func (fl *FallbackRateLimiter) Allow(ctx context.Context, key string) (bool, *distributed.RateLimitResult, error) {
    fl.mu.RLock()
    healthy := fl.healthy
    fl.mu.RUnlock()

    if healthy {
        allowed, result, err := fl.primary.Allow(ctx, key)
        if err == nil {
            return allowed, result, nil
        }

        // Primary failed, signal unhealthy
        select {
        case fl.healthCh <- false:
        default:
        }
    }

    // Use fallback
    return fl.fallback.Allow(ctx, key)
}

// healthMonitor monitors and recovers primary
func (fl *FallbackRateLimiter) healthMonitor() {
    failureCount := 0
    recoveryTicker := time.NewTicker(5 * time.Second)
    defer recoveryTicker.Stop()

    for {
        select {
        case healthy := <-fl.healthCh:
            if !healthy {
                failureCount++
                if failureCount >= 3 {
                    fl.mu.Lock()
                    fl.healthy = false
                    fl.mu.Unlock()
                }
            }

        case <-recoveryTicker.C:
            fl.mu.RLock()
            currentlyHealthy := fl.healthy
            fl.mu.RUnlock()

            if currentlyHealthy {
                // Healthy through a full tick: clear the failure
                // count so old, isolated errors do not accumulate
                // into a spurious unhealthy transition days later.
                failureCount = 0
            }

            if !currentlyHealthy {
                // Try to recover
                ctx, cancel := context.WithTimeout(context.Background(), time.Second)
                _, _, err := fl.primary.Allow(ctx, "__health_check__")
                cancel()

                if err == nil {
                    fl.mu.Lock()
                    fl.healthy = true
                    fl.mu.Unlock()
                    failureCount = 0
                }
            }
        }
    }
}

// LocalRateLimiter is an in-memory fallback limiter
type LocalRateLimiter struct {
    buckets sync.Map
    limit   int64
    window  time.Duration
}

type localBucket struct {
    mu        sync.Mutex
    count     int64
    windowEnd time.Time
}

type LocalConfig struct {
    Limit  int64
    Window time.Duration
}

func NewLocalRateLimiter(config LocalConfig) *LocalRateLimiter {
    return &LocalRateLimiter{
        limit:  config.Limit,
        window: config.Window,
    }
}

func (l *LocalRateLimiter) Allow(ctx context.Context, key string) (bool, *distributed.RateLimitResult, error) {
    now := time.Now()
    windowEnd := now.Truncate(l.window).Add(l.window)

    bucketI, _ := l.buckets.LoadOrStore(key, &localBucket{windowEnd: windowEnd})
    bucket := bucketI.(*localBucket)

    bucket.mu.Lock()
    defer bucket.mu.Unlock()

    // Reset if window expired
    if now.After(bucket.windowEnd) {
        bucket.count = 0
        bucket.windowEnd = windowEnd
    }

    if bucket.count < l.limit {
        bucket.count++
        return true, &distributed.RateLimitResult{
            Allowed:   true,
            Remaining: l.limit - bucket.count,
            Limit:     l.limit,
            ResetAt:   bucket.windowEnd,
        }, nil
    }

    return false, &distributed.RateLimitResult{
        Allowed:    false,
        Remaining:  0,
        Limit:      l.limit,
        ResetAt:    bucket.windowEnd,
        RetryAfter: bucket.windowEnd.Sub(now),
    }, nil
}
```

---

### Junior → FAANG: Graceful Degradation and the Fail-Open Principle

Graceful degradation is one of the most important resilience patterns in distributed systems, and rate limiters are a case study in it. Understanding fail-open vs fail-closed and when each is appropriate is a common interview topic.

**Fail-open means allow traffic when the rate limiter is down.** The `FallbackRateLimiter` uses fail-open: when the primary (Redis) fails, it falls back to a local limiter rather than blocking all traffic. This is the correct choice for most rate limiters because a completely unresponsive API is worse than an API that is slightly over-limit during an infrastructure incident. The local fallback provides approximate enforcement rather than zero enforcement.

**The fallback limit should be more conservative than the primary limit.** If the primary rate limiter allows 1000 requests per minute and the fallback has no limit, then a Redis outage allows unlimited traffic. If the fallback allows 100 requests per minute (per pod), and there are 10 pods, the aggregate fallback limit is 1000 per minute, the same as the primary. This is correct behavior: during a Redis outage, the per-pod local limit provides the same aggregate protection as the distributed limit.

**The health monitor is a simple circuit breaker.** The `healthMonitor` goroutine watches for failure signals and marks the primary as unhealthy after 3 consecutive failures. It then periodically probes the primary with a health check request and marks it healthy again on success. This is the circuit breaker pattern: open (unhealthy), half-open (probing), closed (healthy). Know this pattern and be able to describe it without looking at the code.

**`sync.Map` is appropriate for the fallback limiter's key store.** The `LocalRateLimiter` uses `sync.Map` to store per-key buckets. `sync.Map` is optimized for the case where keys are written once and read many times, which matches the rate limiter pattern (a key is created on the first request from a client and read on every subsequent request). For key stores with high churn (many unique keys that are each seen only once), a sharded mutex-guarded map is more efficient because `sync.Map` has higher overhead for write-heavy workloads.

---

### Senior @ FAANG: Fallback Strategy Design and Operational Recovery

At L6/L7, graceful degradation is not just about having a fallback. It is about designing the fallback to be safe, measurable, and reversible, with documented recovery procedures.

**The fallback limit calibration is a production safety parameter.** The `LocalConfig.Limit` value for the fallback rate limiter must be calibrated against the downstream service's capacity. If the downstream service (database, payment processor) can handle 5000 requests per second from all pods combined, and there are 50 pods, the per-pod fallback limit must be at most 100 requests per second. Setting it higher will allow the downstream service to be overwhelmed during a Redis outage. This calculation must be in the deployment configuration, reviewed at each capacity review, and updated when the number of pods changes.

**Fallback activation must be a visible metric and alert.** The `healthMonitor` goroutine transitions the limiter between healthy and unhealthy states silently. In production, this transition must be observable: emit a metric `rate_limiter.primary_healthy` (1 or 0) that transitions to 0 when the fallback activates. Alert when this metric is 0 for more than 30 seconds: a brief Redis hiccup is acceptable, a sustained outage requires on-call response. Also emit a metric `rate_limiter.fallback_decisions_total` counting the rate limit decisions made by the fallback, so you can see whether the fallback is enforcing limits effectively or effectively allowing everything.

**The health check probe introduces a correctness concern.** The `healthMonitor` probes the primary with `Allow(ctx, "__health_check__")`. This probe consumes a token from the `__health_check__` key's token bucket. Over time, repeated probing may exhaust the health check key's limit and make the probe appear to fail for a different reason than Redis unavailability. Use a dedicated probe that does a simple Redis PING command rather than a rate limit check, so the probe tests Redis connectivity without side effects on the rate limit state.

**Recovery from fallback requires careful state management.** When the primary Redis comes back online after a period where the fallback was active, the Redis keys for all the affected clients are either expired or stale (they reflect the last known state before the outage, not the actual request count during the outage). The effective behavior: when switching back from the fallback to Redis, the Redis counters start fresh for any key that expired during the outage, which may allow a client to immediately burst up to their limit again even if they were at their limit when the outage started. This brief over-limit window immediately after Redis recovery is an accepted property of the fallback design. Document it explicitly and validate that the downstream service can absorb the brief burst without degrading.
