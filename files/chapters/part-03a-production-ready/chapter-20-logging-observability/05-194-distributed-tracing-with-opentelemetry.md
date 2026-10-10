## 20.4 Distributed Tracing with OpenTelemetry

### Setup

Before any spans can be recorded, an OpenTelemetry `TracerProvider` must be configured and registered as the global provider. The provider is wired to an exporter, here an OTLP gRPC exporter targeting a local collector on port 4317, and decorated with resource attributes such as the service name that will appear on every trace. Using a batching exporter rather than a synchronous one keeps the hot path fast by grouping span exports into network calls instead of flushing after each individual span. The function returns a shutdown callback that should be deferred in `main` to ensure buffered spans are flushed before the process exits.

Setup has **two** registrations, not one. Registering the tracer provider makes spans get *recorded*. Registering the text-map propagator makes them get *connected across services*. Omitting the second is the single most common way to end up with a pile of disconnected single-service traces.

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func initTracer(ctx context.Context) (func(context.Context) error, error) {
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint("localhost:4317"),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("create otlp exporter: %w", err)
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(semconv.ServiceName("my-service")),
    )
    if err != nil {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
    )

    // 1. Record spans.
    otel.SetTracerProvider(tp)

    // 2. Propagate them across process boundaries. Without this, the global
    //    propagator is a no-op and no traceparent header is ever sent.
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Shutdown, nil
}
```

Call it with a bounded shutdown so a dead collector cannot hang your exit:

```go
shutdown, err := initTracer(ctx)
if err != nil {
    log.Fatalf("init tracer: %v", err)
}
defer func() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := shutdown(ctx); err != nil {
        log.Printf("tracer shutdown: %v", err)
    }
}()
```

### The Propagator Is Not Optional

`otel.SetTextMapPropagator` looks like a formality and is load-bearing. OpenTelemetry Go's default global propagator is a **no-op**: it injects nothing and extracts nothing. Everything else still works, which is what makes this so hard to spot. Spans are recorded, they reach your backend, they look correct, and every service's trace stands alone with no parent, forever.

Measured with `otelhttp` on both client and server, the only difference being the propagator registration:

```
book setup (no propagator):  downstream traceparent: <MISSING> -- trace is BROKEN
with propagator:             downstream traceparent: 00-48b0738e1cf8a8c53...
```

`otelhttp.NewTransport` faithfully asks the global propagator to inject headers, the no-op propagator declines, and the request goes out clean. No error is returned or logged. The downstream service sees no `traceparent`, so it starts a brand new trace, and the distributed part of your distributed tracing quietly never existed.

`propagation.TraceContext{}` implements the W3C Trace Context standard (`traceparent` and `tracestate`), which is what you want for interoperating with essentially everything. `propagation.Baggage{}` adds W3C Baggage, which carries arbitrary key-value context across services and is worth including from the start. If you also talk to services instrumented with B3 (Zipkin's format), add that propagator to the composite rather than replacing the list.

The fastest way to confirm it works is the one used above: assert that a downstream handler actually receives a non-empty `traceparent` header. That test catches this on day one instead of during an incident.

### Creating Spans

A span represents a single unit of work within a trace and is created by calling `Start` on a `Tracer`, which also returns a child context carrying the new span's identity. Passing this context to downstream calls, including calls to other services, propagates the trace, allowing a complete end-to-end picture to be assembled in the tracing backend. Attributes attached with `SetAttributes` enrich the span with structured key-value data, making it possible to filter and correlate traces by business-level fields such as user IDs or item counts. The `defer span.End()` pattern ensures the span is always closed, recording its duration even when the function returns due to an error.

```go
tracer := otel.Tracer("my-service")

func handleRequest(ctx context.Context) {
    ctx, span := tracer.Start(ctx, "handleRequest")
    defer span.End()

    // Add attributes
    span.SetAttributes(
        attribute.String("user.id", userID),
        attribute.Int("item.count", len(items)),
    )

    // Call another service
    callExternalAPI(ctx)
}
```

### HTTP Instrumentation

The `otelhttp` contrib package provides drop-in wrappers for both the server and client sides of HTTP communication, eliminating the need to manually start and end spans for every handler. Wrapping a server handler with `otelhttp.NewHandler` automatically extracts incoming trace context from request headers and starts a new server span, while `otelhttp.NewTransport` on the client side injects the current span context into outgoing request headers so the remote service can continue the same trace. This bidirectional propagation is what enables the full call graph across service boundaries to appear as a single cohesive trace in tools like Jaeger or Tempo.

```go
import "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

handler := otelhttp.NewHandler(myHandler, "server")
http.ListenAndServe(":8080", handler)

// Client
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
```

> **Senior track**: The OpenTelemetry Go Logs API and SDK (`go.opentelemetry.io/otel/sdk/log`) reached release-candidate status in August 2026 (v1.47.0-rc.1), the final stage before stable v1 compatibility guarantees, with the log exporters still experimental. Paired with the `otelslog` bridge, a single OTLP pipeline can already carry logs, metrics, and traces for a service in practice, removing the need for a separate log shipper. For new greenfield services this collapses the pipeline to: slog, OTLP exporter, OTel Collector, backends. Use `semconv/v1.26.0` or later: older semantic-convention modules predate several renamed attributes, so pin one version and use it everywhere.

### Sampling Strategy

Tracing every request produces overwhelming data volume. Sample strategically:

- **Head sampling:** decide at request entry based on fixed percentage. Simple, but you might miss the interesting traces.
- **Tail sampling:** decide after request completion based on error, latency, or explicit flag. Catches the interesting traces, needs a collector.
- **Dynamic sampling:** higher sample rate for errors and slow requests, lower for routine traffic.

Most production services use 1-5% head sampling plus 100% for errors. Adjust based on volume and cost.

### Staff Lens: Tracing as a Diagnostic Tool

Traces are most valuable when diagnosing specific incidents: "why did this request take 2 seconds?". They are less useful as a routine monitoring tool. Metrics are better for that. Design the tracing system around the diagnostic use case.

### OpenTelemetry as Vendor-Neutral Insurance

Adopting OpenTelemetry means you can change tracing backends (Jaeger, Tempo, Datadog, Honeycomb) without rewriting instrumentation. For a principal engineer making tooling decisions, this is significant: vendor pricing and feature sets change over years, and being able to migrate is a meaningful option to preserve.

---
