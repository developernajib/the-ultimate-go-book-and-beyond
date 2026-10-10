## 103.15 Production Pitfalls: OpenTelemetry Mistakes

### Pitfall 1: Sampling Everything in Production

**Real Incident Report**: A team enabled 100% trace sampling in production to "debug an issue." Within hours, the observability backend was overwhelmed with data, daily ingest cost jumped by an order of magnitude, and ironically, the tracing system itself became too slow to use for debugging.

**The Anti-Pattern**:
```go
// WRONG: 100% sampling in production
tp := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.AlwaysSample()), // Everything sampled!
)
// 1M requests/day = 1M traces = $$$
```

**The Better Approach**:
```go
// RIGHT: Intelligent sampling
tp := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.ParentBased(
        // Sample 1% of traces by default
        sdktrace.TraceIDRatioBased(0.01),
    )),
)

// For critical paths, sample more:
// Use parent-based sampling to ensure consistent decisions

// For high-volume endpoints, sample less:
// Configure per-endpoint sampling in your collector
```

**Key Insight**: 1% sampling is often enough to find issues. 100% sampling is for debugging, not production.

### Pitfall 2: High-Cardinality Span Attributes

**Real Incident Report**: A team added `user_id` as a span attribute. With millions of users, the tracing backend's index exploded, queries became slow, and storage costs ballooned. The attribute was meant to help debugging but made the system unusable.

**The Anti-Pattern**:
```go
// WRONG: High-cardinality attributes
span.SetAttributes(
    attribute.String("user_id", userID),           // 10M unique values
    attribute.String("request_id", requestID),     // Infinite cardinality
    attribute.String("session_id", sessionID),     // Very high cardinality
)
```

**The Better Approach**:
```go
// RIGHT: Low-cardinality attributes for indexing
span.SetAttributes(
    attribute.String("user_tier", user.Tier),      // premium/free/trial
    attribute.String("region", user.Region),       // ~20 regions
    attribute.String("feature", featureName),      // ~50 features
    attribute.String("error_type", errType),       // ~20 error types
)

// Put high-cardinality data in span events (not indexed)
span.AddEvent("request_details", trace.WithAttributes(
    attribute.String("user_id", userID),           // For debugging, not indexing
    attribute.String("request_id", requestID),
))
```

**Key Insight**: Attributes are for filtering and grouping. High-cardinality values go in events or logs, not attributes.

### Pitfall 3: Not Propagating Context

**Real Incident Report**: A service was instrumented with OpenTelemetry, but traces showed disconnected spans. Requests to downstream services appeared as separate traces. The issue: HTTP clients weren't propagating trace context in headers.

**The Anti-Pattern**:
```go
// WRONG: Using standard http.Client
resp, err := http.Get("http://downstream/api")
// No trace context propagated - downstream starts new trace
```

**The Better Approach**:
```go
// RIGHT: Wrap client with otelhttp
client := &http.Client{
    Transport: otelhttp.NewTransport(http.DefaultTransport),
}
resp, err := client.Get("http://downstream/api")
// Trace context automatically propagated in headers

// Or manually propagate:
req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
resp, err := client.Do(req)
```

**Key Insight**: Distributed tracing only works if every service propagates context. One broken link breaks the whole trace.

### Pitfall 4: Ignoring Resource Attributes

**Real Incident Report**: A team had traces from multiple services but couldn't tell which instance produced which trace. Service name was missing, so filtering by service was impossible. They had data but couldn't use it.

**The Anti-Pattern**:
```go
// WRONG: No resource attributes
tp := sdktrace.NewTracerProvider(
    sdktrace.WithSampler(sdktrace.AlwaysSample()),
)
// Traces have no service.name, service.version, etc.
```

**The Better Approach**:
```go
// RIGHT: Complete resource attributes
res, _ := resource.Merge(
    resource.Default(),
    resource.NewWithAttributes(
        semconv.SchemaURL,
        semconv.ServiceName("user-service"),
        semconv.ServiceVersion(version),
        semconv.DeploymentEnvironment("production"),
        attribute.String("team", "platform"),
        attribute.String("region", os.Getenv("AWS_REGION")),
    ),
)

tp := sdktrace.NewTracerProvider(
    sdktrace.WithResource(res),
    sdktrace.WithSampler(sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(0.01),
    )),
)
```

**Key Insight**: Resource attributes identify WHAT generated the telemetry. Without them, you have data but no context.

### Pitfall 5: Synchronous Exporting Blocking Requests

**Real Incident Report**: A service had p99 latency spikes every few seconds. Investigation revealed: the tracer provider was wired with the simple span processor, which exports synchronously on every span end, in the request path. When the collector was slow, requests waited.

**The Anti-Pattern**:
```go
// WRONG: Simple (synchronous) span processor in production
exporter, _ := otlptracegrpc.New(ctx)
tp := sdktrace.NewTracerProvider(
    sdktrace.WithSyncer(exporter), // Exports on every span.End, on the hot path
)
// If the collector is slow, every request pays the export latency
```

**The Better Approach**:
```go
// RIGHT: Configured async exporter with limits
exporter, _ := otlptracegrpc.New(ctx,
    otlptracegrpc.WithTimeout(5*time.Second),
    otlptracegrpc.WithRetry(otlptracegrpc.RetryConfig{
        Enabled:         true,
        InitialInterval: 500 * time.Millisecond,
        MaxInterval:     5 * time.Second,
        MaxElapsedTime:  30 * time.Second,
    }),
)

tp := sdktrace.NewTracerProvider(
    sdktrace.WithBatcher(exporter,
        sdktrace.WithBatchTimeout(5*time.Second),
        sdktrace.WithMaxExportBatchSize(512),
        sdktrace.WithMaxQueueSize(2048),
        sdktrace.WithExportTimeout(30*time.Second),
    ),
)

// Also: handle shutdown gracefully
defer func() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    tp.Shutdown(ctx)  // Flush remaining spans
}()
```

**Key Insight**: Telemetry should never block business logic. Configure timeouts, queue limits, and graceful shutdown.

### Pitfall 6: The "Trace Everything" Illusion vs Dependency Attribution

**Real Incident Report**: A team instrumented every single internal Go helper function with OpenTelemetry spans. Under production load, tracing overhead consumed 18% of CPU cycles and generated millions of micro-spans (e.g., `string.format`, `validate_struct`). Yet during a P0 latency incident, the dashboard failed to answer whether latency originated in MySQL connection stalls, Redis timeouts, or upstream gateway latency.

As demonstrated in [I Rebuilt Observability in Our Go Services - Here’s What Happened to Logs, Traces, and Metrics](https://medium.com/@author/i-rebuilt-observability-in-our-go-services-here-s-what-happened-to-logs-traces-and-metrics) by Renaldi Purwanto, decorative tracing obscures critical diagnostics:

**The Better Approach - Delineate the 5 Golden Spans**:
Focus tracing strictly on architectural boundaries that explain latency and failure:
1. **Inbound Transport**: Root HTTP / gRPC request span.
2. **Database Queries**: Transactions, slow queries (`db.system`, `db.statement.sanitized`).
3. **Outbound Clients**: Third-party HTTP APIs and RPCs with injected context headers.
4. **Asynchronous Brokers**: Queue publish and consumer message extraction.
5. **Heavy Isolated Computation**: Cryptographic hashing, large JSON deserialization (>10MB).

```go
// Clean span creation at external dependency boundary
func callPaymentGateway(ctx context.Context, client *http.Client, payload []byte) (*http.Response, error) {
    ctx, span := tracer.Start(ctx, "payment_client.process_charge",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("peer.service", "stripe"),
            attribute.String("http.method", http.MethodPost),
        ),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.stripe.com/v1/charges", bytes.NewReader(payload))
    if err != nil {
        span.RecordError(err)
        return nil, err
    }

    resp, err := client.Do(req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))
    return resp, nil
}
```

### Pitfall 7: The Unbuffered Timeout Channel & Abandoned Goroutine Leak

**Real Incident Report**: A worker pool consumed jobs and dispatched them with a 2-second timeout. Over 72 hours, the service suffered an exponential memory and goroutine climb, eventually crashing with an OOM.

As diagnosed in [The Production Incidents That Changed How We Write Go](https://medium.com/@yaninyzwitty/the-go-patterns-that-everyone-copies-and-why-it-) by Yaninyz witty, the dispatch routine contained an unbuffered channel and an untracked inner goroutine:

**The Anti-Pattern**:
```go
// WRONG: Unbuffered channel + uncancelled inner worker
func dispatch(ctx context.Context, handler func() error) {
    done := make(chan error) // Unbuffered!
    go func() {
        done <- handler() // Blocks forever if timeout occurs before completion!
    }()

    select {
    case err := <-done:
        if err != nil { log.Printf("err: %v", err) }
    case <-time.After(2 * time.Second):
        log.Println("handler timed out") // Abandoned goroutine leaks forever
    }
}
```

When `time.After` fires at t = 2s, the function returns. The background goroutine eventually finishes its slow database query and attempts to send to `done <-`. Because `done` is unbuffered and has no receiver, the goroutine blocks forever. Every timeout permanently leaks 1 goroutine, its stack memory, and associated database connection sockets.

**The Better Approach**:
1. Always buffer the completion channel by at least 1 (`make(chan error, 1)`).
2. Thread `ctx` directly into the worker so slow operations abort when the caller times out.

```go
// RIGHT: Buffered channel + cancellation propagation
func dispatch(ctx context.Context, handler func(context.Context) error) error {
    ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    done := make(chan error, 1) // Buffered: send never blocks even if receiver exits
    go func() {
        done <- handler(ctx)
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

### Quick Reference: OpenTelemetry Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| 100% sampling | Runaway ingest cost, slow queries | 1-10% sampling, adjust per-endpoint |
| High-cardinality attributes | Slow queries, storage explosion | Use events for user_id, request_id |
| No context propagation | Disconnected spans | otelhttp.NewTransport, inject headers |
| Missing resources | Can't filter by service | Add service.name, version, environment |
| Sync exporting | Latency spikes | Batch with timeouts, queue limits |
| No graceful shutdown | Lost spans on deploy | tp.Shutdown() with timeout |
| Decorative tracing | High CPU, unhelpful traces | Delineate the 5 Golden Spans (DB, client, RPC) |
| Unbuffered timeout channel | Goroutine & socket leak | `make(chan error, 1)` and thread cancellable `ctx` |

### Junior → FAANG: Avoiding the Five Most Common OTel Bugs

The pitfalls table above summarizes failure modes that appear repeatedly in code reviews. For interviews, being able to diagnose these from a symptom is more valuable than memorizing the list.

**Symptom: all spans appear as separate root traces.** Cause: context propagation dropped, either by using `context.Background()` instead of the request context, or by failing to use `otelhttp.NewTransport` for outbound calls. Fix: grep for `context.Background()` in handlers and replace with the request context.

**Symptom: Prometheus query returns too many time series.** Cause: high-cardinality attribute used as a metric label. Common offenders: user ID, request ID, session token, raw URL path. Fix: remove the label or replace it with a bucketed approximation.

**Symptom: spans lost on deployment.** Cause: missing `tp.Shutdown()` call in signal handler. The SDK buffers unsent spans in the batch processor. A SIGTERM that skips Shutdown discards that buffer. Fix: register a graceful shutdown handler that calls `tp.Shutdown(ctx)` with a reasonable timeout (5 seconds).

### Senior @ FAANG: Pitfall Prevention Through Platform Enforcement

At L6 and above, preventing pitfalls is a platform responsibility, not an individual developer responsibility. If a pitfall can be prevented by a lint rule, it should be. If it can be prevented by a shared library default, it must be.

**High-cardinality prevention via static analysis.** Write a custom `go vet` analyzer that detects calls to `attribute.String("user_id", ...)` or `attribute.String("request_id", ...)` in metric label contexts. These are the most common sources of cardinality explosions and they are mechanically detectable. The analyzer runs in CI and blocks merges that introduce new high-cardinality metric labels without an explicit exemption approved by the platform team.

**Context propagation enforcement.** A shared `httputil` package wraps `http.NewRequest` to automatically use `otelhttp.NewTransport` and inject the current context. Developers who use `httputil.NewRequest(ctx, ...)` get correct trace propagation for free. The package is added to the internal linter as the required way to make HTTP requests, and direct use of `http.NewRequest` in handler code generates a lint warning.

**Graceful shutdown as a framework feature.** The shared service framework (the `main.go` template all services start from) includes a shutdown handler that calls `tp.Shutdown()`, `mp.Shutdown()`, and `lp.Shutdown()` with a 5-second deadline before calling `os.Exit`. Individual service teams cannot accidentally omit this because it is not in their code at all: it is in the framework that wraps their service.

**Pitfall post-mortems driving platform improvements.** When a production incident is caused by an OTel misconfiguration (high-cardinality metric causing storage saturation, missing context propagation causing blind spot in a trace), the post-mortem action item is not just "fix the service" but "prevent this class of mistake platform-wide." This feedback loop from incidents to platform improvements is an L6-level contribution that benefits all teams simultaneously.

---
