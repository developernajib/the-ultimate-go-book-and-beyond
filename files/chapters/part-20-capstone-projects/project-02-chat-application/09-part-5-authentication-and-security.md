## Part 5: Authentication and Security

Every chat application must verify who its users are and protect against common attack vectors. In this section, you will implement JWT-based authentication for both HTTP endpoints and WebSocket connections, along with middleware that extracts and validates tokens on every request. You will also add rate limiting to prevent abuse such as message flooding or brute-force login attempts. These security layers work together to ensure that only authenticated users can send messages and that no single user can overwhelm the system.

### 5.1 JWT Service (`internal/auth/jwt.go`)

The JWT service issues and validates access tokens using HMAC-SHA256 signing. It embeds the user ID and role in the token claims and enforces a configurable expiration time.

```go
package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type JWTService struct {
	secret     []byte
	expiration time.Duration
}

type Claims struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
	jwt.RegisteredClaims
}

func NewJWTService(secret string, expiration time.Duration) *JWTService {
	return &JWTService{
		secret:     []byte(secret),
		expiration: expiration,
	}
}

func (s *JWTService) GenerateToken(userID uuid.UUID, username string) (string, error) {
	claims := &Claims{
		UserID:   userID,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.expiration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

func (s *JWTService) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("parse token: %w", err)
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

func (s *JWTService) RefreshToken(tokenString string) (string, error) {
	claims, err := s.ValidateToken(tokenString)
	if err != nil {
		return "", err
	}

	// Generate new token with same claims
	return s.GenerateToken(claims.UserID, claims.Username)
}
```

### 5.2 Authentication Middleware (`internal/auth/middleware.go`)

Authentication middleware validates JWT tokens on every WebSocket upgrade request and HTTP API call, attaching the verified user identity to the request context. Stateless token validation scales without shared session storage, and token expiration limits the blast radius of leaked credentials.

```go
package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

type contextKey string

const (
	UserIDKey   contextKey = "user_id"
	UsernameKey contextKey = "username"
)

type Middleware struct {
	jwtService *JWTService
}

func NewMiddleware(jwtService *JWTService) *Middleware {
	return &Middleware{jwtService: jwtService}
}

func (m *Middleware) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Get token from Authorization header
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Missing authorization header", http.StatusUnauthorized)
			return
		}

		// Extract token (format: "Bearer <token>")
		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || parts[0] != "Bearer" {
			http.Error(w, "Invalid authorization header format", http.StatusUnauthorized)
			return
		}

		token := parts[1]

		// Validate token
		claims, err := m.jwtService.ValidateToken(token)
		if err != nil {
			http.Error(w, "Invalid token", http.StatusUnauthorized)
			return
		}

		// Add user info to context
		ctx := context.WithValue(r.Context(), UserIDKey, claims.UserID)
		ctx = context.WithValue(ctx, UsernameKey, claims.Username)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Helper functions to extract user info from context

func GetUserID(ctx context.Context) (uuid.UUID, error) {
	userID, ok := ctx.Value(UserIDKey).(uuid.UUID)
	if !ok {
		return uuid.Nil, fmt.Errorf("user ID not found in context")
	}
	return userID, nil
}

func GetUsername(ctx context.Context) (string, error) {
	username, ok := ctx.Value(UsernameKey).(string)
	if !ok {
		return "", fmt.Errorf("username not found in context")
	}
	return username, nil
}
```

### 5.3 Rate Limiting Middleware (`internal/auth/ratelimit.go`)

Rate limiting protects the service from abuse by enforcing per-client request quotas using a token bucket or sliding window algorithm. This middleware intercepts requests before they reach application handlers and returns HTTP 429 responses when a client's quota is exhausted.

```go
package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/yourusername/gochat/internal/storage"
)

type RateLimiter struct {
	redisStore *storage.RedisStore
	limit      int
	window     time.Duration
}

func NewRateLimiter(redisStore *storage.RedisStore, limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		redisStore: redisStore,
		limit:      limit,
		window:     window,
	}
}

func (rl *RateLimiter) Limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Use IP address as key (in production, use user ID if authenticated)
		ip := r.RemoteAddr
		key := fmt.Sprintf("ratelimit:%s", ip)

		allowed, err := rl.redisStore.CheckRateLimit(context.Background(), key, rl.limit, rl.window)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		if !allowed {
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// Per-user rate limiter
func (rl *RateLimiter) LimitByUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, err := GetUserID(r.Context())
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		key := fmt.Sprintf("ratelimit:user:%s", userID)

		allowed, err := rl.redisStore.CheckRateLimit(r.Context(), key, rl.limit, rl.window)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		if !allowed {
			http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}
```

### Junior → FAANG: JWT Authentication as a First-Principles Study

JWT-based authentication is standard for modern APIs. Understanding the three parts of a JWT (header, payload, signature) and being able to explain what the signature proves (that the token was issued by a party holding the signing key, and that the payload has not been tampered with) is a baseline expectation for any backend role.

For WebSocket authentication specifically, the pattern of validating the JWT at connection upgrade time (in the HTTP handler that performs the WebSocket handshake) is the correct approach. After the upgrade, the connection is trusted and no per-message authentication is needed. Be ready to explain this in interviews.

Rate limiting middleware applied to the authentication endpoint is a security requirement. Without it, an attacker can attempt unlimited password combinations. The rate limit should apply per IP address, not per account, to handle the case where an attacker rotates through many accounts from a single IP.

### Senior @ FAANG: Authentication as a Platform Service

At senior level, application-level JWT validation is often replaced by a centralized authentication platform. At FAANG, an API gateway or a service mesh sidecar handles JWT validation before requests reach application code. This means application code can assume the request is authenticated and focus on authorization (does this user have permission to access this channel?) rather than authentication.

JWT key rotation is a governance concern. HMAC-SHA256 signed JWTs use a symmetric key: the same key is used to sign and verify. Key rotation requires that the old key remains valid for the duration of the maximum token TTL (so existing sessions are not invalidated immediately), then the old key is retired. Implementing this with key versioning (embedding the key version in the JWT header) allows the validator to select the correct key without trial and error.

Token revocation is the hardest JWT problem. JWTs are stateless by design, meaning a valid token remains valid until expiration even if the user has logged out or their account has been suspended. Mitigations include short TTLs (force frequent re-authentication), a token revocation list in Redis (fast lookup against a deny list on each request), or opaque tokens (reference tokens that require a database lookup on each request, sacrificing the stateless property). The ADR for token revocation must document the chosen approach and the security/performance tradeoff.

---
