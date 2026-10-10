// internal/tenant/types.go
package tenant

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// User represents a user within a tenant
type User struct {
	ID            uuid.UUID      `json:"id" db:"id"`
	TenantID      uuid.UUID      `json:"tenant_id" db:"tenant_id"`
	Email         string         `json:"email" db:"email"`
	PasswordHash  string         `json:"-" db:"password_hash"`
	FirstName     string         `json:"first_name" db:"first_name"`
	LastName      string         `json:"last_name" db:"last_name"`
	Role          Role           `json:"role" db:"role"`
	Status        UserStatus     `json:"status" db:"status"`
	EmailVerified bool           `json:"email_verified" db:"email_verified"`
	Permissions   []string       `json:"permissions,omitempty" db:"-"`
	Metadata      map[string]any `json:"metadata,omitempty" db:"-"`
	CreatedAt     time.Time      `json:"created_at" db:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at" db:"updated_at"`
}

// Role represents a user's role
type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
	RoleViewer Role = "viewer"
)

// UserStatus represents a user's status
type UserStatus string

const (
	UserStatusActive   UserStatus = "active"
	UserStatusInactive UserStatus = "inactive"
	UserStatusPending  UserStatus = "pending"
)

// Permission represents an RBAC permission
type Permission struct {
	ID          uuid.UUID `json:"id" db:"id"`
	TenantID    uuid.UUID `json:"tenant_id" db:"tenant_id"`
	UserID      uuid.UUID `json:"user_id" db:"user_id"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	Resource    string    `json:"resource" db:"resource"`
	Action      string    `json:"action" db:"action"`
}

// Repository defines persistence operations for tenants
type Repository interface {
	Create(ctx context.Context, tx *sqlx.Tx, t *Tenant) error
	GetByID(ctx context.Context, id uuid.UUID) (*Tenant, error)
	GetBySubdomain(ctx context.Context, subdomain string) (*Tenant, error)
	GetByCustomDomain(ctx context.Context, domain string) (*Tenant, error)
	SubdomainExists(ctx context.Context, subdomain string) (bool, error)
	Update(ctx context.Context, t *Tenant) error
	UpdateStatus(ctx context.Context, id uuid.UUID, status TenantStatus) error
	UpdateBranding(ctx context.Context, id uuid.UUID, branding *BrandingSettings) error
	GetPlanByID(ctx context.Context, id uuid.UUID) (*Plan, error)
	CreateUser(ctx context.Context, tx *sqlx.Tx, u *User) error
	CreateSubscription(ctx context.Context, tx *sqlx.Tx, s any) error
	UpdateSubscription(ctx context.Context, s any) error
	GetSubscriptionByTenantID(ctx context.Context, tenantID uuid.UUID) (any, error)
	CreatePermission(ctx context.Context, tx *sqlx.Tx, p *Permission) error
	CountUsers(ctx context.Context, tenantID uuid.UUID) (int64, error)
	CountProjects(ctx context.Context, tenantID uuid.UUID) (int64, error)
	GetStorageUsage(ctx context.Context, tenantID uuid.UUID) (int64, error)
	CountCustomDomains(ctx context.Context, tenantID uuid.UUID) (int64, error)
	CustomDomainExists(ctx context.Context, domain string) (bool, error)
	SetCustomDomain(ctx context.Context, tenantID uuid.UUID, domain string) error
}

// UserRepository defines persistence for users
type UserRepository interface {
	Create(ctx context.Context, u *User) error
	GetByID(ctx context.Context, id uuid.UUID) (*User, error)
	GetByEmail(ctx context.Context, tenantID uuid.UUID, email string) (*User, error)
	GetOwnerByTenantID(ctx context.Context, tenantID uuid.UUID) (*User, error)
	Update(ctx context.Context, u *User) error
	UpdatePassword(ctx context.Context, id uuid.UUID, passwordHash string) error
	VerifyEmail(ctx context.Context, id uuid.UUID) error
}

// EmailService sends emails to users
type EmailService interface {
	SendWelcome(ctx context.Context, to string, tenantName string) error
	SendVerification(ctx context.Context, to string, token string) error
	SendPasswordReset(ctx context.Context, to string, token string) error
}
