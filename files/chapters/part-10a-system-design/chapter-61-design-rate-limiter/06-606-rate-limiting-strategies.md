## 61.6 Rate Limiting Strategies

### Per-Endpoint Rate Limiting

Per-endpoint rate limiting applies different limits to different routes based on their resource cost and abuse potential, rather than applying a single global limit to all requests. An authentication endpoint might allow only 5 requests per minute per IP to prevent brute-force attacks, while a read-heavy search endpoint allows 100 requests per minute per authenticated user. The `EndpointRateLimiter` maintains a map from route pattern to rate limiter instance, looking up the appropriate limiter on each request and falling back to a default limiter for unregistered routes.

```go
// strategies/endpoint.go
package strategies

import (
    "net/http"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"

    "yourproject/distributed"
)

// EndpointRateLimiter applies different limits per endpoint
type EndpointRateLimiter struct {
    limiters map[string]*distributed.RedisSlidingWindow
    defaults *distributed.RedisSlidingWindow
    mu       sync.RWMutex
}

// EndpointConfig defines rate limit for an endpoint
type EndpointConfig struct {
    Pattern    string // e.g., "POST /api/login"
    Limit      int64
    WindowSize time.Duration
}

// NewEndpointRateLimiter creates endpoint-specific limiter
func NewEndpointRateLimiter(client *redis.Client, configs []EndpointConfig, defaultLimit int64, defaultWindow time.Duration) *EndpointRateLimiter {
    limiters := make(map[string]*distributed.RedisSlidingWindow)

    for _, cfg := range configs {
        limiters[cfg.Pattern] = distributed.NewRedisSlidingWindow(
            client,
            "endpoint:"+cfg.Pattern,
            cfg.Limit,
            cfg.WindowSize,
        )
    }

    return &EndpointRateLimiter{
        limiters: limiters,
        defaults: distributed.NewRedisSlidingWindow(client, "endpoint:default", defaultLimit, defaultWindow),
    }
}

// GetLimiter returns the appropriate limiter for a request
func (el *EndpointRateLimiter) GetLimiter(r *http.Request) *distributed.RedisSlidingWindow {
    pattern := r.Method + " " + r.URL.Path

    el.mu.RLock()
    defer el.mu.RUnlock()

    if limiter, ok := el.limiters[pattern]; ok {
        return limiter
    }

    // Try prefix matching
    for p, limiter := range el.limiters {
        if matchPattern(pattern, p) {
            return limiter
        }
    }

    return el.defaults
}

func matchPattern(path, pattern string) bool {
    // Simple prefix matching, could use more sophisticated matching
    return len(path) >= len(pattern) && path[:len(pattern)] == pattern
}
```

### Tiered API Rate Limiting

Tiered rate limiting aligns API capacity with subscription value by assigning each user a tier at authentication time and looking up the corresponding `TierLimits` on every request. The `TieredRateLimiter` enforces both a per-minute and a per-day ceiling in sequence, short-circuiting on the minute check so that quota-exhausted free-tier users never increment the day counter unnecessarily. Using a `getTierFunc` callback rather than embedding tier lookup logic makes it straightforward to swap in a database query, a JWT claim, or a cache lookup without changing the enforcement code.

```go
// strategies/tiered.go
package strategies

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"

    "yourproject/distributed"
)

// TierLevel represents an API tier
type TierLevel string

const (
    TierFree       TierLevel = "free"
    TierBasic      TierLevel = "basic"
    TierPro        TierLevel = "pro"
    TierEnterprise TierLevel = "enterprise"
)

// TierLimits defines limits per tier
type TierLimits struct {
    RequestsPerMinute int64
    RequestsPerDay    int64
    BurstSize         int64
}

var DefaultTierLimits = map[TierLevel]TierLimits{
    TierFree:       {RequestsPerMinute: 10, RequestsPerDay: 1000, BurstSize: 5},
    TierBasic:      {RequestsPerMinute: 60, RequestsPerDay: 10000, BurstSize: 20},
    TierPro:        {RequestsPerMinute: 600, RequestsPerDay: 100000, BurstSize: 100},
    TierEnterprise: {RequestsPerMinute: 6000, RequestsPerDay: 1000000, BurstSize: 500},
}

// TieredRateLimiter applies different limits based on user tier
type TieredRateLimiter struct {
    client      *redis.Client
    tierLimits  map[TierLevel]TierLimits
    getTierFunc func(ctx context.Context, userID string) TierLevel
}

// NewTieredRateLimiter creates a tiered rate limiter
func NewTieredRateLimiter(client *redis.Client, getTierFunc func(context.Context, string) TierLevel) *TieredRateLimiter {
    return &TieredRateLimiter{
        client:      client,
        tierLimits:  DefaultTierLimits,
        getTierFunc: getTierFunc,
    }
}

// Allow checks if request is allowed based on user's tier
func (trl *TieredRateLimiter) Allow(ctx context.Context, userID string) (bool, *distributed.RateLimitResult, error) {
    tier := trl.getTierFunc(ctx, userID)
    limits := trl.tierLimits[tier]

    // Check minute limit
    minuteLimiter := distributed.NewRedisSlidingWindow(
        trl.client,
        fmt.Sprintf("tier:%s:minute", tier),
        limits.RequestsPerMinute,
        time.Minute,
    )

    allowed, result, err := minuteLimiter.Allow(ctx, userID)
    if err != nil || !allowed {
        return allowed, result, err
    }

    // Check daily limit
    dayLimiter := distributed.NewRedisSlidingWindow(
        trl.client,
        fmt.Sprintf("tier:%s:day", tier),
        limits.RequestsPerDay,
        24*time.Hour,
    )

    return dayLimiter.Allow(ctx, userID)
}

// GetRemainingQuota returns remaining quota for a user
func (trl *TieredRateLimiter) GetRemainingQuota(ctx context.Context, userID string) (*QuotaStatus, error) {
    tier := trl.getTierFunc(ctx, userID)
    limits := trl.tierLimits[tier]

    // Get current usage from Redis
    minuteKey := fmt.Sprintf("tier:%s:minute:%s", tier, userID)
    dayKey := fmt.Sprintf("tier:%s:day:%s", tier, userID)

    pipe := trl.client.Pipeline()
    minuteCount := pipe.ZCard(ctx, minuteKey)
    dayCount := pipe.ZCard(ctx, dayKey)
    pipe.Exec(ctx)

    return &QuotaStatus{
        Tier:                tier,
        MinuteLimit:         limits.RequestsPerMinute,
        MinuteRemaining:     limits.RequestsPerMinute - minuteCount.Val(),
        DayLimit:            limits.RequestsPerDay,
        DayRemaining:        limits.RequestsPerDay - dayCount.Val(),
        MinuteResetAt:       time.Now().Truncate(time.Minute).Add(time.Minute),
        DayResetAt:          time.Now().Truncate(24 * time.Hour).Add(24 * time.Hour),
    }, nil
}

type QuotaStatus struct {
    Tier            TierLevel
    MinuteLimit     int64
    MinuteRemaining int64
    DayLimit        int64
    DayRemaining    int64
    MinuteResetAt   time.Time
    DayResetAt      time.Time
}
```

---

### Junior → FAANG: Matching Rate Limit Strategy to Use Case

There is no universal rate limiting strategy. The correct strategy depends on the resource being protected, the type of clients making requests, and the abuse patterns you are defending against. Learning to match strategy to use case is a skill that distinguishes strong candidates.

**Per-endpoint rate limiting protects expensive operations.** An authentication endpoint that checks a password against bcrypt needs drastically stricter limits (5 per minute per IP) than a read-only profile endpoint (100 per minute per user). The `EndpointRateLimiter` in this section provides per-endpoint configuration. Know the abuse patterns that per-endpoint limiting protects against: brute force attacks on auth endpoints, expensive search queries being fired in tight loops, and report generation endpoints being used to extract bulk data.

**Tiered rate limiting aligns incentives with business model.** Free tier users who hit the limit are encouraged to upgrade. Enterprise users who occasionally burst above their standard limit can be given a burst allowance that reflects their larger commitment. The `TierLimits` struct in the section encodes both `RequestsPerMinute` and `BurstSize`, which is a token bucket capacity. This maps directly to the token bucket algorithm: the sustained rate is the refill rate, and the burst size is the bucket capacity.

**The `getTierFunc` must be fast.** The `TieredRateLimiter` calls `getTierFunc` on every request to determine the user's tier. If this function queries a database, it adds a database round trip to every rate limit check. Cache the tier lookup with a short TTL (5 minutes) in Redis or in-process memory. The tier changes rarely (only when a user upgrades or downgrades their plan) so a 5-minute staleness is acceptable for rate limiting purposes.

**Always return the tier and remaining quota in the response.** The `GetRemainingQuota` method allows clients to query their quota status without making a regular request. This is essential for clients that need to plan their request batching (for example, a batch import tool that needs to know how many more imports it can run today). Expose this as a dedicated endpoint (`GET /api/quota`) so clients can check without consuming quota.

---

### Senior @ FAANG: Rate Limit Strategy as a Product Feature

At L6/L7, per-endpoint rate limiting and tiered rate limiting are not just engineering decisions. They are product features that are marketed to customers, documented in SLAs, and governed by a change management process.

**Endpoint rate limit configuration requires a formal change process.** Changing the rate limit on an authentication endpoint from 10 per minute to 5 per minute will break existing integrations that rely on the current limit. Even if the change improves security, it must go through a deprecation process: announce the change 30 days in advance, provide a migration guide (cache tokens, implement exponential backoff), monitor the impact on existing clients during the transition, and provide a temporary override mechanism for enterprise customers who need more time. This is a product change management process, not just a code change.

**Tiered rate limits must be reflected in legal contracts.** Enterprise customers who pay for higher rate limits have a contractual right to those limits. If the rate limiter is misconfigured and enforces the free-tier limit on an enterprise account, the company may have breached the SLA and may owe credits or refunds. The rate limit configuration must be verified by an automated check that compares the configured limits against the CRM data (customer tier) and alerts on discrepancies. This automated verification is an operational requirement, not a nice-to-have.

**Rate limit exemptions require governance.** Enterprise customers sometimes request rate limit exemptions ("we need to do a one-time bulk migration and need 10x the normal limit for 2 hours"). These exemptions must be: time-bounded (the higher limit reverts automatically after the agreed window), logged in an audit system (who approved the exemption, when, for how long, and what justification was given), and monitored (alert if the exempted account exceeds even the higher limit, which might indicate a bug in the client code rather than a legitimate bulk operation). Building this exemption governance infrastructure is a significant engineering investment that is often underestimated until the first enterprise escalation.
