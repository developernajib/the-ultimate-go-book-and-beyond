## 112B.3 Resource Server: JWT Validation Middleware

The JWT validation middleware fetches the JWKS from the authorization server, caches the public keys with a TTL, and verifies the signature and claims (`exp`, `iss`, `aud`) on every request without a network call. Extracting the `Authorization: Bearer` token from the header and storing verified claims in the request context decouples authentication logic from handler business logic, handlers access claims via a typed helper function rather than re-parsing the token. The JWKS cache uses a `sync.RWMutex` so requests read keys concurrently, while a refresh takes the write lock when the TTL expires or an unknown `kid` is encountered.

```go
package resourceserver

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// JWTValidator validates JWT access tokens
type JWTValidator struct {
	mu          sync.RWMutex
	issuer      string
	jwksURL     string
	audience    string
	publicKeys  map[string]any // kid -> public key
	lastFetched time.Time
	cacheTTL    time.Duration
}

// NewJWTValidator creates a new JWT validator
func NewJWTValidator(issuer, jwksURL, audience string) *JWTValidator {
	return &JWTValidator{
		issuer:     issuer,
		jwksURL:    jwksURL,
		audience:   audience,
		publicKeys: make(map[string]any),
		cacheTTL:   1 * time.Hour,
	}
}

// JWKSResponse represents the JWKS endpoint response
type JWKSResponse struct {
	Keys []JWK `json:"keys"`
}

// JWK represents a JSON Web Key
type JWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// FetchJWKS fetches and caches public keys from JWKS endpoint
func (v *JWTValidator) FetchJWKS(ctx context.Context) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	if time.Since(v.lastFetched) < v.cacheTTL {
		return nil // Cache still valid
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create JWKS request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024)) // 1MB limit
	if err != nil {
		return fmt.Errorf("failed to read JWKS response: %w", err)
	}

	var jwks JWKSResponse
	if err := json.Unmarshal(body, &jwks); err != nil {
		return fmt.Errorf("failed to parse JWKS: %w", err)
	}

	// Parse and cache public keys
	newKeys := make(map[string]any)
	for _, key := range jwks.Keys {
		if key.Use != "sig" {
			continue
		}
		publicKey, err := parseJWK(key)
		if err != nil {
			continue
		}
		newKeys[key.Kid] = publicKey
	}

	v.publicKeys = newKeys
	v.lastFetched = time.Now()
	return nil
}

func parseJWK(key JWK) (any, error) {
	// Minimal RSA JWK parsing. For production, prefer a maintained
	// library such as github.com/lestrrat-go/jwx/v2 that covers all
	// key types and edge cases.
	if key.Kty != "RSA" {
		return nil, fmt.Errorf("unsupported key type %s", key.Kty)
	}

	nBytes, err := base64.RawURLEncoding.DecodeString(key.N)
	if err != nil {
		return nil, fmt.Errorf("invalid modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(key.E)
	if err != nil {
		return nil, fmt.Errorf("invalid exponent: %w", err)
	}

	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(new(big.Int).SetBytes(eBytes).Int64()),
	}, nil
}

// ValidatedClaims represents validated JWT claims
type ValidatedClaims struct {
	Subject  string
	ClientID string
	Scopes   []string
	Roles    []string
	Issuer   string
}

// Validate validates a JWT token and returns claims
func (v *JWTValidator) Validate(ctx context.Context, tokenStr string) (*ValidatedClaims, error) {
	// Refresh JWKS if needed
	if err := v.FetchJWKS(ctx); err != nil {
		return nil, fmt.Errorf("JWKS refresh failed: %w", err)
	}

	type accessTokenClaims struct {
		jwt.RegisteredClaims
		ClientID string   `json:"client_id"`
		Scope    string   `json:"scope"`
		Roles    []string `json:"roles"`
	}

	claims := &accessTokenClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		// Verify algorithm
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}

		// Look up key by kid
		kid, _ := t.Header["kid"].(string)
		v.mu.RLock()
		key, exists := v.publicKeys[kid]
		v.mu.RUnlock()

		if !exists {
			// Key not in cache, try refreshing once
			v.mu.Lock()
			v.lastFetched = time.Time{} // Force refresh
			v.mu.Unlock()
			if err := v.FetchJWKS(ctx); err != nil {
				return nil, fmt.Errorf("key %s not found", kid)
			}

			v.mu.RLock()
			key, exists = v.publicKeys[kid]
			v.mu.RUnlock()

			if !exists {
				return nil, fmt.Errorf("key %s not found after refresh", kid)
			}
		}

		return key, nil
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
	)

	if err != nil {
		return nil, fmt.Errorf("token validation failed: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("token is invalid")
	}

	return &ValidatedClaims{
		Subject:  claims.Subject,
		ClientID: claims.ClientID,
		Scopes:   strings.Split(claims.Scope, " "),
		Roles:    claims.Roles,
		Issuer:   claims.Issuer,
	}, nil
}

// AuthMiddleware is an HTTP middleware for JWT authentication
type AuthMiddleware struct {
	validator      *JWTValidator
	requiredScopes []string
}

// NewAuthMiddleware creates authentication middleware
func NewAuthMiddleware(validator *JWTValidator, requiredScopes ...string) *AuthMiddleware {
	return &AuthMiddleware{
		validator:      validator,
		requiredScopes: requiredScopes,
	}
}

type contextKey string

const claimsKey contextKey = "claims"

// Middleware wraps an HTTP handler with JWT authentication
func (m *AuthMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract Bearer token
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"missing_token"}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
			http.Error(w, `{"error":"invalid_token_format"}`, http.StatusUnauthorized)
			return
		}

		tokenStr := parts[1]

		// Validate token
		claims, err := m.validator.Validate(r.Context(), tokenStr)
		if err != nil {
			w.Header().Set("WWW-Authenticate",
				fmt.Sprintf(`Bearer realm="%s", error="invalid_token"`, m.validator.issuer))
			http.Error(w, `{"error":"invalid_token"}`, http.StatusUnauthorized)
			return
		}

		// Check required scopes
		for _, required := range m.requiredScopes {
			if !containsScope(claims.Scopes, required) {
				w.Header().Set("WWW-Authenticate",
					fmt.Sprintf(`Bearer realm="%s", error="insufficient_scope", scope="%s"`,
						m.validator.issuer, strings.Join(m.requiredScopes, " ")))
				http.Error(w, `{"error":"insufficient_scope"}`, http.StatusForbidden)
				return
			}
		}

		// Attach claims to context
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetClaims extracts validated claims from context
func GetClaims(ctx context.Context) *ValidatedClaims {
	claims, _ := ctx.Value(claimsKey).(*ValidatedClaims)
	return claims
}

// RequireRole creates a middleware that checks for a specific role
func RequireRole(role string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := GetClaims(r.Context())
			if claims == nil {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			if !slices.Contains(claims.Roles, role) {
				http.Error(w, `{"error":"forbidden","required_role":"`+role+`"}`,
					http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func containsScope(scopes []string, scope string) bool {
	return slices.Contains(scopes, scope)
}
```

---
