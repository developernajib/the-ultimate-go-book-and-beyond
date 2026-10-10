## 61.9 Company Case Studies

### Stripe: Sophisticated API Rate Limiting

As documented by Brandur Leach in "Scaling your API with rate limiters" (*Stripe Engineering Blog*, 2017), Stripe enforces rate limits across three simultaneous dimensions: per-second token bucket (allowing controlled bursts), concurrent request counting (preventing thread starvation on the server), and monthly quota tracking (for billing enforcement). Each API operation carries a cost weight: a payment creation costs 10 units while a balance read costs 1, so expensive operations consume quota faster. The entire check runs as a single Lua script on Redis to guarantee atomicity across all three dimensions.

```go
// stripe_rate_limiter.go
// Inspired by Stripe's API rate limiting architecture
package stripe

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// StripeRateLimiter implements multi-dimensional rate limiting
type StripeRateLimiter struct {
    redis *redis.ClusterClient

    // Tier configurations
    tierLimits map[string]*TierConfig

    // Request cost calculator
    costCalculator *RequestCostCalculator
}

// TierConfig defines rate limits for an account tier
type TierConfig struct {
    Name            string
    RequestsPerSec  int64
    BurstMultiplier float64
    ConcurrentLimit int
    MonthlyQuota    int64
}

// RequestCostCalculator assigns costs to different operations
type RequestCostCalculator struct {
    endpointCosts map[string]int
    defaultCost   int
}

func (c *RequestCostCalculator) GetCost(endpoint string, method string) int {
    key := fmt.Sprintf("%s:%s", method, endpoint)
    if cost, ok := c.endpointCosts[key]; ok {
        return cost
    }
    return c.defaultCost
}

func NewStripeRateLimiter(redis *redis.ClusterClient) *StripeRateLimiter {
    return &StripeRateLimiter{
        redis: redis,
        tierLimits: map[string]*TierConfig{
            "test": {
                Name:            "Test Mode",
                RequestsPerSec:  25,
                BurstMultiplier: 2.0,
                ConcurrentLimit: 5,
                MonthlyQuota:    10000,
            },
            "standard": {
                Name:            "Standard",
                RequestsPerSec:  100,
                BurstMultiplier: 1.5,
                ConcurrentLimit: 25,
                MonthlyQuota:    100000,
            },
            "scale": {
                Name:            "Scale",
                RequestsPerSec:  500,
                BurstMultiplier: 1.2,
                ConcurrentLimit: 100,
                MonthlyQuota:    -1, // Unlimited
            },
        },
        costCalculator: &RequestCostCalculator{
            endpointCosts: map[string]int{
                "POST:/v1/charges":          10, // Expensive operation
                "POST:/v1/payment_intents":  10,
                "GET:/v1/charges":           1,
                "GET:/v1/balance":           1,
                "POST:/v1/tokens":           5,
                "GET:/v1/customers":         1,
            },
            defaultCost: 1,
        },
    }
}

// DenyReason reports which dimension made the decision, mirroring the
// fourth element the Lua script returns.
type DenyReason int64

const (
    ReasonRateLimited   DenyReason = 0
    ReasonAllowed       DenyReason = 1
    ReasonConcurrentHit DenyReason = -1
    ReasonMonthlyQuota  DenyReason = -2
)

// RateLimitResult contains rate limit decision and metadata
type RateLimitResult struct {
    Allowed        bool
    RetryAfter     time.Duration
    RemainingQuota int64
    Reason         DenyReason
    Cost           int
}

// CheckRateLimit implements Stripe's rate limiting logic
func (rl *StripeRateLimiter) CheckRateLimit(ctx context.Context, req *RateLimitRequest) (*RateLimitResult, error) {
    tier := rl.tierLimits[req.AccountTier]
    if tier == nil {
        tier = rl.tierLimits["standard"]
    }

    cost := rl.costCalculator.GetCost(req.Endpoint, req.Method)

    // Multi-dimensional rate limiting using Lua for atomicity
    script := redis.NewScript(`
        local account_key = KEYS[1]
        local monthly_key = KEYS[2]
        local concurrent_key = KEYS[3]

        local cost = tonumber(ARGV[1])
        local rate_limit = tonumber(ARGV[2])
        local burst_size = tonumber(ARGV[3])
        local concurrent_limit = tonumber(ARGV[4])
        local monthly_quota = tonumber(ARGV[5])
        local now = tonumber(ARGV[6])
        local window = tonumber(ARGV[7])

        -- Check concurrent requests
        local concurrent = tonumber(redis.call("GET", concurrent_key) or "0")
        if concurrent >= concurrent_limit then
            return {0, 0, 0, -1}  -- Concurrent limit hit
        end

        -- Check monthly quota (if applicable)
        if monthly_quota > 0 then
            local monthly_used = tonumber(redis.call("GET", monthly_key) or "0")
            if monthly_used + cost > monthly_quota then
                return {0, 0, monthly_quota - monthly_used, -2}  -- Monthly quota exceeded
            end
        end

        -- Token bucket for per-second rate
        local bucket_data = redis.call("HMGET", account_key, "tokens", "last_update")
        local tokens = tonumber(bucket_data[1]) or burst_size
        local last_update = tonumber(bucket_data[2]) or now

        -- Refill tokens
        local elapsed = (now - last_update) / 1000.0
        tokens = math.min(burst_size, tokens + elapsed * rate_limit)

        if tokens < cost then
            -- Calculate retry-after
            local need = cost - tokens
            local retry_ms = math.ceil(need / rate_limit * 1000)
            return {0, retry_ms, math.floor(tokens), 0}
        end

        -- Allow request
        tokens = tokens - cost
        redis.call("HMSET", account_key, "tokens", tokens, "last_update", now)
        redis.call("EXPIRE", account_key, window)

        -- Increment concurrent counter
        redis.call("INCR", concurrent_key)
        redis.call("EXPIRE", concurrent_key, 60)

        -- Increment monthly usage
        if monthly_quota > 0 then
            redis.call("INCRBY", monthly_key, cost)
            -- Set expiry to end of month if new key
            local ttl = redis.call("TTL", monthly_key)
            if ttl < 0 then
                redis.call("EXPIREAT", monthly_key, ARGV[8])
            end
        end

        return {1, 0, math.floor(tokens), 1}
    `)

    burstSize := int64(float64(tier.RequestsPerSec) * tier.BurstMultiplier)
    monthEnd := getMonthEnd(time.Now()).Unix()

    // The {account} hash tag is required on a Redis Cluster: a Lua
    // script may only touch keys in one hash slot, and without the
    // braces these three keys would hash to different slots and the
    // script would fail with CROSSSLOT.
    result, err := script.Run(ctx, rl.redis,
        []string{
            fmt.Sprintf("stripe:rate:{%s}", req.AccountID),
            fmt.Sprintf("stripe:monthly:{%s}", req.AccountID),
            fmt.Sprintf("stripe:concurrent:{%s}", req.AccountID),
        },
        cost,
        tier.RequestsPerSec,
        burstSize,
        tier.ConcurrentLimit,
        tier.MonthlyQuota,
        time.Now().UnixMilli(),
        300, // 5 minute bucket expiry
        monthEnd,
    ).Int64Slice()

    if err != nil {
        // Fail open for reliability
        return &RateLimitResult{Allowed: true, Cost: cost}, nil
    }

    return &RateLimitResult{
        Allowed:        result[0] == 1,
        RetryAfter:     time.Duration(result[1]) * time.Millisecond,
        RemainingQuota: result[2],
        Reason:         DenyReason(result[3]),
        Cost:           cost,
    }, nil
}

// DecrementConcurrent decrements concurrent request counter after response
func (rl *StripeRateLimiter) DecrementConcurrent(ctx context.Context, accountID string) {
    key := fmt.Sprintf("stripe:concurrent:{%s}", accountID)
    rl.redis.Decr(ctx, key)
}

type RateLimitRequest struct {
    AccountID   string
    AccountTier string
    Endpoint    string
    Method      string
}

func getMonthEnd(t time.Time) time.Time {
    return time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, t.Location())
}
```

### Cloudflare: Edge Rate Limiting

As detailed in "How we built rate limiting capable of scaling through DDoS attacks" (*Cloudflare Blog*, 2017), Cloudflare cannot afford a centralized Redis round trip on every request because their rate limiter runs at edge PoPs worldwide with sub-millisecond latency requirements. Instead, they leverage in-memory data structures: a Count-Min Sketch for approximate request counting per key and HyperLogLog for unique visitor cardinality estimation. Both are probabilistic - they trade exact accuracy for bounded memory usage, which is an acceptable tradeoff when the alternative is adding network latency to every edge request.

```go
// cloudflare_edge_limiter.go
// Inspired by Cloudflare's edge rate limiting
package cloudflare

import (
    "context"
    "hash/fnv"
    "sync"
    "sync/atomic"
    "time"
)

// EdgeRateLimiter provides ultra-low latency rate limiting
type EdgeRateLimiter struct {
    // Count-min sketch for approximate counting
    sketch *CountMinSketch

    // HyperLogLog for unique visitor counting
    uniqueVisitors *HyperLogLog

    // Local token buckets (no Redis)
    buckets sync.Map

    // Configuration
    config EdgeConfig
}

type EdgeConfig struct {
    RequestsPerSecond int64
    BurstSize         int64
    UniqueIPsPerMin   int // For DDoS detection
    SamplingRate      float64
}

// CountMinSketch provides probabilistic counting
type CountMinSketch struct {
    width   int
    depth   int
    counts  [][]uint32
    seeds   []uint32
    mu      sync.RWMutex
}

func NewCountMinSketch(width, depth int) *CountMinSketch {
    counts := make([][]uint32, depth)
    seeds := make([]uint32, depth)
    for i := 0; i < depth; i++ {
        counts[i] = make([]uint32, width)
        seeds[i] = uint32(i * 0x5bd1e995)
    }
    return &CountMinSketch{
        width:  width,
        depth:  depth,
        counts: counts,
        seeds:  seeds,
    }
}

func (s *CountMinSketch) Increment(key string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    for i, seed := range s.seeds {
        h := fnv.New32a()
        h.Write([]byte(key))
        idx := (h.Sum32() ^ seed) % uint32(s.width)
        s.counts[i][idx]++
    }
}

func (s *CountMinSketch) Count(key string) uint32 {
    s.mu.RLock()
    defer s.mu.RUnlock()

    min := uint32(^uint32(0))
    for i, seed := range s.seeds {
        h := fnv.New32a()
        h.Write([]byte(key))
        idx := (h.Sum32() ^ seed) % uint32(s.width)
        if s.counts[i][idx] < min {
            min = s.counts[i][idx]
        }
    }
    return min
}

func (s *CountMinSketch) Reset() {
    s.mu.Lock()
    defer s.mu.Unlock()

    for i := range s.counts {
        for j := range s.counts[i] {
            s.counts[i][j] = 0
        }
    }
}

// LocalBucket is a memory-efficient token bucket
type LocalBucket struct {
    tokens     atomic.Int64 // Fixed-point tokens * 1000
    lastUpdate atomic.Int64 // Unix millis
}

func NewEdgeRateLimiter(config EdgeConfig) *EdgeRateLimiter {
    rl := &EdgeRateLimiter{
        sketch:         NewCountMinSketch(10000, 4),
        uniqueVisitors: NewHyperLogLog(14),
        config:         config,
    }

    // Background cleanup
    go rl.cleanup()
    // Periodic sketch reset
    go rl.resetSketch()

    return rl
}

// Allow checks rate limit with <100µs latency
func (rl *EdgeRateLimiter) Allow(ctx context.Context, identifier string) bool {
    // 1. Update approximate counters (for analytics)
    rl.sketch.Increment(identifier)
    rl.uniqueVisitors.Add(identifier)

    // 2. Get or create local bucket
    bucketI, _ := rl.buckets.LoadOrStore(identifier, &LocalBucket{})
    bucket := bucketI.(*LocalBucket)

    // 3. Token bucket check (all in memory, no network)
    now := time.Now().UnixMilli()
    lastUpdate := bucket.lastUpdate.Load()
    tokens := bucket.tokens.Load()

    // Refill tokens
    if lastUpdate > 0 {
        elapsed := now - lastUpdate
        refill := elapsed * rl.config.RequestsPerSecond // tokens per ms
        tokens = min(tokens+refill, rl.config.BurstSize*1000)
    } else {
        tokens = rl.config.BurstSize * 1000
    }

    // Try to consume a token. This load-then-store is NOT atomic:
    // two racing requests can read the same balance and one refill
    // can be lost, slightly over- or under-admitting. Edge limiting
    // accepts this imprecision in exchange for lock-free speed,
    // exact enforcement lives in the deeper gateway tier.
    if tokens >= 1000 {
        bucket.tokens.Store(tokens - 1000)
        bucket.lastUpdate.Store(now)
        return true
    }

    return false
}

// GetStats returns current rate limiting statistics
func (rl *EdgeRateLimiter) GetStats(identifier string) map[string]any {
    return map[string]any{
        "request_count":   rl.sketch.Count(identifier),
        "unique_visitors": rl.uniqueVisitors.Count(),
    }
}

func (rl *EdgeRateLimiter) cleanup() {
    ticker := time.NewTicker(1 * time.Minute)
    for range ticker.C {
        // Remove stale buckets
        cutoff := time.Now().Add(-5 * time.Minute).UnixMilli()
        rl.buckets.Range(func(key, value any) bool {
            bucket := value.(*LocalBucket)
            if bucket.lastUpdate.Load() < cutoff {
                rl.buckets.Delete(key)
            }
            return true
        })
    }
}

func (rl *EdgeRateLimiter) resetSketch() {
    ticker := time.NewTicker(1 * time.Minute)
    for range ticker.C {
        rl.sketch.Reset()
        rl.uniqueVisitors = NewHyperLogLog(14)
    }
}

// Note: Uses builtin min() available since Go 1.21

// HyperLogLog for cardinality estimation
type HyperLogLog struct {
    registers []uint8
    m         uint32
    precision uint
    alpha     float64
}

func NewHyperLogLog(precision int) *HyperLogLog {
    m := uint32(1 << precision)
    return &HyperLogLog{
        registers: make([]uint8, m),
        m:         m,
        precision: uint(precision),
        alpha:     getAlpha(m),
    }
}

func (h *HyperLogLog) Add(item string) {
    hash := fnv.New64a()
    hash.Write([]byte(item))
    x := hash.Sum64()

    // Low `precision` bits select the register, the REST of the hash
    // feeds the zero count. Shifting by the register count (16384 for
    // precision 14) instead of the precision would zero the operand
    // entirely and poison every register with the max value.
    j := x & uint64(h.m-1)
    w := x >> h.precision
    zeros := uint8(countTrailingZeros(w)) + 1

    if zeros > h.registers[j] {
        h.registers[j] = zeros
    }
}

func (h *HyperLogLog) Count() uint64 {
    var sum float64
    for _, v := range h.registers {
        sum += 1.0 / float64(uint64(1)<<v)
    }
    estimate := h.alpha * float64(h.m*h.m) / sum
    return uint64(estimate)
}

func countTrailingZeros(x uint64) int {
    if x == 0 {
        return 64
    }
    count := 0
    for x&1 == 0 {
        count++
        x >>= 1
    }
    return count
}

func getAlpha(m uint32) float64 {
    switch m {
    case 16:
        return 0.673
    case 32:
        return 0.697
    case 64:
        return 0.709
    default:
        return 0.7213 / (1 + 1.079/float64(m))
    }
}
```

### GitHub: Fair Queuing for API Requests

As outlined in GitHub's engineering documentation ("Rate limits for the REST API", *GitHub Docs*), GitHub's API serves enterprise CI pipelines alongside individual developers, making simple per-key limits unfair: an enterprise account generating legitimate build traffic requires differentiated capacity compared to a single user. Fair queuing solves this by assigning weights to user tiers (enterprise receives 4x priority) and tracking virtual finish times so that during contention, higher-priority requests drain from the queue first. The abuse detector complements fair queuing by flagging clients with abnormally high error rates (over 50%), which typically indicates scraping or brute-force behavior rather than legitimate API usage.

```go
// github_fair_queue.go
// Inspired by GitHub's API rate limiting with fair queuing
package github

import (
    "context"
    "sync"
    "time"
)

// FairQueueLimiter implements weighted fair queuing
type FairQueueLimiter struct {
    mu sync.Mutex

    // Per-user virtual finish times
    userQueues map[string]*UserQueue

    // Global rate limit
    globalRate    float64 // requests per second
    globalTokens  float64
    lastUpdate    time.Time

    // Weights for different user types
    weights map[string]float64
}

type UserQueue struct {
    UserID       string
    UserType     string
    VirtualTime  float64 // Virtual finish time
    PendingCount int
    LastRequest  time.Time
}

func NewFairQueueLimiter(globalRPS float64) *FairQueueLimiter {
    return &FairQueueLimiter{
        userQueues:   make(map[string]*UserQueue),
        globalRate:   globalRPS,
        globalTokens: globalRPS, // Start with burst capacity
        lastUpdate:   time.Now(),
        weights: map[string]float64{
            "enterprise": 4.0, // 4x priority
            "pro":        2.0, // 2x priority
            "free":       1.0, // Base priority
            "anonymous":  0.5, // Half priority
        },
    }
}

// Allow checks if a request should be allowed using fair queuing
func (fq *FairQueueLimiter) Allow(ctx context.Context, userID, userType string) (bool, time.Duration) {
    fq.mu.Lock()
    defer fq.mu.Unlock()

    // Refill global tokens
    fq.refillTokens()

    // Get or create user queue
    uq, exists := fq.userQueues[userID]
    if !exists {
        uq = &UserQueue{
            UserID:      userID,
            UserType:    userType,
            VirtualTime: 0,
        }
        fq.userQueues[userID] = uq
    }

    // Calculate weighted cost
    weight := fq.weights[userType]
    if weight == 0 {
        weight = 1.0
    }
    cost := 1.0 / weight

    // Check global capacity
    if fq.globalTokens < 1 {
        retryAfter := time.Duration(cost/fq.globalRate*1000) * time.Millisecond
        return false, retryAfter
    }

    // Update virtual time (for fair ordering)
    uq.VirtualTime = max(uq.VirtualTime, float64(time.Now().UnixNano())) + cost*1e9

    // Consume global token
    fq.globalTokens--
    uq.PendingCount++
    uq.LastRequest = time.Now()

    return true, 0
}

func (fq *FairQueueLimiter) refillTokens() {
    now := time.Now()
    elapsed := now.Sub(fq.lastUpdate).Seconds()
    fq.globalTokens = min(fq.globalTokens+elapsed*fq.globalRate, fq.globalRate*2)
    fq.lastUpdate = now
}

func (fq *FairQueueLimiter) Complete(userID string) {
    fq.mu.Lock()
    defer fq.mu.Unlock()

    if uq, ok := fq.userQueues[userID]; ok {
        uq.PendingCount--
    }
}

// AbuseDetector detects and handles API abuse patterns
type AbuseDetector struct {
    mu sync.RWMutex

    // Tracking windows per user
    windows map[string]*AbuseWindow

    // Thresholds
    maxErrorRate     float64
    maxBurstRatio    float64
    suspicionTimeout time.Duration
}

type AbuseWindow struct {
    RequestCount int64
    ErrorCount   int64
    BurstCount   int64
    WindowStart  time.Time
    IsSuspicious bool
    SuspiciousAt time.Time
}

func NewAbuseDetector() *AbuseDetector {
    return &AbuseDetector{
        windows:          make(map[string]*AbuseWindow),
        maxErrorRate:     0.5,  // 50% errors
        maxBurstRatio:    10.0, // 10x normal rate
        suspicionTimeout: 10 * time.Minute,
    }
}

func (ad *AbuseDetector) RecordRequest(userID string, isError bool) bool {
    ad.mu.Lock()
    defer ad.mu.Unlock()

    window, exists := ad.windows[userID]
    if !exists {
        window = &AbuseWindow{WindowStart: time.Now()}
        ad.windows[userID] = window
    }

    // Reset window if expired
    if time.Since(window.WindowStart) > time.Minute {
        window.RequestCount = 0
        window.ErrorCount = 0
        window.BurstCount = 0
        window.WindowStart = time.Now()
    }

    window.RequestCount++
    if isError {
        window.ErrorCount++
    }

    // Check for abuse patterns
    errorRate := float64(window.ErrorCount) / float64(window.RequestCount)
    if errorRate > ad.maxErrorRate && window.RequestCount > 10 {
        window.IsSuspicious = true
        window.SuspiciousAt = time.Now()
        return true // Abuse detected
    }

    return false
}

func (ad *AbuseDetector) IsSuspicious(userID string) bool {
    ad.mu.RLock()
    defer ad.mu.RUnlock()

    window, exists := ad.windows[userID]
    if !exists {
        return false
    }

    if window.IsSuspicious {
        if time.Since(window.SuspiciousAt) > ad.suspicionTimeout {
            window.IsSuspicious = false
            return false
        }
        return true
    }

    return false
}
```

---

### Junior → FAANG: Extracting Transferable Lessons from Company Case Studies

The three company implementations in this section (Stripe, Cloudflare, GitHub) each solve the rate limiting problem with a different set of priorities. Learning to identify which priority drove which design choice is more valuable than memorizing the implementations.

**Stripe prioritizes billing accuracy above all.** The `StripeRateLimiter` Lua script checks three dimensions simultaneously (per-second token bucket, concurrent request count, monthly quota) and charges each request a cost based on its operation type. This complexity exists because Stripe bills customers based on API usage, and inaccurate rate limiting means inaccurate billing. The complexity is justified by the business requirement. For a system without billing implications, this level of complexity would be over-engineering.

**Cloudflare prioritizes latency above accuracy.** The `EdgeRateLimiter` uses Count-Min Sketch and HyperLogLog, both probabilistic data structures that overestimate rather than underestimate (Count-Min Sketch never undercounts). This means the edge rate limiter may occasionally block a legitimate request that a perfectly accurate counter would allow. Cloudflare accepts this false positive rate because the latency benefit (no Redis round trip) is more important than perfect accuracy for DDoS protection. Know this trade-off: probabilistic counting is faster but less accurate, exact counting is slower but precise.

**GitHub prioritizes fairness for multi-tier users.** The `FairQueueLimiter` assigns weights by user tier (enterprise = 4x). This is a response to the observation that simple per-key limits treat all users equally, which is unfair when enterprise customers are paying significantly more for higher capacity. Fair queuing ensures that enterprise users get priority access during contention, not just a higher limit. Know that fair queuing adds coordination overhead (tracking virtual finish times) that is not justified for simple use cases.

**Reference these in an interview to anchor your design.** "Similar to how Stripe uses a Lua script to atomically check per-second, concurrent, and monthly limits in one round trip, I would use..." signals that you have studied real systems, not just textbooks.

---

### Senior @ FAANG: Architectural Decisions Behind Real Rate Limiting Systems

At L6/L7, the case studies reveal not just the architecture but the organizational and business decisions that shaped it. Understanding both layers is necessary to make good architectural decisions yourself.

**Stripe's cost-based rate limiting reflects a pricing model.** Charging 10 units for a payment creation and 1 unit for a balance read aligns API consumption with the actual cost of the operation: payment creation involves fraud detection, bank API calls, ledger writes, and regulatory reporting. A balance read is a cache lookup. By making the unit cost proportional to the operational cost, Stripe ensures that customers who create many payments pay more than customers who only read their balance, even if they make the same number of API calls. This is a pricing-model decision encoded in the rate limiter configuration. When you build a rate limiter for a similar system, consult with the product and finance teams before setting cost weights.

**Cloudflare's probabilistic approach is a correctness trade-off documented in their SLA.** Cloudflare's rate limiting SLA includes a "good faith effort" clause rather than a guarantee: they will block most requests from sources that exceed limits, but they explicitly do not guarantee that zero over-limit requests will pass through during a probabilistic counting interval. This legal language is a consequence of the architectural choice to use Count-Min Sketch. At L6+, you understand that architectural choices have legal and contractual implications, and you work with legal and product to ensure the SLA language matches the technical behavior.

**GitHub's fair queuing and abuse detection are complementary, not competing.** The `AbuseDetector` catches clients with high error rates (brute force attempts, poorly written clients). The `FairQueueLimiter` manages capacity allocation among legitimate users. These are two different problems with two different solutions. A common mistake is trying to solve both with a single mechanism. A rate limiter that detects abuse by analyzing error rates is doing too much in one component: it is conflating quota management with security detection. At L6+, you resist the temptation to add abuse detection logic inside the rate limiter. Instead, the rate limiter publishes rate limit decision events (including request metadata) to an event stream, and a separate abuse detection service consumes that stream and publishes block decisions back to the rate limiter via a blocklist. This separation allows each component to be scaled, tuned, and operated independently.
