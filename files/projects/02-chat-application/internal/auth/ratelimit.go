package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/example/chat-application/internal/storage"
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
