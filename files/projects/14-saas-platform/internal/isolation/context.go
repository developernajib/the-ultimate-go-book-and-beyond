// internal/isolation/context.go
package isolation

import (
    "context"
    "errors"

    "github.com/google/uuid"
)

type contextKey string

const (
    tenantContextKey contextKey = "tenant"
    userContextKey   contextKey = "user"
)

var (
    ErrNoTenantContext = errors.New("no tenant in context")
    ErrNoUserContext   = errors.New("no user in context")
)

// TenantContext contains tenant-specific information for the current request
type TenantContext struct {
    TenantID          uuid.UUID
    Subdomain         string
    CustomDomain      string
    IsolationStrategy string
    PlanID            uuid.UUID
    Features          map[string]bool
    Settings          map[string]any

    // Database connection info (for separate DB strategy)
    DatabaseName      string
    SchemaName        string
}

// UserContext contains user-specific information for the current request
type UserContext struct {
    UserID      uuid.UUID
    TenantID    uuid.UUID
    Email       string
    Role        string
    Permissions []string
}

// WithTenant adds tenant context to the given context
func WithTenant(ctx context.Context, tenant *TenantContext) context.Context {
    return context.WithValue(ctx, tenantContextKey, tenant)
}

// GetTenant retrieves tenant context from the given context
func GetTenant(ctx context.Context) (*TenantContext, error) {
    tenant, ok := ctx.Value(tenantContextKey).(*TenantContext)
    if !ok || tenant == nil {
        return nil, ErrNoTenantContext
    }
    return tenant, nil
}

// MustGetTenant retrieves tenant context or panics
func MustGetTenant(ctx context.Context) *TenantContext {
    tenant, err := GetTenant(ctx)
    if err != nil {
        panic(err)
    }
    return tenant
}

// WithUser adds user context to the given context
func WithUser(ctx context.Context, user *UserContext) context.Context {
    return context.WithValue(ctx, userContextKey, user)
}

// GetUser retrieves user context from the given context
func GetUser(ctx context.Context) (*UserContext, error) {
    user, ok := ctx.Value(userContextKey).(*UserContext)
    if !ok || user == nil {
        return nil, ErrNoUserContext
    }
    return user, nil
}

// MustGetUser retrieves user context or panics
func MustGetUser(ctx context.Context) *UserContext {
    user, err := GetUser(ctx)
    if err != nil {
        panic(err)
    }
    return user
}

// TenantID is a convenience function to get tenant ID from context
func TenantID(ctx context.Context) (uuid.UUID, error) {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return uuid.Nil, err
    }
    return tenant.TenantID, nil
}

// UserID is a convenience function to get user ID from context
func UserID(ctx context.Context) (uuid.UUID, error) {
    user, err := GetUser(ctx)
    if err != nil {
        return uuid.Nil, err
    }
    return user.UserID, nil
}

// HasFeature checks if a tenant has a specific feature enabled
func HasFeature(ctx context.Context, feature string) bool {
    tenant, err := GetTenant(ctx)
    if err != nil {
        return false
    }
    enabled, ok := tenant.Features[feature]
    return ok && enabled
}

// HasPermission checks if the current user has a specific permission
func HasPermission(ctx context.Context, permission string) bool {
    user, err := GetUser(ctx)
    if err != nil {
        return false
    }

    for _, p := range user.Permissions {
        if p == permission || p == "*" {
            return true
        }
    }
    return false
}

// HasRole checks if the current user has a specific role
func HasRole(ctx context.Context, role string) bool {
    user, err := GetUser(ctx)
    if err != nil {
        return false
    }
    return user.Role == role || user.Role == "owner" // owner has all roles
}
