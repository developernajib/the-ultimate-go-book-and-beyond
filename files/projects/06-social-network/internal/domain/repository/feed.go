// internal/domain/repository/feed.go
package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/example/social-network/internal/domain"
)

// FeedRepository defines data access for user feeds.
type FeedRepository interface {
	CreateBatch(ctx context.Context, entries []*domain.FeedEntry) error
	GetByUserID(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.FeedEntry, error)
	DeleteByPostID(ctx context.Context, postID uuid.UUID) error
}
