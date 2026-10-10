## Go Implementation: Admission Controller

The admission controller is the throttle valve between the virtual queue and the booking service. It runs as a continuous background loop that checks current system load and admits batches of users at a controlled rate, so the payment and database services never see more concurrent checkouts than they can absorb.

The subtle part is how a user leaves the active set. Completion is easy, the booking flow says so. Abandonment is the common case and nobody reports it: users close the tab, lose signal, or wander off. If the active set only shrinks when someone completes, then every abandoned checkout permanently consumes a slot, the set fills with ghosts, and admission stops entirely while a queue of five million people watches a spinner. The fix is to make membership expire on its own. Rather than a plain set, admission is tracked in a sorted set scored by each user's admission deadline, so an abandoned checkout ages out exactly like a completed one, and the controller prunes lapsed entries before it counts free capacity.

```go
package queue

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// AdmissionController regulates the flow from queue into booking service.
// Prevents overload by controlling admission rate.
type AdmissionController struct {
	rdb            *redis.Client
	maxConcurrent  int64 // max users in booking flow simultaneously
	admitBatchSize int64 // users to admit per batch
	admitInterval  time.Duration
}

const admissionTTL = 10 * time.Minute

// admitScript prunes lapsed admissions, measures free capacity, and moves that
// many users from the queue into the active set, as one atomic unit.
//
// Doing this in Lua rather than as read-then-write in Go matters because more
// than one controller replica will be running during a failover or a rolling
// deploy. Reading ZCARD, deciding there is room, and then popping lets two
// replicas each admit a full batch against the same free capacity.
//
// KEYS: active set (zset of userID -> admission deadline), queue (zset)
// ARGV: now, maxConcurrent, batchSize, ttlSeconds, activeKeyTTL
var admitScript = redis.NewScript(`
	local activeKey = KEYS[1]
	local queueKey  = KEYS[2]
	local now       = tonumber(ARGV[1])
	local maxConc   = tonumber(ARGV[2])
	local batch     = tonumber(ARGV[3])
	local ttl       = tonumber(ARGV[4])

	-- Retire abandoned checkouts. This is the line that keeps the controller
	-- from wedging: without it, a slot is only ever freed by a user who
	-- politely finishes, and most users do not.
	redis.call('ZREMRANGEBYSCORE', activeKey, '-inf', now)

	local room = maxConc - redis.call('ZCARD', activeKey)
	if room <= 0 then return {} end
	if room > batch then room = batch end

	local popped = redis.call('ZPOPMIN', queueKey, room)
	local users = {}
	-- ZPOPMIN replies with a flat [member, score, member, score, ...] array.
	for i = 1, #popped, 2 do
		local userID = popped[i]
		users[#users + 1] = userID
		redis.call('ZADD', activeKey, now + ttl, userID)
	end

	if #users > 0 then
		redis.call('EXPIRE', activeKey, ARGV[5])
	end
	return users
`)

// RunAdmission continuously admits users from queue at controlled rate
func (ac *AdmissionController) RunAdmission(ctx context.Context, eventID string) {
	ticker := time.NewTicker(ac.admitInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := ac.admitBatch(ctx, eventID); err != nil {
				// Log and keep the loop alive: a transient Redis error must not
				// silently stop admission for the rest of the sale.
				slog.ErrorContext(ctx, "admit batch failed",
					"event_id", eventID, "err", err)
			}
		}
	}
}

func (ac *AdmissionController) admitBatch(ctx context.Context, eventID string) error {
	now := time.Now()
	res, err := admitScript.Run(ctx, ac.rdb,
		[]string{activeKey(eventID), queueKey(eventID)},
		now.Unix(), ac.maxConcurrent, ac.admitBatchSize,
		int64(admissionTTL.Seconds()), int64((4 * time.Hour).Seconds()),
	).StringSlice()
	if err != nil {
		// Fail closed. Swallowing the error and treating the load as zero, as
		// a bare `current, _ := SCard(...)` would, admits a full batch every
		// tick precisely when Redis is already in trouble.
		return fmt.Errorf("admit batch: %w", err)
	}
	if len(res) == 0 {
		return nil
	}

	// Count admissions into the same per-minute bucket the wait estimator
	// reads, incremented by the batch size rather than once per call.
	bucket := throughputKey(eventID, now)
	pipe := ac.rdb.Pipeline()
	pipe.IncrBy(ctx, bucket, int64(len(res)))
	pipe.Expire(ctx, bucket, 5*time.Minute)
	if _, err := pipe.Exec(ctx); err != nil {
		// The users are already admitted, so this is a metrics problem only.
		slog.WarnContext(ctx, "throughput accounting failed",
			"event_id", eventID, "err", err)
	}
	return nil
}

// UserCompleted releases a slot as soon as a user finishes, rather than
// waiting for their admission window to lapse.
func (ac *AdmissionController) UserCompleted(ctx context.Context, eventID, userID string) {
	if err := ac.rdb.ZRem(ctx, activeKey(eventID), userID).Err(); err != nil {
		// Not fatal: the entry ages out of the sorted set on its own.
		slog.WarnContext(ctx, "release admission slot failed",
			"event_id", eventID, "user_id", userID, "err", err)
	}
}

func activeKey(eventID string) string { return fmt.Sprintf("queue:active:%s", eventID) }
func queueKey(eventID string) string  { return fmt.Sprintf("queue:waiting:%s", eventID) }
func throughputKey(eventID string, t time.Time) string {
	return fmt.Sprintf("throughput:%s:%s", eventID, t.Format("200601021504"))
}
```

---
