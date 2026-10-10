// internal/api/router.go
package api

import (
	"github.com/gin-gonic/gin"
	"github.com/example/url-shortener/internal/api/handlers"
	"github.com/example/url-shortener/internal/api/middleware"
)

// SetupRouter configures all routes
func SetupRouter(h *handlers.Handler, m *middleware.Middleware) *gin.Engine {
	router := gin.New()

	// Global middleware
	router.Use(gin.Recovery())
	router.Use(m.Logger())
	router.Use(m.CORS())
	router.Use(m.RequestID())

	// Health check (no rate limiting)
	router.GET("/health", h.Health)
	router.GET("/metrics", h.Metrics) // Prometheus metrics

	// Public redirect endpoint (rate limited by IP)
	router.GET("/:code", m.RateLimitByIP(1000, "1h"), h.Redirect)

	// API v1
	v1 := router.Group("/api/v1")
	{
		// Public endpoints (rate limited by IP)
		public := v1.Group("")
		public.Use(m.RateLimitByIP(100, "1h"))
		{
			public.POST("/shorten", h.Shorten)
		}

		// Authenticated endpoints (require API key)
		auth := v1.Group("")
		auth.Use(m.RequireAuth())
		auth.Use(m.RateLimitByUser())
		{
			// URL management
			auth.GET("/urls", h.ListUserURLs)
			auth.GET("/urls/:code", h.GetURLDetails)
			auth.DELETE("/urls/:code", h.DeleteURL)

			// Analytics
			auth.GET("/urls/:code/stats", h.GetURLStats)
			auth.GET("/urls/:code/clicks", h.GetClickDetails)

			// User management
			auth.GET("/user/profile", h.GetProfile)
			auth.PUT("/user/profile", h.UpdateProfile)
			auth.POST("/user/api-key/regenerate", h.RegenerateAPIKey)
		}

		// Admin endpoints
		admin := v1.Group("/admin")
		admin.Use(m.RequireAuth())
		admin.Use(m.RequireAdmin())
		{
			admin.GET("/stats", h.GetSystemStats)
			admin.GET("/users", h.ListUsers)
		}
	}

	return router
}
