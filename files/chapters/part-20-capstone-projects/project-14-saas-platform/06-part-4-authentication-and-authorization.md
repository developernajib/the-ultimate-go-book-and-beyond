## Part 4: Authentication and Authorization

Authentication verifies who a user is, while authorization determines what they are allowed to do. In a multi-tenant SaaS platform, both must be tenant-aware: a user's identity is always scoped to a specific tenant, and their permissions only apply within that tenant's boundaries. This section implements JWT-based authentication for API access, role-based access control for fine-grained permissions, and SAML-based single sign-on so enterprise customers can use their existing identity providers.

### JWT Authentication
JSON Web Tokens (JWTs) are the standard way to handle authentication in modern APIs. When a user logs in, the server generates a signed token containing the user's ID, tenant ID, and role. The client sends this token with every subsequent request, and the server verifies the signature without needing to look anything up in a database. The code below implements token generation, validation, and refresh logic. Notice that the tenant ID is embedded directly in the token claims, which means every authenticated request automatically carries tenant context.

```go
// internal/auth/jwt.go
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

var (
	ErrInvalidToken = errors.New("invalid or expired token")
	ErrTokenExpired = errors.New("token has expired")
)

// TenantClaims represents the JWT payload including tenant context.
type TenantClaims struct {
	UserID   uuid.UUID `json:"user_id"`
	TenantID uuid.UUID `json:"tenant_id"`
	Role     string    `json:"role"`
	jwt.RegisteredClaims
}

// TokenPair contains both access and refresh tokens.
type TokenPair struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// JWTService handles token generation, verification, and rotation.
type JWTService struct {
	secretKey     []byte
	accessExpiry  time.Duration
	refreshExpiry time.Duration
	issuer        string
}

func NewJWTService(secret string, accessExpiry, refreshExpiry time.Duration, issuer string) *JWTService {
	return &JWTService{
		secretKey:     []byte(secret),
		accessExpiry:  accessExpiry,
		refreshExpiry: refreshExpiry,
		issuer:        issuer,
	}
}

// GenerateTokenPair creates new access and refresh tokens for an authenticated user.
func (s *JWTService) GenerateTokenPair(userID, tenantID uuid.UUID, role string) (*TokenPair, error) {
	now := time.Now().UTC()
	accessExpires := now.Add(s.accessExpiry)

	claims := TenantClaims{
		UserID:   userID,
		TenantID: tenantID,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    s.issuer,
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{tenantID.String()},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(accessExpires),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedAccess, err := token.SignedString(s.secretKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign access token: %w", err)
	}

	refreshClaims := jwt.RegisteredClaims{
		Issuer:    s.issuer,
		Subject:   userID.String(),
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(s.refreshExpiry)),
	}
	refreshToken := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims)
	signedRefresh, err := refreshToken.SignedString(s.secretKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign refresh token: %w", err)
	}

	return &TokenPair{
		AccessToken:  signedAccess,
		RefreshToken: signedRefresh,
		ExpiresAt:    accessExpires,
	}, nil
}

// ValidateToken parses and validates a signed JWT, returning claims.
func (s *JWTService) ValidateToken(tokenString string) (*TenantClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &TenantClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.secretKey, nil
	})

	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*TenantClaims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	return claims, nil
}
```

### Role-Based Access Control (RBAC)

RBAC lets you control what actions each user can perform within their tenant. Instead of checking permissions with scattered if-statements throughout your code, you define roles (like owner, admin, member, and viewer) and assign a set of permissions to each role. When a user tries to perform an action, the RBAC system checks whether their role includes the required permission. This approach is much easier to maintain than ad-hoc checks, and it scales well as you add new features and roles to your platform.

```go
// internal/auth/rbac.go
package auth

import (
    "context"
    "fmt"
    "strings"

    "github.com/google/uuid"
    "github.com/yourorg/tenantflow/internal/isolation"
)

// RBAC service handles role and permission management
type RBACService struct {
    permissionRepo PermissionRepository
    cache          cache.Cache
}

func NewRBACService(permissionRepo PermissionRepository, cache cache.Cache) *RBACService {
    return &RBACService{
        permissionRepo: permissionRepo,
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
    // Check cache first
    cacheKey := fmt.Sprintf("user:permissions:%s", userID)
    if cached, err := s.cache.Get(ctx, cacheKey); err == nil {
        if permissions, ok := cached.([]string); ok {
            return permissions, nil
        }
    }

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
    for _, p := range user.Permissions {
        if p == permission {
            return nil // Already has permission
        }
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
```

### SSO Integration (SAML)

Enterprise customers almost always require Single Sign-On (SSO) so their employees can log into your SaaS platform using the same credentials they use for everything else (like Okta, Azure AD, or Google Workspace). SAML is the most common SSO protocol for enterprise applications. It works by redirecting the user to their company's identity provider, where they authenticate, and then the identity provider sends a signed assertion back to your application confirming who the user is. The code below handles the SAML handshake, validates assertions, and maps external user identities to your internal user model.

```go
// internal/auth/saml.go
package auth

import (
    "context"
    "crypto/rsa"
    "crypto/x509"
    "encoding/pem"
    "fmt"
    "net/http"

    "github.com/crewjam/saml/samlsp"
    "github.com/google/uuid"
)

// SAMLService handles SAML SSO authentication
type SAMLService struct {
    ssoConfigRepo SSOConfigRepository
    userRepo      UserRepository
    jwtService    *JWTService
    logger        logger.Logger
}

func NewSAMLService(
    ssoConfigRepo SSOConfigRepository,
    userRepo UserRepository,
    jwtService *JWTService,
    logger logger.Logger,
) *SAMLService {
    return &SAMLService{
        ssoConfigRepo: ssoConfigRepo,
        userRepo:      userRepo,
        jwtService:    jwtService,
        logger:        logger,
    }
}

// GetSAMLMiddleware returns a SAML middleware for a tenant
func (s *SAMLService) GetSAMLMiddleware(ctx context.Context, tenantID uuid.UUID) (*samlsp.Middleware, error) {
    config, err := s.ssoConfigRepo.GetByTenantAndProvider(ctx, tenantID, SSOProviderSAML)
    if err != nil {
        return nil, fmt.Errorf("SAML not configured for tenant: %w", err)
    }

    if !config.Enabled {
        return nil, fmt.Errorf("SAML is disabled for this tenant")
    }

    // Parse certificate
    block, _ := pem.Decode([]byte(*config.SAMLCertificate))
    if block == nil {
        return nil, fmt.Errorf("failed to parse certificate PEM")
    }

    cert, err := x509.ParseCertificate(block.Bytes)
    if err != nil {
        return nil, fmt.Errorf("failed to parse certificate: %w", err)
    }

    // Create SAML middleware
    samlMiddleware, err := samlsp.New(samlsp.Options{
        URL:         *config.SAMLMetadataURL,
        Certificate: cert,
        EntityID:    *config.SAMLEntityID,
    })

    if err != nil {
        return nil, fmt.Errorf("failed to create SAML middleware: %w", err)
    }

    return samlMiddleware, nil
}

// HandleSAMLCallback processes SAML assertion and creates/updates user
func (s *SAMLService) HandleSAMLCallback(ctx context.Context, assertion *saml.Assertion) (*User, error) {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return nil, err
    }

    config, err := s.ssoConfigRepo.GetByTenantAndProvider(ctx, tenantID, SSOProviderSAML)
    if err != nil {
        return nil, err
    }

    // Extract user attributes from SAML assertion
    attributes := s.extractAttributes(assertion, config.AttributeMapping)

    email, ok := attributes["email"].(string)
    if !ok || email == "" {
        return nil, fmt.Errorf("email not found in SAML assertion")
    }

    // Find or create user
    user, err := s.userRepo.GetByEmail(ctx, tenantID, email)
    if err != nil {
        // User doesn't exist, create new one
        user = &User{
            ID:            uuid.New(),
            TenantID:      tenantID,
            Email:         email,
            EmailVerified: true, // SSO users are pre-verified
            FirstName:     getStringAttribute(attributes, "first_name"),
            LastName:      getStringAttribute(attributes, "last_name"),
            Role:          RoleMember, // Default role
            Status:        UserStatusActive,
            SSOProvider:   stringPtr(string(SSOProviderSAML)),
            SSOExternalID: stringPtr(assertion.Subject.NameID.Value),
            CreatedAt:     time.Now().UTC(),
            UpdatedAt:     time.Now().UTC(),
        }

        if err := s.userRepo.Create(ctx, user); err != nil {
            return nil, fmt.Errorf("failed to create SSO user: %w", err)
        }
    } else {
        // Update existing user with SSO info
        user.SSOProvider = stringPtr(string(SSOProviderSAML))
        user.SSOExternalID = stringPtr(assertion.Subject.NameID.Value)
        user.EmailVerified = true
        user.LastLoginAt = timePtr(time.Now().UTC())

        if err := s.userRepo.Update(ctx, user); err != nil {
            return nil, fmt.Errorf("failed to update SSO user: %w", err)
        }
    }

    return user, nil
}

func (s *SAMLService) extractAttributes(assertion *saml.Assertion, mapping map[string]string) map[string]any {
    attributes := make(map[string]any)

    for key, samlAttr := range mapping {
        for _, stmt := range assertion.AttributeStatements {
            for _, attr := range stmt.Attributes {
                if attr.Name == samlAttr {
                    if len(attr.Values) > 0 {
                        attributes[key] = attr.Values[0].Value
                    }
                }
            }
        }
    }

    return attributes
}

// SAMLLoginHandler handles SAML login initiation
func (s *SAMLService) SAMLLoginHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        tenantID, err := isolation.TenantID(ctx)
        if err != nil {
            http.Error(w, "Tenant not found", http.StatusBadRequest)
            return
        }

        middleware, err := s.GetSAMLMiddleware(ctx, tenantID)
        if err != nil {
            s.logger.Error("failed to get SAML middleware", "error", err)
            http.Error(w, "SAML not configured", http.StatusBadRequest)
            return
        }

        // Redirect to IdP
        middleware.HandleStartAuthFlow(w, r)
    }
}

// SAMLCallbackHandler handles SAML assertion callback
func (s *SAMLService) SAMLCallbackHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract SAML assertion (implementation depends on SAML library)
        assertion := samlsp.AssertionFromContext(ctx)
        if assertion == nil {
            http.Error(w, "Invalid SAML assertion", http.StatusBadRequest)
            return
        }

        // Process assertion and get/create user
        user, err := s.HandleSAMLCallback(ctx, assertion)
        if err != nil {
            s.logger.Error("SAML callback failed", "error", err)
            http.Error(w, "Authentication failed", http.StatusInternalServerError)
            return
        }

        // Generate JWT tokens
        accessToken, refreshToken, err := s.jwtService.GenerateTokenPair(user)
        if err != nil {
            s.logger.Error("failed to generate tokens", "error", err)
            http.Error(w, "Authentication failed", http.StatusInternalServerError)
            return
        }

        // Return tokens (or set cookies, or redirect with tokens)
        json.NewEncoder(w).Encode(map[string]string{
            "access_token":  accessToken,
            "refresh_token": refreshToken,
        })
    }
}
```
