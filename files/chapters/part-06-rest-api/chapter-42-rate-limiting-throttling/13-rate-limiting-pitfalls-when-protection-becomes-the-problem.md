## Rate Limiting Pitfalls: When Protection Becomes the Problem

### The Redis Single Point of Failure

**The Incident**: A payment API used Redis for distributed rate limiting. Redis went down for 3 minutes during a network partition. The rate limiter couldn't check limits, so it rejected all requests with 500 errors. During those 3 minutes, zero payments processed. The fallback should have been "fail open" for critical paths, but it was "fail closed" everywhere.

```go
// WRONG: Redis failure = service failure
func rateLimitMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        key := getClientKey(r)

        allowed, err := redis.CheckRateLimit(key)
        if err != nil {
            // Redis down = all requests fail!
            http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
            return
        }

        if !allowed {
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// CORRECT: Fail-open with local fallback
type ResilientRateLimiter struct {
    redis       *redis.Client
    localLimiter *rate.Limiter // Per-instance fallback
    circuit     *gobreaker.CircuitBreaker
    metrics     *RateLimitMetrics
}

func (r *ResilientRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    // Try distributed limiter first
    result, err := r.circuit.Execute(func() (any, error) {
        return r.checkRedis(ctx, key)
    })

    if err != nil {
        // Redis unavailable - use local fallback
        r.metrics.FallbackTriggered()

        // For critical paths: fail open with local rate limiting
        if r.isCriticalPath(ctx) {
            return r.localLimiter.Allow(), nil
        }

        // For non-critical paths: be more conservative
        return r.localLimiter.AllowN(time.Now(), 2), nil // Counts as 2 requests
    }

    return result.(bool), nil
}

func (r *ResilientRateLimiter) checkRedis(ctx context.Context, key string) (bool, error) {
    // Set short timeout for Redis operations
    ctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
    defer cancel()

    // Use Lua script for atomic check-and-increment
    script := `
        local current = redis.call("INCR", KEYS[1])
        if current == 1 then
            redis.call("EXPIRE", KEYS[1], ARGV[1])
        end
        return current
    `

    count, err := r.redis.Eval(ctx, script, []string{key}, 60).Int()
    if err != nil {
        return false, err
    }

    return count <= r.getLimit(key), nil
}

// Critical paths fail open during outages
func (r *ResilientRateLimiter) isCriticalPath(ctx context.Context) bool {
    path, _ := ctx.Value("path").(string)
    criticalPaths := []string{
        "/api/v1/payments",
        "/api/v1/health",
        "/api/v1/webhooks",
    }
    for _, cp := range criticalPaths {
        if strings.HasPrefix(path, cp) {
            return true
        }
    }
    return false
}
```

### The IP Address Spoofing Bypass

**The Incident**: Rate limiting was based on client IP from `X-Forwarded-For` header. Attackers added a fake IP to the header: `X-Forwarded-For: 1.2.3.4, real-attacker-ip`. The code took the first IP, so every request appeared to come from a different address. Rate limits were completely bypassed, and the API was DDoS'd.

```go
// WRONG: Trusting X-Forwarded-For blindly
func getClientIP(r *http.Request) string {
    xff := r.Header.Get("X-Forwarded-For")
    if xff != "" {
        // Takes first IP - easily spoofed!
        return strings.Split(xff, ",")[0]
    }
    return r.RemoteAddr
}

// CORRECT: Trust only IPs from known proxies
type TrustedProxyConfig struct {
    TrustedCIDRs []*net.IPNet
}

func NewTrustedProxyConfig(cidrs []string) (*TrustedProxyConfig, error) {
    config := &TrustedProxyConfig{}
    for _, cidr := range cidrs {
        _, ipNet, err := net.ParseCIDR(cidr)
        if err != nil {
            return nil, fmt.Errorf("invalid CIDR %s: %w", cidr, err)
        }
        config.TrustedCIDRs = append(config.TrustedCIDRs, ipNet)
    }
    return config, nil
}

func (c *TrustedProxyConfig) GetClientIP(r *http.Request) string {
    // Start with direct connection IP
    remoteIP := getIPFromAddr(r.RemoteAddr)

    // Only process XFF if request came from trusted proxy
    if !c.isTrusted(remoteIP) {
        return remoteIP
    }

    // Parse X-Forwarded-For from right to left
    xff := r.Header.Get("X-Forwarded-For")
    if xff == "" {
        return remoteIP
    }

    ips := strings.Split(xff, ",")
    // Walk backwards through the chain
    for i := len(ips) - 1; i >= 0; i-- {
        ip := strings.TrimSpace(ips[i])

        parsed := net.ParseIP(ip)
        if parsed == nil {
            // Unparseable entry. Do NOT return it: this string becomes a
            // limiter bucket key, and an attacker who can put arbitrary text
            // here gets unbounded distinct keys, which is both a limiter
            // bypass and an unbounded-memory bug in the limiter's map.
            // Everything left of a garbage entry is unverifiable, so stop.
            return remoteIP
        }

        if !c.isTrusted(parsed) {
            // First untrusted IP is the real client
            return ip
        }
    }

    // Every hop in the chain was a trusted proxy. Return the address we
    // actually observed, NOT ips[0]: the leftmost entry is the one nobody
    // verified, so a client that pre-seeds the header with a trusted-looking
    // address would otherwise choose its own bucket key.
    return remoteIP
}

func (c *TrustedProxyConfig) isTrusted(ip net.IP) bool {
    if ip == nil {
        return false
    }
    for _, cidr := range c.TrustedCIDRs {
        if cidr.Contains(ip) {
            return true
        }
    }
    return false
}

// Usage with common cloud providers
func SetupRateLimiting() {
    trustedProxies, _ := NewTrustedProxyConfig([]string{
        "10.0.0.0/8",       // Private network (your infrastructure)
        "172.16.0.0/12",    // Private network
        "192.168.0.0/16",   // Private network
        "173.245.48.0/20",  // Cloudflare
        "103.21.244.0/22",  // Cloudflare
        "130.211.0.0/22",   // Google Cloud LB
        "35.191.0.0/16",    // Google Cloud LB
    })

    // ...
}
```

### The Thundering Herd After Rate Limit Reset

**The Incident**: A popular API had minute-based rate limits that reset at :00 seconds. At exactly 12:00:00, 50,000 queued requests all fired simultaneously. The backend couldn't handle the spike, crashed, and took 10 minutes to recover. The rate limit reset timing created a synchronized thundering herd every minute.

```go
// WRONG: Fixed window with synchronized resets
func checkRateLimitBad(key string) bool {
    // All keys with same minute reset at same time!
    window := time.Now().Truncate(time.Minute).Unix()
    redisKey := fmt.Sprintf("ratelimit:%s:%d", key, window)

    count, _ := redis.Incr(redisKey)
    redis.Expire(redisKey, time.Minute)

    return count <= limit
}

// CORRECT: Sliding window with jittered TTL
func checkRateLimitSlidingWindow(key string, limit int, window time.Duration) (bool, int, time.Time) {
    now := time.Now()
    windowStart := now.Add(-window)

    // Sliding window using sorted set
    script := `
        -- Remove old entries
        redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])

        -- Count current window
        local count = redis.call("ZCARD", KEYS[1])

        if count < tonumber(ARGV[3]) then
            -- Add this request
            redis.call("ZADD", KEYS[1], ARGV[2], ARGV[2])
            -- Set expiry with jitter (window + 0-10% random)
            local jitter = math.random(0, tonumber(ARGV[4]) / 10)
            redis.call("EXPIRE", KEYS[1], tonumber(ARGV[4]) + jitter)
            return {1, count + 1}
        end

        return {0, count}
    `

    result, err := redis.Eval(
        ctx, script,
        []string{key},
        windowStart.UnixNano(),  // ARGV[1]: window start
        now.UnixNano(),          // ARGV[2]: current time
        limit,                   // ARGV[3]: limit
        int(window.Seconds()),   // ARGV[4]: window seconds
    ).Int64Slice()

    allowed := result[0] == 1
    remaining := limit - int(result[1])
    resetTime := now.Add(window)

    return allowed, remaining, resetTime
}

// Even better: Token bucket with gradual refill
type TokenBucket struct {
    tokens     float64
    capacity   float64
    refillRate float64
    lastRefill time.Time
    mu         sync.Mutex
}

func (b *TokenBucket) Allow() bool {
    b.mu.Lock()
    defer b.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(b.lastRefill).Seconds()

    // Refill tokens based on elapsed time
    b.tokens = math.Min(b.capacity, b.tokens+elapsed*b.refillRate)
    b.lastRefill = now

    if b.tokens >= 1 {
        b.tokens--
        return true
    }

    return false
}
```

### The Insufficient Granularity Attack

**The Incident**: An API rate limited by API key at 1000 requests/minute. An attacker created 100 free-tier API keys and distributed their attack across all of them. Each key stayed under limits, but combined they sent 100,000 requests/minute, overwhelming the backend. The rate limiter didn't account for coordinated attacks across multiple identities.

```go
// WRONG: Only per-key limiting
func rateLimitByKey(apiKey string) bool {
    count := redis.Incr("ratelimit:key:" + apiKey)
    return count <= 1000
}

// CORRECT: Multi-layer rate limiting
type MultiLayerLimiter struct {
    redis *redis.Client
}

type LimitResult struct {
    Allowed   bool
    Limited   string // Which layer triggered the limit
    Remaining int
    Reset     time.Time
}

func (m *MultiLayerLimiter) Check(ctx context.Context, r *http.Request) LimitResult {
    apiKey := extractAPIKey(r)
    clientIP := getClientIP(r)
    userID := extractUserID(r)
    endpoint := r.URL.Path

    limits := []struct {
        key   string
        limit int
        name  string
    }{
        // Per-key limits
        {fmt.Sprintf("rl:key:%s", apiKey), 1000, "api_key"},

        // Per-IP limits (catches multi-key attacks from same source)
        {fmt.Sprintf("rl:ip:%s", clientIP), 5000, "ip"},

        // Per-user limits (if authenticated)
        {fmt.Sprintf("rl:user:%s", userID), 2000, "user"},

        // Per-endpoint limits (protect expensive endpoints)
        {fmt.Sprintf("rl:endpoint:%s", endpoint), 10000, "endpoint"},

        // Global limits (protect the system)
        {"rl:global", 100000, "global"},
    }

    for _, l := range limits {
        if l.key == "" {
            continue
        }

        count := m.increment(ctx, l.key)
        if count > l.limit {
            return LimitResult{
                Allowed: false,
                Limited: l.name,
            }
        }
    }

    return LimitResult{Allowed: true}
}

// Also track suspicious patterns
func (m *MultiLayerLimiter) detectAbuse(ctx context.Context, r *http.Request) bool {
    clientIP := getClientIP(r)

    // Track unique API keys per IP
    keysKey := fmt.Sprintf("abuse:keys_per_ip:%s", clientIP)
    apiKey := extractAPIKey(r)

    m.redis.SAdd(ctx, keysKey, apiKey)
    m.redis.Expire(ctx, keysKey, time.Hour)

    uniqueKeys, _ := m.redis.SCard(ctx, keysKey).Result()

    // Flag if single IP is using many API keys
    if uniqueKeys > 10 {
        log.Warn("potential abuse: many API keys from single IP",
            "ip", clientIP,
            "unique_keys", uniqueKeys)
        return true
    }

    return false
}
```

### Quick Reference: Rate Limiting Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Redis SPOF | Total outage | Circuit breaker, local fallback |
| IP spoofing | Limits bypassed | Trust only known proxies |
| Synchronized reset | Thundering herd | Sliding window, jittered TTL |
| Single-layer limiting | Coordinated attacks succeed | Multi-layer limits |
| No burst handling | Legitimate spikes rejected | Token bucket algorithm |
| Missing headers | Clients can't adapt | RateLimit-*, Retry-After headers |
| Fail closed everywhere | Critical paths blocked | Fail open for critical paths |
| No monitoring | Can't detect attacks | Track rejection rates, patterns |

### Junior → FAANG: Learning to Spot Pitfalls Before They Become Incidents

The pitfalls in this section are not theoretical. Each one has caused a real production outage. The discipline FAANG interviewers look for is the ability to anticipate these failure modes during design review, not discover them post-incident.

**How to build a pitfall checklist for interviews:**

During a system design interview, after you sketch your rate limiter, walk through this checklist out loud. You will catch at least one flaw the interviewer planted intentionally.

1. What happens if my rate limit store (Redis) goes down? Answer before the interviewer asks it.
2. Where does the client IP come from, and can a caller forge it?
3. Do my window boundaries synchronize across clients and cause a thundering herd?
4. Can a single coordinated actor split their traffic across multiple identities to stay under per-identity limits?
5. Do I return `Retry-After` on every 429? Without it, clients retry immediately and make the problem worse.

**The IP spoofing pitfall in particular trips up first-job engineers** because the code looks correct. `r.Header.Get("X-Forwarded-For")` returns a string, you split it and take the first element, you test it in a local dev environment where there is no proxy, and it works. The bug only appears in production where a real attacker adds a bogus IP to the left of the header. The fix requires understanding the trust model: only parse `X-Forwarded-For` if the request arrived from a trusted proxy CIDR, and parse from right to left (the rightmost IP your proxy did not add is the real client).

**The Redis SPOF pitfall teaches a first-job habit about criticality classification.** Before you write a rate limiter, classify every endpoint on a two-axis grid: critical vs non-critical, and user-facing vs internal. Critical user-facing endpoints (payments, health checks, webhooks) should fail open. Internal endpoints can fail closed. Write this classification in a comment next to the middleware registration. When Redis goes down at 2 am, the on-call engineer needs to know in 10 seconds which endpoints are failing open vs closed.

**Common first-job mistake:** using `log.Fatal` or panicking in a rate limiter error path. A rate limiter is middleware. Middleware must never kill the process. Return a 500 and continue, or fail open. `log.Fatal` in a goroutine crashes the whole service, which is worse than having no rate limiter at all.

### Senior @ FAANG: The Pitfalls That Become Platform-Level Policy Failures

At senior level, a single pitfall is not a bug. It is a signal that the rate limiting platform lacks the right guardrails, and other teams will hit the same pitfall independently. The right response is not a fix but a policy.

**Redis SPOF: circuit breaker is not enough, you need a failure contract.**

A circuit breaker fails open or closed. But your failure contract must specify: which endpoints fail open, with what local fallback rate, for how long, and what alert fires to indicate the circuit is open. Without a written failure contract, every team that integrates your rate limiter writes their own ad hoc behavior. Some fail closed (blocking payments), some fail open with no local fallback (no protection at all). Standardize the contract in the shared library. Expose `SetCriticalPaths([]string)` so teams can declare their endpoints. The library handles the rest.

**IP spoofing: this is a security policy failure, not a code bug.**

The root cause is not the parsing logic. It is the absence of a network-level policy that specifies which CIDRs are trusted proxies. That policy belongs in infrastructure configuration (Terraform, Kubernetes network policies, cloud WAF rules) and should be fed to the application at startup, not hardcoded in source. When Cloudflare rotates their IP ranges (they do, occasionally), hardcoded CIDRs become a silent security regression. The right architecture: a config service or environment variable provides the trusted CIDR list, the rate limiter library reads it at startup and on refresh, and an alert fires if the list has not been refreshed in 24 hours.

**Thundering herd: this is a clock synchronization problem at platform scale.**

The jittered TTL fix works per-key. But if your platform has 100 services all using the same Redis cluster and all using `time.Now().Truncate(time.Minute)` for window keys, the thundering herd is cross-service. All 100 services flush their window keys at the same second. The Redis CPU spike affects every service simultaneously. The platform-level fix: each service's window epoch is offset by a deterministic hash of the service name modulo the window duration. No coordination required, and no two services share a window boundary.

**Multi-key coordination attack: this requires behavioral analytics, not more rate limits.**

Adding more limit dimensions (per-IP, per-key, per-user) helps but does not stop a sophisticated attacker who uses residential proxies with unique IPs and burner accounts. The correct platform response is anomaly detection: track statistical baselines (requests per endpoint per hour, new accounts per IP, success rate per API key) and alert or challenge when a value is more than three standard deviations from the baseline. This is not a rate limiting problem. It is a fraud detection problem that rate limiting surfaces. At FAANG, rate limiting and fraud detection are separate systems that share signals. Rate limiting is the first line. Fraud detection is the second.

**The pitfall that is rarely discussed: rate limits as a denial-of-service vector.**

An attacker who knows your per-IP rate limit can deliberately exhaust another user's quota by spoofing their IP (if you trust `X-Forwarded-For` at edge) or by triggering expensive operations under the victim's session (if the attacker can authenticate as the victim temporarily). The mitigation: rate limit keys must be unforgeable from the outside. User IDs from validated JWTs are good. API keys from a verified header with HMAC are good. IP addresses from `X-Forwarded-For` are not. Design your key hierarchy so only unforgeable identifiers are used for billing-grade quotas.

**Maturity model for pitfall prevention:**

Level 1: Each team discovers pitfalls individually and patches them post-incident.
Level 2: A shared library encodes known pitfalls as library behavior (circuit breaker, trusted proxy parsing, jitter). Teams get the fixes by upgrading the library version.
Level 3: The platform runs chaos tests quarterly that intentionally induce Redis failures, IP spoofing headers, and synchronized window boundaries, and verifies that the shared library handles each case correctly. Failures are caught before teams hit them in production.

The goal of a senior engineer is to move the organization from level 1 to level 3. The pitfalls in this section are your curriculum for that journey.

---
