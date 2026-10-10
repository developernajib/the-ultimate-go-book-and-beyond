## 24.8 Distributed Tracing Debug

### Trace Context Propagation

Distributed tracing relies on a trace context being extracted from incoming request headers and injected into every outbound call so that all spans for a single user request share the same trace ID. `Extract` reads the context from an incoming HTTP request and `Inject` writes it into outbound request headers.

There is one thing you must do first, and skipping it is the single most common reason a correctly instrumented Go service produces traces that break at every service boundary. **The global propagator defaults to a no-op.** `otel.GetTextMapPropagator()` returns an empty composite propagator until you register one, and an empty composite happily accepts every `Inject` call and writes no headers at all. No error, no warning, no log line. Your spans are created, exported, and visible in Jaeger, they simply have no parent, so instead of one trace across ten services you get ten disconnected single-span traces.

Register the W3C propagators once, at startup, next to your tracer provider setup:

```go
otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
    propagation.TraceContext{}, // the W3C traceparent/tracestate headers
    propagation.Baggage{},      // the W3C baggage header
))
```

With that in place `Inject` writes `traceparent: 00-4bf92f...-00f067aa0ba902b7-01`. Without it the header map comes back empty. If you are ever debugging broken trace continuity, inject into a throwaway `http.Header` in a unit test and assert it is non-empty. That five-line test catches this immediately.

```go
package debug

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/trace"
)

func ExtractTraceContext(r *http.Request) context.Context {
    return otel.GetTextMapPropagator().Extract(
        r.Context(),
        propagation.HeaderCarrier(r.Header),
    )
}

func InjectTraceContext(ctx context.Context, req *http.Request) {
    otel.GetTextMapPropagator().Inject(
        ctx,
        propagation.HeaderCarrier(req.Header),
    )
}

// AddDebugAttributes adds debugging info to current span
func AddDebugAttributes(ctx context.Context, attrs map[string]string) {
    span := trace.SpanFromContext(ctx)
    for k, v := range attrs {
        span.SetAttributes(attribute.String(k, v))
    }
}

// RecordException records an error with a stack trace and marks the span failed.
//
// Both calls are needed. RecordError attaches an exception event, but it
// explicitly does not touch the span's status, so a span with only
// RecordError still reports as OK and will not show up in an
// error-filtered trace search. SetStatus is what makes it an error.
func RecordException(ctx context.Context, err error) {
    span := trace.SpanFromContext(ctx)
    span.RecordError(err, trace.WithStackTrace(true))
    span.SetStatus(codes.Error, err.Error())
}
```

### Trace-Based Debugging

Wrapping individual functions in debug spans lets you pinpoint exactly where latency accumulates in a deep call chain without adding permanent instrumentation. Named checkpoints recorded as span events attach arbitrary key-value payloads at specific execution points, giving trace viewers a chronological record of state transitions that is searchable after the fact in Jaeger or Grafana Tempo.

```go
package debug

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

type TraceDebugger struct {
    tracer trace.Tracer
}

func NewTraceDebugger() *TraceDebugger {
    return &TraceDebugger{
        tracer: otel.Tracer("debug"),
    }
}

// WrapWithDebug creates a debug span around a function
func (d *TraceDebugger) WrapWithDebug(ctx context.Context, name string, fn func(context.Context) error) error {
    ctx, span := d.tracer.Start(ctx, fmt.Sprintf("debug/%s", name))
    defer span.End()

    // Add caller info
    span.SetAttributes(
        attribute.String("debug.function", name),
    )

    err := fn(ctx)
    if err != nil {
        // RecordError alone leaves the span status Unset. Both calls, always.
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
    }

    return err
}

// CreateCheckpoint creates a named checkpoint in the trace
func (d *TraceDebugger) CreateCheckpoint(ctx context.Context, name string, data map[string]string) {
    span := trace.SpanFromContext(ctx)
    attrs := []attribute.KeyValue{
        attribute.String("checkpoint", name),
    }
    for k, v := range data {
        attrs = append(attrs, attribute.String(k, v))
    }
    span.AddEvent("checkpoint", trace.WithAttributes(attrs...))
}
```

### Staff Lens: Tracing Saves Hours

A slow request traced across 10 services shows exactly which span is slow. Without tracing, the same diagnosis requires manual log correlation across services, which can take hours. Tracing is infrastructure investment that pays back on every incident.

---
