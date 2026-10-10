// internal/domain/repository/user.go
package repository

import (
    "context"
    "github.com/google/uuid"
    "github.com/example/social-network/internal/domain"
)

type UserRepository interface {
    // Create operations
    Create(ctx context.Context, user *domain.User) error
    CreateSettings(ctx context.Context, settings *domain.UserSettings) error

    // Read operations
    GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error)
    GetByUsername(ctx context.Context, username string) (*domain.User, error)
    GetByEmail(ctx context.Context, email string) (*domain.User, error)
    GetByIDs(ctx context.Context, ids []uuid.UUID) ([]*domain.User, error)
    GetSettings(ctx context.Context, userID uuid.UUID) (*domain.UserSettings, error)

    // Update operations
    Update(ctx context.Context, user *domain.User) error
    UpdateSettings(ctx context.Context, settings *domain.UserSettings) error
    UpdateLastSeen(ctx context.Context, userID uuid.UUID) error
    IncrementFollowerCount(ctx context.Context, userID uuid.UUID, delta int) error
    IncrementFollowingCount(ctx context.Context, userID uuid.UUID, delta int) error
    IncrementPostCount(ctx context.Context, userID uuid.UUID, delta int) error

    // Delete operations
    Delete(ctx context.Context, id uuid.UUID) error

    // Search operations
    Search(ctx context.Context, query string, limit, offset int) ([]*domain.User, error)

    // Utility
    UsernameExists(ctx context.Context, username string) (bool, error)
    EmailExists(ctx context.Context, email string) (bool, error)
}
