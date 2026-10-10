// internal/domain/repository/follow.go
package repository

import (
	"context"

	"github.com/google/uuid"
)

// FollowRepository defines data access for follow relationships.
type FollowRepository interface {
	Create(ctx context.Context, followerID, followeeID uuid.UUID) error
	Delete(ctx context.Context, followerID, followeeID uuid.UUID) error
	GetFollowerIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error)
	GetFollowingIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error)
	IsFollowing(ctx context.Context, followerID, followeeID uuid.UUID) (bool, error)
}
