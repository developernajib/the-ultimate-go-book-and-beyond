## Deep Dive: Follow Graph

The follow graph is the backbone of Twitter's social network. Every timeline read, every fan-out operation, and every "who to follow" suggestion depends on it. The Follow Service stores the relationship in MySQL for durability and uses Redis as a cache in front of it.

This service is where a design gets punished for wishful thinking, in three specific ways.

**A follow is not idempotent unless you make it so.** Tapping Follow twice, or a client retrying after a timeout, must not add two edges or count two followers. Read-then-write cannot give you that, because two concurrent requests both read "not following" and both increment. The unique constraint on `(follower_id, following_id)` is the thing that actually decides, so the write must report whether it inserted a row, and the counter must move only when it did. The same argument runs in reverse for unfollow: decrementing when no edge existed walks the counter negative, and follower counts are hard to walk back.

**A cache miss must never be read as a fact.** `IsCelebrity` deciding from a cached counter with the error swallowed means an evicted key reports zero followers, the account is classified as a regular user, and the fan-out you built this entire hybrid model to prevent fires into 10M timelines. The failure mode is triggered by an ordinary eviction, and it fails toward the catastrophe rather than away from it. Fall back to the database and treat an unknown as needing an answer, not as a zero.

**Caching a set incrementally is not the same as caching it.** `SADD` on a key that does not exist happily creates a one-element set. A later read sees a populated key, calls it a hit, and returns one follower as the complete list. Either write through only when the key already exists, or invalidate and let the read path rebuild. Never half-fill.

```go
package social

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// CelebFollowerThreshold matches the timeline package. Above this, fan-out is
// skipped and tweets are pulled at read time.
const CelebFollowerThreshold = 100000

type FollowService struct {
	db  FollowStore
	rdb *redis.Client
}

func followersKey(uid int64) string { return fmt.Sprintf("followers:%d", uid) }
func countKey(uid int64) string     { return fmt.Sprintf("user:%d:follower_count", uid) }

// Follow adds an edge. CreateFollow performs an INSERT ... ON DUPLICATE KEY
// UPDATE and reports whether a row was actually inserted, so a double tap is a
// no-op instead of a second increment. MySQL is the source of truth for the
// count - Redis only caches it.
func (s *FollowService) Follow(ctx context.Context, followerID, followingID int64) error {
	if followerID == followingID {
		return errors.New("cannot follow yourself")
	}

	inserted, err := s.db.CreateFollow(ctx, followerID, followingID)
	if err != nil {
		return fmt.Errorf("create follow: %w", err)
	}
	if !inserted {
		return nil // already following: idempotent, and the counter must not move
	}

	// Invalidate rather than incrementally patch. SADD-ing into a missing key
	// would mint a one-element "complete" follower list.
	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, followersKey(followingID))
	pipe.Del(ctx, countKey(followingID))
	if _, err := pipe.Exec(ctx); err != nil {
		// The edge is durably committed, so this is not fatal. The stale keys
		// carry a TTL and the counter re-reads from MySQL on the next miss.
		return nil
	}
	return nil
}

// Unfollow removes an edge. The conditional delete is what keeps the counter
// from going negative when an unfollow is retried or arrives out of order.
func (s *FollowService) Unfollow(ctx context.Context, followerID, followingID int64) error {
	deleted, err := s.db.DeleteFollow(ctx, followerID, followingID)
	if err != nil {
		return fmt.Errorf("delete follow: %w", err)
	}
	if !deleted {
		return nil // no edge existed: nothing to undo, nothing to decrement
	}

	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, followersKey(followingID))
	pipe.Del(ctx, countKey(followingID))
	pipe.Exec(ctx)
	return nil
}

// FollowerCount reads through to the database on a miss. It returns an error
// rather than a zero, because every caller here treats the number as a
// decision input and a wrong zero is worse than a failed request.
func (s *FollowService) FollowerCount(ctx context.Context, uid int64) (int64, error) {
	c, err := s.rdb.Get(ctx, countKey(uid)).Int64()
	if err == nil {
		return c, nil
	}
	if !errors.Is(err, redis.Nil) {
		return 0, fmt.Errorf("read cached follower count: %w", err)
	}

	c, err = s.db.CountFollowers(ctx, uid)
	if err != nil {
		return 0, fmt.Errorf("count followers: %w", err)
	}
	s.rdb.Set(ctx, countKey(uid), c, 5*time.Minute)
	return c, nil
}

func (s *FollowService) IsCelebrity(ctx context.Context, uid int64) (bool, error) {
	c, err := s.FollowerCount(ctx, uid)
	if err != nil {
		return false, err
	}
	return c > CelebFollowerThreshold, nil
}

// GetFollowers returns the full follower list. Callers must check IsCelebrity
// first: this materializes every follower, and for a celebrity that is millions
// of IDs in one slice.
func (s *FollowService) GetFollowers(ctx context.Context, uid int64) ([]int64, error) {
	key := followersKey(uid)

	// EXISTS distinguishes "cached and empty" from "not cached". Treating an
	// empty set as a miss sends every follower-less account to the database on
	// every read.
	exists, err := s.rdb.Exists(ctx, key).Result()
	if err == nil && exists == 1 {
		cached, err := s.rdb.SMembers(ctx, key).Result()
		if err == nil {
			return parseIDs(cached)
		}
	}

	ids, err := s.db.GetFollowers(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("get followers: %w", err)
	}

	// Build the set under a temp key and rename it into place, so a concurrent
	// reader sees either the old complete set or the new complete set, never a
	// half-populated one.
	tmp := fmt.Sprintf("%s:build:%d", key, time.Now().UnixNano())
	pipe := s.rdb.Pipeline()
	pipe.SAdd(ctx, tmp, int64sToAny(ids)...)
	pipe.Expire(ctx, tmp, 10*time.Minute)
	pipe.Rename(ctx, tmp, key)
	pipe.Exec(ctx) // cache warming is best effort

	return ids, nil
}

func parseIDs(ss []string) ([]int64, error) {
	ids := make([]int64, 0, len(ss))
	for _, s := range ss {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("corrupt follower id %q: %w", s, err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func int64sToAny(ids []int64) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}
```

Note what `Follow` does *not* claim. The MySQL write and the Redis invalidation are two systems and there is no transaction spanning them, so the pipeline can fail after the edge commits. That is why the cache is invalidated rather than updated: the worst outcome of a lost invalidation is a stale read that expires within the TTL, whereas a lost incremental update corrupts the cached set until someone notices. Design the failure so the recovery is automatic.

---
