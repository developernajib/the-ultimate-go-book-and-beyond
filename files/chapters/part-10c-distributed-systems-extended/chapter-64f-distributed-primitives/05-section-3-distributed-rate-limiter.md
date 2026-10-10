## Section 3: Distributed Rate Limiter

### 3.1 Redis Token Bucket Rate Limiter

A Redis-backed token bucket rate limiter enforces per-key rate limits consistently across all instances of a horizontally-scaled service by storing token counts and refill timestamps in Redis and using a Lua script for atomic check-and-decrement operations. The following implementation handles the refill calculation server-side inside the Lua script to avoid race conditions between the check and the update.

```go
package ratelimit

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

// TokenBucketLimiter implements a distributed token bucket using Redis Lua scripts.
// Atomicity: the Lua script runs atomically on the Redis server.
// No client-side coordination needed - all state lives in Redis.
type TokenBucketLimiter struct {
	client     *redis.Client
	capacity   int64         // Max tokens in bucket.
	refillRate float64       // Tokens added per second.
	script     *redis.Script
}

// tokenBucketScript is the Lua script for atomic token bucket operation.
// Arguments: KEYS[1]=bucket key, ARGV[1]=capacity, ARGV[2]=refillRate,
//            ARGV[3]=currentTimestampMs, ARGV[4]=requestedTokens
// Returns: {allowed (0/1), remaining_tokens, retry_after_ms}
const tokenBucketLua = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])    -- tokens per second
local now = tonumber(ARGV[3])            -- current time in milliseconds
local requested = tonumber(ARGV[4])

-- Get current bucket state: {tokens, last_refill_ts}
local bucket = redis.call("HMGET", key, "tokens", "last_refill_ts")
local tokens = tonumber(bucket[1]) or capacity
local last_refill_ts = tonumber(bucket[2]) or now

-- Calculate tokens to add based on time elapsed since last refill.
local elapsed_ms = now - last_refill_ts
local tokens_to_add = (elapsed_ms / 1000) * refill_rate
tokens = math.min(capacity, tokens + tokens_to_add)

-- Try to consume requested tokens.
local allowed = 0
local retry_after = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
else
    -- Not enough tokens. Calculate when we'll have enough.
    local deficit = requested - tokens
    retry_after = math.ceil((deficit / refill_rate) * 1000)
end

-- Store updated state. Expire key after bucket is full (no activity).
local expire_ms = math.ceil((capacity / refill_rate) * 1000) + 1000
redis.call("HSET", key, "tokens", tokens, "last_refill_ts", now)
redis.call("PEXPIRE", key, expire_ms)

return {allowed, math.floor(tokens), retry_after}
`

func NewTokenBucketLimiter(client *redis.Client, capacity int64, refillRate float64) *TokenBucketLimiter {
	return &TokenBucketLimiter{
		client:     client,
		capacity:   capacity,
		refillRate: refillRate,
		script:     redis.NewScript(tokenBucketLua),
	}
}

// LimitResult holds the result of a rate limit check.
type LimitResult struct {
	Allowed    bool
	Remaining  int64
	RetryAfter time.Duration // How long to wait before retrying.
}

// Allow checks if a request for the given key is allowed.
// key: the identifier to rate limit (e.g., user ID, IP address, API key).
// tokens: number of tokens to consume (use 1 for simple rate limiting).
func (l *TokenBucketLimiter) Allow(ctx context.Context, key string, tokens int64) (LimitResult, error) {
	now := time.Now().UnixMilli()
	redisKey := "ratelimit:tb:" + key

	result, err := l.script.Run(ctx, l.client,
		[]string{redisKey},
		l.capacity, l.refillRate, now, tokens,
	).Int64Slice()

	if err != nil {
		return LimitResult{}, fmt.Errorf("rate limit check: %w", err)
	}

	if len(result) < 3 {
		return LimitResult{}, fmt.Errorf("unexpected result: %v", result)
	}

	return LimitResult{
		Allowed:    result[0] == 1,
		Remaining:  result[1],
		RetryAfter: time.Duration(result[2]) * time.Millisecond,
	}, nil
}

// SlidingWindowLimiter implements a sliding window rate limiter using Redis sorted sets.
// More accurate than token bucket for short burst detection.
type SlidingWindowLimiter struct {
	client     *redis.Client
	maxReqs    int64
	window     time.Duration
}

func NewSlidingWindowLimiter(client *redis.Client, maxReqs int64, window time.Duration) *SlidingWindowLimiter {
	return &SlidingWindowLimiter{
		client:  client,
		maxReqs: maxReqs,
		window:  window,
	}
}

// Allow checks if a request is within the sliding window limit.
func (l *SlidingWindowLimiter) Allow(ctx context.Context, key string) (LimitResult, error) {
	now := time.Now()
	windowStart := now.Add(-l.window).UnixMilli()
	redisKey := "ratelimit:sw:" + key

	pipe := l.client.Pipeline()

	// Remove expired entries from the sorted set.
	pipe.ZRemRangeByScore(ctx, redisKey, "0", fmt.Sprintf("%d", windowStart))

	// Count current entries in window.
	countCmd := pipe.ZCard(ctx, redisKey)

	// Add current request.
	pipe.ZAdd(ctx, redisKey, redis.Z{
		Score:  float64(now.UnixMilli()),
		Member: fmt.Sprintf("%d", now.UnixNano()),
	})

	// Set expiry.
	pipe.Expire(ctx, redisKey, l.window+time.Second)

	if _, err := pipe.Exec(ctx); err != nil {
		return LimitResult{}, fmt.Errorf("sliding window check: %w", err)
	}

	count := countCmd.Val()
	allowed := count < l.maxReqs

	var retryAfter time.Duration
	if !allowed {
		// Calculate when the oldest entry will expire.
		oldest, err := l.client.ZRangeByScoreWithScores(ctx, redisKey, &redis.ZRangeBy{
			Min:    "0",
			Max:    "+inf",
			Offset: 0,
			Count:  1,
		}).Result()
		if err == nil && len(oldest) > 0 {
			oldestTime := time.UnixMilli(int64(oldest[0].Score))
			retryAfter = oldestTime.Add(l.window).Sub(now)
		}
	}

	return LimitResult{
		Allowed:    allowed,
		Remaining:  max(0, l.maxReqs-count-1),
		RetryAfter: retryAfter,
	}, nil
}

// HTTPMiddleware returns an HTTP middleware that enforces rate limiting.
func HTTPMiddleware(limiter *TokenBucketLimiter, keyFn func(r *http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)
			result, err := limiter.Allow(r.Context(), key, 1)
			if err != nil {
				http.Error(w, "rate limit error", http.StatusInternalServerError)
				return
			}

			// Always set rate limit headers.
			w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", result.Remaining))

			if !result.Allowed {
				w.Header().Set("Retry-After",
					fmt.Sprintf("%.0f", result.RetryAfter.Seconds()))
				http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Note: Uses builtin max() available since Go 1.21
```

### Junior → FAANG: Understanding Why Local Rate Limiting Fails and What to Do Instead

The core problem with per-instance rate limiting: if your rate limit is 100 requests per second and you have 10 instances, each instance will allow 100 RPS, giving the caller 1,000 effective RPS. This is the fleet-multiplication problem, and it is the most common rate limiting mistake in horizontally-scaled services.

The Redis Lua script approach in the `TokenBucketLimiter` solves this by making Redis the single source of truth for the rate limit state. All instances hit the same Redis key, and the Lua script executes atomically (Redis is single-threaded, Lua scripts are atomic), so there is no race condition between reading the current count and incrementing it.

The two algorithms have different strengths: token bucket (capacity + refill rate) allows bursts up to the bucket capacity before throttling kicks in, which is friendly to legitimate callers who are bursty by nature (batch uploads, report generation). Sliding window counts requests in the last N seconds and rejects when the count exceeds the limit, providing stricter burst control at the cost of slightly more memory (one sorted set entry per request in the window).

The fail-open decision (allow the request when Redis is unavailable) is a product decision, not a technical one. The technical options are: fail open (allow the request, losing rate limiting guarantees), fail closed (deny the request, losing availability), and use a local fallback limiter (degrade to per-instance limiting when Redis is unavailable). The correct choice depends on whether the rate limit is primarily for abuse prevention (fail open, accept occasional burst during Redis downtime) or for downstream protection (fail closed or use local fallback).

For interview framing: when asked about rate limiting, always address fleet size explicitly. "I would use a Redis token bucket with a Lua script" is a complete answer only after you explain why local rate limiting is insufficient.

### Senior @ FAANG: Rate Limiting Architecture for Multi-Tenant Systems at Scale

At Stripe or Uber scale (millions of requests per second across thousands of services), a single Redis cluster for rate limiting becomes a single point of failure and a bottleneck. The production rate limiting architecture for large-scale multi-tenant systems requires several layers.

Local pre-filtering: before hitting Redis, apply a local token bucket (in-process, no network call) that limits each instance to its fair share of the global rate. For a global rate of 1,000 RPS across 10 instances, each instance gets a local limit of 150 RPS (with 50% headroom for uneven distribution). This local check filters out extreme bursts without a Redis round-trip, reducing Redis load by 70-90% under sustained high traffic.

Redis cluster sharding by rate limit key: a single Redis instance handles approximately 100,000 rate limit operations per second. For a service with 1 million active API keys, the rate limit keys should be sharded across a Redis cluster, with each key routed to its shard by consistent hash. etcd-backed coordination for resharding events is necessary to avoid split-brain during cluster scaling.

Hierarchical rate limits: production rate limiting typically requires multiple levels simultaneously. API-key level (100 RPS per key), organization level (1,000 RPS per org), and global level (10,000 RPS across all traffic) must all be enforced atomically. Checking all three in a single Redis round-trip requires a Lua script that updates three keys and returns the first limit that is exceeded. The script's latency is O(number of limit levels), which is bounded and acceptable.

Sliding window vs token bucket for different limit levels: at the API-key level (individual callers), sliding window provides stricter burst control (prevents the window-boundary double-burst). At the global level (protecting downstream services), token bucket provides burst absorption (legitimate traffic spikes do not get denied if the downstream can handle them briefly). Mixing strategies at different levels is correct engineering, not inconsistency.

Observability: rate limiting observability should include: throttle rate by key prefix (what fraction of requests from each customer are being throttled), Redis latency percentiles for rate limit checks, and fallback activation frequency (how often the local fallback fires, indicating Redis unavailability). A throttle rate that is consistently above 5% for a specific customer is a signal to proactively reach out about quota increases.

---
