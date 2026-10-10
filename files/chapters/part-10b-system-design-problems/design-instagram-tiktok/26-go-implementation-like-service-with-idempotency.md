## Go Implementation: Like Service with Idempotency

The like service demonstrates a pattern critical to distributed systems: idempotency. Users may double-tap, network retries may duplicate requests, and mobile clients may resend on timeout. This implementation uses a Cassandra lightweight transaction (IF NOT EXISTS) so that calling `LikePost` twice produces the same result as calling it once, with no window for two concurrent requests to both pass a read-then-write check. The service also maintains a Redis set of each user's recent likes, which enables the "is_liked" flag in feed responses without querying Cassandra for every post in the feed.

```go
package like

import (
	"context"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// LikeService handles post likes with exact-once semantics
type LikeService struct {
	session  *gocql.Session
	rdb      *redis.ClusterClient
	notifier NotificationBatcher
}

// LikePost likes a post (idempotent: calling twice has no effect).
// postOwnerID is the post author, needed to route the notification
func (s *LikeService) LikePost(ctx context.Context, postID, postOwnerID, userID gocql.UUID) error {
	// Lightweight transaction: concurrent duplicates see applied=false
	applied, err := s.session.Query(`
		INSERT INTO post_likes (post_id, user_id, created_at)
		VALUES (?, ?, ?) IF NOT EXISTS`,
		postID, userID, time.Now()).WithContext(ctx).ScanCAS()
	if err != nil {
		return err
	}
	if !applied {
		return nil // already liked, idempotent
	}

	// Increment counter in Redis (fast read path)
	s.rdb.Incr(ctx, fmt.Sprintf("post:likes:%s", postID))

	// Add to user's "liked posts" set (for "is_liked" flag in feed)
	s.rdb.SAdd(ctx, fmt.Sprintf("user:likes:%s", userID), postID.String())
	s.rdb.Expire(ctx, fmt.Sprintf("user:likes:%s", userID), 24*time.Hour)

	// Notify post owner (batched)
	go s.notifier.AddEvent(postOwnerID.String(), "like", postID.String(), userID.String())

	return nil
}

// UnlikePost removes a like. IF EXISTS keeps it idempotent so repeated
// unlikes cannot drive the counter negative
func (s *LikeService) UnlikePost(ctx context.Context, postID, userID gocql.UUID) error {
	applied, err := s.session.Query(`
		DELETE FROM post_likes WHERE post_id = ? AND user_id = ? IF EXISTS`,
		postID, userID).WithContext(ctx).ScanCAS()
	if err != nil {
		return err
	}
	if !applied {
		return nil // was not liked
	}

	s.rdb.Decr(ctx, fmt.Sprintf("post:likes:%s", postID))
	s.rdb.SRem(ctx, fmt.Sprintf("user:likes:%s", userID), postID.String())

	return nil
}

// IsLiked checks if a user has liked a post (used in feed rendering)
func (s *LikeService) IsLiked(ctx context.Context, postID, userID string) bool {
	// The Redis set only holds recent likes (24h TTL), so it is
	// authoritative for hits but a miss must be confirmed in Cassandra
	exists, err := s.rdb.SIsMember(ctx, fmt.Sprintf("user:likes:%s", userID), postID).Result()
	if err == nil && exists {
		return true
	}

	var count int
	s.session.Query(`
		SELECT count(*) FROM post_likes WHERE post_id = ? AND user_id = ?`,
		postID, userID).WithContext(ctx).Scan(&count)
	return count > 0
}

// BatchIsLiked checks multiple posts at once (for feed rendering).
// Cache-only by design: likes older than the set TTL may render as
// unliked, an acceptable trade for feeds that mostly show recent posts
func (s *LikeService) BatchIsLiked(ctx context.Context, postIDs []string, userID string) map[string]bool {
	result := make(map[string]bool, len(postIDs))
	key := fmt.Sprintf("user:likes:%s", userID)

	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.BoolCmd, len(postIDs))
	for i, pid := range postIDs {
		cmds[i] = pipe.SIsMember(ctx, key, pid)
	}
	pipe.Exec(ctx)

	for i, cmd := range cmds {
		liked, _ := cmd.Result()
		result[postIDs[i]] = liked
	}

	return result
}
```

---
