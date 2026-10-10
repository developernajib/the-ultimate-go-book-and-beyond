// internal/domain/repository/media.go
package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/example/social-network/internal/domain"
)

// MediaRepository defines data access for media assets.
type MediaRepository interface {
	Create(ctx context.Context, media *domain.Media) error
	GetByID(ctx context.Context, id uuid.UUID) (*domain.Media, error)
	GetByUserID(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Media, error)
	Delete(ctx context.Context, id uuid.UUID) error
}
