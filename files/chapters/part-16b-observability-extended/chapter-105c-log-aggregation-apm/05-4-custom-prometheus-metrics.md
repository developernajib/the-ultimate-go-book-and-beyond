## 105C.5 Custom Prometheus Metrics

Custom Prometheus metrics make the difference between knowing a service is slow and knowing exactly which database query, cache key pattern, or user segment is causing the slowdown. The code below defines a full set of counters, gauges, and histograms using `promauto` for zero-boilerplate registration, a middleware that records per-route request durations with HTTP status labels, and business-level recorders for orders, queue depth, and connection pool state.

```go
package prometheusmetrics

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ServiceMetrics holds Prometheus metrics for a service
type ServiceMetrics struct {
	// HTTP metrics
	httpRequestsTotal   *prometheus.CounterVec
	httpRequestDuration *prometheus.HistogramVec
	httpRequestSize     *prometheus.SummaryVec
	httpResponseSize    *prometheus.SummaryVec

	// Business metrics
	ordersCreated  *prometheus.CounterVec
	orderValueCents *prometheus.HistogramVec
	queueDepth     *prometheus.GaugeVec
	processingTime *prometheus.HistogramVec

	// System metrics
	dbConnections  *prometheus.GaugeVec
	cacheHitRatio  *prometheus.GaugeVec
	goroutines     prometheus.Gauge
}

// NewServiceMetrics creates all Prometheus metrics
func NewServiceMetrics(namespace, subsystem string) *ServiceMetrics {
	return &ServiceMetrics{
		httpRequestsTotal: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: namespace,
				Subsystem: subsystem,
				Name:      "http_requests_total",
				Help:      "Total number of HTTP requests by status, method, and path",
			},
			[]string{"method", "path", "status"},
		),

		httpRequestDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: namespace,
				Subsystem: subsystem,
				Name:      "http_request_duration_seconds",
				Help:      "HTTP request duration in seconds",
				Buckets:   prometheus.DefBuckets,
			},
			[]string{"method", "path"},
		),

		httpRequestSize: promauto.NewSummaryVec(
			prometheus.SummaryOpts{
				Namespace:  namespace,
				Subsystem:  subsystem,
				Name:       "http_request_size_bytes",
				Help:       "HTTP request size in bytes",
				Objectives: map[float64]float64{0.5: 0.05, 0.9: 0.01, 0.99: 0.001},
			},
			[]string{"method", "path"},
		),

		httpResponseSize: promauto.NewSummaryVec(
			prometheus.SummaryOpts{
				Namespace:  namespace,
				Subsystem:  subsystem,
				Name:       "http_response_size_bytes",
				Help:       "HTTP response size in bytes",
				Objectives: map[float64]float64{0.5: 0.05, 0.9: 0.01, 0.99: 0.001},
			},
			[]string{"method", "path"},
		),

		ordersCreated: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: namespace,
				Subsystem: "orders",
				Name:      "created_total",
				Help:      "Total orders created by type and status",
			},
			[]string{"order_type", "payment_method"},
		),

		orderValueCents: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: namespace,
				Subsystem: "orders",
				Name:      "value_cents",
				Help:      "Order value distribution in integer cents",
				Buckets:   []float64{1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000},
			},
			[]string{"order_type"},
		),

		queueDepth: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: namespace,
				Subsystem: subsystem,
				Name:      "queue_depth",
				Help:      "Current queue depth by queue name",
			},
			[]string{"queue"},
		),

		dbConnections: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: namespace,
				Subsystem: "database",
				Name:      "connections",
				Help:      "Current database connections by state",
			},
			[]string{"state"}, // "active", "idle", "waiting"
		),

		cacheHitRatio: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: namespace,
				Subsystem: "cache",
				Name:      "hit_ratio",
				Help:      "Cache hit ratio by cache name",
			},
			[]string{"cache"},
		),

		goroutines: promauto.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "goroutines",
			Help:      "Current number of goroutines",
		}),
	}
}

// HTTPMiddleware records HTTP metrics
func (m *ServiceMetrics) HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		path := r.URL.Path

		// Normalize path to avoid high cardinality
		// In production: use path parameter matching
		normalizedPath := normalizePath(path)

		// Record request size
		m.httpRequestSize.WithLabelValues(r.Method, normalizedPath).
			Observe(float64(r.ContentLength))

		wrapped := &metricsResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(wrapped, r)

		duration := time.Since(start).Seconds()
		statusStr := strconv.Itoa(wrapped.statusCode)

		m.httpRequestsTotal.WithLabelValues(r.Method, normalizedPath, statusStr).Inc()
		m.httpRequestDuration.WithLabelValues(r.Method, normalizedPath).Observe(duration)
		m.httpResponseSize.WithLabelValues(r.Method, normalizedPath).
			Observe(float64(wrapped.bytesWritten))
	})
}

// RecordOrderCreated records order creation metrics with amount in integer cents
func (m *ServiceMetrics) RecordOrderCreated(orderType, paymentMethod string, amountCents int64) {
	m.ordersCreated.WithLabelValues(orderType, paymentMethod).Inc()
	m.orderValueCents.WithLabelValues(orderType).Observe(float64(amountCents))
}

// SetQueueDepth updates queue depth gauge
func (m *ServiceMetrics) SetQueueDepth(queue string, depth float64) {
	m.queueDepth.WithLabelValues(queue).Set(depth)
}

// UpdateDBConnections updates database connection gauges
func (m *ServiceMetrics) UpdateDBConnections(active, idle, waiting int) {
	m.dbConnections.WithLabelValues("active").Set(float64(active))
	m.dbConnections.WithLabelValues("idle").Set(float64(idle))
	m.dbConnections.WithLabelValues("waiting").Set(float64(waiting))
}

// MetricsHandler returns the Prometheus metrics HTTP handler
func (m *ServiceMetrics) MetricsHandler() http.Handler {
	return promhttp.Handler()
}

func normalizePath(path string) string {
	// Replace UUIDs and numeric IDs with placeholders
	// Simple implementation. Use gorilla/mux or chi for proper route matching
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if isID(part) {
			parts[i] = ":id"
		}
	}
	return strings.Join(parts, "/")
}

func isID(s string) bool {
	if len(s) == 0 {
		return false
	}
	// Check if looks like UUID or numeric ID
	_, err := strconv.ParseInt(s, 10, 64)
	if err == nil {
		return true
	}
	return len(s) == 36 && strings.Count(s, "-") == 4
}

type metricsResponseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int64
}

func (w *metricsResponseWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *metricsResponseWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.bytesWritten += int64(n)
	return n, err
}
```

### Junior → FAANG: Custom Metrics vs. Auto-Instrumented Metrics

Auto-instrumented metrics (from otelhttp, otelgrpc, database/sql wrappers) cover the infrastructure layer: request count, latency, error rate. Custom metrics cover the business layer: orders created, payments processed, items in cart, conversion rate. Both are necessary for complete observability.

The business metrics are often the most valuable during product incidents: "the error rate is 0% but revenue is down 30%" is a signal that only business metrics can provide. For a first job, partner with your product manager to identify the five most important business events to instrument, and add them as Prometheus counters or histograms.

### Senior @ FAANG: Business Metrics as SLI Candidates

At L6, business metrics are not just supplementary dashboards: they are primary SLI candidates. A payment service's availability SLI measured by HTTP 200 response rate may show 99.9% while the actual payment success rate (measured by successful transaction events) is 98% due to application-level failures that return 200 with an error body. The business metric is the accurate SLI.

An L6 engineer reviews SLI definitions with product and data teams to ensure the metrics that feed SLOs measure actual user outcomes, not infrastructure health. This review often reveals that the "infrastructure SLI" and the "business SLI" diverge during specific failure modes, which is itself a valuable finding that informs both the SLO design and the alert configuration.

---
