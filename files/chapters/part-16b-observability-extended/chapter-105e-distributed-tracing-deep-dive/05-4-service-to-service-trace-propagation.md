## 105E.5 Service-to-Service Trace Propagation

Distributed tracing only produces complete end-to-end traces when each service propagates the W3C `traceparent` header (or B3 for legacy systems) to every downstream call. The propagation helpers below show the correct pattern for both HTTP and gRPC: injecting trace context into outbound request headers and extracting it from inbound requests to continue the same trace across service boundaries. Missing propagation is the most common reason traces appear as disconnected single-service spans in Jaeger or Tempo.

```go
package propagation

import (
	"context"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// HTTPTracingMiddleware extracts and injects trace context for HTTP servers
func HTTPTracingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract incoming trace context
		ctx := otel.GetTextMapPropagator().Extract(
			r.Context(),
			propagation.HeaderCarrier(r.Header),
		)

		// Expose the trace ID to clients for support correlation
		span := trace.SpanFromContext(ctx)
		if span.IsRecording() {
			w.Header().Set("X-Trace-ID", span.SpanContext().TraceID().String())
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GRPCTracingInterceptor adds tracing to gRPC servers
func GRPCTracingInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		// Extract trace context from gRPC metadata
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			md = metadata.New(nil)
		}

		ctx = otel.GetTextMapPropagator().Extract(ctx, metadataCarrier(md))
		return handler(ctx, req)
	}
}

// GRPCClientTracingInterceptor injects trace context into gRPC client calls
func GRPCClientTracingInterceptor() grpc.UnaryClientInterceptor {
	return func(
		ctx context.Context,
		method string,
		req, reply any,
		cc *grpc.ClientConn,
		invoker grpc.UnaryInvoker,
		opts ...grpc.CallOption,
	) error {
		// Inject trace context into outgoing gRPC metadata.
		// Copy before modifying: the returned MD is shared.
		md, ok := metadata.FromOutgoingContext(ctx)
		if !ok {
			md = metadata.New(nil)
		} else {
			md = md.Copy()
		}

		otel.GetTextMapPropagator().Inject(ctx, metadataCarrier(md))
		ctx = metadata.NewOutgoingContext(ctx, md)

		return invoker(ctx, method, req, reply, cc, opts...)
	}
}

// metadataCarrier implements TextMapCarrier for gRPC metadata
type metadataCarrier metadata.MD

func (m metadataCarrier) Get(key string) string {
	vals := metadata.MD(m).Get(key)
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

func (m metadataCarrier) Set(key, val string) {
	metadata.MD(m).Set(key, val)
}

func (m metadataCarrier) Keys() []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// KafkaTracingMiddleware adds trace propagation to Kafka messages
type KafkaTracingMiddleware struct {
	tracer trace.Tracer
}

// NewKafkaTracingMiddleware creates Kafka tracing middleware
func NewKafkaTracingMiddleware(tracer trace.Tracer) *KafkaTracingMiddleware {
	return &KafkaTracingMiddleware{tracer: tracer}
}

// InjectTraceIntoHeaders adds trace context to Kafka message headers
func (m *KafkaTracingMiddleware) InjectTraceIntoHeaders(
	ctx context.Context,
	headers map[string][]byte,
) {
	carrier := kafkaCarrier(headers)
	otel.GetTextMapPropagator().Inject(ctx, carrier)
}

// ExtractTraceFromHeaders extracts trace context from Kafka message headers
func (m *KafkaTracingMiddleware) ExtractTraceFromHeaders(
	ctx context.Context,
	headers map[string][]byte,
) context.Context {
	carrier := kafkaCarrier(headers)
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

// WrapConsume wraps a Kafka message handler with tracing
func (m *KafkaTracingMiddleware) WrapConsume(
	topic string,
	headers map[string][]byte,
	handler func(ctx context.Context) error,
) error {
	ctx := m.ExtractTraceFromHeaders(context.Background(), headers)

	ctx, span := m.tracer.Start(ctx,
		fmt.Sprintf("kafka.consume %s", topic),
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination.name", topic),
			attribute.String("messaging.operation", "receive"),
		),
	)
	defer span.End()

	if err := handler(ctx); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return err
	}

	return nil
}

type kafkaCarrier map[string][]byte

func (c kafkaCarrier) Get(key string) string {
	if v, ok := c[key]; ok {
		return string(v)
	}
	return ""
}

func (c kafkaCarrier) Set(key, val string) {
	c[key] = []byte(val)
}

func (c kafkaCarrier) Keys() []string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	return keys
}
```

### Junior → FAANG: Context Propagation Is the Most Common Source of Broken Traces

The most frequent instrumentation mistake at the junior level is losing the context between service calls. Every time a goroutine is spawned, the context must be passed explicitly to that goroutine. Every time an HTTP client call is made, the outgoing context must be used to inject the trace headers. Every time a message is placed on a queue, the trace context must be serialized into the message metadata. Failing any one of these produces a trace where the receiving service starts a new root span with no parent, making the cross-service relationship invisible.

The W3C `traceparent` header format is worth memorizing: `00-<trace-id>-<span-id>-<flags>`. The trace ID is 32 hex characters (16 bytes), the span ID is 16 hex characters (8 bytes), and the flags byte encodes the sampling decision (01 = sampled, 00 = not sampled). If you can read a raw `traceparent` header and explain each field, you demonstrate a depth of understanding that most engineers who use OTel never develop.

### Senior @ FAANG: Propagation Format Governance and Multi-Protocol Context Injection

At L6, context propagation format selection is a governance decision with multi-year consequences. W3C TraceContext (`traceparent`/`tracestate`) is the standard for new systems and should be the default for all new services. B3 (Zipkin's format, both single-header and multi-header variants) exists in legacy systems and service meshes like Istio that predate the W3C standard. A large organization running a mix of old and new services needs a propagation strategy that handles both formats during migration without breaking traces at the boundary.

The OTel Composite propagator handles this by configuring both propagators in order: the first propagator to successfully extract a parent wins. However, the injection order matters: injecting both formats means every outgoing request carries two sets of headers, doubling the propagation overhead per service hop. For services with high fanout (one request triggers 50 downstream calls), this overhead accumulates. The platform team should document a migration timeline and decommission B3 injection once all services have migrated to W3C.

For async messaging systems (Kafka, RabbitMQ, SQS), the propagation is not automatic. A message produced to Kafka with trace context injected into the message headers will not automatically create a child span in the consumer unless the consumer explicitly extracts those headers. The OTel semantic conventions define a `messaging.message.id` attribute and span kind `CONSUMER` for this pattern. Platform teams must provide a shared consumer wrapper that handles extraction automatically, because relying on individual service teams to implement it correctly across 200 services guarantees inconsistent coverage.

---
