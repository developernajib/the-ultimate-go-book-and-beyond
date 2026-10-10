## Deep Dive: Rate Limiting

Rate limiting protects the system from abuse, whether from bots, scrapers, or a buggy client sending thousands of requests per second. This implementation uses a sliding window log backed by a Redis sorted set: each request is recorded with its timestamp as the score, old entries outside the window are pruned, and the surviving count is the number of requests in the window. Different actions have different limits, for example, you can read your timeline 900 times per 15 minutes, but you can only post 300 tweets in the same window.

Three things make this harder than it looks, and all three are the difference between a limiter and a decoration.

**It has to be atomic.** Pruning, counting, and adding across a Redis pipeline is not atomic: a pipeline only batches round trips, it does not isolate them. Two concurrent requests both read a count of 299 against a limit of 300 and both are admitted. Under exactly the traffic a limiter exists to stop, the check races. A Lua script runs on the Redis server as a single unit, which closes the window.

**Rejected requests must not be recorded.** If the entry is added before the count is checked, a client that keeps hammering while blocked keeps feeding its own log, and the window never drains. Add only on admission.

**Decide deliberately whether it fails open or closed.** If `Exec` returns an error and you ignore it, the count reads back as zero and every request is admitted. A rate limiter that turns itself off exactly when Redis is unhealthy is worse than none, because the outage that took Redis down is now amplified by unmetered traffic. Return the error and let the caller choose per route.

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type RateLimiter struct {
	rdb *redis.Client
}

// Limit is a request budget over a window. The two-element array this used to
// be made every call site guess what index 0 meant.
type Limit struct {
	Window time.Duration
	Max    int
}

var Limits = map[string]Limit{
	"tweet_create":  {15 * time.Minute, 300},
	"timeline_read": {15 * time.Minute, 900},
	"search":        {15 * time.Minute, 450},
	"follow":        {24 * time.Hour, 400},
	"like":          {24 * time.Hour, 1000},
}

// slidingWindow prunes, counts, and conditionally admits in one atomic step.
// KEYS[1]=key ARGV[1]=window start ms ARGV[2]=now ms ARGV[3]=max ARGV[4]=member ARGV[5]=ttl s
var slidingWindow = redis.NewScript(`
local key = KEYS[1]
redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1])
local count = redis.call('ZCARD', key)
if count >= tonumber(ARGV[3]) then
  return {0, 0}
end
redis.call('ZADD', key, ARGV[2], ARGV[4])
redis.call('EXPIRE', key, ARGV[5])
return {1, tonumber(ARGV[3]) - count - 1}
`)

// Check reports whether the request is allowed and how much budget remains.
// An error means the limiter could not decide. It never means "allowed".
func (r *RateLimiter) Check(ctx context.Context, uid int64, action string) (allowed bool, remaining int, err error) {
	cfg, ok := Limits[action]
	if !ok {
		// An unknown action used to fall through to the zero value, giving a
		// budget of 0 and silently blocking a legitimate route forever.
		return false, 0, fmt.Errorf("no rate limit configured for action %q", action)
	}

	now := time.Now()
	key := fmt.Sprintf("rate:%s:%d", action, uid)

	// The member must be unique per request. Using a timestamp as the member
	// makes two requests in the same tick collide, and ZADD then overwrites
	// rather than appends, so the log silently undercounts.
	member := uuid.NewString()

	res, err := slidingWindow.Run(ctx, r.rdb, []string{key},
		now.Add(-cfg.Window).UnixMilli(),
		now.UnixMilli(),
		cfg.Max,
		member,
		int(cfg.Window.Seconds())+1,
	).Slice()
	if err != nil {
		return false, 0, fmt.Errorf("rate limit check: %w", err)
	}

	ok1, _ := res[0].(int64)
	rem, _ := res[1].(int64)
	return ok1 == 1, int(rem), nil
}
```

One cost to acknowledge: a sliding window log stores one sorted-set entry per request, so a 900-request budget means up to 900 entries per user per window. That is fine for per-user API quotas and far too expensive for a per-IP DDoS shield at the edge, where a token bucket holding two numbers per key is the right tool. Match the structure to the budget.

---
