// internal/api/handlers/redirect.go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/example/url-shortener/internal/models"
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
