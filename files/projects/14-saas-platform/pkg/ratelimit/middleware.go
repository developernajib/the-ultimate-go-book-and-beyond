// pkg/ratelimit/middleware.go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/example/saas-platform/internal/isolation"
    "github.com/example/saas-platform/pkg/cache"
    "github.com/example/saas-platform/pkg/logger"
)

// Middleware implements rate limiting
type Middleware struct {
    cache  cache.Cache
    logger logger.Logger
}

func NewMiddleware(cache cache.Cache, logger logger.Logger) *Middleware {
    return &Middleware{
        cache:  cache,
        logger: logger,
    }
}

func (m *Middleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tenantID, err := isolation.TenantID(r.Context())
        if err != nil {
            // No tenant context, skip rate limiting
            next.ServeHTTP(w, r)
            return
        }

        // Rate limit per tenant
        key := fmt.Sprintf("ratelimit:%s", tenantID)

        // Check rate limit (100 requests per minute)
        allowed, err := m.checkRateLimit(r.Context(), key, 100, time.Minute)
        if err != nil {
            m.logger.Error("rate limit check failed", "error", err)
            next.ServeHTTP(w, r)
            return
        }

        if !allowed {
            w.Header().Set("X-RateLimit-Limit", "100")
            w.Header().Set("X-RateLimit-Remaining", "0")
            w.Header().Set("Retry-After", "60")
            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func (m *Middleware) checkRateLimit(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
    // Sliding window rate limiting using Redis
    now := time.Now().Unix()
    windowStart := now - int64(window.Seconds())

    // Remove old entries
    m.cache.ZRemRangeByScore(ctx, key, 0, float64(windowStart))

    // Count requests in window
    count, err := m.cache.ZCount(ctx, key, float64(windowStart), float64(now))
    if err != nil {
        return true, err // Fail open
    }

    if count >= int64(limit) {
        return false, nil
    }

    // Add current request
    m.cache.ZAdd(ctx, key, float64(now), fmt.Sprintf("%d", now))
    m.cache.Expire(ctx, key, window)

    return true, nil
}
