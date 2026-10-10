## 103.2 Distributed Tracing

### Setting Up Tracing

Distributed tracing captures the causal chain of operations across service boundaries, enabling pinpoint identification of latency sources in complex microservice interactions. `InitTracer` configures an OTLP HTTP exporter, attaches service identity via `semconv` resource attributes, and installs a `TraceContext` + `Baggage` composite propagator so that W3C `traceparent` headers flow automatically across outbound HTTP calls.

```go
package telemetry

import (
    "context"
    "errors"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
    "go.opentelemetry.io/otel/trace"
)

type TracerConfig struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string
    SampleRate     float64
}

func InitTracer(ctx context.Context, cfg TracerConfig) (func(context.Context) error, error) {
    // Create OTLP exporter
    exporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(cfg.OTLPEndpoint),
        otlptracehttp.WithInsecure(), // Use WithTLSClientConfig for production
    )
    if err != nil {
        return nil, err
    }

    // Create resource with service information
    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(cfg.ServiceName),
            semconv.ServiceVersion(cfg.ServiceVersion),
            attribute.String("environment", cfg.Environment),
        ),
    )
    // resource.Default carries the schema URL of the semconv version the SDK
    // was built with. If it differs from ours, Merge still returns a usable
    // resource alongside ErrSchemaURLConflict, so tolerate that specific error.
    if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
        return nil, err
    }

    // Create sampler
    var sampler sdktrace.Sampler
    if cfg.SampleRate >= 1.0 {
        sampler = sdktrace.AlwaysSample()
    } else if cfg.SampleRate <= 0 {
        sampler = sdktrace.NeverSample()
    } else {
        sampler = sdktrace.TraceIDRatioBased(cfg.SampleRate)
    }

    // Create tracer provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter,
            sdktrace.WithBatchTimeout(5*time.Second),
            sdktrace.WithMaxExportBatchSize(512),
        ),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(sampler)),
    )

    // Set global tracer provider
    otel.SetTracerProvider(tp)

    // Set global propagator
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    // Return shutdown function
    return tp.Shutdown, nil
}

// GetTracer returns a named tracer
func GetTracer(name string) trace.Tracer {
    return otel.Tracer(name)
}
```

### Creating Spans

With the provider in place, the next step is creating spans in application code. The service-layer example shows how to start a child span with `tracer.Start`, record attributes such as `user.id`, and pair `span.RecordError` with `span.SetStatus` to mark a span as failed, while deferring `span.End` to guarantee the span is always closed even on early returns.

```go
package service

import (
    "context"
    "fmt"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("myapp/service")

type UserService struct {
    repo UserRepository
}

func (s *UserService) GetUser(ctx context.Context, userID string) (*User, error) {
    // Start a span
    ctx, span := tracer.Start(ctx, "UserService.GetUser",
        trace.WithAttributes(
            attribute.String("user.id", userID),
        ),
        trace.WithSpanKind(trace.SpanKindInternal),
    )
    defer span.End()

    // Add event
    span.AddEvent("fetching user from database")

    // Call repository
    user, err := s.repo.FindByID(ctx, userID)
    if err != nil {
        // Record error
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, fmt.Errorf("get user: %w", err)
    }

    // Add more attributes after operation
    span.SetAttributes(
        attribute.String("user.email", user.Email),
        attribute.Bool("user.verified", user.Verified),
    )

    span.SetStatus(codes.Ok, "user fetched successfully")
    return user, nil
}

func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    ctx, span := tracer.Start(ctx, "UserService.CreateUser",
        trace.WithAttributes(
            attribute.String("user.email", req.Email),
        ),
    )
    defer span.End()

    // Validate
    if err := s.validate(ctx, req); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "validation failed")
        return nil, err
    }

    // Create user in database
    user, err := s.repo.Create(ctx, req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "database error")
        return nil, err
    }

    // Add result attributes
    span.SetAttributes(attribute.String("user.id", user.ID))

    // Send welcome email (creates child span)
    if err := s.sendWelcomeEmail(ctx, user); err != nil {
        // Log error but don't fail
        span.AddEvent("failed to send welcome email",
            trace.WithAttributes(attribute.String("error", err.Error())),
        )
    }

    span.SetStatus(codes.Ok, "user created")
    return user, nil
}

func (s *UserService) validate(ctx context.Context, req CreateUserRequest) error {
    ctx, span := tracer.Start(ctx, "UserService.validate")
    defer span.End()

    // Validation logic...
    return nil
}

func (s *UserService) sendWelcomeEmail(ctx context.Context, user *User) error {
    ctx, span := tracer.Start(ctx, "UserService.sendWelcomeEmail",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    // Email sending logic...
    return nil
}
```

### Junior → FAANG: Context Propagation Is Not Optional

Many engineers treat tracing as a debugging tool they add retroactively. At FAANG, distributed tracing is a first-class requirement from day one because without it, you cannot diagnose latency regressions in a multi-service system. The key habit to build is automatic propagation discipline: every outbound HTTP call must go through `otelhttp.NewTransport`, every gRPC call must use `otelgrpc` interceptors, and every message queue publish must manually inject the trace context into message headers.

The most common mistake is forgetting to pass the child context. When you call `tracer.Start(ctx, "operation")`, the returned `childCtx` contains the new span. If you pass the original `ctx` to downstream functions instead of `childCtx`, those functions create spans that are not children of the current span, which produces a broken trace forest instead of a tree.

Interview entry point: "How does the `traceparent` header work?" It encodes four fields: version, trace ID (128-bit), parent span ID (64-bit), and trace flags (sampled bit). Understanding this format shows you can reason about cross-service propagation failures, for example when a proxy or load balancer strips headers it does not recognize.

### Senior @ FAANG: Trace Data as an Operational Contract Between Teams

**Trace schemas as APIs.** At L6 and above, a distributed trace is not just a debugging artifact: it is an operational contract between service teams. The attributes on spans produced by service A are consumed by dashboards, SLO burn-rate alerts, and on-call runbooks owned by teams B, C, and D. Breaking that attribute schema (renaming `http.method` to `request.method`, for example) is a breaking change that requires a deprecation notice, a migration period with both attribute names emitted, and a coordinated dashboard update. Senior engineers establish and enforce these schemas in the same way platform teams manage API versioning.

**Trace-based testing.** Beyond manual inspection, a mature observability platform uses traces as test assertions. In integration tests, a `tracetest.SpanRecorder` captures all spans produced during a test run, and assertions verify that the database span has the correct `db.statement` attribute, that the external HTTP call span has the expected status code, and that no unexpected fan-out occurred. This approach catches instrumentation regressions before they reach production.

**Sampling as a cost and fidelity trade-off.** Head-based sampling (deciding at the root span whether to sample the trace) is simple but blind: it discards error traces at the same rate as healthy ones. Tail-based sampling (deciding after the full trace is collected) preserves 100% of error and high-latency traces at the cost of stateful infrastructure in the Collector. A senior engineer can articulate which workloads justify the operational complexity of tail sampling. For a payment service where every error represents a failed transaction, tail sampling is non-negotiable. For a high-volume logging service, head sampling at 0.1% is sufficient.

**Baggage propagation and PII risk.** The `Baggage` propagation mechanism allows arbitrary key-value pairs to flow across service boundaries in headers. This is useful for feature flag context or tenant IDs, but it is a PII leak vector if used carelessly. A senior engineer establishes a Baggage allowlist enforced by a Collector attribute processor that strips any baggage key not on the approved list before data reaches the backend. This governance prevents a developer from accidentally propagating a user email or session token into traces stored in a third-party backend.

---
