// internal/observability/metrics.go
package observability

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics holds all gateway metrics
type Metrics struct {
    RequestsTotal   *prometheus.CounterVec
    RequestDuration *prometheus.HistogramVec
    RequestSize     *prometheus.HistogramVec
    ResponseSize    *prometheus.HistogramVec
    UpstreamHealthy *prometheus.GaugeVec
}

// NewMetrics creates gateway metrics
func NewMetrics(namespace string) *Metrics {
    return &Metrics{
        RequestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "requests_total",
                Help:      "Total number of requests",
            },
            []string{"route", "method", "status"},
        ),
        RequestDuration: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "request_duration_seconds",
                Help:      "Request duration in seconds",
                Buckets:   prometheus.DefBuckets,
            },
            []string{"route", "method"},
        ),
        RequestSize: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "request_size_bytes",
                Help:      "Request size in bytes",
                Buckets:   prometheus.ExponentialBuckets(100, 10, 8),
            },
            []string{"route"},
        ),
        ResponseSize: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "response_size_bytes",
                Help:      "Response size in bytes",
                Buckets:   prometheus.ExponentialBuckets(100, 10, 8),
            },
            []string{"route"},
        ),
        UpstreamHealthy: promauto.NewGaugeVec(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "upstream_healthy",
                Help:      "Upstream health status (1=healthy, 0=unhealthy)",
            },
            []string{"upstream", "target"},
        ),
    }
}
