## Go Implementation: Comment Service

The comment service handles threaded comments with content moderation, pagination, and real-time counter updates. Every comment passes through a content moderator before being persisted, which blocks inappropriate text at the point of creation. Comments are stored in Cassandra partitioned by `post_id` with TimeUUID clustering, giving you chronologically ordered comments for any post in a single efficient query. The cursor-based pagination uses the last comment's ID as the cursor, which works naturally with Cassandra's clustering order.

```go
package comment

import (
	"context"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
)

// CommentService manages post comments
type CommentService struct {
	session   *gocql.Session
	rdb       *redis.ClusterClient
	moderator ContentModerator
	notifier  NotificationBatcher
}

type Comment struct {
	PostID    gocql.UUID  `json:"post_id"`
	CommentID gocql.UUID  `json:"comment_id"`
	UserID    gocql.UUID  `json:"user_id"`
	Text      string      `json:"text"`
	LikeCount int64       `json:"like_count"`
	ReplyTo   *gocql.UUID `json:"reply_to,omitempty"` // for threaded comments
	CreatedAt time.Time   `json:"created_at"`
}

// AddComment creates a new comment with moderation. postOwnerID is the
// author of the post, needed to route the notification
func (s *CommentService) AddComment(ctx context.Context, postID, postOwnerID, userID gocql.UUID, text string, replyTo *gocql.UUID) (*Comment, error) {
	// Content moderation
	if !s.moderator.IsClean(ctx, text) {
		return nil, fmt.Errorf("comment contains inappropriate content")
	}

	comment := &Comment{
		PostID:    postID,
		CommentID: gocql.TimeUUID(),
		UserID:    userID,
		Text:      text,
		ReplyTo:   replyTo,
		CreatedAt: time.Now(),
	}

	// Write to Cassandra
	err := s.session.Query(`
		INSERT INTO comments (post_id, comment_id, user_id, text, reply_to, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		comment.PostID, comment.CommentID, comment.UserID,
		comment.Text, comment.ReplyTo, comment.CreatedAt,
	).WithContext(ctx).Exec()
	if err != nil {
		return nil, err
	}

	// Increment comment count
	s.rdb.Incr(ctx, fmt.Sprintf("post:comments:%s", postID))

	// Notify post owner
	go s.notifier.AddEvent(postOwnerID.String(), "comment", postID.String(), userID.String())

	return comment, nil
}

// GetComments returns paginated comments for a post
func (s *CommentService) GetComments(ctx context.Context, postID gocql.UUID, limit int, cursor *gocql.UUID) ([]Comment, *gocql.UUID, error) {
	var query string
	var args []any

	if cursor != nil {
		query = `SELECT comment_id, user_id, text, like_count, reply_to, created_at
			FROM comments WHERE post_id = ? AND comment_id < ? ORDER BY comment_id DESC LIMIT ?`
		args = []any{postID, *cursor, limit}
	} else {
		query = `SELECT comment_id, user_id, text, like_count, reply_to, created_at
			FROM comments WHERE post_id = ? ORDER BY comment_id DESC LIMIT ?`
		args = []any{postID, limit}
	}

	iter := s.session.Query(query, args...).WithContext(ctx).Iter()

	var comments []Comment
	var c Comment
	for iter.Scan(&c.CommentID, &c.UserID, &c.Text, &c.LikeCount, &c.ReplyTo, &c.CreatedAt) {
		c.PostID = postID
		comments = append(comments, c)
	}

	var nextCursor *gocql.UUID
	if len(comments) == limit {
		nextCursor = &comments[len(comments)-1].CommentID
	}

	return comments, nextCursor, iter.Close()
}
```

---
