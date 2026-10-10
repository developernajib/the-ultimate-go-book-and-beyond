package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

type contextKey string

const (
	userIDKey contextKey = "user_id"
)

// Authentication middleware
func Authentication() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "missing authorization header", http.StatusUnauthorized)
				return
			}

			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, "invalid authorization header", http.StatusUnauthorized)
				return
			}

			token := parts[1]

			userID, err := validateToken(token)
			if err != nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), userIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUserID gets the user ID from context
func GetUserID(ctx context.Context) (uuid.UUID, bool) {
	userID, ok := ctx.Value(userIDKey).(uuid.UUID)
	return userID, ok
}

func validateToken(token string) (uuid.UUID, error) {
	return uuid.Parse(token)
}
