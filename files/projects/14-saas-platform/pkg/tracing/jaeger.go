// pkg/tracing/jaeger.go
package tracing

import (
    "context"
    "io"
    "net/http"

    "github.com/opentracing/opentracing-go"
    jaeger "github.com/uber/jaeger-client-go"
    "github.com/uber/jaeger-client-go/config"
    "github.com/example/saas-platform/internal/isolation"
)

// InitTracer initializes Jaeger tracer
func InitTracer(serviceName string) (opentracing.Tracer, io.Closer, error) {
    cfg := &config.Configuration{
        ServiceName: serviceName,
        Sampler: &config.SamplerConfig{
            Type:  "const",
            Param: 1,
        },
        Reporter: &config.ReporterConfig{
            LogSpans:           true,
            LocalAgentHostPort: "jaeger:6831",
        },
    }

    tracer, closer, err := cfg.NewTracer(
        config.Logger(jaeger.StdLogger),
    )
    if err != nil {
        return nil, nil, err
    }

    opentracing.SetGlobalTracer(tracer)

    return tracer, closer, nil
}

// TracingMiddleware adds distributed tracing to HTTP requests
type TracingMiddleware struct {
    tracer opentracing.Tracer
}

func NewTracingMiddleware(tracer opentracing.Tracer) *TracingMiddleware {
    return &TracingMiddleware{tracer: tracer}
}

func (m *TracingMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        spanCtx, _ := m.tracer.Extract(
            opentracing.HTTPHeaders,
            opentracing.HTTPHeadersCarrier(r.Header),
        )

        span := m.tracer.StartSpan(
            r.URL.Path,
            opentracing.ChildOf(spanCtx),
            opentracing.Tag{Key: "http.method", Value: r.Method},
            opentracing.Tag{Key: "http.url", Value: r.URL.String()},
        )
        defer span.Finish()

        // Add tenant ID to span
        if tenant, err := isolation.GetTenant(r.Context()); err == nil {
            span.SetTag("tenant_id", tenant.TenantID.String())
        }

        ctx := opentracing.ContextWithSpan(r.Context(), span)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// StartSpan starts a new span from context
func StartSpan(ctx context.Context, operationName string) (opentracing.Span, context.Context) {
    span, ctx := opentracing.StartSpanFromContext(ctx, operationName)
    return span, ctx
}
