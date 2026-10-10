## Go Implementation: Follow Service with Social Graph

The follow service manages the social graph, which is the backbone of any social media platform. Every follow action requires writing to two Cassandra tables (one for "who do I follow" and one for "who follows me") because Cassandra does not support efficient reverse lookups. The service also updates Redis counters for follower/following counts and triggers asynchronous side effects like feed updates and notifications. Notice the idempotency guard: the first insert uses a lightweight transaction (IF NOT EXISTS), so calling follow twice on the same user pair is a no-op and retries or double-taps cannot double-increment the counters.

```go
package social

import (
	"context"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// FollowService manages the social graph
type FollowService struct {
	session  *gocql.Session
	rdb      *redis.ClusterClient
	feedSvc  *FeedService
	notifier NotificationService
}

// Follow creates a follow relationship
func (s *FollowService) Follow(ctx context.Context, followerID, followeeID string) error {
	if followerID == followeeID {
		return fmt.Errorf("cannot follow yourself")
	}

	now := time.Now()

	// Lightweight transaction makes the follow idempotent: a concurrent
	// retry or double-tap sees applied=false instead of racing a
	// read-then-write check
	applied, err := s.session.Query(`
		INSERT INTO following_of (user_id, following_id, created_at)
		VALUES (?, ?, ?) IF NOT EXISTS`,
		followerID, followeeID, now,
	).WithContext(ctx).ScanCAS()
	if err != nil {
		return fmt.Errorf("follow: %w", err)
	}
	if !applied {
		return nil // already following
	}

	// Reverse-lookup table (plain INSERT is an upsert, safe to retry)
	if err := s.session.Query(`
		INSERT INTO followers_of (user_id, follower_id, created_at) VALUES (?, ?, ?)`,
		followeeID, followerID, now,
	).WithContext(ctx).Exec(); err != nil {
		return fmt.Errorf("follow reverse index: %w", err)
	}

	// Update counters
	pipe := s.rdb.Pipeline()
	pipe.Incr(ctx, fmt.Sprintf("user:following_count:%s", followerID))
	pipe.Incr(ctx, fmt.Sprintf("user:follower_count:%s", followeeID))
	pipe.Exec(ctx)

	// Trigger feed update (add followee's recent posts to follower's feed)
	go s.feedSvc.OnFollow(context.Background(), followerID, followeeID)

	// Notify followee
	go s.notifier.NotifyFollow(context.Background(), followeeID, followerID)

	return nil
}

// Unfollow removes a follow relationship
func (s *FollowService) Unfollow(ctx context.Context, followerID, followeeID string) error {
	// IF EXISTS keeps unfollow idempotent: without it, repeated unfollows
	// would drive the counters below negative
	applied, err := s.session.Query(`
		DELETE FROM following_of WHERE user_id = ? AND following_id = ? IF EXISTS`,
		followerID, followeeID,
	).WithContext(ctx).ScanCAS()
	if err != nil {
		return err
	}
	if !applied {
		return nil // was not following
	}

	if err := s.session.Query(`
		DELETE FROM followers_of WHERE user_id = ? AND follower_id = ?`,
		followeeID, followerID,
	).WithContext(ctx).Exec(); err != nil {
		return err
	}

	pipe := s.rdb.Pipeline()
	pipe.Decr(ctx, fmt.Sprintf("user:following_count:%s", followerID))
	pipe.Decr(ctx, fmt.Sprintf("user:follower_count:%s", followeeID))
	pipe.Exec(ctx)

	// Remove followee's posts from follower's feed cache
	go s.feedSvc.OnUnfollow(context.Background(), followerID, followeeID)

	return nil
}

// GetFollowers returns up to limit followers (cursor pagination elided)
func (s *FollowService) GetFollowers(ctx context.Context, userID string, limit int) ([]string, error) {
	iter := s.session.Query(`
		SELECT follower_id FROM followers_of
		WHERE user_id = ? LIMIT ?`,
		userID, limit,
	).WithContext(ctx).Iter()

	var followers []string
	var followerID string
	for iter.Scan(&followerID) {
		followers = append(followers, followerID)
	}
	return followers, iter.Close()
}
```

---
