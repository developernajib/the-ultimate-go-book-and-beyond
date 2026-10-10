// internal/domain/notification.go
package domain

import (
    "time"
    "github.com/google/uuid"
)

type Notification struct {
    ID         uuid.UUID  `json:"id" db:"id"`
    UserID     uuid.UUID  `json:"user_id" db:"user_id"`
    ActorID    *uuid.UUID `json:"actor_id" db:"actor_id"`
    Type       string     `json:"type" db:"type"`
    EntityType string     `json:"entity_type" db:"entity_type"`
    EntityID   *uuid.UUID `json:"entity_id" db:"entity_id"`
    Message    string     `json:"message" db:"message"`
    IsRead     bool       `json:"is_read" db:"is_read"`
    CreatedAt  time.Time  `json:"created_at" db:"created_at"`
    ReadAt     *time.Time `json:"read_at" db:"read_at"`

    // Hydrated fields
    Actor  *PublicUser `json:"actor,omitempty" db:"-"`
    Entity any `json:"entity,omitempty" db:"-"`
}

const (
    NotificationTypeLike    = "like"
    NotificationTypeComment = "comment"
    NotificationTypeFollow  = "follow"
    NotificationTypeMention = "mention"
    NotificationTypeRepost  = "repost"
    NotificationTypeReply   = "reply"
)
