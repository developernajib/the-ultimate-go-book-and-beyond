## 105E.2 OpenTelemetry SDK Deep Dive

The OpenTelemetry Go SDK separates the tracing API (what application code calls) from the SDK implementation (how spans are processed and exported), so switching from Jaeger to Tempo or Datadog requires only changing the exporter, with no application code changes. The setup below configures an OTLP HTTP exporter with retry logic, parent-based sampling that respects upstream sampling decisions while applying a local ratio to new traces, and resource attributes that identify the service in every span for multi-service trace correlation.

```go
package tracing

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// TracingConfig holds tracing configuration
type TracingConfig struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	OTLPEndpoint   string
	SampleRate     float64
	MaxExportBatchSize int
	BatchTimeout   time.Duration
}

// SetupTracing initializes OpenTelemetry tracing
func SetupTracing(ctx context.Context, config TracingConfig) (*sdktrace.TracerProvider, error) {
	// Create OTLP exporter
	exporter, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(config.OTLPEndpoint),
		otlptracehttp.WithInsecure(),
		otlptracehttp.WithHeaders(map[string]string{
			"service-name": config.ServiceName,
		}),
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
			Enabled:         true,
			InitialInterval: 1 * time.Second,
			MaxInterval:     30 * time.Second,
			MaxElapsedTime:  5 * time.Minute,
		}),
		otlptracehttp.WithTimeout(10*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
	}

	// Create resource
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(config.ServiceName),
			semconv.ServiceVersion(config.ServiceVersion),
			attribute.String("deployment.environment", config.Environment),
		),
		resource.WithFromEnv(), // Also pick up OTEL_RESOURCE_ATTRIBUTES
		resource.WithProcess(),
		resource.WithOS(),
		resource.WithHost(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	// Configure batch span processor
	batchProcessor := sdktrace.NewBatchSpanProcessor(
		exporter,
		sdktrace.WithMaxExportBatchSize(config.MaxExportBatchSize),
		sdktrace.WithBatchTimeout(config.BatchTimeout),
		sdktrace.WithMaxQueueSize(2048),
	)

	// Configure sampler
	sampler := configureSampler(config.SampleRate)

	// Create tracer provider
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(batchProcessor),
		sdktrace.WithSpanProcessor(NewCustomSpanProcessor()), // Custom processor
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	// Set global tracer provider
	otel.SetTracerProvider(tp)

	// Set global text map propagator (W3C TraceContext + Baggage)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp, nil
}

func configureSampler(rate float64) sdktrace.Sampler {
	if rate >= 1.0 {
		return sdktrace.AlwaysSample()
	}
	if rate <= 0.0 {
		return sdktrace.NeverSample()
	}
	// Parent-based: if parent sampled, follow parent decision
	// If no parent, sample at configured rate
	return sdktrace.ParentBased(
		sdktrace.TraceIDRatioBased(rate),
		sdktrace.WithRemoteParentSampled(sdktrace.AlwaysSample()),
		sdktrace.WithRemoteParentNotSampled(sdktrace.NeverSample()),
	)
}

// CustomSpanProcessor adds additional processing to all spans
type CustomSpanProcessor struct{}

// NewCustomSpanProcessor creates a custom span processor
func NewCustomSpanProcessor() *CustomSpanProcessor {
	return &CustomSpanProcessor{}
}

func (p *CustomSpanProcessor) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {
	// Add global attributes to all spans at start
	if corrID := correlationIDFromContext(parent); corrID != "" {
		s.SetAttributes(attribute.String("correlation.id", corrID))
	}

	if userID := userIDFromContext(parent); userID != "" {
		s.SetAttributes(attribute.String("user.id", userID))
	}
}

func (p *CustomSpanProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	// Post-process spans: add computed attributes
	duration := s.EndTime().Sub(s.StartTime())

	if duration > 1*time.Second {
		// This span is slow. Log it
		fmt.Printf("SLOW SPAN: %s duration=%v traceID=%s\n",
			s.Name(), duration, s.SpanContext().TraceID())
	}
}

func (p *CustomSpanProcessor) Shutdown(ctx context.Context) error   { return nil }
func (p *CustomSpanProcessor) ForceFlush(ctx context.Context) error { return nil }

func correlationIDFromContext(ctx context.Context) string {
	type ctxKey string
	id, _ := ctx.Value(ctxKey("correlation_id")).(string)
	return id
}

func userIDFromContext(ctx context.Context) string {
	type ctxKey string
	id, _ := ctx.Value(ctxKey("user_id")).(string)
	return id
}

// Tracer wraps otel.Tracer with convenience methods
type Tracer struct {
	tracer trace.Tracer
}

// NewTracer creates a new tracer
func NewTracer(name string) *Tracer {
	return &Tracer{
		tracer: otel.Tracer(name),
	}
}

// StartSpan starts a new span with common configuration
func (t *Tracer) StartSpan(
	ctx context.Context,
	name string,
	opts ...trace.SpanStartOption,
) (context.Context, trace.Span) {
	return t.tracer.Start(ctx, name, opts...)
}

// StartHTTPSpan starts a span for an HTTP client call
func (t *Tracer) StartHTTPSpan(
	ctx context.Context,
	method, url string,
) (context.Context, trace.Span) {
	return t.tracer.Start(ctx,
		fmt.Sprintf("HTTP %s", method),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.HTTPRequestMethodKey.String(method),
			semconv.URLFull(url),
		),
	)
}

// StartDBSpan starts a span for a database operation
func (t *Tracer) StartDBSpan(
	ctx context.Context,
	operation, table string,
) (context.Context, trace.Span) {
	return t.tracer.Start(ctx,
		fmt.Sprintf("db.%s %s", operation, table),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemPostgreSQL,
			semconv.DBOperationName(operation),
			attribute.String("db.sql.table", table),
		),
	)
}

// EndWithError ends a span, recording the error if any
func EndWithError(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}

// TraceHTTPTransport adds tracing to HTTP client calls
type TraceHTTPTransport struct {
	base   http.RoundTripper
	tracer *Tracer
}

// NewTraceHTTPTransport creates a tracing HTTP transport
func NewTraceHTTPTransport(tracer *Tracer) *TraceHTTPTransport {
	return &TraceHTTPTransport{
		base:   http.DefaultTransport,
		tracer: tracer,
	}
}

// RoundTrip executes the HTTP request with tracing
func (t *TraceHTTPTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, span := t.tracer.StartHTTPSpan(req.Context(), req.Method, req.URL.String())
	defer span.End()

	// Inject trace context into request headers
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

	// Execute request
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	span.SetAttributes(
		semconv.HTTPResponseStatusCode(resp.StatusCode),
		attribute.String("http.response.headers.content-type",
			resp.Header.Get("Content-Type")),
	)

	if resp.StatusCode >= 400 {
		span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", resp.StatusCode))
	}

	return resp, nil
}

// BaggageHelper manages W3C baggage for cross-service state propagation
type BaggageHelper struct{}

// SetBaggage adds a baggage entry to the context, preserving existing entries
func SetBaggage(ctx context.Context, key, value string) context.Context {
	member, err := baggage.NewMember(key, value)
	if err != nil {
		return ctx
	}

	bag, err := baggage.FromContext(ctx).SetMember(member)
	if err != nil {
		return ctx
	}
	return baggage.ContextWithBaggage(ctx, bag)
}

// GetBaggage retrieves a baggage value from context
func GetBaggage(ctx context.Context, key string) string {
	bag := baggage.FromContext(ctx)
	return bag.Member(key).Value()
}

// InjectBaggageIntoHeaders injects baggage into HTTP headers
func InjectBaggageIntoHeaders(ctx context.Context, headers http.Header) {
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(headers))
}

// ExtractBaggageFromHeaders extracts baggage from HTTP headers
func ExtractBaggageFromHeaders(ctx context.Context, headers http.Header) context.Context {
	return otel.GetTextMapPropagator().Extract(ctx, propagation.HeaderCarrier(headers))
}
```

### Junior → FAANG: What Every Interview Tests About the OTel SDK

Every FAANG-track interview question about the OTel SDK in Go revolves around three points that junior engineers frequently get wrong. First, understand the API versus SDK split: application code imports `go.opentelemetry.io/otel` (the API), and only the bootstrap code in `main` imports the SDK. This boundary is not stylistic. It means that a library author can add instrumentation without forcing a specific backend on their consumers. Second, understand `ParentBased` sampling: a service that applies `TraceIDRatioBased(0.1)` without wrapping it in `ParentBased` will break traces by sampling child spans at a different rate than the upstream parent decided. Third, know that `TracerProvider.Shutdown` must be called before process exit or you lose the last batch of buffered spans. Missing shutdown during a graceful restart is the most common cause of trace truncation in production.

For first-job readiness, practice setting up the SDK from scratch without referring to documentation. The `SetupTracing` pattern above covers every required component: exporter, resource, batch processor, sampler, global registration. Memorize the order and you can instrument any Go service in under 20 minutes.

### Senior @ FAANG: SDK Configuration as a Platform Contract

At L6, the `SetupTracing` function in a shared internal library is a platform contract, not just a utility. Every parameter in `TracingConfig` is a governance decision. `MaxExportBatchSize` and `BatchTimeout` determine the memory footprint of the in-process span queue. A batch size of 512 with a 5-second timeout is appropriate for most services, but a high-throughput service processing 50,000 requests per second needs explicit analysis, because 20 spans per request at 50,000 RPS means 1,000,000 spans per second flowing through the batch processor, exceeding the default queue capacity in under 2 seconds. The platform team must document the queue sizing model and expose `MaxQueueSize` as a configuration parameter with a default derived from expected traffic, not an arbitrary constant.

The `CustomSpanProcessor` pattern enables cross-cutting span enrichment without modifying application code. At platform scale, this is the enforcement point for attribute policies: every span must carry `correlation.id`, `deployment.environment`, and `service.version`. A custom processor that enforces these attributes and logs a warning when they are missing is a lightweight compliance mechanism that operates without a CI linter. However, the `OnEnd` hook in the example uses `fmt.Printf` for slow span detection, which is inappropriate for production because it is unstructured and cannot be correlated with other signals. The production version should emit a structured log entry using `slog` with the span name, duration, trace ID, and span ID, and link it to the slow-span Prometheus counter so the alerting system can detect regressions in span duration distribution.

The baggage helper functions expose a PII risk that must be addressed in the platform's security review. Baggage propagates arbitrary key-value pairs across every downstream service in the call tree, including third-party services and external APIs. A developer who stores a user's email address in baggage for debugging convenience has inadvertently propagated it to every service the request touches, including any third-party analytics or payment processor that extracts baggage from headers. The platform's baggage API must enforce an allowlist of permitted baggage keys, rejecting or stripping any key not explicitly approved by the security review process.

---
