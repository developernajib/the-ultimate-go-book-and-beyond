## 103.4 Metrics with OpenTelemetry

### Setting Up Metrics

Metrics provide quantitative insight into system behavior, enabling SREs to detect anomalies and trigger alerts before user impact. The following example configures an OTel `MeterProvider` with two readers: a periodic OTLP exporter that pushes to the Collector, and an optional Prometheus exporter that serves a scrape endpoint, so the same instruments feed both pipelines.

```go
package telemetry

import (
    "context"
    "errors"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/metric"
    sdkmetric "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/sdk/resource"
    semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
)

type MetricsConfig struct {
    ServiceName  string
    Environment  string
    OTLPEndpoint string
    EnablePrometheus bool
}

func InitMetrics(ctx context.Context, cfg MetricsConfig) (func(context.Context) error, error) {
    // Create resource
    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(cfg.ServiceName),
        ),
    )
    // Tolerate schema URL conflicts between resource.Default and our semconv pin
    if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
        return nil, err
    }

    var readers []sdkmetric.Reader

    // OTLP exporter
    if cfg.OTLPEndpoint != "" {
        exporter, err := otlpmetrichttp.New(ctx,
            otlpmetrichttp.WithEndpoint(cfg.OTLPEndpoint),
            otlpmetrichttp.WithInsecure(),
        )
        if err != nil {
            return nil, err
        }

        readers = append(readers, sdkmetric.NewPeriodicReader(exporter,
            sdkmetric.WithInterval(30*time.Second),
        ))
    }

    // Prometheus exporter
    if cfg.EnablePrometheus {
        promExporter, err := prometheus.New()
        if err != nil {
            return nil, err
        }
        readers = append(readers, promExporter)
    }

    // Create meter provider
    opts := []sdkmetric.Option{sdkmetric.WithResource(res)}
    for _, reader := range readers {
        opts = append(opts, sdkmetric.WithReader(reader))
    }

    mp := sdkmetric.NewMeterProvider(opts...)
    otel.SetMeterProvider(mp)

    return mp.Shutdown, nil
}

// GetMeter returns a named meter
func GetMeter(name string) metric.Meter {
    return otel.Meter(name)
}
```

### Using Metrics

With the meter provider configured, you create individual instruments (counters, histograms, gauges) from a named `Meter` and record observations in your request handling code. The example below defines an HTTP request counter, a latency histogram, and an active-request gauge, then records values inside middleware.

```go
package service

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

var (
    meter = otel.Meter("myapp/service")

    // Counters
    requestsTotal metric.Int64Counter
    errorsTotal   metric.Int64Counter

    // Histograms
    requestDuration metric.Float64Histogram
    requestSize     metric.Int64Histogram

    // UpDownCounter for in-flight requests
    activeRequests metric.Int64UpDownCounter
)

func init() {
    var err error

    requestsTotal, err = meter.Int64Counter("http_requests_total",
        metric.WithDescription("Total number of HTTP requests"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        panic(err)
    }

    errorsTotal, err = meter.Int64Counter("http_errors_total",
        metric.WithDescription("Total number of HTTP errors"),
        metric.WithUnit("{error}"),
    )
    if err != nil {
        panic(err)
    }

    requestDuration, err = meter.Float64Histogram("http_request_duration_seconds",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
    )
    if err != nil {
        panic(err)
    }

    activeRequests, err = meter.Int64UpDownCounter("http_active_requests",
        metric.WithDescription("Number of active HTTP requests"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        panic(err)
    }
}

// MetricsMiddleware records HTTP metrics
func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        ctx := r.Context()

        attrs := []attribute.KeyValue{
            attribute.String("method", r.Method),
            attribute.String("path", r.URL.Path),
        }

        // Track active requests
        activeRequests.Add(ctx, 1, metric.WithAttributes(attrs...))
        defer activeRequests.Add(ctx, -1, metric.WithAttributes(attrs...))

        // Wrap response writer to capture status
        rw := &responseWriter{ResponseWriter: w, statusCode: 200}

        next.ServeHTTP(rw, r)

        // Record metrics
        duration := time.Since(start).Seconds()
        statusAttrs := append(attrs, attribute.Int("status", rw.statusCode))

        requestsTotal.Add(ctx, 1, metric.WithAttributes(statusAttrs...))
        requestDuration.Record(ctx, duration, metric.WithAttributes(statusAttrs...))

        if rw.statusCode >= 400 {
            errorsTotal.Add(ctx, 1, metric.WithAttributes(statusAttrs...))
        }
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

// Business metrics example
type Order struct {
    PaymentMethod string
    Region        string
    TotalCents    int64
}

type OrderService struct {
    ordersCreated  metric.Int64Counter
    orderValue     metric.Int64Histogram
    processingTime metric.Float64Histogram
}

func NewOrderService() *OrderService {
    ordersCreated, _ := meter.Int64Counter("orders_created_total")
    orderValue, _ := meter.Int64Histogram("order_value_cents",
        metric.WithExplicitBucketBoundaries(1000, 5000, 10000, 25000, 50000, 100000, 500000),
    )
    processingTime, _ := meter.Float64Histogram("order_processing_seconds")

    return &OrderService{
        ordersCreated:  ordersCreated,
        orderValue:     orderValue,
        processingTime: processingTime,
    }
}

func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
    start := time.Now()

    // Process order...

    // Record metrics
    attrs := metric.WithAttributes(
        attribute.String("payment_method", order.PaymentMethod),
        attribute.String("region", order.Region),
    )

    s.ordersCreated.Add(ctx, 1, attrs)
    s.orderValue.Record(ctx, order.TotalCents, attrs)
    s.processingTime.Record(ctx, time.Since(start).Seconds(), attrs)

    return nil
}
```

### Junior → FAANG: Choosing the Right Instrument for the Job

The most common junior mistake with OTel metrics is using a counter when a histogram is needed, or vice versa. Here is the decision rule:

Use a **counter** when you only care about total accumulation: total requests, total errors, total bytes sent. Counters are monotonically increasing and reset to zero on process restart. Use `rate()` in PromQL to get the per-second rate.

Use a **histogram** when you care about distribution: request latency, payload size, queue depth. Histograms let you compute percentiles (p50, p95, p99) which counters cannot provide. The bucket boundaries matter: poorly chosen buckets (too coarse) hide latency spikes.

Use a **gauge** for values that go up and down: current goroutine count, active connections, cache size. Gauges represent a point-in-time snapshot, not an accumulation.

Interview entry point: "Why would you prefer a histogram over a gauge for measuring latency?" A gauge only records the most recent value, which loses all distribution information. A histogram accumulates observations into buckets, enabling percentile calculation over any time window.

### Senior @ FAANG: Metrics Cardinality Budget and Instrument Design Governance

**Cardinality as a cost multiplier.** Every unique combination of label values creates a new time series in Prometheus or Thanos. A metric with labels `{service, region, method, status_code}` with 10 services, 3 regions, 50 methods, and 20 status codes produces 30,000 time series. Add a `user_id` label and that number grows by the number of active users. At FAANG scale, a single high-cardinality label in a high-volume metric can add millions of time series, and the storage and query cost scales with them. A senior engineer designs metrics with explicit cardinality budgets documented in the platform standards.

**Instrument naming conventions as a discoverability contract.** Ad-hoc metric names like `my_service_stuff_total` make cross-service dashboards impossible. An L6 engineer defines a naming standard: `{domain}_{noun}_{unit}_{type}` where type is one of `total` (counter), `seconds` (histogram), `ratio` (gauge). For example: `payment_transactions_seconds`, `auth_login_attempts_total`, `cache_hit_ratio`. This standard enables a single dashboard template to work across all services by parameterizing the domain prefix.

**Exemplars as the bridge between metrics and traces.** Exemplars link a specific histogram observation to the trace that produced it. When a p99 latency spike appears on a Grafana dashboard, an exemplar lets you click directly to the trace for the specific request that was at the 99th percentile, eliminating minutes of manual correlation. Enabling exemplars requires using the OTel Prometheus exporter with exemplar support and configuring Grafana to render them. This integration is a platform-level feature that benefits every team simultaneously.

**Metric lifecycle management.** Metrics are not free to add but costly to remove. A metric that was added for a one-time incident investigation and never cleaned up accumulates storage cost indefinitely. A senior engineer treats metric registration like schema migration: require a description field that explains why the metric exists, add a review step in the PR process for new metrics, and implement a periodic audit that flags metrics with zero observations over 30 days for deprecation review.

---
