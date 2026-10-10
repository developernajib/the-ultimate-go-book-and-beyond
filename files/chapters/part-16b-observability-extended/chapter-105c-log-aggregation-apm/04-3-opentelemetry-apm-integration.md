## 105C.4 OpenTelemetry APM Integration

OpenTelemetry provides vendor-neutral tracing, metrics, and logging APIs that export to any compatible backend (Jaeger, Tempo, Datadog, Honeycomb) by swapping the exporter without changing application code. The `SetupOTel` function below initializes both the trace provider with a batching OTLP exporter and a Prometheus metrics exporter, registers them as globals, and returns a shutdown function that flushes pending data on graceful termination. Registering custom `ServiceMetrics` instruments immediately after setup ensures all request, error, database, and business metrics are defined before any traffic arrives.

```go
package apm

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// OTelConfig holds OpenTelemetry configuration
type OTelConfig struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string
	SampleRate     float64
}

// OTelSDK wraps the OpenTelemetry SDK setup
type OTelSDK struct {
	TracerProvider *sdktrace.TracerProvider
	MeterProvider  *sdkmetric.MeterProvider
	tracer         trace.Tracer
	meter          metric.Meter
}

// SetupOTel initializes OpenTelemetry with tracing and metrics
func SetupOTel(ctx context.Context, config OTelConfig) (*OTelSDK, error) {
	// Create resource describing this service
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(config.ServiceName),
			semconv.ServiceVersion(config.ServiceVersion),
			attribute.String("deployment.environment", config.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	// Setup trace exporter
	traceExporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(config.OTLPEndpoint),
		otlptracehttp.WithInsecure(),
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
			Enabled:         true,
			InitialInterval: 1 * time.Second,
			MaxInterval:     10 * time.Second,
			MaxElapsedTime:  30 * time.Second,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create trace exporter: %w", err)
	}

	// Setup trace provider with head-based sampling
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter,
			sdktrace.WithMaxExportBatchSize(512),
			sdktrace.WithBatchTimeout(5*time.Second),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(
			sdktrace.ParentBased(
				sdktrace.TraceIDRatioBased(config.SampleRate),
			),
		),
	)

	// Setup Prometheus metrics exporter
	prometheusExporter, err := prometheus.New()
	if err != nil {
		return nil, fmt.Errorf("failed to create Prometheus exporter: %w", err)
	}

	meterProvider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(prometheusExporter),
	)

	// Register global providers
	otel.SetTracerProvider(tracerProvider)
	otel.SetMeterProvider(meterProvider)

	sdk := &OTelSDK{
		TracerProvider: tracerProvider,
		MeterProvider:  meterProvider,
		tracer:         tracerProvider.Tracer(config.ServiceName),
		meter:          meterProvider.Meter(config.ServiceName),
	}

	return sdk, nil
}

// Shutdown gracefully shuts down OTel exporters
func (sdk *OTelSDK) Shutdown(ctx context.Context) error {
	if err := sdk.TracerProvider.Shutdown(ctx); err != nil {
		return fmt.Errorf("trace provider shutdown: %w", err)
	}
	if err := sdk.MeterProvider.Shutdown(ctx); err != nil {
		return fmt.Errorf("meter provider shutdown: %w", err)
	}
	return nil
}

// ServiceMetrics holds all custom metrics for a service
type ServiceMetrics struct {
	// Request metrics
	RequestTotal    metric.Int64Counter
	RequestDuration metric.Float64Histogram
	RequestActive   metric.Int64UpDownCounter

	// Error metrics
	ErrorTotal metric.Int64Counter

	// Database metrics
	DBQueryDuration metric.Float64Histogram
	DBPoolActive    metric.Int64UpDownCounter
	DBPoolWaiting   metric.Int64UpDownCounter

	// Cache metrics
	CacheHits   metric.Int64Counter
	CacheMisses metric.Int64Counter

	// Business metrics
	OrdersProcessed metric.Int64Counter
	OrderValueCents metric.Int64Histogram
}

// NewServiceMetrics creates all service metrics
func NewServiceMetrics(meter metric.Meter) (*ServiceMetrics, error) {
	m := &ServiceMetrics{}
	var err error

	m.RequestTotal, err = meter.Int64Counter(
		"http.server.request.count",
		metric.WithDescription("Total number of HTTP requests"),
		metric.WithUnit("{request}"),
	)
	if err != nil {
		return nil, err
	}

	m.RequestDuration, err = meter.Float64Histogram(
		"http.server.request.duration",
		metric.WithDescription("HTTP request duration"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
		),
	)
	if err != nil {
		return nil, err
	}

	m.RequestActive, err = meter.Int64UpDownCounter(
		"http.server.active_requests",
		metric.WithDescription("Number of active HTTP requests"),
		metric.WithUnit("{request}"),
	)
	if err != nil {
		return nil, err
	}

	m.ErrorTotal, err = meter.Int64Counter(
		"http.server.error.count",
		metric.WithDescription("Total number of HTTP errors"),
		metric.WithUnit("{error}"),
	)
	if err != nil {
		return nil, err
	}

	m.DBQueryDuration, err = meter.Float64Histogram(
		"db.query.duration",
		metric.WithDescription("Database query duration"),
		metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(
			0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
		),
	)
	if err != nil {
		return nil, err
	}

	m.CacheHits, err = meter.Int64Counter(
		"cache.hits",
		metric.WithDescription("Cache hit count"),
		metric.WithUnit("{hit}"),
	)
	if err != nil {
		return nil, err
	}

	m.CacheMisses, err = meter.Int64Counter(
		"cache.misses",
		metric.WithDescription("Cache miss count"),
		metric.WithUnit("{miss}"),
	)
	if err != nil {
		return nil, err
	}

	m.OrdersProcessed, err = meter.Int64Counter(
		"orders.processed.total",
		metric.WithDescription("Total orders processed"),
		metric.WithUnit("{order}"),
	)
	if err != nil {
		return nil, err
	}

	m.OrderValueCents, err = meter.Int64Histogram(
		"orders.value_cents",
		metric.WithDescription("Order value distribution in integer cents"),
		metric.WithUnit("cents"),
		metric.WithExplicitBucketBoundaries(
			1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000,
		),
	)
	if err != nil {
		return nil, err
	}

	return m, nil
}

// InstrumentedHandler wraps an HTTP handler with OTel instrumentation
type InstrumentedHandler struct {
	metrics *ServiceMetrics
	tracer  trace.Tracer
	logger  *slog.Logger
}

// Wrap adds instrumentation to an HTTP handler
func (h *InstrumentedHandler) Wrap(pattern string, handler http.Handler) http.Handler {
	// OTel HTTP instrumentation with custom span name
	return otelhttp.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			span := trace.SpanFromContext(ctx)

			// Record active request
			h.metrics.RequestActive.Add(ctx, 1,
				metric.WithAttributes(
					attribute.String("http.method", r.Method),
					attribute.String("http.route", pattern),
				))
			defer h.metrics.RequestActive.Add(ctx, -1,
				metric.WithAttributes(
					attribute.String("http.method", r.Method),
					attribute.String("http.route", pattern),
				))

			start := time.Now()
			wrapped := &statusRecorder{ResponseWriter: w, code: 200}

			handler.ServeHTTP(wrapped, r)

			duration := time.Since(start).Seconds()
			attrs := metric.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.route", pattern),
				attribute.Int("http.status_code", wrapped.code),
			)

			h.metrics.RequestTotal.Add(ctx, 1, attrs)
			h.metrics.RequestDuration.Record(ctx, duration, attrs)

			if wrapped.code >= 500 {
				h.metrics.ErrorTotal.Add(ctx, 1, attrs)
				span.SetAttributes(attribute.Bool("error", true))
			}

			// Add request attributes to span
			span.SetAttributes(
				semconv.HTTPRequestMethodKey.String(r.Method),
				semconv.HTTPResponseStatusCode(wrapped.code),
				attribute.String("http.route", pattern),
			)
		}),
		pattern,
		otelhttp.WithTracerProvider(otel.GetTracerProvider()),
		otelhttp.WithMeterProvider(otel.GetMeterProvider()),
	)
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

// SpanHelper provides utilities for creating spans
type SpanHelper struct {
	tracer trace.Tracer
}

// NewSpanHelper creates a span helper
func NewSpanHelper(tracer trace.Tracer) *SpanHelper {
	return &SpanHelper{tracer: tracer}
}

// StartSpan creates a span and returns a cleanup function
func (h *SpanHelper) StartSpan(ctx context.Context, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span, func()) {
	ctx, span := h.tracer.Start(ctx, name, opts...)
	return ctx, span, func() { span.End() }
}

// RecordDBQuery records a database query as a span
func (h *SpanHelper) RecordDBQuery(ctx context.Context, operation, table, query string) (context.Context, trace.Span) {
	ctx, span := h.tracer.Start(ctx, fmt.Sprintf("db.%s %s", operation, table),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemPostgreSQL,
			semconv.DBOperationName(operation),
			attribute.String("db.sql.table", table),
			attribute.String("db.statement", truncateQuery(query, 1000)),
		),
	)
	return ctx, span
}

// RecordCacheOperation records a cache operation
func (h *SpanHelper) RecordCacheOperation(ctx context.Context, operation, key string) (context.Context, trace.Span) {
	ctx, span := h.tracer.Start(ctx, fmt.Sprintf("cache.%s", operation),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemKey.String("redis"),
			semconv.DBOperationName(operation),
			attribute.String("cache.key", key),
		),
	)
	return ctx, span
}

func truncateQuery(query string, maxLen int) string {
	if len(query) > maxLen {
		return query[:maxLen] + "..."
	}
	return query
}

// APMMiddleware provides comprehensive APM for HTTP services
func APMMiddleware(sdk *OTelSDK, metrics *ServiceMetrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return otelhttp.NewHandler(next, "http-server",
			otelhttp.WithTracerProvider(sdk.TracerProvider),
			otelhttp.WithMeterProvider(sdk.MeterProvider),
			otelhttp.WithSpanNameFormatter(func(operation string, r *http.Request) string {
				return fmt.Sprintf("%s %s", r.Method, r.URL.Path)
			}),
			otelhttp.WithFilter(func(r *http.Request) bool {
				// Skip health check endpoints from tracing
				return r.URL.Path != "/health" && r.URL.Path != "/metrics"
			}),
		)
	}
}
```

### Junior → FAANG: APM vs. Manual Instrumentation

APM (Application Performance Monitoring) tools like Elastic APM, Datadog APM, and New Relic automatically instrument your service via agents or auto-instrumentation libraries. They capture request traces, error rates, and latency distributions without code changes. OpenTelemetry is the open-standards alternative that achieves the same result with vendor portability.

For a first job, understand the trade-off: APM agents are faster to deploy but create vendor lock-in and may have higher overhead than carefully written manual instrumentation. OpenTelemetry requires more setup but gives you full control over what data is collected and where it goes.

Interview entry point: "What is the difference between APM and distributed tracing?" APM is an umbrella term that includes distributed tracing, error tracking, performance profiling, and anomaly detection, often in a single product. Distributed tracing specifically refers to the propagation of trace context across service boundaries and the storage of span data. OpenTelemetry provides the distributed tracing primitive. APM tools build higher-level features on top.

### Senior @ FAANG: APM Data as a Developer Productivity Platform

At L6, APM is not just an incident investigation tool: it is a developer productivity platform. Performance regression detection in CI (comparing p99 latency from the PR's load test against the baseline) catches regressions before production. Error grouping (clustering exceptions by stack trace fingerprint) reduces the alert noise from a single bug that appears in many requests. Service dependency maps (derived from span parent-child relationships) document the actual service graph rather than the documented one, which are often different.

An L6 engineer evaluates APM platform investments against these developer productivity metrics: time to detect regressions (measured from code merge to alert), mean time to understand a new error (measured from error first occurrence to developer assigned), and service graph accuracy (percentage of service dependencies that are documented vs. observed in traces). These metrics make the APM investment case in terms product management understands.

---
