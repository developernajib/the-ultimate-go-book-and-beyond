// internal/auth/user_repository.go
package auth

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// sqlUserRepository is a stub SQL implementation of UserRepository.
type sqlUserRepository struct {
	db *sqlx.DB
}

// NewUserRepository creates a new user repository backed by a SQL database.
func NewUserRepository(db *sqlx.DB) UserRepository {
	return &sqlUserRepository{db: db}
}

func (r *sqlUserRepository) GetByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return nil, fmt.Errorf("not implemented")
}

func (r *sqlUserRepository) GetByEmail(ctx context.Context, tenantID uuid.UUID, email string) (*User, error) {
	return nil, fmt.Errorf("not implemented")
}

func (r *sqlUserRepository) Create(ctx context.Context, u *User) error {
	return fmt.Errorf("not implemented")
}

func (r *sqlUserRepository) Update(ctx context.Context, u *User) error {
	return fmt.Errorf("not implemented")
}

func (r *sqlUserRepository) UpdateRole(ctx context.Context, id uuid.UUID, role Role) error {
	return fmt.Errorf("not implemented")
}

func (r *sqlUserRepository) UpdatePermissions(ctx context.Context, id uuid.UUID, permissions []string) error {
	return fmt.Errorf("not implemented")
}

// sqlSessionRepository is a stub SQL implementation of SessionRepository.
type sqlSessionRepository struct {
	db *sqlx.DB
}

// NewSessionRepository creates a new session repository backed by a SQL database.
func NewSessionRepository(db *sqlx.DB) SessionRepository {
	return &sqlSessionRepository{db: db}
}

func (r *sqlSessionRepository) Create(ctx context.Context, s *Session) error {
	return fmt.Errorf("not implemented")
}

func (r *sqlSessionRepository) GetByID(ctx context.Context, id uuid.UUID) (*Session, error) {
	return nil, fmt.Errorf("not implemented")
}

func (r *sqlSessionRepository) Delete(ctx context.Context, id uuid.UUID) error {
	return fmt.Errorf("not implemented")
}

func (r *sqlSessionRepository) DeleteByUserID(ctx context.Context, userID uuid.UUID) error {
	return fmt.Errorf("not implemented")
}
