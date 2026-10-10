// internal/api/handlers/handler.go
package handlers

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/example/url-shortener/internal/service"
)

// AnalyticsGetterService defines analytics query operations for handlers
type AnalyticsGetterService interface {
	GetStats(ctx context.Context, code string, days int) (*service.AnalyticsStats, error)
}

// Handler holds all HTTP handler dependencies
type Handler struct {
	shortener *service.ShortenerService
	analytics AnalyticsGetterService
}

// NewHandler creates a new Handler
func NewHandler(shortener *service.ShortenerService, analytics AnalyticsGetterService) *Handler {
	return &Handler{
		shortener: shortener,
		analytics: analytics,
	}
}

// Health returns the health status
func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"service": "url-shortener",
	})
}

// Metrics exposes Prometheus metrics
func (h *Handler) Metrics(c *gin.Context) {
	promhttp.Handler().ServeHTTP(c.Writer, c.Request)
}

// getUserID extracts the user ID from context (if authenticated)
func (h *Handler) getUserID(c *gin.Context) *int64 {
	user, exists := c.Get("user_id")
	if !exists {
		return nil
	}
	if id, ok := user.(int64); ok {
		return &id
	}
	return nil
}

// respondError sends a consistent error response
func (h *Handler) respondError(c *gin.Context, status int, message string, err error) {
	response := gin.H{"error": message}
	if err != nil {
		response["details"] = err.Error()
	}
	c.JSON(status, response)
}

// handleServiceError maps service errors to HTTP status codes
func (h *Handler) handleServiceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrURLNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "URL not found"})
	case errors.Is(err, service.ErrExpiredURL):
		c.JSON(http.StatusGone, gin.H{"error": "URL has expired"})
	case errors.Is(err, service.ErrInvalidURL):
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid URL"})
	case errors.Is(err, service.ErrURLTooLong):
		c.JSON(http.StatusBadRequest, gin.H{"error": "URL too long"})
	case errors.Is(err, service.ErrRateLimitExceeded):
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Rate limit exceeded"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal server error"})
	}
}

// Placeholder handlers for routes defined in router but not fully implemented in book
func (h *Handler) ListUserURLs(c *gin.Context)    { c.JSON(http.StatusOK, gin.H{"urls": []any{}}) }
func (h *Handler) GetURLDetails(c *gin.Context)   { c.JSON(http.StatusOK, gin.H{}) }
func (h *Handler) DeleteURL(c *gin.Context)       { c.JSON(http.StatusNoContent, nil) }
func (h *Handler) GetClickDetails(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"clicks": []any{}}) }
func (h *Handler) GetProfile(c *gin.Context)      { c.JSON(http.StatusOK, gin.H{}) }
func (h *Handler) UpdateProfile(c *gin.Context)   { c.JSON(http.StatusOK, gin.H{}) }
func (h *Handler) RegenerateAPIKey(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"api_key": "new-key"})
}
func (h *Handler) GetSystemStats(c *gin.Context) { c.JSON(http.StatusOK, gin.H{}) }
func (h *Handler) ListUsers(c *gin.Context)      { c.JSON(http.StatusOK, gin.H{"users": []any{}}) }
