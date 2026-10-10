## Rate Limiter Pitfalls: When Limits Cause Chaos

### Pitfall 1: Rate Limiter Becomes Single Point of Failure

**Incident Report**: Redis-based rate limiter caused complete service outage when Redis cluster failed. All requests were rejected because the limiter couldn't determine if clients were within limits.

```go
// WRONG: Hard dependency on Redis
func (r *RateLimiter) Allow(ctx context.Context, key string) bool {
    count, err := r.redis.Incr(ctx, key).Result()
    if err != nil {
        // Redis down = all requests rejected
        return false
    }

    if count == 1 {
        r.redis.Expire(ctx, key, r.window)
    }

    return count <= int64(r.limit)
}

// CORRECT: Graceful degradation with local fallback
type ResilientRateLimiter struct {
    redis     *redis.Client
    localRate *rate.Limiter  // Go stdlib rate limiter as fallback
    limit     int
    window    time.Duration
    metrics   *RateLimiterMetrics
}

func (r *ResilientRateLimiter) Allow(ctx context.Context, key string) bool {
    // Try Redis first
    count, err := r.allowRedis(ctx, key)
    if err == nil {
        return count <= int64(r.limit)
    }

    // Redis failed - log and use local fallback
    r.metrics.RedisFallbacks.Inc()
    log.Printf("Rate limiter Redis error: %v, falling back to local", err)

    // Local rate limiter is more permissive to avoid false rejections
    // It's per-instance, so effective limit is limit * num_instances
    return r.localRate.Allow()
}

func (r *ResilientRateLimiter) allowRedis(ctx context.Context, key string) (int64, error) {
    // Add timeout to prevent blocking
    ctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
    defer cancel()

    count, err := r.redis.Incr(ctx, key).Result()
    if err != nil {
        return 0, err
    }

    if count == 1 {
        r.redis.Expire(ctx, key, r.window)
    }

    return count, nil
}

// Even more resilient: Circuit breaker around Redis
type CircuitBreakerRateLimiter struct {
    redis   *redis.Client
    local   *rate.Limiter
    circuit *CircuitBreaker
}

func (r *CircuitBreakerRateLimiter) Allow(ctx context.Context, key string) bool {
    if r.circuit.IsOpen() {
        // Redis circuit open, use local only
        return r.local.Allow()
    }

    count, err := r.allowRedis(ctx, key)
    if err != nil {
        r.circuit.RecordFailure()
        return r.local.Allow()
    }

    r.circuit.RecordSuccess()
    return count <= int64(r.limit)
}
```

### Pitfall 2: Unfair Rate Limiting for Legitimate Users Behind NAT

**Incident Report**: Large enterprise customer with 10,000 employees behind single NAT IP got rate limited while individual abusers from different IPs bypassed limits. The company threatened to leave.

```go
// WRONG: Simple IP-based rate limiting
func (r *RateLimiter) GetKey(req *http.Request) string {
    return req.RemoteAddr  // All users behind NAT share one limit!
}

// CORRECT: Multi-factor rate limiting key
type SmartKeyExtractor struct {
    trustedProxies map[string]bool
}

func (e *SmartKeyExtractor) GetKey(req *http.Request) RateLimitKey {
    key := RateLimitKey{}

    // 1. Use authenticated user ID if available (best)
    if userID := auth.UserIDFromContext(req.Context()); userID != "" {
        key.UserID = userID
        key.Type = "user"
        return key
    }

    // 2. Use API key if provided
    if apiKey := req.Header.Get("X-API-Key"); apiKey != "" {
        key.APIKey = hashAPIKey(apiKey)
        key.Type = "api_key"
        return key
    }

    // 3. Fall back to IP, but handle proxies correctly
    ip := e.getRealIP(req)
    key.IP = ip
    key.Type = "ip"

    // 4. Add fingerprint for additional granularity
    // This helps distinguish users behind same NAT
    fingerprint := generateFingerprint(req)
    key.Fingerprint = fingerprint

    return key
}

func (e *SmartKeyExtractor) getRealIP(req *http.Request) string {
    // Check X-Forwarded-For if from trusted proxy
    if e.trustedProxies[req.RemoteAddr] {
        xff := req.Header.Get("X-Forwarded-For")
        if xff != "" {
            ips := strings.Split(xff, ",")
            // Take first non-private IP
            for _, ip := range ips {
                ip = strings.TrimSpace(ip)
                if !isPrivateIP(ip) {
                    return ip
                }
            }
        }
    }

    // Strip port
    ip, _, _ := net.SplitHostPort(req.RemoteAddr)
    return ip
}

func generateFingerprint(req *http.Request) string {
    h := sha256.New()
    h.Write([]byte(req.UserAgent()))
    h.Write([]byte(req.Header.Get("Accept-Language")))
    h.Write([]byte(req.Header.Get("Accept-Encoding")))
    return hex.EncodeToString(h.Sum(nil))[:16]
}

// Composite rate limiting: different limits for different key types
type TieredRateLimiter struct {
    limiters map[string]*RateLimiter
}

func (t *TieredRateLimiter) Allow(ctx context.Context, key RateLimitKey) bool {
    switch key.Type {
    case "user":
        // Authenticated users get higher limits
        return t.limiters["user"].Allow(ctx, key.UserID)

    case "api_key":
        // API keys have tiered limits based on plan
        plan := t.getPlan(key.APIKey)
        return t.limiters[plan].Allow(ctx, key.APIKey)

    case "ip":
        // IP-based has base limit, but check fingerprint too
        ipAllowed := t.limiters["ip"].Allow(ctx, key.IP)
        fingerprintAllowed := t.limiters["fingerprint"].Allow(ctx, key.IP+":"+key.Fingerprint)
        return ipAllowed && fingerprintAllowed
    }

    return false
}
```

### Pitfall 3: Rate Limit Window Reset Causing Traffic Spikes

**Incident Report**: Fixed-window rate limiter with 1000 req/min limit caused 2000 requests in 2 seconds across window boundaries. Users learned to send 1000 requests at 11:59:59 and 1000 more at 12:00:00.

```go
// WRONG: Fixed window allows burst at boundary
func (r *FixedWindowLimiter) Allow(ctx context.Context, key string) bool {
    window := time.Now().Unix() / 60  // Minute boundary
    windowKey := fmt.Sprintf("%s:%d", key, window)

    count, _ := r.redis.Incr(ctx, windowKey).Result()
    r.redis.Expire(ctx, windowKey, time.Minute)

    return count <= int64(r.limit)
    // Problem: 1000 at :59 + 1000 at :00 = 2000 in 2 seconds
}

// CORRECT: Sliding window log
func (r *SlidingWindowLimiter) Allow(ctx context.Context, key string) bool {
    now := time.Now()
    windowStart := now.Add(-r.window)

    // Use sorted set to track request timestamps
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window_start = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local window_ms = tonumber(ARGV[4])

        -- Remove old entries
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current entries
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add new entry
            redis.call('ZADD', key, now, now .. '-' .. math.random())
            redis.call('PEXPIRE', key, window_ms)
            return 1
        end

        return 0
    `)

    allowed, _ := script.Run(ctx, r.redis, []string{key},
        now.UnixMilli(),
        windowStart.UnixMilli(),
        r.limit,
        r.window.Milliseconds(),
    ).Int()

    return allowed == 1
}

// ALTERNATIVE: Sliding window counter (less memory). The check and
// the increment must be one Lua script: a pipelined GET followed by a
// Go-side check and a separate INCR would reintroduce exactly the
// TOCTOU race that Mistake 2 in this chapter warns about.
func (r *SlidingWindowCounterLimiter) Allow(ctx context.Context, key string) bool {
    now := time.Now()

    script := redis.NewScript(`
        local base = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_s = tonumber(ARGV[2])
        local now_s = tonumber(ARGV[3])

        local current_window = math.floor(now_s / window_s)
        local current_key = base .. ":" .. current_window
        local previous_key = base .. ":" .. (current_window - 1)

        local current = tonumber(redis.call("GET", current_key) or "0")
        local previous = tonumber(redis.call("GET", previous_key) or "0")

        -- If we're 40% through the current window, the previous
        -- window counts 60%
        local progress = (now_s % window_s) / window_s
        local weighted = previous * (1 - progress) + current

        if weighted >= limit then
            return 0
        end

        redis.call("INCR", current_key)
        redis.call("EXPIRE", current_key, window_s * 2)
        return 1
    `)

    // Hash tag so the derived per-window subkeys stay in one cluster slot
    allowed, err := script.Run(ctx, r.redis, []string{"{" + key + "}"},
        r.limit,
        int64(r.window.Seconds()),
        now.Unix(),
    ).Int()

    return err == nil && allowed == 1
}
```

### Pitfall 4: Rate Limiting Bypass via Request Manipulation

**Incident Report**: Attackers bypassed rate limits by adding random query parameters, slight URL variations, and header modifications. Each variation was counted as a different endpoint.

```go
// WRONG: Rate limit key includes full URL
func (r *RateLimiter) GetEndpointKey(req *http.Request) string {
    return req.URL.String()  // Different for /api/v1/users?foo=1 vs /api/v1/users?bar=2
}

// CORRECT: Normalize requests before rate limiting
type NormalizedKeyExtractor struct{}

func (e *NormalizedKeyExtractor) GetEndpointKey(req *http.Request) string {
    // Normalize URL path
    path := e.normalizePath(req.URL.Path)

    // Ignore query parameters for rate limiting (unless they change semantics)
    // Keep only significant params
    significantParams := e.extractSignificantParams(path, req.URL.Query())

    // Normalize method
    method := strings.ToUpper(req.Method)

    if len(significantParams) > 0 {
        return fmt.Sprintf("%s:%s:%s", method, path, significantParams)
    }
    return fmt.Sprintf("%s:%s", method, path)
}

func (e *NormalizedKeyExtractor) normalizePath(path string) string {
    // Remove trailing slash
    path = strings.TrimSuffix(path, "/")

    // Convert path parameters to placeholders
    // /api/v1/users/123 -> /api/v1/users/:id
    parts := strings.Split(path, "/")
    for i, part := range parts {
        // If part looks like an ID (numeric, UUID, etc), normalize it
        if e.looksLikeID(part) {
            parts[i] = ":id"
        }
    }

    return strings.Join(parts, "/")
}

func (e *NormalizedKeyExtractor) looksLikeID(s string) bool {
    // Numeric ID
    if _, err := strconv.ParseInt(s, 10, 64); err == nil {
        return true
    }

    // UUID
    if _, err := uuid.Parse(s); err == nil {
        return true
    }

    // Hex string (like MongoDB ObjectID)
    if len(s) == 24 {
        if _, err := hex.DecodeString(s); err == nil {
            return true
        }
    }

    return false
}

func (e *NormalizedKeyExtractor) extractSignificantParams(path string, params url.Values) string {
    // Define which params matter for each endpoint
    significantByEndpoint := map[string][]string{
        "/api/v1/search":   {"q"},           // Search query matters
        "/api/v1/products": {"category_id"}, // Category affects rate limit
    }

    significant := significantByEndpoint[path]
    if len(significant) == 0 {
        return ""
    }

    var result []string
    for _, key := range significant {
        if val := params.Get(key); val != "" {
            result = append(result, key+"="+val)
        }
    }
    slices.Sort(result)
    return strings.Join(result, "&")
}
```

### Quick Reference: Rate Limiter Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| SPOF | Total outage when Redis fails | Local fallback, circuit breaker |
| NAT unfairness | Enterprises blocked, abusers pass | Multi-factor keys, fingerprinting |
| Window boundary | 2x burst at window reset | Sliding window, token bucket |
| Bypass via params | Attackers evade limits | Normalize URLs, ignore irrelevant params |

---

### Junior → FAANG: Incident Report Analysis as Learning Accelerator

Each pitfall in this section describes an incident that happened in a real system. Reading incident reports is one of the most efficient ways to learn production engineering without having to experience the failures yourself.

**Pitfall 1 (SPOF) is the most common rate limiter mistake in production.** Adding Redis as a dependency to the rate limiter means the rate limiter inherits Redis's availability. If Redis has 99.9% uptime (8.7 hours downtime per year), and your service has 99.9% uptime, the combined system has lower than 99.9% uptime because the rate limiter failure causes a service failure. The local fallback eliminates this dependency: during Redis outages, the service continues with per-pod rate limiting rather than failing completely. This is a fundamental principle of resilient systems: don't let a monitoring/enforcement component have higher blast radius than the service it is protecting.

**Pitfall 2 (NAT unfairness) shows that IP-based rate limiting has fundamental limitations.** Large enterprise campuses may have thousands of employees behind a single NAT IP. A 100 requests per minute per IP rate limit is completely unusable for such customers. The multi-factor key approach (prefer authenticated user ID over API key over IP fingerprint over raw IP) correctly handles this by keying on the smallest granularity of identity available. Know that API key authentication is the correct solution for enterprise clients: it allows per-user rate limiting even behind a shared NAT.

**Pitfall 3 (window boundary) is the key argument for sliding window over fixed window.** If your interviewer has not heard of the boundary burst problem, explaining it and its fix (sliding window counter) is a strong signal. The explanation: fixed window allows L requests in the last epsilon seconds of window k and L more in the first epsilon seconds of window k+1, for a burst of 2L requests in 2*epsilon seconds. Sliding window eliminates this by using a rolling window that never has a hard boundary.

---

### Senior @ FAANG: Systemic Prevention of Rate Limiter Pitfalls

At L6/L7, the prevention column in the pitfall table is not enough. Prevention requires: engineering controls that make the pitfall impossible to introduce, monitoring that detects the pitfall if it is introduced, and a runbook for recovery when it is detected despite prevention.

**SPOF prevention requires a three-layer defense.** Layer 1 (code): implement local fallback with circuit breaker. Layer 2 (monitoring): alert on `rate_limiter.primary_healthy = 0` for more than 30 seconds. Layer 3 (operational): quarterly chaos engineering exercise that simulates Redis failure and verifies the fallback activates correctly. A pitfall that is prevented only in code can be reintroduced by a future refactor. A pitfall that is also monitored and chaos-tested is resilient to regression.

**NAT unfairness requires a policy decision before a technical solution.** The technical solution (multi-factor key with fingerprinting) is correct. But it requires a policy decision: what is the rate limit for an unauthenticated request from an IP that is clearly a large NAT (serving many clients)? You cannot distinguish a legitimate enterprise customer behind a NAT from a botnet that all appear to share a NAT. The policy options: (1) require API key authentication for any client that needs more than the unauthenticated limit, (2) offer a higher IP-based limit as a paid feature, (3) apply fingerprinting to provide per-device limits within the same IP. Each option has business implications. Document the chosen policy and the rationale before implementing the technical solution.

**Request normalization for bypass prevention requires an exhaustive inventory of parameter spaces.** The `NormalizedKeyExtractor` in Pitfall 4 normalizes path parameters and filters irrelevant query parameters. But every new endpoint that is added to the API may have different path parameter patterns and different meaningful query parameters. The normalization logic must be updated when new endpoints are added, or it will be incorrect for those endpoints. Enforce this by adding an endpoint registration step: every new endpoint must declare its normalization rules (which path segments are IDs, which query parameters are significant) as part of its API registration. The rate limiter reads these rules from the registry rather than hardcoding them, making normalization updates automatic when new endpoints are registered.
