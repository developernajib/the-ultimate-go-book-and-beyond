## Interview Questions

### Question 1: Compare token bucket and sliding window algorithms. When would you choose each?

**What FAANG expects:** Four algorithms by name: fixed window (has boundary burst, 2x rate possible), sliding window counter (smoother, weighted), sliding window log (exact but O(N) memory), token bucket (burst + steady rate). Know which your interviewer likely wants by context: billing = sliding window, API traffic smoothing = token bucket. Bonus for naming leaky bucket as token bucket's dual (smoothing output instead of input).

**Answer:**

| Aspect | Token Bucket | Sliding Window |
|--------|--------------|----------------|
| Burst handling | Allows bursts up to bucket size | Strict per-window limit |
| Memory | O(1) per key | O(requests) for sliding log, O(1) for counter |
| Accuracy | May allow 2x rate at window boundary | More accurate |
| Complexity | Simple | Medium |

**Token Bucket** - best for:
- APIs where occasional bursts are acceptable
- Services with variable but bounded traffic
- When you want smooth rate limiting

```go
// Token bucket allows burst then throttles
// With rate=10/s and burst=20:
// - Can immediately send 20 requests (burst)
// - Then only 10/s until bucket refills
type TokenBucket struct {
    rate       float64
    burst      float64
    tokens     float64
    lastUpdate time.Time
    mu         sync.Mutex
}

func (tb *TokenBucket) Allow() bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(tb.lastUpdate).Seconds()
    tb.tokens = min(tb.burst, tb.tokens+elapsed*tb.rate)
    tb.lastUpdate = now

    if tb.tokens >= 1 {
        tb.tokens--
        return true
    }
    return false
}
```

**Sliding Window** - best for:
- Strict rate enforcement (billing, quotas)
- Protection against traffic spikes
- When you need predictable behavior

```go
// Sliding window counter: strict per-window limit
// Combines current and previous window counts
type SlidingWindowCounter struct {
    windowSize time.Duration
    limit      int64
    prevCount  int64
    currCount  int64
    prevWindow int64
    currWindow int64
    mu         sync.Mutex
}

func (sw *SlidingWindowCounter) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now().UnixMilli()
    windowStart := now - now%sw.windowSize.Milliseconds()

    // Move to new window if needed. Carry the count only when the
    // new window is adjacent, after a longer gap there is nothing
    // recent to weight.
    if windowStart != sw.currWindow {
        if windowStart-sw.currWindow == sw.windowSize.Milliseconds() {
            sw.prevCount = sw.currCount
        } else {
            sw.prevCount = 0
        }
        sw.prevWindow = sw.currWindow
        sw.currCount = 0
        sw.currWindow = windowStart
    }

    // Calculate weighted count
    windowProgress := float64(now-windowStart) / float64(sw.windowSize.Milliseconds())
    estimatedCount := float64(sw.prevCount)*(1-windowProgress) + float64(sw.currCount)

    if int64(estimatedCount) >= sw.limit {
        return false
    }

    sw.currCount++
    return true
}
```

**Follow-ups:**
- *When does the fixed window's boundary burst actually hurt?* Billing and quota enforcement where 2x the nominal rate in a 1-second span triggers downstream overload. Use sliding window for those.
- *Why not always use sliding window log for perfect accuracy?* Memory cost (one entry per request) and Redis ZSET manipulation cost per check. Fine at 100 req/min/user, expensive at 10k req/sec.
- *What is leaky bucket and where does it fit?* Output smoother: enqueue requests, drain at fixed rate, drop on overflow. Natural fit for outbound pipelines (SMTP sending, crawler politeness) where you want strict output rate.

### Question 2: How would you design a rate limiter for a globally distributed system?

**What FAANG expects:** Three approaches with trade-offs: local + global sync (eventual, fastest), partitioned per-region quotas (no coordination, wastes unused capacity), and sticky routing (consistent hash to owner region). Call out the fail-open rule on global store unavailability. Bonus for citing Envoy's RLS (rate-limit service) pattern and Google SRE retry-budget.

**Answer:**

For global distribution, you have three main approaches:

**1. Local rate limiting with global sync** (eventual consistency):
```go
// Each region enforces local limits, periodically syncs
type GlobalRateLimiter struct {
    local      *LocalLimiter
    globalSync *GlobalSyncClient
    region     string
}

func (gl *GlobalRateLimiter) Allow(ctx context.Context, key string) bool {
    // Always check local first (fast)
    if !gl.local.Allow(key) {
        return false
    }

    // Async sync to global state
    go gl.globalSync.ReportUsage(gl.region, key, 1)

    return true
}

// Background process receives global updates
func (gl *GlobalRateLimiter) syncGlobalState() {
    for update := range gl.globalSync.Updates() {
        // Adjust local limits based on global usage
        gl.local.AdjustLimit(update.Key, update.GlobalRemaining)
    }
}
```

**2. Partitioned limits** (per-region quotas):
```go
// Split quota across regions: 30% US, 30% EU, 20% Asia, 20% buffer
type PartitionedLimiter struct {
    regionQuotas map[string]float64
    baseLimiter  *Limiter
    region       string
}

func (pl *PartitionedLimiter) Allow(ctx context.Context, key string) bool {
    regionLimit := int64(float64(pl.baseLimiter.Limit()) * pl.regionQuotas[pl.region])
    return pl.baseLimiter.AllowN(key, 1, regionLimit)
}
```

**3. Request routing** (sticky sessions):
```go
// Route requests to consistent region based on user
type RoutedLimiter struct {
    hashRing    *consistent.Hash
    limiters    map[string]*RemoteLimiter
}

func (rl *RoutedLimiter) Allow(ctx context.Context, key string) bool {
    // Route to owning region
    ownerRegion := rl.hashRing.Get(key)
    return rl.limiters[ownerRegion].Allow(ctx, key)
}
```

For most systems, I recommend **approach 1** because:
- Low latency (local decisions)
- Graceful degradation (works when global sync fails)
- Eventually consistent (acceptable for rate limiting)

**Follow-ups:**
- *What is the worst-case over-allow during a global sync interval?* roughly `regions × local_quota × sync_interval`. Size the sync interval so this over-allow is comfortably under your downstream capacity.
- *When do partitioned quotas waste capacity?* When traffic is uneven across regions. US-peak hours under-utilize EU and Asia quotas. Mitigate with a "steal" mechanism: if local quota is exhausted, request a chunk from neighboring regions.
- *How do you migrate from no rate limit to enforced rate limit without breaking customers?* Shadow mode first (log what would be blocked), then tiered rollout (1% → 10% → 100% per-customer), then enforce. Publish the new limit in a changelog with a long deprecation window.

### Question 3: How do you handle rate limiting for services with variable costs (e.g., API with cheap and expensive operations)?

**What FAANG expects:** Credit-based (weighted) rate limiting: each operation consumes N units, not 1. The canonical example is Shopify's GraphQL API (computed query cost) and AWS API Gateway usage plans. Bonus for distinguishing compute cost from wall-clock cost (a cheap query that hits a slow backend should still throttle when the backend is slow, separate "concurrency" limiter).

**Answer:**

Implement cost-based rate limiting where different operations consume different amounts of quota:

```go
type CostBasedRateLimiter struct {
    redis *redis.Client
    costs map[string]int64 // operation -> cost
}

func (rl *CostBasedRateLimiter) Allow(ctx context.Context, key, operation string) (bool, error) {
    cost := rl.costs[operation]
    if cost == 0 {
        cost = 1 // Default cost
    }

    script := redis.NewScript(`
        local key = KEYS[1]
        local cost = tonumber(ARGV[1])
        local limit = tonumber(ARGV[2])
        local window = tonumber(ARGV[3])

        local current = tonumber(redis.call("GET", key) or "0")

        if current + cost > limit then
            return {0, limit - current}  -- Denied
        end

        redis.call("INCRBY", key, cost)
        if current == 0 then
            redis.call("EXPIRE", key, window)
        end

        return {1, limit - current - cost}  -- Allowed
    `)

    result, err := script.Run(ctx, rl.redis,
        []string{key},
        cost,
        1000,  // 1000 units per minute
        60,
    ).Int64Slice()

    if err != nil {
        return true, err // Fail open
    }

    return result[0] == 1, nil
}

// Usage
limiter := NewCostBasedRateLimiter(redis, map[string]int64{
    "GetUser":       1,
    "ListUsers":     5,
    "SearchUsers":   10,
    "ExportUsers":   100,
    "GenerateReport": 500,
})
```

**Follow-ups:**
- *How do you assign costs to GraphQL queries that clients compose?* Static analysis of the query at parse time: sum estimated row counts × field weights. Reject queries that exceed per-request max cost before execution. GitHub and Shopify both publish their cost calculators.
- *What about dynamic cost (cheap query hits a cold cache and becomes expensive)?* Add a "concurrency" limiter next to the rate limiter: cap in-flight requests per tenant. Slow operations hold a slot longer, self-throttling without needing dynamic cost accounting.
- *How do you communicate the cost to clients?* Response headers: `X-RateLimit-Cost: 50`, `X-RateLimit-Remaining: 950`, `X-RateLimit-Reset: 1712345678`. Enables client-side pacing. Match the convention of the APIs your clients already integrate with.

---

### Junior → FAANG: Interview Preparation for Rate Limiter Questions

The three questions in this section cover the three main axes of rate limiter design interviews: algorithm comparison, distributed coordination, and variable-cost enforcement. Here is how to structure your preparation.

**Practice deriving the algorithm comparison table from memory.** Know the five algorithms, their memory usage, accuracy characteristics, and burst behavior without looking at the table. Being able to reconstruct the comparison table on a whiteboard in under two minutes signals that you have internalized the content, not just read it. The table entries to memorize: token bucket (O(1), allows bursts), leaky bucket (O(1), smooths output), fixed window (O(1), 2x boundary burst), sliding window log (O(n), exact), sliding window counter (O(1), approximate).

**The global distribution question has a three-part structure.** Always answer this question with: (1) local-only, (2) partitioned quotas, (3) sticky routing. For each option, state the latency (local = fastest, partitioned = fast, sticky = adds one network hop for non-owner regions), the accuracy (local = poor, partitioned = acceptable, sticky = best), and the failure mode (local = easy to overload if regional traffic is uneven, partitioned = wastes quota in low-traffic regions, sticky = adds dependency on the routing layer). Then recommend option 1 (local with async sync) for most use cases.

**The cost-based question tests whether you understand GraphQL and Shopify-style APIs.** Know that Shopify's GraphQL API assigns a cost to each query based on the expected number of database rows returned. A query for a single product costs 1, a query for all orders with line items costs 1000. The cost is computed at parse time before execution. Clients can ask for the cost of a query without executing it (using a dry-run mode). Know these details and be able to explain why cost-based limiting is more accurate than request-count limiting for variable-cost queries.

---

### Senior @ FAANG: Bar-Raiser Calibration for Rate Limiter Design

At L6/L7, rate limiter design interviews are evaluated on three dimensions that go beyond algorithm knowledge: operational maturity (can you run this in production?), governance thinking (who controls this and how?), and failure mode analysis (what breaks and how does the system recover?).

**Algorithm question calibration: L6 vs L7.** An L6 answer names all five algorithms with trade-offs, recommends the sliding window counter for the given use case with justification, and identifies the boundary burst as the key limitation of fixed window. An L7 answer additionally addresses the mathematical guarantee under adversarial conditions (2x burst = 2L/(2*epsilon) instantaneous rate), the clock drift budget for the distributed implementation (acceptable NTP drift vs. required accuracy), and the Lua script correctness proof for the distributed version (why WATCH/MULTI does not work for conditional increment). The L7 answer is a complete correctness argument, not just a recommendation.

**Distribution question calibration: L6 vs L7.** An L6 answer correctly describes the three approaches, recommends local + async sync, and acknowledges the over-limit window during sync lag. An L7 answer additionally provides a quantitative bound on the over-limit traffic (`regions * local_quota * sync_interval_seconds`), proposes a sync interval that keeps this bound within the downstream service's capacity, addresses the failure mode when the sync channel is unavailable (local-only until sync resumes, with a metric for sync lag), and discusses the governance question of who sets the sync interval (SRE team, in coordination with the platform team, reviewed at each capacity review).

**Cost-based question calibration: L6 vs L7.** An L6 answer implements cost-based limiting with a static cost map. An L7 answer additionally addresses: how costs are assigned for dynamically composed queries (GraphQL query complexity analysis at parse time), how costs are communicated to clients in a way that enables pacing (response headers + a dry-run API), how costs are audited (every request logs its cost for post-hoc analysis), and how cost weights are changed over time (a change management process that announces cost changes 30 days in advance, with a migration period where both old and new costs are accepted). The L7 answer treats cost assignment as a product governance problem, not just an engineering configuration.
