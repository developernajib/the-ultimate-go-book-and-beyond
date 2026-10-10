## Chapter 10: Monitoring with Prometheus

You cannot improve what you cannot measure. Monitoring gives you real-time visibility into how your URL shortener is performing in production: how many requests per second it handles, what the latency distribution looks like, whether the cache is effective, and whether the database is keeping up. In this chapter, we define custom Prometheus metrics, build middleware to record them automatically on every request, and configure Prometheus and Grafana to scrape and visualize the data.

### 10.1 Prometheus Metrics

Prometheus metrics are defined as package-level variables using the `promauto` package, which automatically registers them with the default Prometheus registry. We use three types of metrics: Counters that only go up (like total requests), Histograms that track the distribution of values (like request latency), and Gauges that can go up or down (like active connections). Each metric includes labels so you can filter and group the data in Grafana queries.

```go
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
```

### 10.2 Metrics Middleware

The metrics middleware wraps every HTTP request to automatically record timing and status code information. It increments the active connections gauge when a request starts and decrements it when the request finishes, giving you a real-time view of concurrency. After the handler completes, it records the response status code and the total duration in seconds, which Prometheus can then aggregate into percentile latency charts.

```go
// internal/api/middleware/metrics.go
package middleware

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/goshort/internal/metrics"
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
```

### 10.3 Prometheus Configuration

The Prometheus configuration file tells Prometheus which services to scrape and how often. Each `scrape_config` entry defines a job name, the target addresses, and the metrics path. Prometheus will poll these endpoints at the configured interval (15 seconds by default) and store the time-series data for querying. The alerting section points to Alertmanager, which can send notifications via email, Slack, or PagerDuty when metrics cross defined thresholds.

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'goshort'
    static_configs:
      - targets: ['api:8080']
    metrics_path: '/metrics'

  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']

  - job_name: 'node'
    static_configs:
      - targets: ['node-exporter:9100']

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - 'alerts.yml'
```

### 10.4 Grafana Dashboard JSON

Grafana dashboards are defined as JSON documents that you can import through the Grafana UI or provision automatically. The dashboard below creates four panels: a request rate graph showing traffic over time, a P95 latency graph so you can spot slowdowns, a cache hit rate graph to monitor caching effectiveness, and a stat panel showing the total number of URLs shortened. You can customize these panels or add new ones as your monitoring needs grow.

```json
{
  "dashboard": {
    "title": "GoShort Metrics",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(goshort_http_requests_total[5m])"
          }
        ],
        "type": "graph"
      },
      {
        "title": "P95 Latency",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(goshort_http_request_duration_seconds_bucket[5m]))"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Cache Hit Rate",
        "targets": [
          {
            "expr": "rate(goshort_cache_hits_total[5m]) / (rate(goshort_cache_hits_total[5m]) + rate(goshort_cache_misses_total[5m]))"
          }
        ],
        "type": "graph"
      },
      {
        "title": "URLs Shortened",
        "targets": [
          {
            "expr": "goshort_urls_shortened_total"
          }
        ],
        "type": "stat"
      }
    ]
  }
}
```

---

### Junior → FAANG: Monitoring as a Job Requirement, Not a Nice-to-Have

Every backend service at FAANG has a monitoring dashboard before it goes to production. Prometheus and Grafana are the most common open-source stack, and knowing them is a practical job prerequisite. The three metric types (Counter, Histogram, Gauge) cover almost every use case. Understand which to use and why: Counters for events that only increase (requests served, errors emitted), Histograms for latency distributions, Gauges for current state (active connections, queue depth).

For interviews, describe your metrics in terms of the four golden signals: latency (how long requests take), traffic (how many requests per second), errors (what fraction of requests fail), and saturation (how close to capacity the system is). Any service that exposes these four signals can be operated reliably.

The middleware approach (recording metrics automatically on every request) is the right pattern. Do not scatter metric recording calls throughout business logic. Keep it in the infrastructure layer.

### Senior @ FAANG: Observability as an Organizational Capability

At senior level, metrics are only one leg of the observability triad. Logs (structured, correlated by request ID) and traces (distributed, spanning service boundaries) complete the picture. A metric spike tells you something is wrong. Traces tell you which service is responsible. Logs tell you what happened on the affected request. Designing for all three from the start is more efficient than retrofitting later.

SLO-driven alerting is the standard at FAANG. Rather than alerting on raw metrics (alert if error rate > 1%), SLO alerts are based on burn rate: how fast are you consuming your error budget for the month? A 5% error rate for one minute is a different concern than a 0.1% error rate sustained for 10 hours, even though both might trigger a simple threshold alert. The burn rate model requires calculating your error budget from your SLO, then alerting when the burn rate exceeds a multiple of the sustainable rate.

Cardinality is a Prometheus cost driver that deserves an ADR. Every unique combination of label values creates a new time series. A label for `user_id` on a request counter with 10 million users creates 10 million time series. Prometheus performance degrades significantly above a few hundred thousand time series. The rule is: never use unbounded values (user IDs, request IDs, full URL paths) as label values. Use bounded, low-cardinality values (status code, method, handler name, cache tier). Enforcing this rule across all services is a platform governance responsibility.

Dashboard standardization reduces cognitive load during incidents. When every service exposes a consistent set of panels (RPS, latency p50/p95/p99, error rate, saturation), on-call engineers can navigate between service dashboards quickly during an incident. Platform teams provide dashboard templates. Application teams fill in service-specific details. The alternative, where every team designs their own dashboards from scratch, produces inconsistent and incomplete observability coverage.

---
