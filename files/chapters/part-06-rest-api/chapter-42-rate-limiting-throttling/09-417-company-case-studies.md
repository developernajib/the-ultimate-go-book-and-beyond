## 42.7 Company Case Studies

### How Stripe Implements Rate Limiting

Stripe uses a multi-layer rate limiting system that protects both its infrastructure and merchants' applications. The design is worth studying because it layers limiters with different jobs rather than relying on one.

Separate what Stripe documents from what this section invents for teaching purposes. **Documented**: a global limit of 100 requests per second in live mode and 25 per second in sandbox/test mode, most individual endpoints capped at 25 per second regardless of mode, resource-specific limits (Payment Intents allow 1,000 updates per object per hour), concurrency limits alongside rate limits, and a `Stripe-Rate-Limited-Reason` response header on 429s whose value is one of `global-rate`, `endpoint-rate`, `global-concurrency`, `endpoint-concurrency`, or `resource-specific`. Stripe's engineering blog additionally describes a Redis token bucket, concurrency limiters, and load shedders.

**Not documented, and invented below for the exercise**: the per-endpoint cost table. Stripe has not published one. It is a good vehicle for teaching cost-based limiting, so treat the numbers as illustration rather than as facts about Stripe.

Two details worth internalising because they are counterintuitive. Test mode is **more** restricted than live mode, not less, which surprises people whose load tests pass in production and fail in sandbox. And Stripe does not emit remaining/limit/reset headers at all. There is no `Stripe-RateLimit-Limit`. A client learns it was limited from the 429 and learns *why* from `Stripe-Rate-Limited-Reason`, which tells it whether to slow down globally, back off one endpoint, or stop hammering one object.

```go
/*
STRIPE'S RATE LIMITING STRATEGY (as documented, plus an illustrative cost model)

1. Multiple Rate Limit Layers:
   - Global limit per API key: 100 req/s live, 25 req/s sandbox
   - Per-endpoint limits: most endpoints 25 req/s
   - Per-resource limits: e.g. 1000 updates/hour on one PaymentIntent
   - Concurrency limits, enforced separately from rate

2. Request Cost System (ILLUSTRATIVE -- Stripe publishes no cost table):
   - GET /charges: 1 unit
   - POST /charges: 10 units
   - POST /payouts: 50 units
   - Batch operations: N x base cost

3. Burst Allowance:
   - Allow temporary bursts above limit
   - Smooth traffic spikes from legitimate use

4. On rejection:
   - 429 Too Many Requests
   - Stripe-Rate-Limited-Reason: global-rate | endpoint-rate |
       global-concurrency | endpoint-concurrency | resource-specific
   - NOTE: Stripe does NOT return Stripe-RateLimit-Limit/Remaining/Reset.
     No such headers exist. Clients cannot self-throttle from headers and
     must implement backoff from the 429 itself.
*/

// StripeStyleLimiter implements Stripe's cost-based rate limiting
type StripeStyleLimiter struct {
    client      *redis.Client
    limits      map[string]TierLimit
    costs       map[string]int
    defaultCost int
}

type TierLimit struct {
    Rate       int           // Requests per window
    Window     time.Duration // Window size
    BurstLimit int           // Burst allowance
}

func NewStripeStyleLimiter(client *redis.Client) *StripeStyleLimiter {
    return &StripeStyleLimiter{
        client: client,
        limits: map[string]TierLimit{
            "live":       {Rate: 100, Window: time.Second, BurstLimit: 25}, // live mode
            "test":       {Rate: 25, Window: time.Second, BurstLimit: 5},   // sandbox: LOWER
            "restricted": {Rate: 5, Window: time.Second, BurstLimit: 2},
        },
        costs: map[string]int{
            "GET /v1/charges":         1,
            "POST /v1/charges":        10,
            "GET /v1/customers":       1,
            "POST /v1/customers":      5,
            "POST /v1/payouts":        50,
            "POST /v1/transfers":      50,
            "GET /v1/balance":         1,
            "GET /v1/events":          2,
            "POST /v1/invoices/send":  20,
        },
        defaultCost: 1,
    }
}

func (s *StripeStyleLimiter) Allow(ctx context.Context, apiKey, endpoint string) (*RateLimitResult, error) {
    // Determine tier from API key
    tier := s.getTierFromAPIKey(apiKey)
    limit := s.limits[tier]

    // Calculate request cost
    cost := s.defaultCost
    if c, ok := s.costs[endpoint]; ok {
        cost = c
    }

    // Use Redis script for atomic check
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local burst = tonumber(ARGV[4])
        local cost = tonumber(ARGV[5])

        -- Get current window data
        local current = redis.call('HGETALL', key)
        local tokens = limit + burst  -- Start with full burst
        local last_update = now

        if #current > 0 then
            for i = 1, #current, 2 do
                if current[i] == 'tokens' then
                    tokens = tonumber(current[i+1])
                elseif current[i] == 'last' then
                    last_update = tonumber(current[i+1])
                end
            end
        end

        -- Refill tokens based on elapsed time
        local elapsed = (now - last_update) / 1000
        local refill = elapsed * (limit / (window / 1000))
        tokens = math.min(limit + burst, tokens + refill)

        -- Check if request allowed
        local allowed = 0
        local remaining = math.floor(tokens)

        if tokens >= cost then
            tokens = tokens - cost
            allowed = 1
            remaining = math.floor(tokens)
        end

        -- Update state
        redis.call('HMSET', key, 'tokens', tokens, 'last', now)
        redis.call('PEXPIRE', key, window * 2)

        return {allowed, remaining, limit}
    `)

    now := time.Now()
    result, err := script.Run(ctx, s.client, []string{bucketKey(apiKey)},
        now.UnixMilli(),
        limit.Window.Milliseconds(),
        limit.Rate,
        limit.BurstLimit,
        cost,
    ).Slice()

    if err != nil {
        // Fail open, but say so. Returning a nil error here would tell the
        // caller "you have quota" when what happened is "the limiter is
        // broken". Those need different metrics and different alerts, and
        // swallowing the distinction means a Redis outage looks exactly
        // like a quiet afternoon on your dashboards.
        //
        // Do not wrap err into anything the client sees: Redis errors can
        // echo back the command, and the command contains the key.
        return &RateLimitResult{
            Allowed:   true,
            Remaining: limit.Rate,
            Degraded:  true,
        }, fmt.Errorf("ratelimit backend unavailable: %w", err)
    }

    return &RateLimitResult{
        Allowed:   result[0].(int64) == 1,
        Remaining: int(result[1].(int64)),
        Limit:     int(result[2].(int64)),
        Reset:     now.Add(limit.Window),
        Cost:      cost,
    }, nil
}

func (s *StripeStyleLimiter) getTierFromAPIKey(apiKey string) string {
    // Stripe API keys carry their type in the prefix:
    //   sk_live_xxx - live secret key      -> 100 req/s
    //   sk_test_xxx - sandbox secret key   ->  25 req/s
    //   rk_live_xxx - restricted key
    //
    // Sandbox is LOWER than live, not higher. Getting this backwards is a
    // real and common misreading, and it produces the worst possible
    // outcome: load tests pass against a limit more generous than the one
    // production will actually enforce.
    switch {
    case strings.HasPrefix(apiKey, "rk_"):
        return "restricted"
    case strings.HasPrefix(apiKey, "sk_test_"):
        return "test"
    default:
        return "live"
    }
}

// bucketKey derives the Redis key for an API key.
//
// Never build the key as "ratelimit:" + apiKey. That writes a live secret
// key into Redis in plaintext, where it lands in RDB/AOF snapshots, in
// `redis-cli --scan` output, in slowlog entries, and in any monitoring tool
// that samples keyspace. Redis is not a secret store and its keyspace is
// not treated as sensitive by anyone on your ops team.
//
// Hash instead. The bucket is stable for a given key and reveals nothing.
// Truncating the digest to 128 bits keeps keys short while leaving
// collisions out of reach.
func bucketKey(apiKey string) string {
    sum := sha256.Sum256([]byte(apiKey))
    return "ratelimit:" + hex.EncodeToString(sum[:16])
}

type RateLimitResult struct {
    Allowed   bool
    Remaining int
    Limit     int
    Reset     time.Time
    Cost      int
    Degraded  bool // true when the decision was made without the backend
}
```

Note the `costs` map is keyed by `"POST /v1/charges"`, a route template rather than a concrete path. Look up `"POST /v1/charges/ch_3Ab.../capture"` in that map and you miss, silently fall through to `defaultCost: 1`, and charge one unit for your single most expensive operation. Cost tables must be keyed by the same route pattern your router matched (`r.Pattern`), and a miss on a table like this deserves a metric, because a miss means you are undercharging for something you deliberately decided to meter.

### How Cloudflare Implements Rate Limiting

Cloudflare enforces rate limits at the edge, before requests reach the origin server. This means decisions must be sub-millisecond and work without a round-trip to a central data store. The rule-based configuration allows matching on URL path, method, headers, and other request properties, with actions ranging from blocking to issuing a JavaScript challenge.

```go
/*
CLOUDFLARE'S RATE LIMITING APPROACH

1. Edge-Based Limiting:
   - Rate limits enforced at edge locations
   - Sub-millisecond decision time
   - No round-trip to origin

2. Rule-Based Configuration:
   - Match on URL path, method, headers
   - Action: Block, Challenge, JS Challenge, Log
   - Custom response codes and bodies

3. Counting Methods:
   - Same IP
   - Same IP + Path
   - Custom expression (header values, cookies)

4. Advanced Features:
   - Counting only certain responses (4xx, 5xx)
   - Mitigation timeout separate from counting window
   - Advanced expressions for complex rules

5. Origin Protection:
   - Additional rate limiting for origin requests
   - Prevents cascade during DDoS
*/

// CloudflareStyleLimiter implements edge-based rate limiting
type CloudflareStyleLimiter struct {
    rules   []RateLimitRule
    counter CounterStore
}

type RateLimitRule struct {
    ID          string
    Name        string
    Expression  string            // CEL expression for matching
    Threshold   int               // Requests per period
    Period      time.Duration     // Counting period
    Timeout     time.Duration     // How long to block after limit hit
    Action      Action
    CountOnly   []int             // Only count these status codes (empty = all)
    KeyFunc     func(*Request) string
}

type Action string

const (
    ActionBlock     Action = "block"
    ActionChallenge Action = "challenge"
    ActionLog       Action = "log"
    ActionSimulate  Action = "simulate"
)

type Request struct {
    Method     string
    Path       string
    Headers    map[string]string
    IP         string
    Country    string
    ASN        int
    UserAgent  string
}

func NewCloudflareStyleLimiter(rules []RateLimitRule) *CloudflareStyleLimiter {
    return &CloudflareStyleLimiter{
        rules:   rules,
        counter: NewEdgeCounter(), // Distributed counter
    }
}

func (c *CloudflareStyleLimiter) Check(ctx context.Context, req *Request) *RateLimitDecision {
    decisions := make([]*RateLimitDecision, 0)

    for _, rule := range c.rules {
        if !c.matchesExpression(req, rule.Expression) {
            continue
        }

        key := rule.KeyFunc(req)
        fullKey := fmt.Sprintf("%s:%s", rule.ID, key)

        // Check if already blocked
        if blocked, until := c.counter.IsBlocked(ctx, fullKey); blocked {
            decisions = append(decisions, &RateLimitDecision{
                Rule:    rule,
                Blocked: true,
                Until:   until,
            })
            continue
        }

        // Increment counter
        count := c.counter.Increment(ctx, fullKey, rule.Period)

        if count > rule.Threshold {
            // Over threshold - apply action
            decision := &RateLimitDecision{
                Rule:      rule,
                Count:     count,
                Threshold: rule.Threshold,
            }

            switch rule.Action {
            case ActionBlock:
                decision.Blocked = true
                decision.Until = time.Now().Add(rule.Timeout)
                c.counter.Block(ctx, fullKey, rule.Timeout)
            case ActionChallenge:
                decision.Challenge = true
            case ActionLog:
                decision.Log = true
            case ActionSimulate:
                decision.Simulated = true
            }

            decisions = append(decisions, decision)
        }
    }

    // Return most restrictive decision
    return c.mostRestrictive(decisions)
}

type RateLimitDecision struct {
    Rule      RateLimitRule
    Blocked   bool
    Challenge bool
    Log       bool
    Simulated bool
    Count     int
    Threshold int
    Until     time.Time
}

func (c *CloudflareStyleLimiter) matchesExpression(req *Request, expr string) bool {
    // Simplified expression matching
    // Real implementation uses CEL (Common Expression Language)

    // Example: "http.request.uri.path contains \"/api/\" and ip.src in {10.0.0.0/8}"
    // For this example, we'll use simple pattern matching
    return true // Simplified
}

func (c *CloudflareStyleLimiter) mostRestrictive(decisions []*RateLimitDecision) *RateLimitDecision {
    if len(decisions) == 0 {
        return nil
    }

    // Priority: Block > Challenge > Log > Simulate
    for _, d := range decisions {
        if d.Blocked {
            return d
        }
    }
    for _, d := range decisions {
        if d.Challenge {
            return d
        }
    }
    return decisions[0]
}

// CountOnResponse updates counters only for certain responses
func (c *CloudflareStyleLimiter) CountOnResponse(ctx context.Context, req *Request, statusCode int) {
    for _, rule := range c.rules {
        if len(rule.CountOnly) == 0 {
            continue // Already counted on request
        }

        // Check if status code should be counted
        shouldCount := false
        for _, code := range rule.CountOnly {
            if statusCode == code {
                shouldCount = true
                break
            }
        }

        if shouldCount {
            key := rule.KeyFunc(req)
            fullKey := fmt.Sprintf("%s:%s", rule.ID, key)
            c.counter.Increment(ctx, fullKey, rule.Period)
        }
    }
}
```

### How Discord Implements Rate Limiting

Discord's API uses a bucket-based rate limiting system where multiple routes can share a single bucket. This matters because operations like editing a message and deleting a message on the same channel share the same underlying resource, so they should share the same limit. Discord also enforces a global limit across all routes and returns a rich set of headers including the bucket ID, letting client libraries track limits per bucket rather than per URL.

```go
/*
DISCORD'S RATE LIMITING STRATEGY

1. Per-Route Limits:
   - Each API endpoint has its own limit
   - Limits vary based on operation type
   - Global limit across all routes: 50 requests/second for bots

2. Bucket-Based System:
   - Routes share "buckets" for rate limiting
   - Bucket IDs returned in headers
   - Same bucket = shared limit

3. Headers Discord Returns:
   - X-RateLimit-Limit: Max requests per window
   - X-RateLimit-Remaining: Requests left
   - X-RateLimit-Reset: Epoch seconds, WITH decimals (e.g. 1470173023.123)
   - X-RateLimit-Reset-After: Seconds until reset, can have decimals
   - X-RateLimit-Bucket: Unique bucket ID
   - X-RateLimit-Global: 429 responses ONLY, and only if the global limit hit
   - X-RateLimit-Scope: 429 responses ONLY. "user", "global", or "shared"

4. Special Handling:
   - Message sending: Complex formula based on history
   - Emoji reactions: Separate limits per emoji
   - Guild operations: Very strict limits

5. Bot vs User Limits:
   - Bots get different (often higher) limits
   - Verified bots get even higher limits
*/

// DiscordStyleLimiter implements Discord's bucket-based rate limiting
type DiscordStyleLimiter struct {
    client       *redis.Client
    buckets      map[string]BucketConfig
    routeBuckets map[string]string // Route -> Bucket ID mapping
}

type BucketConfig struct {
    ID           string
    Limit        int
    Window       time.Duration
    Global       bool
    Scope        string // "user", "global", "shared"
}

func NewDiscordStyleLimiter(client *redis.Client) *DiscordStyleLimiter {
    return &DiscordStyleLimiter{
        client: client,
        buckets: map[string]BucketConfig{
            "message_send": {
                ID:     "msg_send",
                Limit:  5,
                Window: 5 * time.Second,
                Scope:  "user",
            },
            "message_edit": {
                ID:     "msg_edit",
                Limit:  5,
                Window: 5 * time.Second,
                Scope:  "user",
            },
            "reaction_add": {
                ID:     "reaction",
                Limit:  1,
                Window: 250 * time.Millisecond,
                Scope:  "user",
            },
            "guild_create": {
                ID:     "guild_op",
                Limit:  10,
                Window: time.Hour * 24,
                Scope:  "user",
            },
            "global": {
                ID:     "global",
                Limit:  50,
                Window: time.Second,
                Global: true,
                Scope:  "global",
            },
        },
        routeBuckets: map[string]string{
            "POST /channels/{channel_id}/messages":            "message_send",
            "PATCH /channels/{channel_id}/messages/{msg_id}":  "message_edit",
            "PUT /channels/{channel_id}/messages/{msg_id}/reactions/{emoji}/@me": "reaction_add",
            "POST /guilds": "guild_create",
        },
    }
}

func (d *DiscordStyleLimiter) Check(ctx context.Context, userID, route string) (*DiscordRateLimitResult, error) {
    // First check global limit
    globalResult, err := d.checkBucket(ctx, userID, "global")
    if err != nil {
        return nil, err
    }
    if !globalResult.Allowed {
        globalResult.IsGlobal = true
        return globalResult, nil
    }

    // Find bucket for route
    bucketID, ok := d.routeBuckets[route]
    if !ok {
        // Default bucket
        bucketID = "default"
    }

    result, err := d.checkBucket(ctx, userID, bucketID)
    if err != nil {
        return nil, err
    }

    result.BucketID = bucketID
    return result, nil
}

func (d *DiscordStyleLimiter) checkBucket(ctx context.Context, userID, bucketID string) (*DiscordRateLimitResult, error) {
    bucket, ok := d.buckets[bucketID]
    if !ok {
        bucket = BucketConfig{
            ID:     bucketID,
            Limit:  100,
            Window: time.Minute,
            Scope:  "user",
        }
    }

    // Construct key based on scope
    var key string
    switch bucket.Scope {
    case "global":
        key = fmt.Sprintf("discord:global:%s", bucketID)
    case "shared":
        key = fmt.Sprintf("discord:shared:%s", bucketID)
    default:
        key = fmt.Sprintf("discord:user:%s:%s", userID, bucketID)
    }

    now := time.Now()
    windowStart := now.Truncate(bucket.Window)
    windowEnd := windowStart.Add(bucket.Window)

    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window_ms = tonumber(ARGV[2])
        local now_ms = tonumber(ARGV[3])

        local count = redis.call('INCR', key)

        if count == 1 then
            redis.call('PEXPIRE', key, window_ms)
        end

        local ttl = redis.call('PTTL', key)
        local remaining = limit - count

        if remaining < 0 then
            remaining = 0
        end

        return {count <= limit and 1 or 0, remaining, ttl}
    `)

    result, err := script.Run(ctx, d.client, []string{key},
        bucket.Limit,
        bucket.Window.Milliseconds(),
        now.UnixMilli(),
    ).Slice()

    if err != nil {
        return &DiscordRateLimitResult{Allowed: true}, nil
    }

    ttlMs := result[2].(int64)
    resetAt := now.Add(time.Duration(ttlMs) * time.Millisecond)

    return &DiscordRateLimitResult{
        Allowed:     result[0].(int64) == 1,
        Remaining:   int(result[1].(int64)),
        Limit:       bucket.Limit,
        Reset:       resetAt,
        ResetAfter:  time.Duration(ttlMs) * time.Millisecond,
        Scope:       bucket.Scope,
    }, nil
}

type DiscordRateLimitResult struct {
    Allowed     bool
    Remaining   int
    Limit       int
    Reset       time.Time
    ResetAfter  time.Duration
    BucketID    string
    Scope       string
    IsGlobal    bool
}

// WriteHeaders writes Discord-style rate limit headers.
//
// Fidelity note: Discord returns X-RateLimit-Scope and X-RateLimit-Global
// ONLY on 429 responses. The other five accompany every response so clients
// can self-throttle before being rejected. Emitting Scope on a 200 is a
// small thing, but a client library written against the documented contract
// may treat its presence as a signal that it was limited.
func (r *DiscordRateLimitResult) WriteHeaders(w http.ResponseWriter, limited bool) {
    w.Header().Set("X-RateLimit-Limit", strconv.Itoa(r.Limit))
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(r.Remaining))
    // Reset is an epoch timestamp with millisecond precision, e.g.
    // 1470173023.123. Reset-After is the same instant expressed as a
    // duration, which is the clock-skew-immune one clients should prefer.
    w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%.3f", float64(r.Reset.UnixMilli())/1000))
    w.Header().Set("X-RateLimit-Reset-After", fmt.Sprintf("%.3f", r.ResetAfter.Seconds()))
    w.Header().Set("X-RateLimit-Bucket", r.BucketID)

    if limited {
        w.Header().Set("X-RateLimit-Scope", r.Scope)
        if r.IsGlobal {
            w.Header().Set("X-RateLimit-Global", "true")
        }
    }
}
```

### Junior → FAANG: Learning from Production Rate Limiting Designs

Reading production designs from Stripe, Cloudflare, and Discord teaches patterns that textbooks rarely cover:

**Cost-based limiting:** Not all requests cost the same. A `POST /v1/payouts` touches multiple downstream systems, triggers compliance checks, and may initiate an ACH transfer. Treating it the same as a `GET /v1/balance` wastes your API's protection budget. The practical takeaway is to identify your most expensive endpoints by profiling actual resource consumption (DB queries, downstream calls, CPU time) and assign higher costs to them. Note that the cost table in the example above is invented for teaching. Stripe's real published limits are per-second request caps plus concurrency caps plus resource-specific caps, which is a different way of solving the same problem: rather than pricing each endpoint, cap the endpoints that hurt and cap how many can run at once.

**Rule-based matching at the edge (Cloudflare):** Rate limiting at the origin server means the request has already consumed a TCP connection, a TLS handshake, and application thread time before it is rejected. Edge enforcement rejects malicious traffic before it reaches the origin. As a junior engineer, learn to distinguish "where does the limit decision happen" from "where does the counter live." Cloudflare makes the decision at the edge, but the counter may still be backed by a distributed store.

**Bucket sharing (Discord):** Multiple routes sharing a single rate limit bucket is a resource-management insight. Routes that operate on the same underlying resource (a Discord channel) contend for the same hardware. A shared bucket reflects that reality. When designing your own API, group endpoints by their shared resources and consider whether they should consume from the same quota.

First-job habit: when you encounter a `429`, read every header the API returns before writing retry logic. Discord includes `X-RateLimit-Bucket` so you can cache the bucket-to-route mapping and avoid firing requests at routes that share a bucket you have already saturated. Stripe, by contrast, returns no remaining/limit headers at all and tells you only *why* you were limited via `Stripe-Rate-Limited-Reason`. Same problem, opposite contract. Read the docs for the specific API rather than assuming that the headers you saw on the last one will be there.

### Senior @ FAANG: Platform-Level Lessons from Industry Rate Limiting

**Treating API Quota as a Resource Budget**

The cost-based model sketched above is an instance of a general principle: rate limits should be proportional to the resource cost of the operation, not its HTTP method. At FAANG, this manifests as "request units" or "capacity units" in internal quota systems, and DynamoDB's read and write capacity units are the most familiar public example. The platform team defines cost weights for each operation class, and those weights are governed centrally so that a new expensive operation cannot be deployed without a cost review.

The governance question this model surfaces is: who owns the cost table? If teams can self-assign operation costs, they will undercharge their own endpoints to avoid customer complaints. A platform governance model assigns costs through a capacity review process: the owning team proposes a cost, the platform team validates it against load test data, and the approved cost is encoded in a central policy store that the rate limiter reads at startup. Changes require a pull request and a reviewer from the platform team.

**Cloudflare: Policy-as-Code for Edge Rate Limiting**

The `RateLimitRule` struct in the Cloudflare-style example represents a declarative policy. The shift from imperative code ("if path contains /api and count > 100, block") to declarative rules ("rule: path=/api, threshold=100, action=block") enables several platform capabilities: policy auditing (diff the rule set between releases), staging (apply rules in `simulate` mode before activating them), and federation (push rules to all edge PoPs atomically). These capabilities are meaningless for a single-server API but essential when you operate thousands of edge nodes.

The `ActionSimulate` mode deserves particular attention as a maturity signal. Deploying a new rate limit rule directly to production is dangerous: if the threshold is too low, it silently rejects legitimate traffic. Simulate mode logs the decision without enforcing it, allowing the team to validate the rule against production traffic patterns before activation. This is rate-limit feature flagging, and any platform-grade implementation should support it.

**Discord: Bucket Topology as an API Design Constraint**

Discord's bucket system reflects a design principle that is easy to overlook: the rate limit topology should match the resource contention topology. Routes that compete for the same server-side mutex, database row, or external API call should share a bucket. Routes that are independent should have independent limits.

This has implications for API versioning. When you introduce a new endpoint that shares a resource with an existing endpoint, you must either add the new endpoint to the existing bucket (preserving the resource protection) or carefully provision a new bucket that accounts for the combined load. Neither decision is trivial, and getting it wrong produces incidents: a new endpoint steals capacity from an existing one, causing the existing endpoint's SLO to degrade mysteriously.

The staff-level concern is discoverability, and Discord's answer is instructive precisely because it is the opposite of what you might expect. Discord does **not** publish a static bucket-to-route table, and it reserves the right to change bucket topology without notice. Instead it makes the topology discoverable at runtime: every response carries `X-RateLimit-Bucket`, so a client learns which routes share a bucket by observing the identifier and caching the route-to-bucket mapping itself.

That is a deliberate trade. A published table would be a compatibility commitment freezing the topology across versions, and Discord declined to make it. The runtime header keeps the server free to re-shard buckets while still letting a well-written client track limits accurately, at the cost of every SDK needing bucket-tracking logic. When you design your own system, decide consciously which of the two you are promising, because switching later breaks clients either way: publish a table and you own it forever, or emit an identifier and accept that clients must be taught to use it.

**Bar-Raiser Interview Signals**

"How would you design a cost-based rate limiting system for a new platform API with 200 endpoints?" Strong answers cover: the cost assignment governance process, the risk of cost inflation if teams self-assign, the monitoring needed to detect when actual resource consumption diverges from the assigned cost, and how you would handle a cost weight change for an existing endpoint without breaking existing SDK integrations.

"Cloudflare enforces rate limits without a round-trip to a central store. What are the consistency trade-offs, and when are they acceptable?" The answer should address the gossip/approximate counting model, the bounded over-admission error, and the distinction between DDoS mitigation (where approximation is fine) and billing-accurate quotas (where it is not).

---
