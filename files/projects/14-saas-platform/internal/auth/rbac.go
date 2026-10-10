// internal/auth/rbac.go
package auth

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/example/saas-platform/internal/isolation"
	"github.com/example/saas-platform/pkg/cache"
	"github.com/google/uuid"
)

// RBAC service handles role and permission management
type RBACService struct {
	permissionRepo PermissionRepository
	userRepo       UserRepository
	cache          cache.Cache
}

func NewRBACService(permissionRepo PermissionRepository, userRepo UserRepository, cache cache.Cache) *RBACService {
	return &RBACService{
		permissionRepo: permissionRepo,
		userRepo:       userRepo,
		cache:          cache,
	}
}

// CheckPermission verifies if user has a specific permission
func (s *RBACService) CheckPermission(ctx context.Context, permission string) error {
	user, err := isolation.GetUser(ctx)
	if err != nil {
		return fmt.Errorf("no user in context: %w", err)
	}

	// Owner has all permissions
	if user.Role == string(RoleOwner) {
		return nil
	}

	// Check if user has wildcard permission
	for _, p := range user.Permissions {
		if p == "*" {
			return nil
		}

		// Check exact match
		if p == permission {
			return nil
		}

		// Check wildcard match (e.g., "users:*" matches "users:read")
		if matchesWildcard(p, permission) {
			return nil
		}
	}

	return fmt.Errorf("permission denied: %s", permission)
}

// RequirePermission returns middleware that checks for a permission
func (s *RBACService) RequirePermission(permission string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := s.CheckPermission(r.Context(), permission); err != nil {
				http.Error(w, "Permission denied", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireRole returns middleware that checks for a role
func (s *RBACService) RequireRole(role Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := isolation.GetUser(r.Context())
			if err != nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			// Owner has access to everything
			if user.Role == string(RoleOwner) {
				next.ServeHTTP(w, r)
				return
			}

			if user.Role != string(role) {
				http.Error(w, "Insufficient role", http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// GetUserPermissions retrieves all permissions for a user
func (s *RBACService) GetUserPermissions(ctx context.Context, userID uuid.UUID) ([]string, error) {
	// Check cache first (cache returns string, skip type assertion)
	cacheKey := fmt.Sprintf("user:permissions:%s", userID)
	_ = cacheKey

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	var permissions []string

	// Add role-based permissions
	rolePerms, err := s.permissionRepo.GetByRole(ctx, user.TenantID, user.Role)
	if err != nil {
		return nil, err
	}

	for _, p := range rolePerms {
		permissions = append(permissions, p.Name)
	}

	// Add user-specific permissions
	permissions = append(permissions, user.Permissions...)

	// Cache for 5 minutes
	s.cache.Set(ctx, cacheKey, permissions, 5*time.Minute)

	return permissions, nil
}

// AssignRoleToUser assigns a role to a user
func (s *RBACService) AssignRoleToUser(ctx context.Context, userID uuid.UUID, role Role) error {
	// Only admins and owners can assign roles
	if err := s.CheckPermission(ctx, "users:assign_role"); err != nil {
		return err
	}

	// Update user role
	if err := s.userRepo.UpdateRole(ctx, userID, role); err != nil {
		return err
	}

	// Invalidate cache
	cacheKey := fmt.Sprintf("user:permissions:%s", userID)
	s.cache.Delete(ctx, cacheKey)

	return nil
}

// GrantPermission grants a specific permission to a user
func (s *RBACService) GrantPermission(ctx context.Context, userID uuid.UUID, permission string) error {
	// Only admins and owners can grant permissions
	if err := s.CheckPermission(ctx, "users:grant_permission"); err != nil {
		return err
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	// Check if permission already exists
	if slices.Contains(user.Permissions, permission) {
		return nil // Already has permission
	}

	// Add permission
	user.Permissions = append(user.Permissions, permission)

	if err := s.userRepo.UpdatePermissions(ctx, userID, user.Permissions); err != nil {
		return err
	}

	// Invalidate cache
	cacheKey := fmt.Sprintf("user:permissions:%s", userID)
	s.cache.Delete(ctx, cacheKey)

	return nil
}

// RevokePermission revokes a specific permission from a user
func (s *RBACService) RevokePermission(ctx context.Context, userID uuid.UUID, permission string) error {
	// Only admins and owners can revoke permissions
	if err := s.CheckPermission(ctx, "users:revoke_permission"); err != nil {
		return err
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	// Remove permission
	var newPermissions []string
	for _, p := range user.Permissions {
		if p != permission {
			newPermissions = append(newPermissions, p)
		}
	}

	if err := s.userRepo.UpdatePermissions(ctx, userID, newPermissions); err != nil {
		return err
	}

	// Invalidate cache
	cacheKey := fmt.Sprintf("user:permissions:%s", userID)
	s.cache.Delete(ctx, cacheKey)

	return nil
}

func matchesWildcard(pattern, permission string) bool {
	// Support wildcard patterns like "users:*" or "*:read"
	patternParts := strings.Split(pattern, ":")
	permParts := strings.Split(permission, ":")

	if len(patternParts) != len(permParts) {
		return false
	}

	for i := range patternParts {
		if patternParts[i] != "*" && patternParts[i] != permParts[i] {
			return false
		}
	}

	return true
}
