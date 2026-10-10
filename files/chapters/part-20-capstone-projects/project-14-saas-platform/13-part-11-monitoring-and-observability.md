## Part 11: Monitoring and Observability

You cannot manage what you cannot measure. Monitoring and observability give you real-time insight into the health, performance, and behavior of your SaaS platform. This section implements three pillars of observability: metrics (using Prometheus to track request rates, error rates, and latency), distributed tracing (using Jaeger to follow a request across multiple services), and structured logging. In a multi-tenant platform, all of these must be tagged with the tenant ID so you can diagnose issues for a specific customer without sifting through logs from every tenant.

```go
// pkg/metrics/prometheus.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
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
```

### Distributed Tracing

When a single user request passes through the API gateway, then the auth service, then the tenant service, and finally the database, you need a way to see the entire journey as one connected trace. Distributed tracing assigns a unique trace ID to each incoming request and propagates it across service boundaries using OpenTelemetry. Each service records spans (timed operations) that show exactly where time was spent. The code below initializes the Jaeger tracing exporter and provides helper functions for creating and propagating spans throughout your microservices.

```go
// pkg/tracing/jaeger.go
package tracing

import (
    "context"
    "io"

    "github.com/opentracing/opentracing-go"
    "github.com/uber/jaeger-client-go"
    "github.com/uber/jaeger-client-go/config"
)

// InitTracer initializes Jaeger tracer
func InitTracer(serviceName string) (opentracing.Tracer, io.Closer, error) {
    cfg := &config.Configuration{
        ServiceName: serviceName,
        Sampler: &config.SamplerConfig{
            Type:  "const",
            Param: 1,
        },
        Reporter: &config.ReporterConfig{
            LogSpans:           true,
            LocalAgentHostPort: "jaeger:6831",
        },
    }

    tracer, closer, err := cfg.NewTracer(
        config.Logger(jaeger.StdLogger),
    )
    if err != nil {
        return nil, nil, err
    }

    opentracing.SetGlobalTracer(tracer)

    return tracer, closer, nil
}

// TracingMiddleware adds distributed tracing to HTTP requests
type TracingMiddleware struct {
    tracer opentracing.Tracer
}

func NewTracingMiddleware(tracer opentracing.Tracer) *TracingMiddleware {
    return &TracingMiddleware{tracer: tracer}
}

func (m *TracingMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        spanCtx, _ := m.tracer.Extract(
            opentracing.HTTPHeaders,
            opentracing.HTTPHeadersCarrier(r.Header),
        )

        span := m.tracer.StartSpan(
            r.URL.Path,
            opentracing.ChildOf(spanCtx),
            opentracing.Tag{Key: "http.method", Value: r.Method},
            opentracing.Tag{Key: "http.url", Value: r.URL.String()},
        )
        defer span.Finish()

        // Add tenant ID to span
        if tenant, err := isolation.GetTenant(r.Context()); err == nil {
            span.SetTag("tenant_id", tenant.TenantID.String())
        }

        ctx := opentracing.ContextWithSpan(r.Context(), span)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// StartSpan starts a new span from context
func StartSpan(ctx context.Context, operationName string) (opentracing.Span, context.Context) {
    span, ctx := opentracing.StartSpanFromContext(ctx, operationName)
    return span, ctx
}
```
