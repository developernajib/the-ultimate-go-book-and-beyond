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
	exporter, err := otlptracehttp.New(
		context.Background(),
		otlptracehttp.WithEndpoint(endpoint),
		otlptracehttp.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("create OTLP exporter: %w", err)
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
