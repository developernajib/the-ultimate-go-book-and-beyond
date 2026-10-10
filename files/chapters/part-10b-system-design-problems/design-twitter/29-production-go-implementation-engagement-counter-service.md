## Production Go Implementation: Engagement Counter Service

Like counts, retweet counts, and reply counts are among the most frequently read and written fields in the entire system. Reading them from the database on every request would be too slow, so this service keeps real-time counters in Redis using atomic INCR/DECR operations. A background flush loop periodically syncs the Redis counters back to MySQL so that the database stays reasonably up to date. If a flush fails for a particular tweet, it is marked dirty again and retried in the next cycle.

That last sentence is a promise, and promises in a flush loop are only as good as the error handling underneath them. This is the most dangerous code in the chapter, for a reason worth internalizing: **a cache that reads zero on failure and then writes that zero back to the source of truth does not degrade, it destroys.** If `GetCounts` swallows its errors and hands back `(0, 0, 0, nil)`, the retry branch becomes unreachable dead code, and the very next flush overwrites a viral tweet's 2.4 million likes with zero. Nothing throws. Nothing pages. The number is simply gone, and the likes table it was derived from is the only way back.

You do not need a Redis outage to trigger it either. An ordinary eviction of one counter key returns `redis.Nil`, which is an error, which becomes zero, which gets written. The counters are the thing most likely to be evicted, because there are billions of them.

Two rules fall out of that, and they generalize well past this service. A read that cannot distinguish "zero" from "I don't know" must never feed a write. And a decrement needs a floor: an unlike that arrives twice, or an unlike for a like that was never recorded, walks the counter below zero and a negative like count is a bug users screenshot.

```go
package engagement

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// EngagementCounter manages denormalized like/retweet/reply counts.
// Redis holds the real-time count, MySQL is reconciled periodically.
type EngagementCounter struct {
	rdb           *redis.ClusterClient
	tweetDB       TweetStore
	mu            sync.Mutex
	dirtySet      map[int64]bool // tweet IDs with pending counter updates
	flushInterval time.Duration
}

// countersKey groups all three counters for a tweet into one Redis hash. The
// hash tag would also keep separate keys on one slot, but a single hash means
// one round trip and one atomic read, so the three counters can never be
// captured from different moments.
func countersKey(tweetID int64) string { return fmt.Sprintf("tweet:{%d}:counters", tweetID) }

func NewEngagementCounter(ctx context.Context, rdb *redis.ClusterClient, db TweetStore) *EngagementCounter {
	ec := &EngagementCounter{
		rdb:           rdb,
		tweetDB:       db,
		dirtySet:      make(map[int64]bool),
		flushInterval: 30 * time.Second,
	}
	// Take a context so the loop is stoppable. A goroutine started in a
	// constructor with no way to signal it is a leak by construction.
	go ec.flushLoop(ctx)
	return ec
}

func (c *EngagementCounter) IncrementLike(ctx context.Context, tweetID int64) error {
	if err := c.rdb.HIncrBy(ctx, countersKey(tweetID), "likes", 1).Err(); err != nil {
		return fmt.Errorf("increment like: %w", err)
	}
	c.markDirty(tweetID)
	return nil
}

// decrFloor decrements a field but never below zero.
var decrFloor = redis.NewScript(`
local v = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if v <= 0 then
  return 0
end
return redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
`)

// DecrementLike lowers the like count without letting it go negative. A bare
// DECR here means one duplicate unlike event, or an unlike for a like that was
// never counted, leaves the tweet showing -1 likes forever.
func (c *EngagementCounter) DecrementLike(ctx context.Context, tweetID int64) error {
	if err := decrFloor.Run(ctx, c.rdb, []string{countersKey(tweetID)}, "likes").Err(); err != nil {
		return fmt.Errorf("decrement like: %w", err)
	}
	c.markDirty(tweetID)
	return nil
}

// GetCounts returns the current counts. It returns an error when Redis cannot
// answer and ErrCountsMissing when the key is absent, because callers must be
// able to tell "this tweet has zero likes" from "I could not find out".
var ErrCountsMissing = errors.New("counters not present in cache")

func (c *EngagementCounter) GetCounts(ctx context.Context, tweetID int64) (likes, retweets, replies int64, err error) {
	vals, err := c.rdb.HMGet(ctx, countersKey(tweetID), "likes", "retweets", "replies").Result()
	if err != nil {
		return 0, 0, 0, fmt.Errorf("read counters: %w", err)
	}
	if vals[0] == nil && vals[1] == nil && vals[2] == nil {
		return 0, 0, 0, ErrCountsMissing
	}
	return toInt64(vals[0]), toInt64(vals[1]), toInt64(vals[2]), nil
}

func toInt64(v any) int64 {
	s, ok := v.(string)
	if !ok {
		return 0 // field absent within an existing hash genuinely means zero
	}
	var n int64
	fmt.Sscanf(s, "%d", &n)
	return n
}

func (c *EngagementCounter) markDirty(tweetID int64) {
	c.mu.Lock()
	c.dirtySet[tweetID] = true
	c.mu.Unlock()
}

// flushLoop periodically syncs Redis counters to MySQL.
func (c *EngagementCounter) flushLoop(ctx context.Context) {
	ticker := time.NewTicker(c.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.flush(context.WithoutCancel(ctx)) // drain before exiting
			return
		case <-ticker.C:
			c.flush(ctx)
		}
	}
}

func (c *EngagementCounter) flush(ctx context.Context) {
	c.mu.Lock()
	dirty := c.dirtySet
	c.dirtySet = make(map[int64]bool)
	c.mu.Unlock()

	for tweetID := range dirty {
		likes, retweets, replies, err := c.GetCounts(ctx, tweetID)
		switch {
		case errors.Is(err, ErrCountsMissing):
			// The key was evicted. There is nothing to flush, and writing the
			// zero we just failed to read would erase the real count in MySQL.
			slog.WarnContext(ctx, "counters evicted before flush", "tweet", tweetID)
			continue
		case err != nil:
			c.markDirty(tweetID) // reachable now: retry next cycle
			continue
		}

		if err := c.tweetDB.UpdateCounts(ctx, tweetID, likes, retweets, replies); err != nil {
			slog.ErrorContext(ctx, "counter flush failed", "tweet", tweetID, "error", err)
			c.markDirty(tweetID)
		}
	}
}
```

Redis is the working copy here, not the ledger. The `likes` table is the ledger, and it is what the nightly reconciliation job replays to repair drift. Keep that direction of authority straight: counters flow from the ledger to the cache when they disagree, never the reverse.

---
