## 61.5 Multi-Tier Rate Limiting

Multi-tier rate limiting applies a hierarchy of limits, for example, per-second, per-minute, and per-hour, so that both short-term bursts and sustained overuse are controlled with a single enforcement layer. A request is allowed only if it passes all tier limits simultaneously, preventing clients from spreading requests evenly within per-minute windows while exceeding the per-second limit. Checking tiers from most restrictive (per-second) to least restrictive (per-hour) short-circuits early, avoiding unnecessary Redis round trips when a request is already blocked by a tighter tier.

```go
// multi/multi_tier.go
package multi

import (
    "context"
    "sort"
    "sync"
)

// Tier represents a rate limiting tier
type Tier struct {
    Name     string
    Limiter  RateLimiter
    Priority int // Lower = higher priority
}

// RateLimiter interface for different implementations
type RateLimiter interface {
    Allow(ctx context.Context, key string) (bool, *RateLimitResult, error)
}

// MultiTierLimiter applies multiple rate limiters
type MultiTierLimiter struct {
    tiers []Tier
}

// NewMultiTierLimiter creates a multi-tier rate limiter
func NewMultiTierLimiter(tiers ...Tier) *MultiTierLimiter {
    // Sort by priority
    sorted := make([]Tier, len(tiers))
    copy(sorted, tiers)
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i].Priority < sorted[j].Priority
    })

    return &MultiTierLimiter{tiers: sorted}
}

// Allow checks all tiers and returns combined result
func (m *MultiTierLimiter) Allow(ctx context.Context, key string) (bool, map[string]*RateLimitResult, error) {
    results := make(map[string]*RateLimitResult)
    var mu sync.Mutex
    var wg sync.WaitGroup

    // Check all tiers in parallel. Note the trade-off: a request
    // consumes quota in every tier that allows it even when another
    // tier denies it, so a throttled client is double-penalized.
    // Production systems either check sequentially (most restrictive
    // first, stop at the first denial) or refund tokens on denial.
    for _, tier := range m.tiers {
        wg.Add(1)
        go func(t Tier) {
            defer wg.Done()
            allowed, result, err := t.Limiter.Allow(ctx, key)
            if err != nil {
                return
            }
            result.Allowed = allowed
            mu.Lock()
            results[t.Name] = result
            mu.Unlock()
        }(tier)
    }

    wg.Wait()

    // If any tier denies, deny the request
    for _, result := range results {
        if !result.Allowed {
            return false, results, nil
        }
    }

    return true, results, nil
}

// Example usage:
// globalLimiter := NewRedisTokenBucket(client, "global", 10000, 1000) // 10k burst, 1k/sec
// userLimiter := NewRedisSlidingWindow(client, "user", 100, time.Minute) // 100/min per user
// ipLimiter := NewRedisSlidingWindow(client, "ip", 1000, time.Minute) // 1000/min per IP
//
// multiTier := NewMultiTierLimiter(
//     Tier{Name: "global", Limiter: globalLimiter, Priority: 1},
//     Tier{Name: "ip", Limiter: ipLimiter, Priority: 2},
//     Tier{Name: "user", Limiter: userLimiter, Priority: 3},
// )
```

### Adaptive Rate Limiting

Static rate limits sized for peak load leave capacity unused during normal operation, while limits sized for average load cause cascading failures when the system is under stress. The `AdaptiveLimiter` runs a background goroutine that polls a caller-supplied `loadFunc` every five seconds and adjusts `currentRate` asymmetrically, cutting by 10% when load exceeds the threshold but recovering by only 5% when load drops below half the threshold, so the system backs off quickly but recovers cautiously. The read/write mutex separates the fast `Allow` path (which only reads `currentRate`) from the slower `adjust` path, keeping latency impact minimal on every incoming request.

```go
// adaptive/adaptive.go
package adaptive

import (
    "context"
    "sync"
    "time"

    "yourproject/distributed"
)

// AdaptiveLimiter adjusts rate limits based on system load
type AdaptiveLimiter struct {
    mu            sync.RWMutex
    baseLimiter   *distributed.RedisTokenBucket
    baseRate      float64
    currentRate   float64
    minRate       float64
    maxRate       float64
    loadThreshold float64 // CPU/memory threshold to reduce rate

    // Metrics
    loadFunc     func() float64 // Returns current system load (0-1)
    errorRate    float64
    latencyP99   time.Duration
}

// NewAdaptiveLimiter creates an adaptive rate limiter
func NewAdaptiveLimiter(base *distributed.RedisTokenBucket, config AdaptiveConfig) *AdaptiveLimiter {
    al := &AdaptiveLimiter{
        baseLimiter:   base,
        baseRate:      config.BaseRate,
        currentRate:   config.BaseRate,
        minRate:       config.MinRate,
        maxRate:       config.MaxRate,
        loadThreshold: config.LoadThreshold,
        loadFunc:      config.LoadFunc,
    }

    // Start background adjustment
    go al.adjustLoop()

    return al
}

// adjustLoop periodically adjusts the rate based on conditions
func (al *AdaptiveLimiter) adjustLoop() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        al.adjust()
    }
}

func (al *AdaptiveLimiter) adjust() {
    al.mu.Lock()
    defer al.mu.Unlock()

    load := al.loadFunc()
    newRate := al.currentRate

    if load > al.loadThreshold {
        // Reduce rate by 10%
        newRate = al.currentRate * 0.9
    } else if load < al.loadThreshold*0.5 {
        // Increase rate by 5% (slower increase)
        newRate = al.currentRate * 1.05
    }

    // Clamp to bounds
    if newRate < al.minRate {
        newRate = al.minRate
    }
    if newRate > al.maxRate {
        newRate = al.maxRate
    }

    al.currentRate = newRate
}

// Allow checks if request is allowed with current adaptive rate
func (al *AdaptiveLimiter) Allow(ctx context.Context, key string) (bool, *distributed.RateLimitResult, error) {
    al.mu.RLock()
    currentRate := al.currentRate
    al.mu.RUnlock()

    // Create a temporary limiter with current rate
    // In practice, you'd update the underlying limiter
    return al.baseLimiter.Allow(ctx, key, 1)
}

// CurrentRate returns the current rate
func (al *AdaptiveLimiter) CurrentRate() float64 {
    al.mu.RLock()
    defer al.mu.RUnlock()
    return al.currentRate
}

type AdaptiveConfig struct {
    BaseRate      float64
    MinRate       float64
    MaxRate       float64
    LoadThreshold float64
    LoadFunc      func() float64
}
```

---

### Junior → FAANG: Multi-Tier Limiting and Adaptive Systems

Multi-tier rate limiting is the answer to the question "how do you prevent both short bursts and sustained abuse?" Understanding when to add each tier and what each tier protects against is a common interview follow-up.

**Each tier targets a different abuse pattern.** A per-second tier (10 requests per second) prevents instantaneous floods. A per-minute tier (100 requests per minute) prevents sustained abuse that stays under the per-second limit by spreading requests evenly. A per-day tier (10,000 requests per day) prevents clients from running continuously at the sustained per-minute rate for 24 hours. Each tier is necessary because the others can be exploited without it.

**Check from most restrictive to least restrictive.** The `MultiTierLimiter` checks all tiers in parallel, which is correct for read-heavy implementations. An optimization: check tiers in order of restrictiveness (per-second first). If the per-second check fails, skip the per-minute and per-day checks entirely. This saves two Redis round trips for the common case where a client is bursting. The parallel approach in the section is more complex to implement correctly but eliminates the sequential latency if all checks are needed.

**Adaptive rate limiting is a control system.** The `AdaptiveLimiter` adjusts the rate based on system load. This is a proportional controller: cut by 10% when load exceeds threshold, increase by 5% when load is low. The asymmetric recovery (faster to cut, slower to recover) is deliberate: you want to shed load quickly under pressure but avoid oscillation during recovery. This is the same principle as TCP congestion control. Know the analogy: rate limiter adaptive adjustment is similar to TCP AIMD (Additive Increase Multiplicative Decrease).

**The `loadFunc` is the integration point.** The `AdaptiveLimiter` takes a `loadFunc() float64` callback that returns the current system load as a value from 0 to 1. This function can query CPU utilization, memory pressure, queue depth, or p99 latency. Different metrics work better for different systems. Queue depth (number of requests waiting in a queue) is often the most accurate signal because it directly measures backpressure.

---

### Senior @ FAANG: Multi-Tier Rate Limiting as a Defense-in-Depth Strategy

At L6/L7, multi-tier rate limiting is part of a defense-in-depth strategy that includes CDN-layer, gateway-layer, and application-layer enforcement. Each layer has different accuracy requirements and different operational characteristics.

**CDN-layer rate limiting is volumetric, not precise.** Cloudflare and Akamai rate limiting products are designed to block large-scale DDoS attacks, not to enforce precise per-user quotas. They use probabilistic counting (Count-Min Sketch) and approximate cardinality estimation (HyperLogLog) to make decisions with sub-millisecond latency without Redis. The accuracy is lower (they may block some legitimate traffic or allow some attacker traffic) but the latency impact is negligible. Design the CDN layer to block the top 0.1% of request sources (by volume) and let application-layer rate limiting handle the rest.

**Gateway-layer rate limiting is per-customer, not per-request-type.** An API gateway (Kong, Envoy, AWS API Gateway) enforces per-customer limits (100 requests per minute for free tier, 10,000 for enterprise) across all endpoints. This is the billing and quota enforcement layer. It uses Redis with Lua scripts for accuracy and has a local fallback for Redis unavailability. The gateway layer does not apply per-endpoint limits (those belong in the application layer) and does not apply content-cost-based limits (those require application-layer knowledge of what the request is doing).

**Adaptive rate limiting requires careful monitoring to avoid runaway behavior.** The `AdaptiveLimiter` in this section can reduce the rate to `minRate` under sustained high load. If `minRate` is set too low, the adaptive limiter may inadvertently block all traffic during a brief load spike, causing a self-inflicted outage. If it is set too high, it provides no protection. The correct approach: set `minRate` at 20% of `baseRate` (enough to pass health check traffic and critical operations), set the load threshold at the 95th percentile of normal load (not the peak), and add a rate-limit floor for health check endpoints that bypasses the adaptive limiter entirely. Monitor `currentRate` as a metric and alert when it falls below 50% of `baseRate` for more than 30 seconds, indicating sustained overload.
