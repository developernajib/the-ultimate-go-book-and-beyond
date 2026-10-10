## 52E.5 Per-Tenant Rate Limiting

### Token Bucket Per Tenant

Each tenant gets their own rate limit bucket, with the allowed request rate determined by their plan tier. The implementation uses a Redis Lua script to atomically increment a per-minute counter and check whether the tenant has exceeded their limit. Using a Lua script ensures the increment-and-check is atomic even under concurrent requests:

```go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/yourorg/app/internal/tenant"
)

type TenantRateLimiter struct {
    redis   *redis.Client
    tiers   map[string]RateLimitTier
}

type RateLimitTier struct {
    RequestsPerMinute int
    BurstMultiplier   float64  // allowed burst = RPM * BurstMultiplier
}

var defaultTiers = map[string]RateLimitTier{
    "free":       {RequestsPerMinute: 60,    BurstMultiplier: 1.5},
    "pro":        {RequestsPerMinute: 600,   BurstMultiplier: 2.0},
    "business":   {RequestsPerMinute: 3000,  BurstMultiplier: 2.0},
    "enterprise": {RequestsPerMinute: 15000, BurstMultiplier: 3.0},
}

type RateLimitResult struct {
    Allowed    bool
    Limit      int
    Remaining  int
    ResetAt    time.Time
    RetryAfter time.Duration
}

// Allow checks if a request is within rate limits using Redis sliding window
// Uses the token bucket algorithm via Redis Lua script for atomicity
func (r *TenantRateLimiter) Allow(ctx context.Context, t *tenant.TenantContext) (RateLimitResult, error) {
    tier, ok := r.tiers[t.Plan]
    if !ok {
        tier = r.tiers["free"]
    }

    limit := tier.RequestsPerMinute
    window := time.Minute
    key := fmt.Sprintf("ratelimit:%s:%d", t.ID, time.Now().Truncate(window).Unix())

    // Atomic increment with TTL using Lua script
    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        local current = redis.call('INCR', key)
        if current == 1 then
            redis.call('EXPIRE', key, window)
        end

        local ttl = redis.call('TTL', key)
        return {current, limit, ttl}
    `)

    result, err := script.Run(ctx, r.redis,
        []string{key},
        limit,
        int(window.Seconds()),
        time.Now().Unix(),
    ).IntSlice()
    if err != nil {
        // Fail open: if Redis is down, allow the request
        return RateLimitResult{Allowed: true, Limit: limit, Remaining: limit}, nil
    }

    current := result[0]
    ttl := result[2]

    remaining := limit - current
    if remaining < 0 {
        remaining = 0
    }

    resetAt := time.Now().Add(time.Duration(ttl) * time.Second)

    if current > limit {
        return RateLimitResult{
            Allowed:    false,
            Limit:      limit,
            Remaining:  0,
            ResetAt:    resetAt,
            RetryAfter: resetAt.Sub(time.Now()),
        }, nil
    }

    return RateLimitResult{
        Allowed:   true,
        Limit:     limit,
        Remaining: remaining,
        ResetAt:   resetAt,
    }, nil
}

// RateLimitMiddleware applies per-tenant rate limiting
func RateLimitMiddleware(limiter *TenantRateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            t := tenant.MustFromContext(r.Context())

            result, err := limiter.Allow(r.Context(), t)
            if err != nil {
                slog.Error("rate limiter error", "error", err, "tenant_id", t.ID)
                // Fail open
                next.ServeHTTP(w, r)
                return
            }

            // Always set rate limit headers
            w.Header().Set("X-RateLimit-Limit", strconv.Itoa(result.Limit))
            w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
            w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))
            w.Header().Set("X-RateLimit-Policy", fmt.Sprintf("%d;w=60", result.Limit))

            if !result.Allowed {
                w.Header().Set("Retry-After", strconv.Itoa(int(result.RetryAfter.Seconds())))
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusTooManyRequests,
                    Title:  "Rate Limit Exceeded",
                    Detail: fmt.Sprintf("Rate limit of %d requests/minute exceeded. Upgrade your plan for higher limits.", result.Limit),
                })
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Per-Endpoint Rate Limits

Not all endpoints cost the same. A report generation endpoint that triggers a heavy database query should count more against the global rate limit than a simple GET. The per-endpoint rate limiter applies both endpoint-specific limits and a cost multiplier against the global tenant budget:

```go
// PerEndpointRateLimiter applies different limits per endpoint
type PerEndpointRateLimiter struct {
    base      *TenantRateLimiter
    overrides map[string]EndpointRateOverride
}

type EndpointRateOverride struct {
    RequestsPerMinute int
    CostMultiplier    float64  // this endpoint counts as N requests against global limit
}

var endpointOverrides = map[string]EndpointRateOverride{
    "POST /reports/generate": {RequestsPerMinute: 5, CostMultiplier: 10},
    "POST /exports":          {RequestsPerMinute: 2, CostMultiplier: 20},
    "GET /search":            {RequestsPerMinute: 30, CostMultiplier: 3},
}

func (l *PerEndpointRateLimiter) Allow(ctx context.Context, t *tenant.TenantContext, endpoint string) (RateLimitResult, error) {
    override, hasOverride := l.overrides[endpoint]

    if hasOverride {
        // Check endpoint-specific limit first
        endpointKey := fmt.Sprintf("ratelimit:endpoint:%s:%s:%d",
            t.ID, endpoint, time.Now().Truncate(time.Minute).Unix())
        // ... apply endpoint-specific limit
    }

    // Apply global limit (with cost multiplier if applicable)
    return l.base.Allow(ctx, t)
}
```

### Junior → FAANG: Rate Limiting Algorithms and Failure Modes

Rate limiting is a standard interview topic, but per-tenant rate limiting with plan-based tiers adds the multi-tenancy dimension that separates FAANG-track candidates.

Common junior gaps:

- Implementing a fixed-window counter instead of a sliding window. A fixed-window counter allows a burst of exactly `limit * 2` requests at the window boundary (last few seconds of one window plus first few seconds of the next). The Lua script in this section uses a per-minute bucket, which is a fixed window. A true sliding window requires a sorted set in Redis with per-request timestamps, which is more expensive but eliminates the boundary burst.
- Hardcoding rate limits instead of reading them from the tenant context. A plan upgrade should take effect on the next request, not after a deployment.
- Failing closed when Redis is unavailable. The implementation above fails open (allows the request). Know why: if Redis is down, rejecting all requests means a service outage for all tenants. Failing open with an alert is the correct production posture. Failing closed is only correct for security-critical operations (authentication, payment).

Worked example: "A tenant on the free plan is making 100 requests per second, well above their 60 RPM limit. Walk me through how your rate limiter handles this."

Answer: the Lua script atomically increments the per-minute counter for the tenant in Redis and checks whether it exceeds the plan limit. Every request above 60 within the same minute window returns `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers. The middleware runs before any business logic, so the excess requests do not touch the database.

First-job habits:

- Test rate limiting with a real Redis instance in integration tests, not just unit tests with mocks. The Lua script atomicity is a runtime property that only a real Redis validates.
- Always set `Retry-After` on 429 responses. Without it, a well-behaved client retries immediately, creating a thundering herd that makes the rate limit problem worse.

### Senior @ FAANG: Rate Limiting Architecture at Platform Scale

The single-service rate limiter in this section is correct as a starting point. At platform scale, with multiple services and hundreds of thousands of tenants, the rate limiting architecture becomes a platform concern.

**Distributed rate limiting across multiple services:**

When a tenant's API calls flow through multiple services (API gateway, backend service, async worker), each service implementing its own rate limiter creates a fragmented picture. The tenant's actual request rate is the sum across all services, but each service only sees its own slice.

The platform solution: centralize rate limiting at the API gateway layer. The gateway is the single entry point for external traffic and has the complete view of per-tenant request rates. Individual backend services implement only internal protections (bulkheads, database connection limits), not global rate limits. The gateway's rate limiting decision is authoritative.

For internal service-to-service calls, rate limiting is typically not needed at the same granularity as external API limits. Instead, bulkheads (per-tenant concurrency limits) are more appropriate, since internal calls are made by the system on behalf of the tenant, not by the tenant directly.

**Per-endpoint cost weighting:**

The `PerEndpointRateLimiter` pattern in this section uses a cost multiplier. At scale, this multiplier should be data-driven, not hardcoded. The platform measures the actual resource cost of each endpoint type (CPU time, database query cost, memory allocation) and derives the multiplier from production telemetry. This is how large platforms prevent the "one expensive endpoint" problem without manually tuning multipliers for every route.

**Rate limit quotas as a product feature:**

At FAANG scale, rate limits are a product feature with their own management API. Enterprise customers negotiate custom limits as part of their contract. The platform must support:

- Per-tenant limit overrides stored in the database and cached in Redis with sub-second TTL after a contract update.
- Temporary limit increases (burst grants) for batch operations: a tenant migrating data needs elevated limits for a fixed window.
- Rate limit dashboards for the customer: the API must expose current usage against limits so customers can proactively manage their consumption.
- Alerting for tenants approaching their limit at 80% consumption, so customer success can reach out before they hit the wall.

**Governance ADR: fail-open versus fail-closed:**

Document the fail-open decision explicitly. If Redis is unavailable and you fail open, you are accepting that a Redis outage allows unlimited traffic. At scale, this can cause downstream database overload. The alternative is a local in-process fallback rate limiter (token bucket per tenant, in memory) that activates when Redis is unreachable. The local limiter uses the plan-tier defaults as its limits and is eventually reconciled when Redis recovers. This is the production-grade answer to "what happens when your rate limiter's dependency is down."

---
