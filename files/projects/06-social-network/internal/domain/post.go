// internal/domain/post.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type Post struct {
    ID           uuid.UUID   `json:"id" db:"id"`
    UserID       uuid.UUID   `json:"user_id" db:"user_id"`
    Content      string      `json:"content" db:"content"`
    MediaURLs    []string    `json:"media_urls" db:"media_urls"`
    MediaTypes   []string    `json:"media_types" db:"media_types"`
    Hashtags     []string    `json:"hashtags" db:"hashtags"`
    Mentions     []uuid.UUID `json:"mentions" db:"mentions"`
    ReplyToID    *uuid.UUID  `json:"reply_to_id" db:"reply_to_id"`
    RepostOfID   *uuid.UUID  `json:"repost_of_id" db:"repost_of_id"`
    Visibility   string      `json:"visibility" db:"visibility"`
    LikeCount    int         `json:"like_count" db:"like_count"`
    CommentCount int         `json:"comment_count" db:"comment_count"`
    RepostCount  int         `json:"repost_count" db:"repost_count"`
    ViewCount    int         `json:"view_count" db:"view_count"`
    CreatedAt    time.Time   `json:"created_at" db:"created_at"`
    UpdatedAt    time.Time   `json:"updated_at" db:"updated_at"`
    DeletedAt    *time.Time  `json:"deleted_at" db:"deleted_at"`

    // Joined fields
    Author *PublicUser `json:"author,omitempty" db:"-"`
    IsLiked bool       `json:"is_liked,omitempty" db:"-"`
}

type CreatePostRequest struct {
    Content    string      `json:"content" validate:"omitempty,max=280"`
    MediaURLs  []string    `json:"media_urls" validate:"omitempty,max=4,dive,url"`
    ReplyToID  *uuid.UUID  `json:"reply_to_id"`
    RepostOfID *uuid.UUID  `json:"repost_of_id"`
    Visibility string      `json:"visibility" validate:"omitempty,oneof=public followers private"`
}

type UpdatePostRequest struct {
    Content string `json:"content" validate:"required,max=280"`
}

type PostLike struct {
    ID        uuid.UUID `json:"id" db:"id"`
    PostID    uuid.UUID `json:"post_id" db:"post_id"`
    UserID    uuid.UUID `json:"user_id" db:"user_id"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
}
