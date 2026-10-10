// internal/api/middleware/ratelimit.go
package middleware

import (
	"fmt"
	"net/http"
	"time"

	"github.com/example/url-shortener/internal/models"
	"github.com/gin-gonic/gin"
)

// RateLimitByIP limits requests by IP address
func (m *Middleware) RateLimitByIP(limit int, window string) gin.HandlerFunc {
	duration, _ := time.ParseDuration(window)

	return func(c *gin.Context) {
		ip := c.ClientIP()
		identifier := fmt.Sprintf("ip:%s", ip)

		allowed, remaining, resetTime, err := m.rateLimiter.Allow(
			c.Request.Context(),
			identifier,
			limit,
			duration,
		)

		// Set rate limit headers
		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))
		c.Header("X-RateLimit-Reset", resetTime.Format(time.RFC3339))

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Rate limit check failed"})
			c.Abort()
			return
		}

		if !allowed {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "Rate limit exceeded",
				"retry_after": resetTime.Unix() - time.Now().Unix(),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

// RateLimitByUser limits requests by authenticated user
func (m *Middleware) RateLimitByUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		user, exists := c.Get("user")
		if !exists {
			c.Next()
			return
		}

		userModel := user.(*models.User)
		identifier := fmt.Sprintf("user:%d", userModel.ID)

		// Use user-specific limits based on tier
		limit := userModel.RateLimitPerHour
		window := 1 * time.Hour

		allowed, remaining, resetTime, err := m.rateLimiter.Allow(
			c.Request.Context(),
			identifier,
			limit,
			window,
		)

		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))
		c.Header("X-RateLimit-Reset", resetTime.Format(time.RFC3339))

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Rate limit check failed"})
			c.Abort()
			return
		}

		if !allowed {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "Rate limit exceeded",
				"retry_after": resetTime.Unix() - time.Now().Unix(),
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
