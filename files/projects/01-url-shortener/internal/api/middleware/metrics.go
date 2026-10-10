// internal/api/middleware/metrics.go
package middleware

import (
	"strconv"
	"time"

	"github.com/example/url-shortener/internal/metrics"
	"github.com/gin-gonic/gin"
)

// PrometheusMetrics records HTTP metrics
func PrometheusMetrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()

		// Increment active connections
		metrics.ActiveConnections.Inc()
		defer metrics.ActiveConnections.Dec()

		// Process request
		c.Next()

		// Record metrics
		duration := time.Since(start).Seconds()
		status := strconv.Itoa(c.Writer.Status())

		metrics.HTTPRequestsTotal.WithLabelValues(
			c.Request.Method,
			c.FullPath(),
			status,
		).Inc()

		metrics.HTTPRequestDuration.WithLabelValues(
			c.Request.Method,
			c.FullPath(),
		).Observe(duration)
	}
}
