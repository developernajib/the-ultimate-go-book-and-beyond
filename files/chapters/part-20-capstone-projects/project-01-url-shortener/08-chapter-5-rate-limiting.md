## Chapter 5: Rate Limiting

Rate limiting protects your service from abuse, whether it comes from malicious actors trying to overwhelm your system or from legitimate users accidentally sending too many requests. Without rate limiting, a single client could consume all your server resources and make the service unavailable for everyone else. In this chapter, we implement a token bucket algorithm using Redis for distributed state, and wire it into our API as middleware that runs before every request.

### 5.1 Token Bucket Algorithm

The token bucket algorithm works like a bucket that fills with tokens at a steady rate. Each incoming request consumes one token, and if the bucket is empty, the request is denied. We implement this using a Redis Lua script so that the check-and-increment operation is atomic -- meaning two requests arriving at the same instant cannot both see the same counter value. This prevents race conditions that would otherwise allow clients to exceed their rate limit.

```go
// internal/ratelimit/token_bucket.go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TokenBucketLimiter implements rate limiting using token bucket algorithm
type TokenBucketLimiter struct {
	client *redis.Client
	prefix string
}

// NewTokenBucketLimiter creates a new rate limiter
func NewTokenBucketLimiter(client *redis.Client, prefix string) *TokenBucketLimiter {
	return &TokenBucketLimiter{
		client: client,
		prefix: prefix,
	}
}

// Allow checks if a request is allowed under rate limit
// Returns: (allowed bool, remaining int, resetTime time.Time, error)
func (r *TokenBucketLimiter) Allow(ctx context.Context, identifier string, limit int, window time.Duration) (bool, int, time.Time, error) {
	key := fmt.Sprintf("%s:ratelimit:%s", r.prefix, identifier)
	now := time.Now()

	// Lua script for atomic rate limiting
	script := redis.NewScript(`
		local key = KEYS[1]
		local limit = tonumber(ARGV[1])
		local window = tonumber(ARGV[2])
		local now = tonumber(ARGV[3])

		-- Get current count and timestamp
		local current = redis.call('HMGET', key, 'count', 'reset_time')
		local count = tonumber(current[1]) or 0
		local reset_time = tonumber(current[2]) or 0

		-- If window expired, reset
		if now > reset_time then
			count = 0
			reset_time = now + window
		end

		-- Check if request is allowed
		if count < limit then
			count = count + 1
			redis.call('HMSET', key, 'count', count, 'reset_time', reset_time)
			redis.call('EXPIRE', key, window)
			return {1, limit - count, reset_time}  -- allowed
		else
			return {0, 0, reset_time}  -- denied
		end
	`)

	result, err := script.Run(
		ctx,
		r.client,
		[]string{key},
		limit,
		int(window.Seconds()),
		now.Unix(),
	).Result()

	if err != nil {
		return false, 0, time.Time{}, fmt.Errorf("rate limit check: %w", err)
	}

	values := result.([]any)
	allowed := values[0].(int64) == 1
	remaining := int(values[1].(int64))
	resetTime := time.Unix(values[2].(int64), 0)

	return allowed, remaining, resetTime, nil
}

// Reset clears the rate limit for an identifier
func (r *TokenBucketLimiter) Reset(ctx context.Context, identifier string) error {
	key := fmt.Sprintf("%s:ratelimit:%s", r.prefix, identifier)
	return r.client.Del(ctx, key).Err()
}
```

### 5.2 Rate Limit Middleware

Middleware is the ideal place to enforce rate limits because it runs before your handler code and can reject requests early. The middleware below provides two variants: one that limits by IP address for anonymous users, and one that limits by user ID for authenticated users. Each variant sets standard `X-RateLimit-*` response headers so that API consumers know how many requests they have remaining and when their limit resets.

```go
// internal/api/middleware/ratelimit.go
package middleware

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/goshort/internal/ratelimit"
)

// RateLimitByIP limits requests by IP address
func (m *Middleware) RateLimitByIP(limit int, window string) gin.HandlerFunc {
	duration, _ := time.ParseDuration(window)

	return func(c *gin.Context) {
		ip := c.ClientIP()
		identifier := fmt.Sprintf("ip:%s", ip)

		allowed, remaining, resetTime, err := m.rateLimiter.Allow(
			c.Request.Context(),
			identifier,
			limit,
			duration,
		)

		// Set rate limit headers
		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))
		c.Header("X-RateLimit-Reset", resetTime.Format(time.RFC3339))

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Rate limit check failed"})
			c.Abort()
			return
		}

		if !allowed {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":      "Rate limit exceeded",
				"retry_after": resetTime.Unix() - time.Now().Unix(),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

// RateLimitByUser limits requests by authenticated user
func (m *Middleware) RateLimitByUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, exists := c.Get("user")
		if !exists {
			c.Next()
			return
		}

		userModel := user.(*models.User)
		identifier := fmt.Sprintf("user:%d", userModel.ID)

		// Use user-specific limits based on tier
		limit := userModel.RateLimitPerHour
		window := 1 * time.Hour

		allowed, remaining, resetTime, err := m.rateLimiter.Allow(
			c.Request.Context(),
			identifier,
			limit,
			window,
		)

		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))
		c.Header("X-RateLimit-Reset", resetTime.Format(time.RFC3339))

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Rate limit check failed"})
			c.Abort()
			return
		}

		if !allowed {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "Rate limit exceeded",
				"retry_after": resetTime.Unix() - time.Now().Unix(),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
```

---

### Junior → FAANG: Rate Limiting as a Safety Concept, Not Just a Feature

The reason rate limiting exists is not to frustrate users. It is to protect the service from being overwhelmed by any single source, whether accidental or malicious. Understanding the "why" makes it easier to explain in interviews and to implement correctly.

The Lua script atomicity point in this chapter is important for interviews. Without an atomic check-and-decrement, two simultaneous requests could both observe a token count of 1, both consume it, and both succeed, effectively allowing 2x the intended rate. The Lua script runs atomically on the Redis server, eliminating that race condition. Be able to explain this in an interview without referencing the code.

For entry-level roles, knowing the difference between token bucket (allows bursts up to bucket capacity) and sliding window (no burst allowance, smooth rate) is a common interview question. Token bucket is more common in practice because it provides a better user experience for applications that have natural burst patterns.

### Senior @ FAANG: Rate Limiting as a Multi-Layer Platform Concern

At FAANG scale, rate limiting is not a single middleware function. It is a multi-layer control that spans edge (CDN/load balancer), service (application middleware), and data (database connection pool limits). Each layer has a different granularity and a different purpose.

Edge rate limiting (Cloudflare, AWS WAF, Nginx) is the first line of defense against volumetric abuse. It operates on IP addresses and request patterns, blocking obvious attacks before they reach application code. Application-layer rate limiting (token bucket per API key) enforces business logic limits. Data-layer limits (max connections per user, query timeout) protect the database from runaway clients.

The ADR for rate limiting must answer: what is the limit per tier, how are limits communicated to clients (`Retry-After` header, `X-RateLimit-Remaining`), how are high-volume legitimate customers accommodated (quotas, tier-based limits), and what happens when the Redis backend for rate limiting is unavailable (fail open allowing all traffic, or fail closed blocking all traffic). Fail open is the safer default for availability but allows abuse during outages. That tradeoff requires a product decision, not just an engineering one.

Distributed rate limiting at scale introduces consistency challenges. If you have 50 application instances each with a local rate limit state, the effective per-user limit is 50x the configured limit. Redis-based centralized counting solves this but adds latency to every request. Token bucket with a sliding window approximation using Redis Sorted Sets is a common production approach: accurate within a 1-2% margin, with sub-millisecond Redis operations. Document the chosen accuracy tradeoff in the ADR.

---
