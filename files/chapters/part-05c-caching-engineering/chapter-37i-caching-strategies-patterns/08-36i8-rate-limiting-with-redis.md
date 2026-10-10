## 37I.8 Rate Limiting with Redis

### Sliding Window Rate Limiter

`SlidingWindowRateLimiter` stores request timestamps in a Redis sorted set, using the Unix millisecond timestamp as both the score and the member value. On each call it atomically removes expired entries (outside the current window), counts the remaining members, and conditionally adds a new entry, all in a single Lua script to avoid race conditions between the check and the write. This approach gives a true sliding window (not a fixed bucket) at the cost of one Redis round-trip per request.

The `TokenBucketRateLimiter` below implements the token bucket algorithm, which allows short bursts up to the bucket capacity while enforcing a sustained average rate. It stores the current token count and last refill timestamp in a Redis hash, refilling tokens proportionally to elapsed time on each request. Like the sliding window, all logic runs inside a Lua script for atomicity.

```go
package cache

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// SlidingWindowRateLimiter implements sliding window counter using Redis
type SlidingWindowRateLimiter struct {
	client    *redis.Client
	limit     int64
	window    time.Duration
	keyPrefix string
}

// Allow returns true if the request is within the rate limit
// Uses sorted set with timestamp as score for sliding window
func (r *SlidingWindowRateLimiter) Allow(ctx context.Context, identifier string) (bool, int64, error) {
	key := fmt.Sprintf("%s:ratelimit:%s", r.keyPrefix, identifier)
	now := time.Now().UnixMilli()
	windowStart := now - r.window.Milliseconds()

	// Lua script for atomic sliding window
	script := redis.NewScript(`
		local key = KEYS[1]
		local now = tonumber(ARGV[1])
		local window_start = tonumber(ARGV[2])
		local limit = tonumber(ARGV[3])
		local window_ms = tonumber(ARGV[4])

		-- Remove expired entries
		redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

		-- Count current window
		local count = redis.call('ZCARD', key)

		if count < limit then
			-- Add current request
			redis.call('ZADD', key, now, now)
			-- Set expiry on the key
			redis.call('PEXPIRE', key, window_ms)
			return {1, limit - count - 1}
		else
			return {0, 0}
		end
	`)

	result, err := script.Run(ctx, r.client,
		[]string{key},
		now, windowStart, r.limit, r.window.Milliseconds(),
	).Int64Slice()

	if err != nil {
		return false, 0, fmt.Errorf("rate limit script: %w", err)
	}

	allowed := result[0] == 1
	remaining := result[1]
	return allowed, remaining, nil
}

// TokenBucketRateLimiter uses Redis for distributed token bucket
type TokenBucketRateLimiter struct {
	client   *redis.Client
	rate     float64       // tokens per second
	capacity float64       // bucket capacity
	prefix   string
}

// Allow returns true if a token is available, with refill
func (r *TokenBucketRateLimiter) Allow(ctx context.Context, key string, cost float64) (bool, error) {
	script := redis.NewScript(`
		local key = KEYS[1]
		local rate = tonumber(ARGV[1])
		local capacity = tonumber(ARGV[2])
		local now = tonumber(ARGV[3])
		local cost = tonumber(ARGV[4])

		local data = redis.call('HMGET', key, 'tokens', 'last_refill')
		local tokens = tonumber(data[1]) or capacity
		local last_refill = tonumber(data[2]) or now

		-- Refill tokens based on elapsed time
		local elapsed = (now - last_refill) / 1000.0
		tokens = math.min(capacity, tokens + elapsed * rate)

		if tokens >= cost then
			tokens = tokens - cost
			redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
			redis.call('PEXPIRE', key, 60000)
			return 1
		else
			redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
			redis.call('PEXPIRE', key, 60000)
			return 0
		end
	`)

	result, err := script.Run(ctx, r.client,
		[]string{r.prefix + ":" + key},
		r.rate, r.capacity,
		time.Now().UnixMilli(), cost,
	).Int()

	if err != nil {
		return false, err
	}
	return result == 1, nil
}
```

### Junior to FAANG: Picking the Right Algorithm and Avoiding Footguns

Rate limiting sounds trivial until you implement it and discover five different algorithms with different failure modes. Understand all five before writing any code, because the one you pick determines whether your limiter is fair, burst-tolerant, accurate, and cheap.

The five core algorithms. Fixed window counter increments a counter per window (for example `requests_in_minute_42 = 10`) and resets at the window boundary. It is cheap (one `INCR`) but allows 2x burst at window edges: 100 requests in the last second of one window and 100 in the first second of the next both count as legal and produce 200 requests in 2 seconds under a 100/minute cap. Sliding log stores every request timestamp in a sorted set and counts the window on each request. Accurate but O(N) memory per identifier and O(log N) per check. Sliding window counter (what the code above calls "sliding window") approximates the sliding log by weighting the previous window and the current window by elapsed fraction. O(1) memory and O(1) per check. The de facto standard for most services. Token bucket refills tokens at a fixed rate up to a capacity, and each request consumes tokens. It allows bursts up to the bucket size and smooths to the refill rate in steady state. Ideal when you want burst tolerance. Leaky bucket enforces a fixed outflow regardless of inflow by queuing requests into a FIFO of bounded size. Denies when the queue is full. Ideal when downstream throughput must be strictly bounded. GCRA (Generic Cell Rate Algorithm), used in Redis Cell (`CL.THROTTLE`), is mathematically equivalent to token bucket but implemented as a single timestamp comparison with no queue, making it the most efficient distributed implementation.

The code above uses sliding-log (sorted set with ZADD/ZCARD) and token bucket. Both are correct but the sliding-log approach is actually closer to a sliding log than a sliding window counter because it stores every timestamp. It will scale to about 1000 requests per identifier per window before the sorted set gets expensive. For higher rate limits, switch to the weighted sliding window counter (store one counter per fixed sub-window and interpolate) or use Redis Cell for GCRA.

Worked example for a first-job engineer. You must limit API calls to 100 per minute per API key. Fixed window is easiest but allows 200/minute at window edges. Sliding log stores 100 timestamps per key in Redis, which is fine for 10k active keys (1M entries total) but not for 10M active keys. Sliding window counter with 6 sub-windows of 10 seconds gives you 6 integers per key, scales easily, and is accurate within 1/6 of the window. Token bucket with capacity 100 and refill 100/minute gives you the same steady-state limit with full burst allowance from a cold bucket. Pick token bucket if your API is meant to allow bursts (most public APIs), sliding window counter if your downstream cannot absorb bursts (database-backed endpoints), and fixed window only if you are explicitly rate-limiting by window boundary (for example, hourly billing counts).

Interview entry-point. When asked "design a rate limiter" walk through all five algorithms with their tradeoffs. Then propose a layered solution: edge rate limit at the CDN or API gateway (coarse, fail-fast, per IP), per-API-key rate limit at the application (finer, per-user quota), per-endpoint rate limit at the service (protects hot endpoints), and per-database rate limit via connection pool and query budget. Each tier has a different purpose and catches a different abuse pattern. A junior who names one tier loses points. A candidate who names four and explains what each protects against is immediately a stronger signal.

Common junior mistakes. Implementing `GET count; if count < limit; INCR count` without Lua, which races. Always use a Lua script or `INCR` with `EXPIRE NX` for atomic check-and-set. Using local time on the application side and expecting Redis to have the same clock. Use Redis `TIME` command or pass `now` consistently. Forgetting to set TTL on the rate limit key, which leaks memory for every identifier ever seen. Using a hash of the user's IP as the identifier without considering that mobile networks NAT thousands of users behind one IP. Combine IP with a fingerprint (user ID, API key, device ID) when available. Returning HTTP 429 without `Retry-After` and `X-RateLimit-Remaining` headers, which makes it impossible for clients to back off gracefully.

### Senior at FAANG: Distributed Rate Limiting at Scale

At staff level, rate limiting is a problem of correctness under distribution, fairness across tenants, and economics of the limiter itself. The naive "single Redis key per user" model breaks down somewhere between 100k and 1M QPS of check traffic. What follows is the production envelope.

GCRA and Redis Cell. The Generic Cell Rate Algorithm from telecom ATM networks is the most elegant rate limiter ever devised. It stores a single timestamp per identifier (the "theoretical arrival time" or TAT) and on each request computes whether the request is allowed based on a single comparison. No queue, no counter, no sub-windows. The math: given rate `r` requests per period and burst `b`, the inter-arrival time is `1/r`. On request at time `t`, if `TAT - t > burst_tolerance`, deny. Otherwise, update `TAT = max(t, TAT) + 1/r` and allow. redis-cell (a third-party Redis module written in Rust, exposing `CL.THROTTLE`) provides this as a single command. It is not bundled with Redis and must be loaded separately, so confirm your managed Redis offering allows custom modules before relying on it. Use `CL.THROTTLE key max_burst count_per_period period [cost]` and get a response of `[allowed, total_limit, remaining, retry_after_sec, reset_sec]`. This replaces the Lua scripts in the code above with a single O(1) call per check, and scales to millions of identifiers per Redis instance.

Sliding window counter correctness. The weighted approximation formula is `count_approx = count_prev * (1 - fraction_elapsed) + count_curr`, where `count_prev` is the previous window's total and `count_curr` is the current window's count so far. This has a worst-case error of about `rate * fraction_window_drift` which is typically under 1 percent for well-sized windows. The Cloudflare 2017 blog post on sliding window counters is the canonical reference. Use it for coarse limits where approximation is fine. Use GCRA or sliding log when exact counts matter (billing, compliance).

Distributed coordination and the hot-key problem. A rate limit on a global API key that sees 1M QPS will funnel all 1M check calls through a single Redis key on a single node. This is a shard hot-key problem. Mitigate with local quotas: allocate each pod a local budget (for example 1000 QPS from the global 1M QPS), check locally with an in-process token bucket, and synchronize surplus and deficit back to Redis every N milliseconds. This is the "split-and-refresh" pattern from Stripe and Cloudflare. The tradeoff is that pods can temporarily exceed their local budget by the refresh interval times the rate. Tune the refresh interval to keep global overshoot under 1 percent. Google's Doorman paper describes a more formal version with capacity leasing.

Envoy and sidecar-based limiters. At FAANG scale, rate limiting lives in the infrastructure layer, not the application. Envoy's global rate limit service (`envoy.filters.http.ratelimit`) offloads the check to a dedicated gRPC service that speaks to Redis. Your application stays out of the hot path. The sidecar pattern makes rate limits uniformly enforceable across polyglot services and removes rate-limit logic from every codebase. For new services in 2026, prefer this over in-app rate limiting. Use the in-app limiter only for logic-specific limits (for example, "no more than 5 failed logins per hour") that depend on application state.

Multi-tenant fairness. A naive per-tenant limit lets one noisy tenant exhaust the shared backend even if each tenant stays under their individual quota. Fairness requires a two-level limiter: a per-tenant quota and a global concurrency limit on the shared resource (semaphore, connection pool). Under overload, a tenant's requests that would exceed the global limit get queued or rejected even if the tenant is under their own quota. Use weighted fair queuing (WFQ) or deficit round robin (DRR) to allocate the global capacity proportionally to tenant shares. This is what protects downstream databases and third-party APIs from a single heavy tenant. Stripe's published rate-limiter design (the four-limiter model from their engineering blog) and AWS's adaptive throttling implement variants of this.

Tier hierarchy. Design rate limits at four tiers. Tier 1 is the edge (CDN, WAF) with coarse IP-based limits and known-bad-actor blocklists. Tier 2 is the API gateway with per-API-key quotas and burst allowances, implemented in Envoy or equivalent. Tier 3 is the service with per-endpoint limits for expensive operations and per-user limits for state-changing operations. Tier 4 is the resource layer with DB connection pool limits, external API quota sharing, and circuit breakers. Each tier has a different time constant and a different scope. A well-designed system rejects abusive traffic as early as possible (Tier 1) and protects the most expensive resources as late as possible (Tier 4).

Back-pressure and the retry storm. Returning HTTP 429 tells a well-behaved client to retry. A badly written client retries immediately and creates a retry storm. Mitigate with exponential backoff in the `Retry-After` header, jitter on the backoff to avoid synchronization, and client library enforcement. For internal services, prefer explicit queue depth and backpressure signals over rate limiting, because queues let you adapt to actual capacity rather than a fixed guess. gRPC's flow control and HTTP/2 window updates are mechanical backpressure that works better than retry for sustained overload.

Observability. Emit metrics for: per-tier allow/deny counts, per-tenant quota utilization, limiter Redis latency (including Lua script duration), overshoot rate versus configured rate, and retry storm detection (ratio of 429s to subsequent requests from same client). Alert on per-tenant utilization above 90 percent sustained, which means the quota is set too low or the tenant is about to cause problems. Alert on Redis latency p99 above 5ms, which means the limiter itself is becoming a bottleneck and you need to shard.

Security considerations. Rate limits are a security boundary for brute-force and enumeration attacks. A login endpoint with rate limit of 10 per minute per IP is effectively useless against a botnet of 100k IPs. Layer rate limits with behavioral detection: per-IP, per-account, per-geolocation, per-device-fingerprint. Use sliding log for auth endpoints (exact count matters), and alert on anomalous distributions (for example, 10k distinct IPs each doing exactly one failed login in a minute, which is a credential-stuffing signature). Do not leak rate-limit internals to clients. Return 429 with a generic message, not "you have used 99 of 100 requests in the last minute," which tells an attacker the exact window.

Storage alternatives to Redis. Memcached with CAS operations can implement token bucket but lacks Lua so correctness is harder. DynamoDB with conditional writes works for low QPS and regional HA but costs an order of magnitude more per check. In-process limiters backed by gossip (HashiCorp memberlist, Serf) avoid the central Redis dependency and scale horizontally, at the cost of convergence delay. Cloudflare published a paper on gossip-based rate limiting in 2020 that is worth studying. For most services, Redis with GCRA remains the right answer in 2026.

Interview framing for staff. When asked "design rate limiting for a global API" do not describe a Lua script. Describe the tier hierarchy (edge, gateway, service, resource). Pick the algorithm per tier (token bucket at edge for burst tolerance, GCRA at gateway for correctness, sliding window at service for per-endpoint, semaphore at resource for concurrency). Cover the hot-key problem and split-and-refresh. Discuss multi-tenant fairness via WFQ. Talk about retry storms and back-pressure. Close with observability and security layering. The candidate who treats rate limiting as a systems design problem, not an algorithm puzzle, operates at staff level.

---
