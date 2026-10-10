// pkg/metrics/prometheus.go
package metrics

import (
    "fmt"
    "net/http"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/example/saas-platform/internal/isolation"
)

var (
    // HTTP metrics
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status", "tenant_id"},
    )

    HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path", "tenant_id"},
    )

    // Tenant metrics
    TenantProvisioningDuration = promauto.NewHistogram(
        prometheus.HistogramOpts{
            Name:    "tenant_provisioning_duration_seconds",
            Help:    "Time taken to provision a tenant",
            Buckets: []float64{1, 5, 10, 30, 60, 120},
        },
    )

    ActiveTenantsGauge = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "active_tenants_total",
            Help: "Total number of active tenants",
        },
    )

    // Billing metrics
    SubscriptionsTotal = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "subscriptions_total",
            Help: "Total number of subscriptions",
        },
        []string{"status", "plan"},
    )

    MRRGauge = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "mrr_cents",
            Help: "Monthly recurring revenue in cents",
        },
    )

    // Database metrics
    DatabaseQueriesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "database_queries_total",
            Help: "Total number of database queries",
        },
        []string{"operation", "table"},
    )

    DatabaseQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "database_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1},
        },
        []string{"operation", "table"},
    )

    // Usage metrics
    APICallsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "api_calls_total",
            Help: "Total number of API calls",
        },
        []string{"tenant_id", "endpoint"},
    )

    QuotaExceededTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "quota_exceeded_total",
            Help: "Total number of quota exceeded errors",
        },
        []string{"tenant_id", "resource"},
    )
)

// MetricsMiddleware records HTTP metrics
type MetricsMiddleware struct{}

func (m *MetricsMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Wrap response writer to capture status code
        wrapped := &statusWriter{ResponseWriter: w, status: http.StatusOK}

        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()

        tenantID := "unknown"
        if tenant, err := isolation.GetTenant(r.Context()); err == nil {
            tenantID = tenant.TenantID.String()
        }

        HTTPRequestsTotal.WithLabelValues(
            r.Method,
            r.URL.Path,
            fmt.Sprintf("%d", wrapped.status),
            tenantID,
        ).Inc()

        HTTPRequestDuration.WithLabelValues(
            r.Method,
            r.URL.Path,
            tenantID,
        ).Observe(duration)
    })
}

type statusWriter struct {
    http.ResponseWriter
    status int
}

func (w *statusWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}
