// internal/domain/repository/post.go
package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/example/social-network/internal/domain"
)

// PostRepository defines data access for posts.
type PostRepository interface {
	Create(ctx context.Context, post *domain.Post) error
	GetByID(ctx context.Context, id uuid.UUID) (*domain.Post, error)
	GetByUserID(ctx context.Context, userID uuid.UUID, limit, offset int) ([]*domain.Post, error)
	GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.Post, error)
	GetByAuthorIDs(ctx context.Context, authorIDs []uuid.UUID, limit int, beforeID *uuid.UUID) ([]*domain.Post, error)
	Update(ctx context.Context, post *domain.Post) error
	Delete(ctx context.Context, id uuid.UUID) error
	LikePost(ctx context.Context, postID, userID uuid.UUID) error
	UnlikePost(ctx context.Context, postID, userID uuid.UUID) error
	IsLiked(ctx context.Context, postID, userID uuid.UUID) (bool, error)
	GetLikes(ctx context.Context, postID uuid.UUID, limit, offset int) ([]uuid.UUID, error)
}
