// internal/auth/repositories.go
package auth

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// JSONB is a map that serializes to/from JSON for Postgres jsonb columns
type JSONB map[string]any

func (j JSONB) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any(j))
}

func (j *JSONB) UnmarshalJSON(data []byte) error {
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return fmt.Errorf("failed to unmarshal JSONB: %w", err)
	}
	*j = m
	return nil
}

// UserRepository defines persistence for users in auth package
type UserRepository interface {
	GetByID(ctx context.Context, id uuid.UUID) (*User, error)
	GetByEmail(ctx context.Context, tenantID uuid.UUID, email string) (*User, error)
	Create(ctx context.Context, u *User) error
	Update(ctx context.Context, u *User) error
	UpdateRole(ctx context.Context, id uuid.UUID, role Role) error
	UpdatePermissions(ctx context.Context, id uuid.UUID, permissions []string) error
}

// SessionRepository defines persistence for user sessions
type SessionRepository interface {
	Create(ctx context.Context, s *Session) error
	GetByID(ctx context.Context, id uuid.UUID) (*Session, error)
	Delete(ctx context.Context, id uuid.UUID) error
	DeleteByUserID(ctx context.Context, userID uuid.UUID) error
}

// PermissionRepository defines persistence for permissions
type PermissionRepository interface {
	GetByRole(ctx context.Context, tenantID uuid.UUID, role Role) ([]*Permission, error)
	GetByUserID(ctx context.Context, userID uuid.UUID) ([]*Permission, error)
}

// SSOConfigRepository defines persistence for SSO configurations
type SSOConfigRepository interface {
	GetByTenantAndProvider(ctx context.Context, tenantID uuid.UUID, provider SSOProvider) (*SSOConfig, error)
	Upsert(ctx context.Context, config *SSOConfig) error
}
