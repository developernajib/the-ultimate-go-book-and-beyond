// internal/domain/feed.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type FeedEntry struct {
    ID           uuid.UUID `json:"id" db:"id"`
    UserID       uuid.UUID `json:"user_id" db:"user_id"`
    PostID       uuid.UUID `json:"post_id" db:"post_id"`
    PostAuthorID uuid.UUID `json:"post_author_id" db:"post_author_id"`
    RankScore    float64   `json:"rank_score" db:"rank_score"`
    CreatedAt    time.Time `json:"created_at" db:"created_at"`

    // Hydrated post
    Post *Post `json:"post,omitempty" db:"-"`
}

type Feed struct {
    Entries    []*FeedEntry `json:"entries"`
    NextCursor *string      `json:"next_cursor,omitempty"`
    HasMore    bool         `json:"has_more"`
}
