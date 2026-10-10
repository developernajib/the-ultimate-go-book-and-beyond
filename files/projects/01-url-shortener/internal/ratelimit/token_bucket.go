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
