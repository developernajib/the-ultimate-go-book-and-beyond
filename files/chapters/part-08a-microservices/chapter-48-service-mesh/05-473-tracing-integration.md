## 48.3 Tracing Integration

### Propagating Trace Context

Even though the mesh data plane (Envoy sidecar, ambient waypoint, or Cilium's L7 proxy) automatically generates spans for each service-to-service call, Go services must still propagate the W3C `traceparent` header from inbound requests to all outbound calls. Otherwise the mesh sees disconnected single-hop spans rather than a unified trace - the proxy only knows what HTTP headers cross it, and if the app drops the header between recv and send, the trace breaks. The OpenTelemetry `propagation.TraceContext` extractor reads the header into the Go `context.Context`, and the injector writes it into outbound `http.Request` headers, stitching the full request path into one trace visible in Jaeger, Tempo, or the Grafana unified stack.

A common misconception is that the mesh provides complete observability. The mesh gives you *network-layer* spans (one span per proxy hop, carrying request/response metadata). It cannot see inside your process, so database queries, cache lookups, business-logic branches, and in-process goroutine fan-out are invisible unless the application emits spans for them via `otel.Tracer("...").Start(ctx, "...")`. Production-grade services combine both: mesh spans for the call graph shape, application spans for the detail that makes a trace diagnostically useful.

```go
package tracing

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/trace"
)

// TracingMiddleware propagates trace context from Istio
func TracingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract trace context from headers. Istio emits W3C traceparent by
        // default (since 1.18); older meshes used B3, so a composite
        // propagator covers both.
        propagator := otel.GetTextMapPropagator()
        ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

        // Get or create span. Name the span after the route pattern, not the
        // raw URL path: /users/12345 as a span name is a cardinality explosion.
        spanName := r.Pattern
        if spanName == "" {
            spanName = "http.request"
        }
        tracer := otel.Tracer("user-service")
        ctx, span := tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
        )
        defer span.End()

        // Pass context to handler
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// PropagateHeaders ensures trace headers are forwarded
func PropagateHeaders(ctx context.Context, req *http.Request) {
    // Inject current trace context into outgoing request
    propagator := otel.GetTextMapPropagator()
    propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// HTTP client that propagates trace context
type TracingClient struct {
    client *http.Client
}

func (c *TracingClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Ensure trace context is propagated
    PropagateHeaders(ctx, req)
    return c.client.Do(req.WithContext(ctx))
}

// B3 header names (used by Istio/Envoy)
const (
    B3TraceID      = "x-b3-traceid"
    B3SpanID       = "x-b3-spanid"
    B3ParentSpanID = "x-b3-parentspanid"
    B3Sampled      = "x-b3-sampled"
    B3Flags        = "x-b3-flags"
)

// ForwardB3Headers forwards B3 headers for outgoing requests
func ForwardB3Headers(incomingHeaders http.Header, outgoingReq *http.Request) {
    headersToForward := []string{
        B3TraceID,
        B3SpanID,
        B3ParentSpanID,
        B3Sampled,
        B3Flags,
        "x-request-id",
        "x-ot-span-context",
    }

    for _, header := range headersToForward {
        if value := incomingHeaders.Get(header); value != "" {
            outgoingReq.Header.Set(header, value)
        }
    }
}
```

### gRPC with Trace Propagation

For gRPC, trace context travels in the metadata map rather than HTTP headers, so a unary interceptor reads the incoming metadata, extracts the span context using the OpenTelemetry TextMapPropagator, and stores it in the Go context before the handler runs. The outgoing interceptor performs the reverse, injecting the current span's context into the metadata before every outbound gRPC call. These two interceptors are the minimum Go-side work required to maintain trace continuity through a gRPC-based service mesh.

```go
package grpc

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
)

// UnaryClientInterceptor propagates trace context in gRPC calls
func UnaryClientInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Create carrier for metadata
        md, ok := metadata.FromOutgoingContext(ctx)
        if !ok {
            md = metadata.MD{}
        }

        // Inject trace context
        propagator := otel.GetTextMapPropagator()
        propagator.Inject(ctx, metadataCarrier(md))

        // Add metadata to context
        ctx = metadata.NewOutgoingContext(ctx, md)

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}

// UnaryServerInterceptor extracts trace context from incoming gRPC calls
func UnaryServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Extract metadata
        md, ok := metadata.FromIncomingContext(ctx)
        if ok {
            // Extract trace context
            propagator := otel.GetTextMapPropagator()
            ctx = propagator.Extract(ctx, metadataCarrier(md))
        }

        // Create span
        tracer := otel.Tracer("grpc-server")
        ctx, span := tracer.Start(ctx, info.FullMethod)
        defer span.End()

        return handler(ctx, req)
    }
}

type metadataCarrier metadata.MD

func (m metadataCarrier) Get(key string) string {
    values := metadata.MD(m).Get(key)
    if len(values) > 0 {
        return values[0]
    }
    return ""
}

func (m metadataCarrier) Set(key, value string) {
    metadata.MD(m).Set(key, value)
}

func (m metadataCarrier) Keys() []string {
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    return keys
}
```

### Junior → FAANG: The Single Most Common Trace Bug in Go Services

The single most common tracing bug in Go microservices inside a mesh is creating an outbound request without propagating context:

```go
// This breaks the trace silently
req, _ := http.NewRequest("GET", url, nil)
resp, _ := client.Do(req)
```

The bug is silent because each hop still produces spans. The Jaeger UI shows multiple traces instead of one unified trace. The symptom is "I can see spans in Jaeger but cannot connect them to the original request." This is almost always a missing `propagator.Inject` call.

The fix is mechanical and should be a team code-review checklist item: every `http.NewRequest` call inside a handler must be followed by context injection before the `Do` call. Using `http.NewRequestWithContext(ctx, ...)` instead of `http.NewRequest` is a prerequisite, not a sufficient fix, because passing `ctx` to the request does not automatically inject headers.

For gRPC, the equivalent mistake is creating a client without the `otelgrpc` interceptors. The OpenTelemetry gRPC instrumentation library (`go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc`) provides `otelgrpc.UnaryClientInterceptor()` and `otelgrpc.StreamClientInterceptor()` that handle propagation automatically. Prefer these over hand-rolling the `metadataCarrier` pattern unless you have a specific reason to control propagation behavior.

Header format note: Istio uses W3C `traceparent` by default as of Istio 1.18+. Older Istio versions used B3 single-header or B3 multi-header. If your traces are still broken after adding propagation, verify that the OTel propagator format matches what Istio is configured to emit. Configuring both (`propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, b3.New())`) handles both formats without overhead.

### Senior @ FAANG: Trace Sampling Strategy, Head vs Tail Sampling, and Trace Data Volume at Scale

At FAANG scale, tracing is not a checkbox. It is a data engineering problem. At ten thousand requests per second, 100% trace sampling produces millions of spans per minute. The storage, ingestion, and query cost of that volume is significant. Senior engineers must make deliberate decisions about sampling strategy.

**Head sampling.** Istio's default is probabilistic head sampling at the edge: the first proxy in the chain makes a sampling decision and propagates it via the `x-b3-sampled` or `traceparent` `sampled` flag. All downstream proxies and application code honor that decision. The downside is that the sampling decision is made before any error has occurred, so slow or failed requests are sampled at the same rate as healthy ones, which is the exact opposite of what you want.

**Tail sampling.** Tail sampling buffers spans until the entire trace is complete, then makes the sampling decision based on the full trace: always sample traces with errors, always sample traces above a latency threshold, sample a small percentage of healthy traces for baseline coverage. The OpenTelemetry Collector has a `tailsampling` processor that implements this. The infrastructure cost is that the Collector must hold in-memory state for every in-flight trace for the duration of the tail sampling window (typically 30 to 60 seconds), which requires significant memory at high request rates. The architecture is: all spans go to the Collector, the Collector applies tail sampling, only the sampled traces reach Tempo or Jaeger.

**Exemplars as a bridge.** In environments where full tail sampling is too expensive, exemplars provide a middle ground. Prometheus exemplars attach a trace ID to a specific metric sample. When an SRE sees an anomaly in a Grafana dashboard (a latency spike at a particular time), they click the exemplar point and jump directly to the trace for that exact request. This requires: Prometheus exemplar storage enabled (experimental but stable in 2026), the Go service emitting exemplars via `prometheus.NewHistogramVec` with exemplar support, and the tracing backend accepting the trace ID for lookup. The net effect is that you capture 100% of metrics and a small percentage of traces, but you can find the trace for any anomalous metric data point.

**Span cardinality as a first-class concern.** The `otel.Tracer` span name should be a fixed string (the route pattern, not the URL). Using `r.URL.Path` as the span name creates one distinct span name per unique URL, which is a cardinality explosion for paths with IDs (`/users/12345`, `/users/67890`). The platform team should publish a naming convention and enforce it via a lint rule in the internal OTel wrapper library.

---
