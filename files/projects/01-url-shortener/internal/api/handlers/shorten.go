// internal/api/handlers/shorten.go
package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/example/url-shortener/internal/service"
)

// ShortenRequest represents the JSON request body
type ShortenRequest struct {
	URL         string  `json:"url" binding:"required,url"`
	CustomAlias *string `json:"custom_alias,omitempty"`
	ExpiresIn   *int    `json:"expires_in,omitempty"` // seconds
}

// ShortenResponse represents the JSON response
type ShortenResponse struct {
	ShortCode string     `json:"short_code"`
	ShortURL  string     `json:"short_url"`
	LongURL   string     `json:"long_url"`
	CreatedAt time.Time  `json:"created_at"`
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
