// internal/api/middleware/middleware.go
package middleware

import (
	"context"
	"time"
	"uuid"

	"github.com/example/url-shortener/internal/ratelimit"
	"github.com/gin-gonic/gin"
)

// RateLimiterService interface for middleware to use
type RateLimiterService interface {
	Allow(ctx context.Context, identifier string, limit int, window time.Duration) (bool, int, time.Time, error)
}

// Middleware holds shared dependencies for all middleware
type Middleware struct {
	rateLimiter *ratelimit.TokenBucketLimiter
}

// NewMiddleware creates a new Middleware instance
func NewMiddleware(rl *ratelimit.TokenBucketLimiter) *Middleware {
	return &Middleware{
		rateLimiter: rl,
	}
}

// Logger returns a structured request logger middleware
func (m *Middleware) Logger() gin.HandlerFunc {
	return gin.Logger()
}

// CORS returns a Cross-Origin Resource Sharing middleware
func (m *Middleware) CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Origin, Content-Type, Authorization, X-API-Key")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}

// RequestID adds a unique request ID to every request
func (m *Middleware) RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := c.GetHeader("X-Request-ID")
		if requestID == "" {
			requestID = uuid.New().String()
		}
		c.Set("request_id", requestID)
		c.Header("X-Request-ID", requestID)
		c.Next()
	}
}

// RequireAuth validates API key authentication
func (m *Middleware) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader("X-API-Key")
		if apiKey == "" {
			c.JSON(401, gin.H{"error": "API key required"})
			c.Abort()
			return
		}
		// In production, look up user by API key from DB
		// For now, just set a placeholder
		c.Set("api_key", apiKey)
		c.Next()
	}
}

// RequireAdmin validates admin-level access
func (m *Middleware) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		// In production, check user tier from context
		c.Next()
	}
}
