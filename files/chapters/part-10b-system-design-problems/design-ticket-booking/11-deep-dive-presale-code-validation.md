## Deep Dive: Presale Code Validation

Presale codes give early access to fan clubs, credit card holders, or artist-selected groups before the general public sale. The validation must be atomic: checking the code's validity, verifying it has not exceeded its usage limit, and marking it as used must all happen in a single operation. Otherwise, a race condition lets the same code be redeemed more times than intended. This implementation uses a Redis Lua script to perform all checks and updates atomically, so thousands of simultaneous redemptions of one code still respect its limit.

One caveat worth stating out loud, because it is the same distinction the oversell design turns on. Redis is the only counter here, so the limit is exactly as durable as Redis is: a replica promoted mid-presale can lose recent `used_count` increments and let a code over-redeem. That is a deliberate trade. Over-redeeming a fan club code by a handful is a marketing annoyance, while selling one seat twice is a legal problem, which is why the seat path pays for a database constraint and this path does not. If a contract puts hard limits on a code, the redemption belongs in PostgreSQL with the count enforced by a `CHECK` on the committed row, and Redis becomes the cache in front of it.

```go
package presale

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type PresaleCode struct {
	Code       string    `json:"code"`
	EventID    string    `json:"event_id"`
	Type       string    `json:"type"` // fan_club, amex, artist
	MaxUses    int       `json:"max_uses"`
	MaxTickets int       `json:"max_tickets"` // per redemption
	ValidFrom  time.Time `json:"valid_from"`
	ValidUntil time.Time `json:"valid_until"`
}

// redeemScript checks and redeems a code as one atomic unit.
//
// Compiled once at package level, not rebuilt per call: redis.NewScript hashes
// the body to derive its SHA1, and doing that inside the request path re-hashes
// the same source text on every redemption for nothing.
//
// Every HGET is guarded. tonumber on a missing field yields nil, and comparing
// nil to a number is a Lua runtime error, so an unseeded or half-written code
// hash would surface to the user as an opaque script failure instead of
// "invalid code".
var redeemScript = redis.NewScript(`
	local key = KEYS[1]
	local userKey = KEYS[2]
	local now = tonumber(ARGV[1])
	local userID = ARGV[2]

	local maxUses = tonumber(redis.call("HGET", key, "max_uses"))
	local maxTickets = tonumber(redis.call("HGET", key, "max_tickets"))
	local validFrom = tonumber(redis.call("HGET", key, "valid_from"))
	local validUntil = tonumber(redis.call("HGET", key, "valid_until"))
	if not maxUses or not maxTickets or not validFrom or not validUntil then
		return redis.error_reply("invalid code")
	end

	if now < validFrom or now > validUntil then
		return redis.error_reply("code not active")
	end

	local usedCount = tonumber(redis.call("HGET", key, "used_count") or "0")
	if usedCount >= maxUses then return redis.error_reply("code fully redeemed") end

	if redis.call("SISMEMBER", userKey, userID) == 1 then
		return redis.error_reply("already used by you")
	end

	redis.call("HINCRBY", key, "used_count", 1)
	redis.call("SADD", userKey, userID)

	-- Bound the redeemer set's lifetime. Without this the set of every user who
	-- ever redeemed a code outlives the presale window forever, and a busy
	-- promoter's Redis fills with sets for events that finished years ago.
	redis.call("EXPIREAT", userKey, validUntil + 86400)
	redis.call("EXPIREAT", key, validUntil + 86400)

	return maxTickets
`)

// ValidatePresaleCode atomically checks and redeems a code.
func ValidatePresaleCode(ctx context.Context, rdb *redis.Client, code, eventID, userID string) (*PresaleCode, error) {
	key := fmt.Sprintf("presale:%s:%s", eventID, code)
	userKey := fmt.Sprintf("presale:users:%s:%s", eventID, code)
	maxTickets, err := redeemScript.Run(ctx, rdb, []string{key, userKey},
		time.Now().Unix(), userID).Int()
	if err != nil {
		return nil, fmt.Errorf("redeem presale code: %w", err)
	}

	return &PresaleCode{Code: code, EventID: eventID, MaxTickets: maxTickets}, nil
}
```

---
