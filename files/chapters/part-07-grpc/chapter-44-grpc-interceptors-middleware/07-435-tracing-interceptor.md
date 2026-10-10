## 44.5 Tracing Interceptor

### OpenTelemetry Integration

The tracing interceptor extracts an incoming trace context from gRPC metadata, starts a child span for the RPC, and injects the span into the Go context so downstream database calls and HTTP requests inherit the same trace. Setting span attributes (gRPC method, status code, request size) gives the tracing backend enough data to build a complete call graph across services.

> **Production note (2026).** The hand-written interceptor below is pedagogical - it shows exactly how propagation works. In production, prefer `grpc.StatsHandler(otelgrpc.NewServerHandler(...))` on the server and `grpc.StatsHandler(otelgrpc.NewClientHandler(...))` on the client. StatsHandlers see transport-level events (connection start, per-message size, stream close reasons) that interceptors cannot observe, and they emit OpenTelemetry's RED metrics alongside spans in a single pass. The `otelgrpc.UnaryServerInterceptor` / `otelgrpc.UnaryClientInterceptor` helpers still exist for backward compatibility but are deprecated in favor of the StatsHandler API.

```go
package interceptor

import (
    "context"
    "strings"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    grpcCodes "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

const tracerName = "grpc-server"

// TracingInterceptor adds OpenTelemetry tracing
func TracingInterceptor() grpc.UnaryServerInterceptor {
    tracer := otel.Tracer(tracerName)

    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Extract trace context from incoming metadata
        md, _ := metadata.FromIncomingContext(ctx)
        ctx = otel.GetTextMapPropagator().Extract(ctx, metadataCarrier(md))

        // Start span
        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                attribute.String("rpc.system", "grpc"),
                attribute.String("rpc.service", parseService(info.FullMethod)),
                attribute.String("rpc.method", parseMethod(info.FullMethod)),
            ),
        )
        defer span.End()

        // Handle request
        resp, err := handler(ctx, req)

        // Record error
        if err != nil {
            st, _ := status.FromError(err)
            span.SetStatus(codes.Error, st.Message())
            span.SetAttributes(
                attribute.String("rpc.grpc.status_code", st.Code().String()),
            )
        } else {
            span.SetStatus(codes.Ok, "")
            span.SetAttributes(
                attribute.String("rpc.grpc.status_code", grpcCodes.OK.String()),
            )
        }

        return resp, err
    }
}

// StreamTracingInterceptor adds tracing to streaming RPCs
func StreamTracingInterceptor() grpc.StreamServerInterceptor {
    tracer := otel.Tracer(tracerName)

    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        ctx := ss.Context()
        md, _ := metadata.FromIncomingContext(ctx)
        ctx = otel.GetTextMapPropagator().Extract(ctx, metadataCarrier(md))

        ctx, span := tracer.Start(ctx, info.FullMethod,
            trace.WithSpanKind(trace.SpanKindServer),
            trace.WithAttributes(
                attribute.String("rpc.system", "grpc"),
                attribute.Bool("rpc.grpc.client_stream", info.IsClientStream),
                attribute.Bool("rpc.grpc.server_stream", info.IsServerStream),
            ),
        )
        defer span.End()

        wrapped := &tracingServerStream{
            ServerStream: ss,
            ctx:          ctx,
        }

        err := handler(srv, wrapped)

        if err != nil {
            st, _ := status.FromError(err)
            span.SetStatus(codes.Error, st.Message())
        } else {
            span.SetStatus(codes.Ok, "")
        }

        return err
    }
}

type tracingServerStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (s *tracingServerStream) Context() context.Context {
    return s.ctx
}

// metadataCarrier implements propagation.TextMapCarrier
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

func parseService(method string) string {
    // /package.Service/Method -> package.Service
    method = strings.TrimPrefix(method, "/")
    if i := strings.LastIndex(method, "/"); i >= 0 {
        return method[:i]
    }
    return method
}

func parseMethod(method string) string {
    // /package.Service/Method -> Method
    if i := strings.LastIndex(method, "/"); i >= 0 {
        return method[i+1:]
    }
    return method
}
```

### Junior -> FAANG: Trace Context Propagation Step by Step

Distributed tracing is one of those topics where junior engineers understand the concept (follow a request across services) but stumble on the mechanics (how does trace context actually move between services?).

The mechanics in gRPC are: the client interceptor starts a span, calls `propagator.Inject(ctx, carrier)` to write the trace context into gRPC metadata (the carrier), and sends the RPC. The server interceptor calls `propagator.Extract(ctx, carrier)` to read the trace context from the incoming metadata and recreates the context with the parent span. Then it calls `tracer.Start(ctx, ...)` which automatically links the new span as a child of the extracted parent. Without the extract step on the server, every server span is a root span and you get isolated spans instead of a trace tree.

The `metadataCarrier` type is the glue. gRPC metadata is `map[string][]string`. The W3C Trace Context propagator writes `traceparent` and `tracestate` keys. The carrier bridges these two APIs.

For FAANG interviews: be able to draw the span relationship. Client sends RPC: client creates span A (SpanKindClient). Server receives RPC: server creates span B (SpanKindServer) with parent = span A. If the handler calls a database, that creates span C with parent = span B. The interviewer will ask what the span tree looks like and how to identify the parent-child relationship in the tracing UI.

Also understand why `defer span.End()` is placed immediately after `tracer.Start()`. Placing it anywhere else risks the span not being ended if the function returns early (for example, on auth failure). The defer guarantees the span is always closed even on error paths.

### Senior @ FAANG: Tracing Infrastructure and Sampling Strategy

**StatsHandler vs interceptor for tracing (repeated for emphasis):** The production note in the section is critical. `otelgrpc.NewServerHandler()` used as a `stats.Handler` is the correct approach in 2026. The pedagogical interceptor in this section shows how propagation works, which is essential knowledge. But deploying a hand-rolled tracing interceptor alongside `otelgrpc` in production creates duplicate spans, corrupted parent-child relationships, and inflated trace storage costs. The ADR for your platform should specify: `stats.Handler` for standard gRPC tracing, interceptors only for custom span attributes that `otelgrpc` does not emit.

**Sampling strategy is a platform decision, not a service decision:** Head-based sampling (decide at the first service whether to sample this trace) produces consistent traces (all spans for a sampled trace are present) but misses rare errors (a 0.01% error rate means most error traces are not sampled at 1% sampling). Tail-based sampling (decide at the collector after seeing all spans for a trace) captures all errors but requires the collector to buffer all spans for a trace window (typically 30 seconds), which is expensive at high volume. Most FAANG-scale systems use a hybrid: 1-5% head-based sampling for normal traffic, 100% sampling for error traces (via a custom sampler that checks `rpc.grpc.status_code` on span end). The collector then applies tail-based sampling only for the traces that need it.

**Trace context security:** The `traceparent` header carries the trace ID and sampling flag. If an external caller sends a crafted `traceparent`, they can force your service to sample all their requests (trace flag = 1) or inject a specific trace ID into your traces (enabling trace ID collision attacks). The `otelgrpc` sampler respects incoming `traceflags` by default. A security-conscious platform overrides this: external-facing services always apply head-based sampling decisions locally and never inherit the sampling flag from untrusted callers. Internal service-to-service calls inherit the flag because the caller is trusted. This distinction requires knowing at the interceptor level whether the call is from an external or internal source, which typically comes from the TLS client certificate or a signed header.

**Span attribute governance:** The semantic conventions define which attributes to set on gRPC spans. Beyond the required attributes, teams often want to add business context (tenant ID, feature flag, request size). These additions should go through a review process because span attributes increase trace storage cost and are visible to anyone with access to the tracing backend. PII in span attributes is a compliance violation. The platform should provide a typed API for adding approved custom attributes and block raw `span.SetAttributes()` calls in service code via a static analysis linter.

---
