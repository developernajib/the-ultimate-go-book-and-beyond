## Part 9: Observability - Logging, Metrics, Tracing

Observability is what lets you understand what your gateway is doing in production. Without it, debugging issues becomes guesswork. We implement three pillars of observability here: structured logging with `zap` for fast, machine-parseable log output. Prometheus metrics for tracking request counts, latencies, and error rates that you can graph in Grafana. And distributed tracing with OpenTelemetry so you can follow a single request across the gateway and all downstream services. Together, these three tools give you full visibility into the health and performance of your gateway.

```go
// internal/observability/logger.go
package observability

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

// NewLogger creates a configured logger
func NewLogger(level, format, output string) (*zap.Logger, error) {
    var zapLevel zapcore.Level
    if err := zapLevel.UnmarshalText([]byte(level)); err != nil {
        zapLevel = zapcore.InfoLevel
    }

    config := zap.Config{
        Level:            zap.NewAtomicLevelAt(zapLevel),
        Development:      false,
        Encoding:         format,
        EncoderConfig:    zap.NewProductionEncoderConfig(),
        OutputPaths:      []string{output},
        ErrorOutputPaths: []string{"stderr"},
    }

    if format == "console" {
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    }

    return config.Build()
}
```

```go
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
```

```go
// internal/observability/tracing.go
package observability

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/sdk/resource"
    "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
)

// InitTracing initializes OpenTelemetry tracing
func InitTracing(serviceName, endpoint string, samplingRate float64) (*trace.TracerProvider, error) {
    exporter, err := jaeger.New(
        jaeger.WithCollectorEndpoint(jaeger.WithEndpoint(endpoint)),
    )
    if err != nil {
        return nil, fmt.Errorf("create jaeger exporter: %w", err)
    }

    tp := trace.NewTracerProvider(
        trace.WithBatcher(exporter),
        trace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceNameKey.String(serviceName),
        )),
        trace.WithSampler(trace.TraceIDRatioBased(samplingRate)),
    )

    otel.SetTracerProvider(tp)

    return tp, nil
}

// ShutdownTracing gracefully shuts down the tracer provider
func ShutdownTracing(ctx context.Context, tp *trace.TracerProvider) error {
    return tp.Shutdown(ctx)
}
```
