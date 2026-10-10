## Chapter 4: REST API Design

The REST API is the public interface that clients use to create short URLs, perform redirects, and retrieve analytics. Good API design means using consistent naming conventions, proper HTTP status codes, versioned endpoints, and clear error messages. In this chapter, we define all routes using the Gin web framework, implement the core handlers for shortening and redirecting, and build an analytics endpoint that returns click statistics.

### 4.1 API Routes

The router file is where you map HTTP methods and URL paths to handler functions. Notice how routes are organized into groups: public endpoints that anyone can access, authenticated endpoints that require an API key, and admin endpoints with elevated privileges. Each group applies different middleware for rate limiting and authorization, so you can control access at a granular level.

```go
// internal/api/router.go
package api

import (
	"github.com/gin-gonic/gin"
	"github.com/yourusername/goshort/internal/api/handlers"
	"github.com/yourusername/goshort/internal/api/middleware"
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
```

### 4.2 Shorten Handler

The shorten handler is the most important endpoint in the API. It receives a JSON request containing the long URL, validates the input using Gin's binding tags, and delegates the actual shortening logic to the service layer. If the user provides a custom alias or an expiration time, those values are passed along as well. The handler is intentionally thin -- it only handles HTTP concerns like parsing the request body and writing the JSON response.

```go
// internal/api/handlers/shorten.go
package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/goshort/internal/service"
)

// ShortenRequest represents the JSON request body
type ShortenRequest struct {
	URL         string  `json:"url" binding:"required,url"`
	CustomAlias *string `json:"custom_alias,omitempty"`
	ExpiresIn   *int    `json:"expires_in,omitempty"` // seconds
}

// ShortenResponse represents the JSON response
type ShortenResponse struct {
	ShortCode string    `json:"short_code"`
	ShortURL  string    `json:"short_url"`
	LongURL   string    `json:"long_url"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// Shorten creates a short URL
func (h *Handler) Shorten(c *gin.Context) {
	var req ShortenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		h.respondError(c, http.StatusBadRequest, "Invalid request body", err)
		return
	}

	// Get user ID from context (if authenticated)
	userID := h.getUserID(c)

	// Calculate expiration
	var expiresAt *time.Time
	if req.ExpiresIn != nil {
		expiry := time.Now().Add(time.Duration(*req.ExpiresIn) * time.Second)
		expiresAt = &expiry
	}

	// Build service request
	serviceReq := &service.ShortenRequest{
		LongURL:   req.URL,
		ExpiresAt: expiresAt,
		UserID:    userID,
	}

	if req.CustomAlias != nil {
		serviceReq.CustomAlias = *req.CustomAlias
	}

	// Call service
	result, err := h.shortener.Shorten(c.Request.Context(), serviceReq)
	if err != nil {
		h.handleServiceError(c, err)
		return
	}

	// Build response
	response := &ShortenResponse{
		ShortCode: result.ShortCode,
		ShortURL:  result.ShortURL,
		LongURL:   result.LongURL,
		CreatedAt: result.CreatedAt,
		ExpiresAt: result.ExpiresAt,
	}

	c.JSON(http.StatusCreated, response)
}
```

### 4.3 Redirect Handler

The redirect handler is the most performance-critical path in the entire application because it runs on every single click. It extracts the short code from the URL path, builds a click event with the visitor's IP address and user agent, and then calls the service to record the click and retrieve the original URL. The handler responds with an HTTP 301 (Moved Permanently) redirect, which tells browsers to cache the redirect and go directly to the target URL on future visits.

```go
// internal/api/handlers/redirect.go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/goshort/internal/models"
)

// Redirect handles the short URL redirection
func (h *Handler) Redirect(c *gin.Context) {
	code := c.Param("code")
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Short code is required"})
		return
	}

	// Build click event
	event := &models.ClickEvent{
		IPAddress: c.ClientIP(),
		UserAgent: c.GetHeader("User-Agent"),
		Referer:   c.GetHeader("Referer"),
	}

	// Get URL and record click
	url, err := h.shortener.RecordClick(c.Request.Context(), code, event)
	if err != nil {
		h.handleServiceError(c, err)
		return
	}

	// Perform redirect
	c.Redirect(http.StatusMovedPermanently, url.LongURL)
}
```

### 4.4 Analytics Handler

The analytics handler lets authenticated users view detailed statistics about their shortened URLs. It verifies that the requesting user actually owns the URL before returning data, which prevents one user from viewing another user's click statistics. The response includes total clicks, clicks grouped by day, top countries, top referrers, and a breakdown by device type, giving users a complete picture of how their links are performing.

```go
// internal/api/handlers/analytics.go
package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// URLStatsResponse represents URL statistics
type URLStatsResponse struct {
	ShortCode    string            `json:"short_code"`
	LongURL      string            `json:"long_url"`
	TotalClicks  int64             `json:"total_clicks"`
	ClicksByDay  map[string]int64  `json:"clicks_by_day"`
	TopCountries []CountryStat     `json:"top_countries"`
	TopReferrers []ReferrerStat    `json:"top_referrers"`
	DeviceBreakdown DeviceBreakdown `json:"device_breakdown"`
}

type CountryStat struct {
	Country string `json:"country"`
	Clicks  int64  `json:"clicks"`
}

type ReferrerStat struct {
	Referer string `json:"referer"`
	Clicks  int64  `json:"clicks"`
}

type DeviceBreakdown struct {
	Desktop int64 `json:"desktop"`
	Mobile  int64 `json:"mobile"`
	Tablet  int64 `json:"tablet"`
	Bot     int64 `json:"bot"`
}

// GetURLStats retrieves statistics for a URL
func (h *Handler) GetURLStats(c *gin.Context) {
	code := c.Param("code")
	userID := h.getUserID(c)

	// Verify ownership
	url, err := h.shortener.GetURL(c.Request.Context(), code)
	if err != nil {
		h.handleServiceError(c, err)
		return
	}

	if url.UserID == nil || (userID != nil && *url.UserID != *userID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	// Get time range from query params (default: last 30 days)
	days := 30
	if d := c.Query("days"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil {
			days = parsed
		}
	}

	// Fetch analytics
	stats, err := h.analytics.GetStats(c.Request.Context(), code, days)
	if err != nil {
		h.respondError(c, http.StatusInternalServerError, "Failed to fetch analytics", err)
		return
	}

	response := &URLStatsResponse{
		ShortCode:       code,
		LongURL:         url.LongURL,
		TotalClicks:     url.Clicks,
		ClicksByDay:     stats.ClicksByDay,
		TopCountries:    h.mapCountryStats(stats.TopCountries),
		TopReferrers:    h.mapReferrerStats(stats.TopReferrers),
		DeviceBreakdown: h.mapDeviceBreakdown(stats.DeviceBreakdown),
	}

	c.JSON(http.StatusOK, response)
}

// Helper functions for mapping stats...
func (h *Handler) mapCountryStats(countries map[string]int64) []CountryStat {
	result := make([]CountryStat, 0, len(countries))
	for country, clicks := range countries {
		result = append(result, CountryStat{Country: country, Clicks: clicks})
	}
	return result
}

func (h *Handler) mapReferrerStats(referrers map[string]int64) []ReferrerStat {
	result := make([]ReferrerStat, 0, len(referrers))
	for referer, clicks := range referrers {
		result = append(result, ReferrerStat{Referer: referer, Clicks: clicks})
	}
	return result
}

func (h *Handler) mapDeviceBreakdown(breakdown map[string]int64) DeviceBreakdown {
	return DeviceBreakdown{
		Desktop: breakdown["desktop"],
		Mobile:  breakdown["mobile"],
		Tablet:  breakdown["tablet"],
		Bot:     breakdown["bot"],
	}
}
```

---

### Junior → FAANG: REST API Design as a First-Principles Exercise

A well-structured router file tells a reviewer everything about how you think about access control and API organization. Grouping routes by authentication requirement (public, authenticated, admin) and applying middleware at the group level is a pattern that scales to large APIs without becoming a maintenance burden.

For interviews, be ready to explain every HTTP status code you use and why. 301 (permanent redirect) versus 302 (temporary redirect) is a common probe: 301 tells browsers and crawlers to cache the redirect permanently, which reduces load but makes it impossible to change the destination later without clearing browser caches. 302 is safer for a URL shortener that allows updating destinations. That single distinction demonstrates you understand HTTP semantics, not just syntax.

API versioning is a topic interviewers frequently raise. Even if your implementation uses `/api/v1` prefixes, be able to explain what you would do when a breaking change is required: run old and new versions concurrently, migrate clients over a defined period, then deprecate the old version. That process is standard at FAANG.

### Senior @ FAANG: API Design as an Organizational Contract

At senior level, an API is a promise to external or internal clients. Every endpoint you expose becomes a compatibility obligation. Every response field you add can be depended upon by consumers who will resist removal. Every error code you define will eventually be checked against in client code that you do not control.

Versioning strategy deserves an ADR. URL-based versioning (`/v1/`, `/v2/`) is simple and explicit but duplicates routing code across versions. Header-based versioning (`Accept: application/vnd.goshort.v2+json`) is cleaner architecturally but harder for clients to implement and debug. The choice depends on your client population: public APIs favor URL versioning for debuggability, internal APIs can afford header versioning for cleaner routing.

Error response design is underspecified in most implementations. At FAANG scale, error responses must include a machine-readable error code (not just HTTP status), a human-readable message, a request ID for log correlation, and optionally a documentation link. This structure allows clients to handle errors programmatically and allows on-call engineers to trace a client-reported error to a specific log entry. Standardizing this structure across all services is a platform engineering concern, not a per-service decision.

Middleware ordering is an operational correctness issue. Rate limiting middleware that runs before authentication means unauthenticated requests consume rate limit budget. Authentication middleware that runs before logging means unauthenticated requests may not appear in access logs. The correct order for most services is: request ID injection, structured logging, authentication, authorization, rate limiting, request validation, handler. Documenting this order and enforcing it across services is a platform governance concern at the L6/L7 level.

---
