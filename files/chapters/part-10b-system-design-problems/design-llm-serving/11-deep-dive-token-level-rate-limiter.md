## Deep Dive: Token-Level Rate Limiter

Traditional API rate limiting counts requests per minute, but that approach fails for LLM serving because a single request can consume anywhere from 100 to 128,000 tokens. A token-level rate limiter tracks the actual compute resources consumed, not just the number of HTTP calls. This implementation uses a Redis-backed fixed one-minute window counter, checked and consumed by an atomic Lua script so that even under high concurrency no tenant can exceed their allocated token budget.

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type TokenRateLimiter struct {
	rdb *redis.Client
}

type RateLimitResult struct {
	Allowed         bool
	RemainingTokens int64
	ResetAt         time.Time
}

// CheckAndConsume atomically reserves tokens against the tenant's
// per-minute budget. The Lua script makes the read-check-increment
// sequence atomic, so concurrent requests cannot both pass the check
// and jointly overshoot the limit.
func (r *TokenRateLimiter) CheckAndConsume(ctx context.Context, tenantID string, tokens int, tier string) (*RateLimitResult, error) {
	limits := getTierLimits(tier)
	windowKey := fmt.Sprintf("rl:tokens:%s:%d", tenantID, time.Now().Unix()/60)

	script := `
		local used  = tonumber(redis.call('GET', KEYS[1]) or '0')
		local limit = tonumber(ARGV[1])
		local req   = tonumber(ARGV[2])
		if used + req > limit then
			return {0, limit - used}
		end
		redis.call('INCRBY', KEYS[1], req)
		redis.call('EXPIRE', KEYS[1], 120)
		return {1, limit - used - req}`

	result, err := r.rdb.Eval(ctx, script, []string{windowKey}, limits.TokensPerMinute, tokens).Int64Slice()
	if err != nil {
		return nil, err
	}

	return &RateLimitResult{
		Allowed:         result[0] == 1,
		RemainingTokens: result[1],
		ResetAt:         time.Now().Truncate(time.Minute).Add(time.Minute),
	}, nil
}

type TierLimits struct {
	TokensPerMinute int64
	TokensPerDay    int64
	MaxContext      int
	MaxOutput       int
	ConcurrentReqs  int
}

func getTierLimits(tier string) TierLimits {
	switch tier {
	case "free":
		return TierLimits{10000, 100000, 4096, 1024, 1}
	case "pro":
		return TierLimits{100000, 10000000, 32768, 8192, 10}
	case "enterprise":
		return TierLimits{1000000, 100000000, 128000, 32768, 100}
	default:
		return getTierLimits("free")
	}
}
```

---
