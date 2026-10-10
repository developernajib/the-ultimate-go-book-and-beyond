## 103.11 Exemplars: Linking Metrics to Traces

### Implementing Exemplars

Exemplars attach specific trace IDs to metric data points, creating a direct link from an anomalous metric reading to the distributed trace that caused it. `RequestMetrics` records each observation with the request context, and the SDK's exemplar reservoir pulls the active trace and span IDs out of that context automatically, so Prometheus stores the trace ID alongside the observation bucket and Grafana can render a direct "jump to trace" link from any high-latency data point on a dashboard.

```go
package metrics

import (
    "context"
    "net/http"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/trace"
)

var meter = otel.Meter("myapp/metrics")

// RequestMetrics tracks HTTP requests with exemplars
type RequestMetrics struct {
    requestDuration metric.Float64Histogram
    requestsTotal   metric.Int64Counter
}

func NewRequestMetrics() (*RequestMetrics, error) {
    duration, err := meter.Float64Histogram(
        "http_request_duration_seconds",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
    )
    if err != nil {
        return nil, err
    }

    total, err := meter.Int64Counter(
        "http_requests_total",
        metric.WithDescription("Total HTTP requests"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    return &RequestMetrics{
        requestDuration: duration,
        requestsTotal:   total,
    }, nil
}

// RecordRequest records a request with exemplar support
func (m *RequestMetrics) RecordRequest(ctx context.Context, method, path string, statusCode int, duration time.Duration) {
    attrs := []attribute.KeyValue{
        attribute.String("method", method),
        attribute.String("path", path),
        attribute.Int("status_code", statusCode),
    }

    // Get trace context for exemplar
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        // The trace ID is automatically attached as an exemplar
        // when using the OpenTelemetry SDK with exemplar support enabled
    }

    // Record metrics with attributes
    m.requestDuration.Record(ctx, duration.Seconds(), metric.WithAttributes(attrs...))
    m.requestsTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
}

// ExemplarMiddleware wraps handlers to record metrics with exemplars
func ExemplarMiddleware(metrics *RequestMetrics) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Wrap response writer to capture status code
            // (responseWriter is the status-capturing wrapper from 103.4)
            rw := &responseWriter{ResponseWriter: w, statusCode: 200}

            next.ServeHTTP(rw, r)

            // Record metrics with exemplar from trace context
            metrics.RecordRequest(
                r.Context(),
                r.Method,
                r.URL.Path,
                rw.statusCode,
                time.Since(start),
            )
        })
    }
}
```

### Prometheus Exemplar Configuration

Prometheus must be configured with `--enable-feature=exemplar-storage` to accept and store exemplars. The scrape configuration below enables exemplar collection from Go services, and the storage retention setting controls how long exemplars are kept before expiry.

```yaml
# prometheus.yml with exemplar support
# (also start Prometheus with --enable-feature=exemplar-storage)
global:
  scrape_interval: 15s
  evaluation_interval: 15s

storage:
  exemplars:
    max_exemplars: 100000

scrape_configs:
  - job_name: 'go-services'
    static_configs:
      - targets: ['service1:8080', 'service2:8080']
    # Enable OpenMetrics format for exemplar support
    scrape_protocols:
      - OpenMetricsText1.0.0
      - PrometheusText0.0.4
```

### Querying Exemplars in Grafana

Grafana displays exemplars as dots overlaid on a time-series graph. Clicking a dot opens the linked trace in Jaeger or Tempo. The PromQL query below retrieves the p99 latency histogram with exemplars enabled, and the Grafana panel configuration shows how to wire the trace ID from the exemplar to a Tempo data source.

```
# PromQL query with exemplar visualization
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
)

# In Grafana:
# 1. Enable "Exemplars" in the query options
# 2. Configure Jaeger/Tempo as the trace data source
# 3. Click on exemplar points to jump to the trace
```

### Junior → FAANG: Exemplars Close the Metrics-to-Traces Gap

Without exemplars, investigating a p99 latency spike requires a multi-step process: notice the spike on a Grafana graph, guess a time range, go to Jaeger, search for slow traces in that time range, and hope to find the relevant one among thousands. Exemplars eliminate that gap by embedding a trace ID directly in the histogram observation that caused the percentile spike.

When Grafana renders a histogram with exemplar support enabled, it shows small dots on the graph where exemplar samples exist. Clicking a dot opens the corresponding trace directly in Jaeger or Tempo. This workflow compresses a five-minute investigation into five seconds.

First-job habit: enable exemplars on all histogram metrics in your services. The implementation cost is minimal, recent OTel Go SDKs record exemplars automatically when a sampled span is in the context, so the remaining work is enabling exemplar storage in Prometheus and exemplar rendering in Grafana.

### Senior @ FAANG: Exemplars as a Platform Feature, Cardinality Impact, and Exemplar Sampling

**Exemplars require coordinated backend configuration.** Exemplars are a feature that spans three systems: the OTel SDK (which records exemplars), the Prometheus exporter (which formats them in the exposition format), and Grafana (which renders them). All three must be correctly configured for the feature to work end-to-end. A platform team enables exemplars centrally in the shared Go service library and in the Grafana data source configuration, so individual teams get the feature automatically without any per-service setup.

**Exemplar sampling.** The OTel SDK does not record an exemplar for every histogram observation (that would reproduce the trace storage cost problem). Instead, it samples one exemplar per bucket per collection interval. This means exemplars provide representative samples of the observations in each latency bucket, not exhaustive coverage. A senior engineer understands this limitation: if the p99 spike is caused by a very rare slow request (one in 10,000), there is no guarantee an exemplar was recorded for that specific request. Tail-based sampling with a slow-trace policy is the complementary mechanism that ensures rare slow traces are always retained.

**Exemplars and sampling interaction.** Exemplars are only useful if the trace they reference is actually stored in the tracing backend, otherwise clicking the exemplar link produces a "trace not found" error. The OTel SDK's default trace-based exemplar filter records exemplars only for sampled spans, which keeps links resolvable under head-based sampling. Tail-based sampling decides after the exemplar has already been emitted, so an L6 engineer either configures tail policies (error and latency rules) that retain the traces exemplars tend to reference, or accepts and documents a known rate of dangling exemplar links.

---
