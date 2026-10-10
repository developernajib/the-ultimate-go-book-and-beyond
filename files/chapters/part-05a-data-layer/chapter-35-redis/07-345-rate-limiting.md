## 35.5 Rate Limiting

### Fixed Window

The fixed window algorithm divides time into discrete intervals (e.g., one-minute windows) and counts requests within each interval. `INCR` atomically increments the counter and returns the new count. On the first request (count == 1), the key's TTL is set to the window duration so it auto-expires at the end of the interval. This approach is simple and memory-efficient, but has an edge case: a burst at the boundary between two windows can allow up to 2x the limit (e.g., 100 requests in the last second of window 1 and 100 in the first second of window 2).

```go
func (r *RateLimiter) AllowFixedWindow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
    current, err := r.rdb.Incr(ctx, key).Result()
    if err != nil {
        return false, err
    }

    if current == 1 {
        r.rdb.Expire(ctx, key, window)
    }

    return current <= int64(limit), nil
}
```

### Sliding Window Log

The sliding window log fixes the boundary burst problem by storing every request timestamp in a sorted set, scored by its millisecond timestamp. On each request, the algorithm removes entries older than the window, counts the remaining entries, and adds the new request - all in a single pipeline. The trade-off is memory: each request is stored individually, so a key with a 1000-request limit holds up to 1000 sorted set members. This is accurate but expensive at high volumes. Note that the count is checked before the new entry is added, so the limit is exclusive (strictly less than).

```go
func (r *RateLimiter) AllowSlidingWindowLog(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
    now := time.Now().UnixMilli()
    windowStart := now - window.Milliseconds()

    pipe := r.rdb.Pipeline()

    // Remove old entries
    pipe.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", windowStart))

    // Count current entries
    pipe.ZCard(ctx, key)

    // Add current request
    pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: now})

    // Set expiration
    pipe.Expire(ctx, key, window)

    results, err := pipe.Exec(ctx)
    if err != nil {
        return false, err
    }

    count := results[1].(*redis.IntCmd).Val()
    return count < int64(limit), nil
}
```

### Token Bucket

The token bucket algorithm allows controlled bursts while enforcing a long-term average rate. A bucket starts full at `capacity` tokens and refills at `refillRate` tokens per second. Each request consumes one token. If the bucket is empty, the request is rejected. The entire check-and-update runs as a Lua script inside Redis, making it atomic. No two concurrent requests can read the same token count and both succeed when only one token remains. The bucket state is stored as a hash with two fields: the current token count and the timestamp of the last refill calculation. A one-hour TTL on the hash cleans up inactive keys automatically.

```go
func (r *RateLimiter) AllowTokenBucket(ctx context.Context, key string, capacity int, refillRate float64) (bool, error) {
    script := redis.NewScript(`
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        local bucket = redis.call("hmget", key, "tokens", "last_refill")
        local tokens = tonumber(bucket[1]) or capacity
        local last_refill = tonumber(bucket[2]) or now

        -- Refill tokens
        local elapsed = (now - last_refill) / 1000
        local refill = elapsed * refill_rate
        tokens = math.min(capacity, tokens + refill)

        -- Try to consume token
        local allowed = 0
        if tokens >= 1 then
            tokens = tokens - 1
            allowed = 1
        end

        -- Update bucket
        redis.call("hmset", key, "tokens", tokens, "last_refill", now)
        redis.call("expire", key, 3600)

        return allowed
    `)

    result, err := script.Run(ctx, r.rdb, []string{key}, capacity, refillRate, time.Now().UnixMilli()).Int()
    return result == 1, err
}
```

### Junior to FAANG: rate-limiting prerequisites

Before you write a rate limiter, be certain you understand why you cannot do it in memory. An in-memory counter only limits the one replica it lives in. If you run three API replicas behind a load balancer and set a 100 request per minute limit, the user can actually make 300. Centralizing the counter in Redis is the whole point. The second prerequisite is atomicity. `GET` then `if below limit then SET` is wrong because two requests can both read 99 and both write 100. Use `INCR`, use `EVAL`, or use a data-structure-native atomic operation.

Worked example. Your login endpoint receives credential stuffing from a botnet. You add a sliding window counter keyed by IP at 10 requests per minute. The bot backs off per-IP but rotates through 10000 IPs. You add a second, coarser limit keyed by the username at 5 failures per minute. Now an attacker who has the username is slowed regardless of IP diversity. You add a third, global limit on the endpoint at 50 thousand per minute to protect the origin if the bot scales past what your per-user limit can absorb. Three layers, three keys, three `INCR` calls in a pipeline. Total added latency under a millisecond.

First-job context. Your team probably already uses a rate limiter. Look for `go-redis/redis_rate` (GCRA rate limiting over Redis), `ulule/limiter` (middleware for chi or gin), or a homegrown `INCR + EXPIRE`. Your job on day one is to understand the tier hierarchy your team enforces, not to rewrite it. Read the middleware, trace one request through it, and confirm you can name every key and TTL.

Interview entry point. "Design a rate limiter for a public API." Start by asking what fairness guarantee the service needs. Per-IP is trivial but unfair behind NAT. Per-user requires auth before the limit, which is bad for unauthenticated endpoints. Per-API-key is standard for public APIs. Walk through fixed window, point out the 2x boundary burst, introduce sliding window log (accurate, expensive), then sliding window counter (approximate, cheap) as the production pick. End with token bucket for burst-tolerant APIs and leaky bucket for strict-smoothing. Naming all five and knowing which to use when is the bar.

### Senior at FAANG: picking algorithm, tier, placement, and library

Algorithm selection matters more than it looks. Fixed window is almost always wrong in production. The boundary burst is not theoretical, attackers align their pulses to window boundaries. Sliding window log is accurate but its memory is O(N) per key where N is the limit. A 1000 request per minute limit across 10 million keys is 10 billion sorted set entries, which is not Redis-shaped. Sliding window counter (two weighted counters) gets you within 1 percent accuracy at O(1) memory and is what Cloudflare and Stripe actually run. Token bucket is the right pick when the API is allowed to burst and the business model charges on sustained rate. Leaky bucket is token bucket with output smoothing, used when the downstream cannot handle bursts at all (payment processors, SMS gateways). redis-cell (`CL.THROTTLE`, generic cell rate algorithm) encapsulates a Redis-side token bucket in a single command. It is a third-party Rust module (`brandur/redis-cell`), not bundled with Redis or Valkey, so you load it separately per deployment (DragonflyDB ships an equivalent built in). Where it is available, in Go you reach it with `rdb.Do(ctx, "CL.THROTTLE", ...)` and parse the five-element reply. The advantage is one round trip instead of Lua plus argument marshaling.

Library choice. `go-redis_rate` (from the go-redis authors) implements the generic cell rate algorithm, is actively maintained, and is the default pick for most teams in 2026. `ulule/limiter` is a middleware wrapper, fine for hello-world, insufficient for tier hierarchies. `sethvargo/go-limiter` is in-memory with pluggable backends, useful for local dev. Build on `go-redis_rate` at the service level, wrap it in your own `RateLimiter` interface so you can swap to Redis Cell or to edge-enforcement later.

Tier hierarchy. A production API enforces rate limits at four tiers: per-IP (DDoS layer, very high ceiling, very short window), per-user or per-API-key (product layer, the numbers in the docs), per-tenant (fairness across users in a B2B account), and per-endpoint (origin protection, global ceiling across all callers). Each tier is a separate Redis key. Check all four in one pipeline. Reject if any tier is over. Return `Retry-After` computed from the most restrictive tier. The common bug is checking only the per-user tier and discovering under attack that a single free-tier tenant consumed all your DB capacity.

Placement: edge versus service. Cheap limits (per-IP DDoS protection) belong at the edge: Cloudflare, Fastly, AWS WAF. The edge rejects in microseconds without touching your origin, and the edge has global visibility no single origin has. Expensive limits (per-user, per-tenant, per-endpoint) belong at the service because the edge does not know your auth model. The anti-pattern is running a single Redis rate limiter from the service that also tries to stop volumetric DDoS. At 10 million rps your Redis melts long before your rate logic runs. Layer the limits. Edge eats volumetric. Service eats semantic.

Clock skew and Redis time. Token bucket and sliding window both depend on a clock. If you pass `time.Now()` from the Go side, replicas with drifted clocks compute different refill rates and you get unfairness. Use Redis `TIME` inside the Lua script (`redis.call("TIME")`) so every replica sees the same epoch. For sliding window counter, use `PEXPIRE` not `EXPIRE` because 1 second granularity is too coarse for fine-grained windows.

Fairness and starvation. A naive token bucket shared across a tenant can starve a single user inside the tenant if one caller is aggressive. Nested tiers (tenant bucket plus per-user bucket inside) prevent this but double your Redis cost. Alternatives include weighted fair queuing at the service, or moving the fairness requirement to a proper queue (SQS FIFO per tenant) when the workload tolerates queuing.

Staff ADR. The rate limit ADR states: (1) the algorithm and why, (2) the tiers and the ceiling at each tier, (3) the placement (edge versus service) for each tier, (4) the failure mode (what happens when Redis is down, do you fail open or fail closed, the answer is usually fail open for availability but fail closed for auth endpoints), (5) the observability plan (reject counter per tier, p99 of the limiter middleware latency, Redis command budget). Teams that skip (4) get paged at 3 AM when Redis has a 10 second blip and the entire API starts rejecting every request.

---
