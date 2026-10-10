## 42.9 Interview Questions

### Question 1: Compare rate limiting algorithms and when to use each

**Answer:**

```go
/*
RATE LIMITING ALGORITHM COMPARISON

1. FIXED WINDOW COUNTER
   How: Count requests in fixed time windows (e.g., 0:00-1:00, 1:00-2:00)

   Pros:
   - Simple to implement
   - Low memory footprint (one counter per key)
   - Fast O(1) operations

   Cons:
   - Boundary spike problem: 2x burst at window edges
   - Example: 100/min limit, 100 requests at 0:59, 100 more at 1:01

   Use when:
   - Simplicity is priority
   - Approximate limiting is acceptable
   - You don't have burst-sensitive operations

2. SLIDING WINDOW LOG
   How: Keep timestamp of every request, count requests in sliding window

   Pros:
   - Most accurate (no boundary issues)
   - Exact request tracking

   Cons:
   - High memory usage (O(n) per key where n = limit)
   - Slower for high-volume endpoints

   Use when:
   - Accuracy is critical
   - Limits are relatively low
   - You need audit trail of requests

3. SLIDING WINDOW COUNTER
   How: Weighted average of current and previous fixed windows

   Pros:
   - Good accuracy (solves boundary problem)
   - Low memory (two counters per key)
   - Fast operations

   Cons:
   - Approximate (not exact count)
   - Slightly more complex than fixed window

   Use when:
   - Need balance of accuracy and efficiency
   - General-purpose API rate limiting

4. TOKEN BUCKET
   How: Bucket fills with tokens at constant rate, requests consume tokens

   Pros:
   - Allows controlled bursts
   - Smooth rate limiting
   - Can have different refill and burst rates

   Cons:
   - More state to track (tokens + timestamp)
   - Burst can still overwhelm downstream

   Use when:
   - Bursts are acceptable/expected
   - Mobile apps with sporadic connectivity
   - Real-time applications

5. LEAKY BUCKET
   How: Process requests at constant rate, queue excess, drop when full

   Pros:
   - Constant output rate (no bursts)
   - Protects downstream services
   - Smooth traffic shaping

   Cons:
   - Adds latency for queued requests
   - More complex implementation
   - May not be suitable for interactive APIs

   Use when:
   - Downstream can't handle bursts
   - You need traffic shaping
   - Batch processing systems
*/

// Decision tree for choosing algorithm
func ChooseAlgorithm(requirements Requirements) Algorithm {
    if requirements.NeedExactCount {
        return SlidingWindowLog
    }

    if requirements.NeedConstantRate {
        return LeakyBucket
    }

    if requirements.AllowBursts {
        return TokenBucket
    }

    if requirements.LowMemory && !requirements.HighAccuracy {
        return FixedWindow
    }

    // Default: good balance
    return SlidingWindowCounter
}
```

**What FAANG expects:** Name all five algorithms unprompted, explain the boundary-burst problem for fixed windows with a concrete example (100/min limit, 200 requests between 0:59.5 and 1:00.5), distinguish O(1) vs O(rate) memory trade-offs, and justify a default (sliding window counter for general APIs, token bucket when clients expect burst headroom, leaky bucket only when a downstream system cannot absorb spikes). Bonus: mention that `golang.org/x/time/rate` implements token bucket with lazy refill (elapsed-time computation on each call, no ticker goroutine).

**Follow-ups:**
1. "Your fixed-window limiter is admitting 2x the intended rate at window boundaries. Without switching to sliding window, how would you mitigate it?" (Answer: add a per-key burst cap, or jitter window start times per key so boundaries do not align across clients.)
2. "Token bucket versus leaky bucket, which one would you pick for a payment API calling a bank's 100 TPS endpoint?" (Answer: leaky bucket. The bank's limit is strict, bursts would be rejected downstream anyway and cause retries.)
3. "How does `rate.Limiter.Reserve()` differ from `Wait()`, and when would you prefer each?" (Answer: `Reserve` returns the delay synchronously so you can decide whether to wait or cancel. `Wait` just blocks. Use `Reserve` when you need to enforce a max-wait SLA or cancel the reservation on a fast-failing caller.)

### Question 2: How would you implement rate limiting across multiple data centers?

**Answer:**

```go
/*
MULTI-DATACENTER RATE LIMITING STRATEGIES

Challenge: User might hit different data centers for different requests.
Need global view of usage without adding latency.

APPROACHES:

1. CENTRAL COUNTER (Simple, High Latency)
   - Single Redis cluster for all DCs
   - Every request checks central store

   Pros: Accurate global limiting
   Cons: Added latency for cross-DC calls, single point of failure

2. LOCAL + ASYNC SYNC (Low Latency, Eventually Consistent)
   - Each DC has local rate limiter
   - Sync counts asynchronously between DCs

   Pros: Low latency, resilient to DC failures
   Cons: Can exceed limit during sync delays

3. SPLIT LIMITS (Simple, Predictable)
   - Divide limit by number of DCs
   - Each DC enforces its portion

   Example: 1000/min global → 333/min per DC (3 DCs)

   Pros: No coordination needed, predictable
   Cons: Unbalanced traffic wastes capacity

4. GOSSIP-BASED (Scalable, Complex)
   - DCs share counts via gossip protocol
   - Eventually consistent with CRDTs

   Pros: Highly scalable, tolerant of failures
   Cons: Complex implementation, eventual consistency
*/

// Implementation: Local + Async Sync approach
type GlobalRateLimiter struct {
    localLimiter  *LocalRateLimiter
    localDC       string
    syncClient    *SyncClient
    globalCounts  sync.Map
    syncInterval  time.Duration
}

func NewGlobalRateLimiter(dc string, limit int, window time.Duration) *GlobalRateLimiter {
    g := &GlobalRateLimiter{
        // Each DC gets portion of limit + buffer for sync delay
        localLimiter: NewLocalRateLimiter(limit/3 + limit/10, window),
        localDC:      dc,
        syncInterval: 100 * time.Millisecond,
    }

    go g.syncLoop()
    return g
}

func (g *GlobalRateLimiter) Allow(ctx context.Context, key string) (bool, int, time.Time) {
    // Fast path: check local limit
    allowed, remaining, reset := g.localLimiter.Allow(key)
    if !allowed {
        return false, remaining, reset
    }

    // Get estimated global count (may be slightly stale)
    globalCount := g.estimateGlobalCount(key)

    // If we're approaching global limit, be more conservative
    if globalCount > g.localLimiter.Limit() * 2 {
        // Reject to leave room for other DCs
        return false, 0, reset
    }

    return true, remaining, reset
}

func (g *GlobalRateLimiter) syncLoop() {
    ticker := time.NewTicker(g.syncInterval)
    defer ticker.Stop()

    for range ticker.C {
        // Get local counts
        localCounts := g.localLimiter.GetAllCounts()

        // Send to sync service
        globalCounts, err := g.syncClient.Exchange(g.localDC, localCounts)
        if err != nil {
            continue // Use stale data on sync failure
        }

        // Update global view
        for key, count := range globalCounts {
            g.globalCounts.Store(key, count)
        }
    }
}

func (g *GlobalRateLimiter) estimateGlobalCount(key string) int {
    if count, ok := g.globalCounts.Load(key); ok {
        return count.(int)
    }
    return 0
}

// Sync service aggregates counts from all DCs
type SyncService struct {
    dcCounts map[string]map[string]int // DC -> key -> count
    mu       sync.RWMutex
}

func (s *SyncService) Exchange(dc string, counts map[string]int) (map[string]int, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Store this DC's counts
    s.dcCounts[dc] = counts

    // Calculate global counts
    global := make(map[string]int)
    for _, dcCounts := range s.dcCounts {
        for key, count := range dcCounts {
            global[key] += count
        }
    }

    return global, nil
}
```

**What FAANG expects:** Candidate should reach for "local decision plus async aggregation" first (low latency) and only fall back to a central counter if the business requires strict global limits (billing, fraud prevention). Mention CRDTs (G-Counter) for gossip-based sync so counts never decrease. Call out that Cloudflare publicly uses a sliding window counter with per-PoP state and periodic global reconciliation, not a central lock. Never propose a synchronous cross-region call per request.

**Follow-ups:**
1. "A user sends 1000 requests to 3 DCs in parallel. Your per-DC limit is 333. What is the worst case number of requests admitted before sync?" (Answer: 3 x 333 = 999, acceptable because the next window still rejects the excess.)
2. "How do you bound the blast radius if your sync service itself goes down?" (Answer: each DC continues enforcing its local portion, so global limits loosen by at most 2x for the sync interval. Monitor sync lag and alert.)
3. "What if a single user's traffic is concentrated in one DC because of GeoDNS?" (Answer: split-limit strategies waste capacity. Use weighted splits based on historical traffic, or elect a "coordinator DC" per key via consistent hashing so one DC owns the counter for that user.)

### Question 3: How do you handle rate limiting for APIs with varying operation costs?

**Answer:**

```go
/*
COST-BASED RATE LIMITING

Problem: Not all requests are equal
- GET /users: Cheap (database read)
- POST /reports: Expensive (heavy computation)
- GET /export: Very expensive (generates files)

Solution: Assign costs to operations, deduct from budget
*/

// CostBasedLimiter deducts operation costs from a budget
type CostBasedLimiter struct {
    client       *redis.Client
    budgetLimit  int           // Total budget per window
    window       time.Duration
    costs        map[string]int
    defaultCost  int
}

func NewCostBasedLimiter(client *redis.Client, budget int, window time.Duration) *CostBasedLimiter {
    return &CostBasedLimiter{
        client:      client,
        budgetLimit: budget,
        window:      window,
        costs: map[string]int{
            // Read operations: low cost
            "GET":    1,
            "HEAD":   1,

            // Write operations: medium cost
            "POST":   5,
            "PUT":    5,
            "PATCH":  5,
            "DELETE": 3,

            // Specific expensive operations
            "POST /api/reports":    50,
            "GET /api/export":      100,
            "POST /api/bulk":       200,
            "POST /api/import":     500,
        },
        defaultCost: 1,
    }
}

func (c *CostBasedLimiter) Window() time.Duration { return c.window }

// GetCost resolves the cost of a route such as "POST /api/reports".
// route must be the matched route TEMPLATE (r.Pattern), not a concrete path,
// or the specific-endpoint lookup below never hits.
func (c *CostBasedLimiter) GetCost(route string) int {
    // Most specific first: the exact route.
    if cost, ok := c.costs[route]; ok {
        return cost
    }

    // Then the method's default cost.
    method, _, found := strings.Cut(route, " ")
    if !found {
        method = route
    }
    if cost, ok := c.costs[method]; ok {
        return cost
    }

    return c.defaultCost
}

func (c *CostBasedLimiter) Allow(ctx context.Context, userID, route string) (*CostResult, error) {
    cost := c.GetCost(route)
    key := fmt.Sprintf("cost_limit:%s", userID)

    script := redis.NewScript(`
        local key = KEYS[1]
        local cost = tonumber(ARGV[1])
        local budget = tonumber(ARGV[2])
        local window = tonumber(ARGV[3])

        local current = redis.call('GET', key)
        if current == false then
            current = 0
        else
            current = tonumber(current)
        end

        local remaining = budget - current

        if remaining < cost then
            local ttl = redis.call('TTL', key)
            return {0, remaining, ttl}
        end

        local new_total = redis.call('INCRBY', key, cost)
        if new_total == cost then
            redis.call('EXPIRE', key, window)
        end

        local ttl = redis.call('TTL', key)
        return {1, budget - new_total, ttl}
    `)

    result, err := script.Run(ctx, c.client, []string{key},
        cost,
        c.budgetLimit,
        int(c.window.Seconds()),
    ).Slice()

    if err != nil {
        return &CostResult{Allowed: true, Budget: c.budgetLimit}, nil
    }

    return &CostResult{
        Allowed:   result[0].(int64) == 1,
        Remaining: int(result[1].(int64)),
        Budget:    c.budgetLimit,
        Cost:      cost,
        ResetIn:   time.Duration(result[2].(int64)) * time.Second,
    }, nil
}

type CostResult struct {
    Allowed   bool
    Remaining int
    Budget    int
    Cost      int
    ResetIn   time.Duration
}

// Middleware that uses cost-based limiting
func CostBasedMiddleware(limiter *CostBasedLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userID := getUserID(r)

            // Look the cost up by matched route (r.Pattern), never r.URL.Path:
            // a cost table keyed by template silently misses on every
            // concrete path and charges the default for your priciest calls.
            route := r.Pattern
            if route == "" {
                route = r.Method + " " + r.URL.Path
            }

            result, err := limiter.Allow(r.Context(), userID, route)
            if err != nil {
                http.Error(w, "Internal error", http.StatusInternalServerError)
                return
            }

            // Standard state, plus custom headers for the cost model. The
            // IETF draft has no notion of per-request cost, so Budget/Cost
            // are necessarily bespoke and must be documented as such.
            w.Header().Set("RateLimit-Policy",
                fmt.Sprintf("%q;q=%d;w=%d", "cost", result.Budget,
                    int(limiter.Window().Seconds())))
            w.Header().Set("RateLimit",
                fmt.Sprintf("%q;r=%d;t=%d", "cost", max(result.Remaining, 0),
                    int(result.ResetIn.Seconds())))
            w.Header().Set("X-RateLimit-Cost", strconv.Itoa(result.Cost))

            if !result.Allowed {
                retryAfter := max(int(result.ResetIn.Seconds()), 1)
                w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
                w.Header().Set("Content-Type", "application/problem+json")

                // WriteHeader BEFORE writing the body. Any write to w
                // implicitly sends 200 OK first, so encoding the JSON and
                // then calling WriteHeader(429) sends the client a 200 with
                // an error body, logs "superfluous WriteHeader call", and
                // guarantees no client ever backs off. Header().Set is fine
                // in any order - the first *write* is what commits the status.
                w.WriteHeader(http.StatusTooManyRequests)

                json.NewEncoder(w).Encode(map[string]any{
                    "type":   "https://example.com/probs/budget-exceeded",
                    "title":  "Too Many Requests",
                    "status": http.StatusTooManyRequests,
                    "detail": fmt.Sprintf("Request cost %d exceeds remaining budget %d",
                        result.Cost, result.Remaining),
                    "cost":                result.Cost,
                    "remaining":           result.Remaining,
                    "retry_after_seconds": retryAfter,
                })
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

**What FAANG expects:** Recognize that request count is the wrong unit when operations have 100x cost variance (a search versus a bulk export). Propose a budget-based scheme (GitHub's GraphQL cost, Shopify's leaky bucket in "cost units", AWS API token weights). Mention that the cost must be known before the handler runs (assign by route, or estimate then reconcile). Critical: the check-and-decrement must be atomic in a distributed setting, which means Lua. Also call out that costs should be published to clients (header or docs) so they can budget.

**Follow-ups:**
1. "How would you handle a request whose actual cost is only known after execution (e.g., a paginated query that returns a variable number of rows)?" (Answer: charge an estimate upfront, reconcile after. If actual cost exceeds estimate, debit the delta. Shopify's leaky bucket does this.)
2. "A client complains your `X-RateLimit-Cost` header is non-deterministic. How do you guarantee determinism?" (Answer: compute cost purely from request attributes (method, path, declared page size), never from server state. Make cost part of the API contract.)
3. "How do you prevent a client from probing your endpoint costs to reverse-engineer your backend?" (Answer: publish costs in docs. There is no security benefit to hiding them, and clients need them to self-throttle.)

### Question 4: How would you implement adaptive rate limiting that responds to system load?

**Answer:**

```go
/*
ADAPTIVE RATE LIMITING

Goal: Automatically adjust limits based on system health
- High load → Lower limits (protect system)
- Low load → Higher limits (better UX)
- Failing dependencies → Limit affected endpoints

Key Metrics to Monitor:
- CPU utilization
- Memory pressure
- Request latency (p99)
- Error rate
- Queue depth
- Downstream health
*/

type AdaptiveLimiter struct {
    baseLimiter    *TokenBucketLimiter
    baseRate       int
    minRate        int
    maxRate        int
    currentRate    atomic.Int64

    // Health metrics
    metrics        *MetricsCollector

    // Thresholds
    cpuThreshold   float64  // Start reducing at this CPU %
    latencyTarget  time.Duration  // Target p99 latency
    errorThreshold float64  // Start reducing at this error %
}

func NewAdaptiveLimiter(baseRate, minRate, maxRate int) *AdaptiveLimiter {
    a := &AdaptiveLimiter{
        baseLimiter:    NewTokenBucketLimiter(float64(baseRate)/60, baseRate),
        baseRate:       baseRate,
        minRate:        minRate,
        maxRate:        maxRate,
        metrics:        NewMetricsCollector(),
        cpuThreshold:   0.7,
        latencyTarget:  100 * time.Millisecond,
        errorThreshold: 0.01, // 1%
    }

    a.currentRate.Store(int64(baseRate))
    go a.adjustLoop()

    return a
}

func (a *AdaptiveLimiter) adjustLoop() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        health := a.metrics.GetHealthScore()
        newRate := a.calculateRate(health)

        oldRate := a.currentRate.Swap(int64(newRate))
        if int64(newRate) != oldRate {
            // Recreate limiter with new rate
            a.baseLimiter = NewTokenBucketLimiter(float64(newRate)/60, newRate)

            a.metrics.RecordRateChange(int(oldRate), newRate, health)
        }
    }
}

func (a *AdaptiveLimiter) calculateRate(health HealthScore) int {
    // Calculate multiplier based on health
    var multiplier float64 = 1.0

    // CPU factor
    if health.CPUUsage > a.cpuThreshold {
        cpuFactor := 1 - ((health.CPUUsage - a.cpuThreshold) / (1 - a.cpuThreshold))
        multiplier *= cpuFactor
    }

    // Latency factor
    if health.P99Latency > a.latencyTarget {
        latencyRatio := float64(a.latencyTarget) / float64(health.P99Latency)
        multiplier *= latencyRatio
    }

    // Error rate factor
    if health.ErrorRate > a.errorThreshold {
        errorFactor := 1 - (health.ErrorRate / 0.1) // Scale down to 0 at 10% errors
        if errorFactor < 0.1 {
            errorFactor = 0.1 // Never go below 10% of rate
        }
        multiplier *= errorFactor
    }

    // Memory pressure factor
    if health.MemoryPressure > 0.9 {
        multiplier *= 0.5
    }

    // Can increase above base if system is healthy
    if multiplier >= 1.0 && health.CPUUsage < 0.3 && health.ErrorRate < 0.001 {
        multiplier = 1.5 // Increase 50% when healthy
    }

    newRate := int(float64(a.baseRate) * multiplier)

    // Clamp to bounds
    if newRate < a.minRate {
        newRate = a.minRate
    }
    if newRate > a.maxRate {
        newRate = a.maxRate
    }

    return newRate
}

type HealthScore struct {
    CPUUsage       float64       // 0-1
    MemoryPressure float64       // 0-1
    P99Latency     time.Duration
    ErrorRate      float64       // 0-1
    QueueDepth     int
}

// Per-endpoint adaptive limiting
type EndpointAdaptiveLimiter struct {
    limiters       map[string]*AdaptiveLimiter
    dependencies   map[string][]string  // endpoint -> dependencies
    depHealth      sync.Map             // dependency -> healthy bool
}

func (e *EndpointAdaptiveLimiter) Allow(ctx context.Context, endpoint, key string) bool {
    limiter, ok := e.limiters[endpoint]
    if !ok {
        return true
    }

    // Check if any dependencies are unhealthy
    if deps, ok := e.dependencies[endpoint]; ok {
        for _, dep := range deps {
            if healthy, ok := e.depHealth.Load(dep); ok && !healthy.(bool) {
                // Dependency is down - severely limit this endpoint
                return limiter.AllowReduced(key, 0.1) // 10% of normal rate
            }
        }
    }

    return limiter.Allow(key)
}
```

**What FAANG expects:** The expert answer pivots from rate-based to concurrency-based limiting. Describe Netflix's gradient algorithm (`gradient = minRTT / currentRTT`, multiply current limit by gradient + sqrt(limit) queue allowance) which ships in Netflix/concurrency-limits, Envoy's adaptive concurrency filter, and Vector's ARC. The advantage: no magic number thresholds, the system finds its own saturation point. A good candidate also mentions CoDel for queue management and AIMD as the simpler TCP-congestion-control-inspired fallback.

**Follow-ups:**
1. "Why is measuring minRTT hard in practice, and how does Netflix work around it?" (Answer: minRTT drifts as hardware and dependencies change. Gradient2 uses a long-term exponentially smoothed average instead of a true minimum so it tracks gradual environmental changes.)
2. "Adaptive limits can oscillate: you shed load, latency drops, you admit more, latency spikes, you shed again. How do you damp this?" (Answer: use AIMD (additive increase, multiplicative decrease) so growth is slow and shrink is fast, or hysteresis bands so small gradient changes do not trigger updates.)
3. "Where should the adaptive decision live, per-instance or globally?" (Answer: per-instance almost always. Each replica has different RTT characteristics, and you want a slow replica to shed its own traffic without starving healthy ones. A global controller creates a coupling that amplifies oscillation.)

### Question 5: Explain the trade-offs between rate limiting at different layers

**Answer:**

```go
/*
RATE LIMITING LAYERS

Each layer has different characteristics:

1. EDGE / CDN LAYER (Cloudflare, AWS CloudFront)
   Pros:
   - Stops attacks before reaching origin
   - Globally distributed, low latency
   - Handles massive scale

   Cons:
   - Limited context (no user info)
   - Can't do complex business logic
   - Usually IP-based only

   Best for:
   - DDoS protection
   - Bot mitigation
   - Geographic restrictions

2. API GATEWAY LAYER (Kong, AWS API Gateway)
   Pros:
   - Can see API keys, basic auth
   - Per-endpoint limits
   - Central management

   Cons:
   - Still limited user context
   - May need to call auth service
   - Added latency

   Best for:
   - API key rate limits
   - Per-endpoint protection
   - Third-party API throttling

3. APPLICATION LAYER (Your Go service)
   Pros:
   - Full user context
   - Complex business rules
   - Per-operation costs
   - Tenant-aware limiting

   Cons:
   - Traffic already at your servers
   - Must handle distributed limiting
   - More implementation work

   Best for:
   - User-specific limits
   - Business logic limits
   - Feature-based throttling

4. DATABASE LAYER (Rate limit queries)
   Pros:
   - Protects most vulnerable resource
   - Simple to implement

   Cons:
   - Very late in the request
   - Limited to DB operations

   Best for:
   - Expensive query protection
   - Report generation limits
*/

// Multi-layer rate limiting implementation
type MultiLayerLimiter struct {
    // Layer 1: IP-based (handled by edge, but we back it up)
    ipLimiter *IPLimiter

    // Layer 2: API key based
    apiKeyLimiter *APIKeyLimiter

    // Layer 3: User/tenant based
    userLimiter *UserLimiter

    // Layer 4: Operation based
    operationLimiter *OperationLimiter
}

func (m *MultiLayerLimiter) Middleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx := r.Context()

            // Layer 1: IP limit (coarse, first line of defense)
            ip := getClientIP(r)
            if !m.ipLimiter.Allow(ctx, ip) {
                writeRateLimitError(w, "ip_rate_limit", "Too many requests from this IP")
                return
            }

            // Layer 2: API key limit (if present)
            if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
                allowed, result := m.apiKeyLimiter.Allow(ctx, apiKey)
                setAPIKeyHeaders(w, result)
                if !allowed {
                    writeRateLimitError(w, "api_key_rate_limit", "API key rate limit exceeded")
                    return
                }
            }

            // Layer 3: User/tenant limit (after auth middleware)
            if user := GetUser(ctx); user != nil {
                allowed, result := m.userLimiter.Allow(ctx, user.ID, user.TenantID)
                setUserHeaders(w, result)
                if !allowed {
                    writeRateLimitError(w, "user_rate_limit", "User rate limit exceeded")
                    return
                }
            }

            // Layer 4: Operation limit
            operation := r.Method + " " + r.URL.Path
            allowed, result := m.operationLimiter.Allow(ctx, operation, GetUserID(ctx))
            setOperationHeaders(w, result)
            if !allowed {
                writeRateLimitError(w, "operation_rate_limit",
                    fmt.Sprintf("Rate limit exceeded for %s", operation))
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Example: Defense in depth configuration
func ConfigureRateLimiting() {
    /*
    Layer 1 - Edge (Cloudflare):
    - 1000 req/sec per IP globally
    - Challenge on suspicious patterns
    - Block known bad IPs

    Layer 2 - API Gateway:
    - 100 req/sec per API key
    - Per-endpoint overrides

    Layer 3 - Application:
    - Free tier: 60 req/min per user
    - Pro tier: 1000 req/min per user
    - Enterprise: Custom

    Layer 4 - Database:
    - Max 10 concurrent queries per user
    - Export limited to 1/hour
    */
}
```

**What FAANG expects:** Articulate defense in depth: coarse at the edge (IP-based, stops volumetric attacks before they reach origin), finer at each successive layer (API key at gateway, user/tenant at application, per-query at database). Name specific products (Cloudflare, AWS WAF, Kong, Envoy, Istio). Emphasize that limits at different layers serve different threats: edge protects against DDoS, application protects against abusive but authenticated clients, database protects against expensive queries. Each layer should fail open to the next so a Redis outage at the application layer does not bypass the edge CAPTCHA.

**Follow-ups:**
1. "An attacker rotates through 100k residential IPs to bypass your IP rate limit. What layer catches them?" (Answer: IP rate limiting is useless against botnets. Fall back to behavioral signals (request fingerprint, TLS JA3, session-linked rate limits post-auth) and challenge with CAPTCHA or proof-of-work.)
2. "Your gateway rate-limits at 1000 req/s but your app servers auto-scale based on CPU. What problem does this create?" (Answer: the gateway cap creates a ceiling that scaling cannot break through. Either make the gateway limit per-backend-capacity-aware, or move the limit to the app layer where adaptive concurrency can find the true ceiling.)
3. "How do you handle rate-limit headers when a request passes through multiple layers each with its own limit?" (Answer: the `RateLimit` header should report the **binding** limit, meaning whichever layer is closest to rejecting, which is not necessarily the outermost one. `RateLimit-Policy` is a list, so you can advertise several quotas at once when a client genuinely needs to plan against both a burst limit and a daily one. What you should not do is let each layer overwrite the header on the way out, which is the default behaviour of most proxy chains and yields whichever value the last hop happened to write. Decide deliberately which layer owns the header and have the others leave it alone.)

### Junior → FAANG: Answering Rate Limiting Questions Without Freezing

Rate limiting interviews trip up junior candidates because the questions look simple on the surface ("just count requests, right?") but every follow-up digs into distributed systems, atomicity, and failure modes. The mental model to build before your interview is this: rate limiting is a distributed coordination problem, not a counting problem.

**Prerequisite gaps most juniors have:**

1. They know token bucket by name but cannot derive it. Practice: draw a bucket, a tap filling it, and a drain. The drain is your request consumer. The tap is the refill rate. If the bucket is empty, the request waits or drops. That picture lets you answer any token bucket question cold.

2. They think Redis is magic. You need to know why plain `INCR` is not enough (no TTL atomically set), why `INCR` + `EXPIRE` in two commands is a race condition, and why Lua scripts solve it. Practice writing the three-line Lua script: `INCR key`, `if result == 1 then EXPIRE key window end`, `return result`. This pattern appears in every FAANG rate limiting question.

3. They do not know what the remaining count means to a client. The answer: it lets the client self-throttle before getting a 429, so well-behaved clients slow down on their own and your rejection rate drops. Know the current spelling too. The IETF draft carries it as `r` inside a single `RateLimit` header (`RateLimit: "default";r=50;t=30`), having withdrawn the older `RateLimit-Remaining` field, while most deployed APIs still emit GitHub-style `X-RateLimit-Remaining`. Naming the legacy convention *and* the draft, and knowing which is which, reads as someone who has shipped this rather than skimmed a blog post.

**First-job habits to build now:**

- Always return `Retry-After` on 429. Without it, clients implement exponential backoff from scratch and you get a thundering herd anyway.
- Pick a default algorithm before your interview and be able to justify it. "Sliding window counter because it is O(1) space, good accuracy, and one Redis call per request" is a complete, defensible answer.
- Know the boundary-burst attack for fixed windows. If you cannot explain why 200 requests pass through at window boundary when the limit is 100, you will fail the first follow-up.

**Entry-point framing for each question type:**

- Algorithm comparison: Start with memory and accuracy axes. Draw the O(1) vs O(rate) memory trade-off, then add accuracy. Sliding window log is in the top-right (accurate, expensive). Fixed window is in the bottom-left (cheap, inaccurate). Token bucket sits in the middle for both.
- Distributed rate limiting: Start with "do we need strict global accuracy or approximate?" Strict means a central Redis with Lua. Approximate means local limiters with async sync. Almost all real-world systems can tolerate approximate.
- Failure modes: The interviewer wants to hear "fail open for critical paths, fail closed for non-critical." Say it early.

### Senior @ FAANG: Rate Limiting as a Platform Capability

At L5 and above, interviewers are not testing whether you know token bucket. They already assume that. They are testing whether you can reason about rate limiting as a platform capability that other teams depend on, has operational failure modes that wake people up at 3 am, and must be designed to evolve without breaking clients.

**Architectural decision record framing:**

Every rate limiting design should be driven by an explicit ADR. The decision is not "which algorithm" but "what failure contract do we give callers?" A system that fails closed on Redis outage has a different SLA than one that fails open. Write that down before you write code. At FAANG, undocumented failure contracts become incidents.

**The three maturity levels of a rate limiting platform:**

Level 1 (in-process): Each service owns its own limiter. Simple, no ops burden, but limits are per-replica, not global. Acceptable for single-region, single-instance services.

Level 2 (shared Redis): Limits are global across replicas. Requires Lua scripts for atomicity. Introduces Redis as a dependency. Needs circuit breakers, local fallback, and Redis health metrics. Most teams at FAANG operate here.

Level 3 (rate limiting service): A dedicated service that other teams call, with its own SLA, config API, and audit log. Limits can be changed at runtime without deploys. Costs are published in a contract. This is where Stripe, Cloudflare, and AWS operate for their external APIs.

**Bar-raiser interview signals:**

A bar raiser will push you past the algorithm and into the operational reality. Strong signals include:

- Quoting concrete numbers. "Redis INCR with Lua takes under 1ms at p99 on a local cluster. A cross-region call takes 80ms minimum. That is an 80x latency hit for strict global accuracy. So unless billing is on the line, use local limiters with async sync."
- Naming the Netflix gradient algorithm unprompted and explaining why per-instance concurrency limits self-tune better than per-instance rate limits under variable load.
- Discussing CRDT G-Counters for gossip-based sync and explaining why you cannot use a PN-Counter (which allows decrement) because quota should never increase from a peer's report.
- Raising the key selection problem: rate limit by IP is bypassable, by API key is bypassable with rotating keys, by user is the right answer for authenticated traffic, but unauthenticated traffic at the edge needs device fingerprinting (TLS JA3, HTTP/2 frame ordering, request header order).

**Staff-level concerns:**

At L6/L7, the question is not how to build the limiter but how to operate it across 500 services without every team reinventing it. The right answer involves: a shared library with a common interface, a config service that pushes limit changes without deploys, per-endpoint cost registry that product teams can read, and a central dashboard that security can use to detect abuse across all services at once. You are not designing a component. You are designing a capability with a roadmap.

**Governance model:**

Who owns rate limiting decisions? At most companies this is ambiguous and becomes a source of incidents. A senior candidate proposes: the platform team owns the mechanism and default policies, product teams own the limit values for their endpoints, security owns the right to override any limit in a confirmed attack. Document that explicitly so on-call engineers know who to wake up.

**The metric that matters most:**

False positive rate. Every legitimate request you reject costs the business. Track `ratelimit_requests_rejected_total` broken down by whether the client later succeeded (retry after Retry-After) vs abandoned. Abandoned retries after a 429 are the ones that cost you revenue. This metric should be in your team's weekly review, not just your ops runbook.

---
