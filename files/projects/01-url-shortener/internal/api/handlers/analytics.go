// internal/api/handlers/analytics.go
package handlers

import (
	"context"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// URLStatsResponse represents URL statistics
type URLStatsResponse struct {
	ShortCode       string          `json:"short_code"`
	LongURL         string          `json:"long_url"`
	TotalClicks     int64           `json:"total_clicks"`
	ClicksByDay     map[string]int64 `json:"clicks_by_day"`
	TopCountries    []CountryStat   `json:"top_countries"`
	TopReferrers    []ReferrerStat  `json:"top_referrers"`
	DeviceBreakdown DeviceBreakdown `json:"device_breakdown"`
}

// CountryStat holds per-country click stats
type CountryStat struct {
	Country string `json:"country"`
	Clicks  int64  `json:"clicks"`
}

// ReferrerStat holds per-referrer click stats
type ReferrerStat struct {
	Referer string `json:"referer"`
	Clicks  int64  `json:"clicks"`
}

// DeviceBreakdown holds device type breakdown
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
	if h.analytics == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Analytics not available"})
		return
	}

	stats, err := h.analytics.GetStats(context.Background(), code, days)
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

// Helper functions for mapping stats
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
