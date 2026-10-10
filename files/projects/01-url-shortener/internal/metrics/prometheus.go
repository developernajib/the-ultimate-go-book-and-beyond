// internal/metrics/prometheus.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTP metrics
	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "goshort_http_requests_total",
			Help: "Total number of HTTP requests",
		},
		[]string{"method", "endpoint", "status"},
	)

	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "goshort_http_request_duration_seconds",
			Help:    "HTTP request latency in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "endpoint"},
	)

	// URL shortening metrics
	URLsShortenedTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "goshort_urls_shortened_total",
			Help: "Total number of URLs shortened",
		},
	)

	URLRedirectsTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "goshort_url_redirects_total",
			Help: "Total number of URL redirects",
		},
	)

	// Cache metrics
	CacheHitsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "goshort_cache_hits_total",
			Help: "Total number of cache hits",
		},
		[]string{"cache_layer"},
	)

	CacheMissesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "goshort_cache_misses_total",
			Help: "Total number of cache misses",
		},
		[]string{"cache_layer"},
	)

	// Database metrics
	DBQueriesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "goshort_db_queries_total",
			Help: "Total number of database queries",
		},
		[]string{"operation", "table"},
	)

	DBQueryDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "goshort_db_query_duration_seconds",
			Help:    "Database query latency in seconds",
			Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1},
		},
		[]string{"operation", "table"},
	)

	// Rate limiting metrics
	RateLimitExceeded = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "goshort_rate_limit_exceeded_total",
			Help: "Total number of rate limit violations",
		},
		[]string{"limiter_type"},
	)

	// Active connections
	ActiveConnections = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "goshort_active_connections",
			Help: "Number of active HTTP connections",
		},
	)
)
