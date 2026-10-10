package auth

import (
	"context"
	"fmt"
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
