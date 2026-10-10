## 103.17 Exercises with Solutions

### Exercise 1: Implement End-to-End Tracing for a Microservice

**Task:** Create a complete traced microservice that calls two downstream services.

**Solution:**

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "log"
    "net/http"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
    "go.opentelemetry.io/otel/trace"
)

var tracer trace.Tracer

func main() {
    ctx := context.Background()

    // Initialize OpenTelemetry
    // WithEndpoint takes host:port without a scheme
    shutdown, err := initTelemetry(ctx, "order-service", "localhost:4318")
    if err != nil {
        log.Fatal(err)
    }
    defer shutdown(ctx)

    tracer = otel.Tracer("order-service")

    // Create instrumented HTTP client for downstream calls
    httpClient := &http.Client{
        Transport: otelhttp.NewTransport(http.DefaultTransport),
        Timeout:   30 * time.Second,
    }

    // Setup handlers
    mux := http.NewServeMux()
    mux.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
        handleCreateOrder(w, r, httpClient)
    })

    // Wrap with OpenTelemetry middleware
    handler := otelhttp.NewHandler(mux, "order-service")

    log.Println("Starting order-service on :8080")
    log.Fatal(http.ListenAndServe(":8080", handler))
}

func initTelemetry(ctx context.Context, serviceName, endpoint string) (func(context.Context) error, error) {
    exporter, err := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(endpoint),
        otlptracehttp.WithInsecure(),
    )
    if err != nil {
        return nil, fmt.Errorf("create exporter: %w", err)
    }

    res, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
            attribute.String("environment", "development"),
        ),
    )
    // Tolerate schema URL conflicts between resource.Default and our semconv pin
    if err != nil && !errors.Is(err, resource.ErrSchemaURLConflict) {
        return nil, fmt.Errorf("create resource: %w", err)
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()), // For development
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Shutdown, nil
}

type OrderRequest struct {
    UserID   string   `json:"user_id"`
    Items    []string `json:"items"`
    Quantity int      `json:"quantity"`
}

type OrderResponse struct {
    OrderID     string `json:"order_id"`
    Status      string `json:"status"`
    TotalCents  int64  `json:"total_cents"`
    Inventory   bool   `json:"inventory_available"`
    PaymentAuth string `json:"payment_auth"`
}

func handleCreateOrder(w http.ResponseWriter, r *http.Request, client *http.Client) {
    ctx := r.Context()

    // Create span for business logic
    ctx, span := tracer.Start(ctx, "CreateOrder",
        trace.WithAttributes(
            attribute.String("http.method", r.Method),
        ),
    )
    defer span.End()

    // Parse request
    var req OrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "invalid request")
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    span.SetAttributes(
        attribute.String("user.id", req.UserID),
        attribute.Int("order.item_count", len(req.Items)),
    )

    // Step 1: Check inventory (downstream call)
    inventoryOK, err := checkInventory(ctx, client, req.Items)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "inventory check failed")
        http.Error(w, "inventory check failed", http.StatusServiceUnavailable)
        return
    }

    // Step 2: Process payment (downstream call)
    paymentAuth, err := processPayment(ctx, client, req.UserID, 9999)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "payment failed")
        http.Error(w, "payment failed", http.StatusPaymentRequired)
        return
    }

    // Create response
    resp := OrderResponse{
        OrderID:     fmt.Sprintf("ORD-%d", time.Now().UnixNano()),
        Status:      "created",
        TotalCents:  9999,
        Inventory:   inventoryOK,
        PaymentAuth: paymentAuth,
    }

    span.SetAttributes(attribute.String("order.id", resp.OrderID))
    span.SetStatus(codes.Ok, "order created")

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func checkInventory(ctx context.Context, client *http.Client, items []string) (bool, error) {
    ctx, span := tracer.Start(ctx, "CheckInventory",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.Int("inventory.items", len(items)),
        ),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, "GET", "http://inventory-service:8081/check", nil)
    if err != nil {
        return false, err
    }

    resp, err := client.Do(req)
    if err != nil {
        span.RecordError(err)
        return false, err
    }
    defer resp.Body.Close()

    span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))

    return resp.StatusCode == http.StatusOK, nil
}

func processPayment(ctx context.Context, client *http.Client, userID string, amountCents int64) (string, error) {
    ctx, span := tracer.Start(ctx, "ProcessPayment",
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            attribute.String("user.id", userID),
            attribute.Int64("payment.amount_cents", amountCents),
        ),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, "POST", "http://payment-service:8082/charge", nil)
    if err != nil {
        return "", err
    }

    resp, err := client.Do(req)
    if err != nil {
        span.RecordError(err)
        return "", err
    }
    defer resp.Body.Close()

    span.SetAttributes(attribute.Int("http.status_code", resp.StatusCode))

    if resp.StatusCode != http.StatusOK {
        return "", fmt.Errorf("payment failed with status %d", resp.StatusCode)
    }

    return fmt.Sprintf("AUTH-%d", time.Now().UnixNano()), nil
}
```

### Exercise 2: Create Custom Metrics with Proper Bucketing

**Task:** Implement custom histogram metrics with appropriate bucket boundaries for an API.

**Solution:**

```go
package metrics

import (
    "context"
    "net/http"
    "sync/atomic"
    "time"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/metric"
)

var meter = otel.Meter("myapp/api")

// APIMetrics holds all API-related metrics
type APIMetrics struct {
    requestDuration   metric.Float64Histogram
    requestSize       metric.Int64Histogram
    responseSize      metric.Int64Histogram
    activeRequests    metric.Int64UpDownCounter
    requestsTotal     metric.Int64Counter
    errorsTotal       metric.Int64Counter
    dbQueryDuration   metric.Float64Histogram
    cacheHitRatio     metric.Float64ObservableGauge
    cacheHits         atomic.Int64
    cacheMisses       atomic.Int64
}

func NewAPIMetrics() (*APIMetrics, error) {
    m := &APIMetrics{}
    var err error

    // Request duration with latency-focused buckets
    // Buckets: 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
    m.requestDuration, err = meter.Float64Histogram(
        "http_request_duration_seconds",
        metric.WithDescription("HTTP request duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
        ),
    )
    if err != nil {
        return nil, err
    }

    // Request size with typical payload sizes
    // Buckets: 100B, 1KB, 10KB, 100KB, 1MB, 10MB
    m.requestSize, err = meter.Int64Histogram(
        "http_request_size_bytes",
        metric.WithDescription("HTTP request body size in bytes"),
        metric.WithUnit("By"),
        metric.WithExplicitBucketBoundaries(
            100, 1024, 10240, 102400, 1048576, 10485760,
        ),
    )
    if err != nil {
        return nil, err
    }

    // Response size with similar buckets
    m.responseSize, err = meter.Int64Histogram(
        "http_response_size_bytes",
        metric.WithDescription("HTTP response body size in bytes"),
        metric.WithUnit("By"),
        metric.WithExplicitBucketBoundaries(
            100, 1024, 10240, 102400, 1048576, 10485760,
        ),
    )
    if err != nil {
        return nil, err
    }

    // Active requests gauge
    m.activeRequests, err = meter.Int64UpDownCounter(
        "http_active_requests",
        metric.WithDescription("Number of active HTTP requests"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    // Total requests counter
    m.requestsTotal, err = meter.Int64Counter(
        "http_requests_total",
        metric.WithDescription("Total number of HTTP requests"),
        metric.WithUnit("{request}"),
    )
    if err != nil {
        return nil, err
    }

    // Errors counter
    m.errorsTotal, err = meter.Int64Counter(
        "http_errors_total",
        metric.WithDescription("Total number of HTTP errors"),
        metric.WithUnit("{error}"),
    )
    if err != nil {
        return nil, err
    }

    // Database query duration with database-specific buckets
    // Buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s
    m.dbQueryDuration, err = meter.Float64Histogram(
        "db_query_duration_seconds",
        metric.WithDescription("Database query duration in seconds"),
        metric.WithUnit("s"),
        metric.WithExplicitBucketBoundaries(
            0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
        ),
    )
    if err != nil {
        return nil, err
    }

    // Cache hit ratio (observable gauge updated periodically)
    m.cacheHitRatio, err = meter.Float64ObservableGauge(
        "cache_hit_ratio",
        metric.WithDescription("Cache hit ratio"),
        metric.WithFloat64Callback(func(ctx context.Context, o metric.Float64Observer) error {
            hits := m.cacheHits.Load()
            total := hits + m.cacheMisses.Load()
            if total == 0 {
                o.Observe(0)
                return nil
            }
            o.Observe(float64(hits) / float64(total))
            return nil
        }),
    )
    if err != nil {
        return nil, err
    }

    return m, nil
}

// Middleware creates HTTP middleware that records metrics
func (m *APIMetrics) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        ctx := r.Context()

        attrs := []attribute.KeyValue{
            attribute.String("method", r.Method),
            attribute.String("path", normalizePath(r.URL.Path)),
        }

        // Track active requests
        m.activeRequests.Add(ctx, 1, metric.WithAttributes(attrs...))
        defer m.activeRequests.Add(ctx, -1, metric.WithAttributes(attrs...))

        // Track request size
        if r.ContentLength > 0 {
            m.requestSize.Record(ctx, r.ContentLength, metric.WithAttributes(attrs...))
        }

        // Wrap response writer to capture status and size
        rw := &responseWriter{ResponseWriter: w, statusCode: 200}
        next.ServeHTTP(rw, r)

        // Record metrics after request completes
        duration := time.Since(start).Seconds()
        statusAttrs := append(attrs, attribute.Int("status_code", rw.statusCode))

        m.requestDuration.Record(ctx, duration, metric.WithAttributes(statusAttrs...))
        m.requestsTotal.Add(ctx, 1, metric.WithAttributes(statusAttrs...))
        m.responseSize.Record(ctx, int64(rw.bytesWritten), metric.WithAttributes(statusAttrs...))

        if rw.statusCode >= 400 {
            m.errorsTotal.Add(ctx, 1, metric.WithAttributes(
                append(statusAttrs, attribute.String("error_class", errorClass(rw.statusCode)))...,
            ))
        }
    })
}

// RecordDBQuery records database query metrics
func (m *APIMetrics) RecordDBQuery(ctx context.Context, operation, table string, duration time.Duration, err error) {
    attrs := []attribute.KeyValue{
        attribute.String("operation", operation),
        attribute.String("table", table),
    }

    if err != nil {
        attrs = append(attrs, attribute.Bool("error", true))
    }

    m.dbQueryDuration.Record(ctx, duration.Seconds(), metric.WithAttributes(attrs...))
}

// RecordCacheAccess records cache hit/miss
func (m *APIMetrics) RecordCacheAccess(hit bool) {
    if hit {
        m.cacheHits.Add(1)
    } else {
        m.cacheMisses.Add(1)
    }
}

type responseWriter struct {
    http.ResponseWriter
    statusCode   int
    bytesWritten int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytesWritten += n
    return n, err
}

// normalizePath converts paths like /users/123 to /users/:id
func normalizePath(path string) string {
    // Implement path normalization to avoid high cardinality
    // E.g., /users/123 → /users/:id
    return path // Simplified for example
}

func errorClass(statusCode int) string {
    switch {
    case statusCode >= 500:
        return "server_error"
    case statusCode >= 400:
        return "client_error"
    default:
        return "unknown"
    }
}
```

### Exercise 3: Build a Log Correlation System

**Task:** Implement structured logging that correlates with traces.

**Solution:**

```go
package logging

import (
    "context"
    "io"
    "log/slog"
    "os"
    "time"

    "go.opentelemetry.io/otel/trace"
)

// ContextHandler wraps slog.Handler to add trace context
type ContextHandler struct {
    slog.Handler
    addSource bool
}

// NewContextHandler creates a new handler with trace correlation
func NewContextHandler(w io.Writer, opts *slog.HandlerOptions) *ContextHandler {
    if opts == nil {
        opts = &slog.HandlerOptions{}
    }

    return &ContextHandler{
        Handler:   slog.NewJSONHandler(w, opts),
        addSource: opts.AddSource,
    }
}

// Handle adds trace context to log records
func (h *ContextHandler) Handle(ctx context.Context, r slog.Record) error {
    // Add trace context if available
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        // Clone before modifying: Record copies share state per the slog contract
        r = r.Clone()
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
            slog.Bool("trace_sampled", span.SpanContext().IsSampled()),
        )
    }

    return h.Handler.Handle(ctx, r)
}

// WithAttrs returns a new handler with additional attributes
func (h *ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &ContextHandler{
        Handler:   h.Handler.WithAttrs(attrs),
        addSource: h.addSource,
    }
}

// WithGroup returns a new handler with a group name
func (h *ContextHandler) WithGroup(name string) slog.Handler {
    return &ContextHandler{
        Handler:   h.Handler.WithGroup(name),
        addSource: h.addSource,
    }
}

// Logger wraps slog.Logger with additional convenience methods
type Logger struct {
    *slog.Logger
}

// NewLogger creates a new correlated logger
func NewLogger(serviceName string) *Logger {
    handler := NewContextHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,
    })

    logger := slog.New(handler).With(
        slog.String("service", serviceName),
    )

    return &Logger{Logger: logger}
}

// WithRequestID adds request ID to log context
func (l *Logger) WithRequestID(requestID string) *Logger {
    return &Logger{
        Logger: l.Logger.With(slog.String("request_id", requestID)),
    }
}

// WithUserID adds user ID to log context
func (l *Logger) WithUserID(userID string) *Logger {
    return &Logger{
        Logger: l.Logger.With(slog.String("user_id", userID)),
    }
}

// WithOperation adds operation name to log context
func (l *Logger) WithOperation(operation string) *Logger {
    return &Logger{
        Logger: l.Logger.With(slog.String("operation", operation)),
    }
}

// LogRequest logs an HTTP request with timing
func (l *Logger) LogRequest(ctx context.Context, method, path string, statusCode int, duration time.Duration, err error) {
    attrs := []slog.Attr{
        slog.String("method", method),
        slog.String("path", path),
        slog.Int("status_code", statusCode),
        slog.Duration("duration", duration),
    }

    if err != nil {
        attrs = append(attrs, slog.String("error", err.Error()))
        l.LogAttrs(ctx, slog.LevelError, "request failed", attrs...)
    } else if statusCode >= 400 {
        l.LogAttrs(ctx, slog.LevelWarn, "request error", attrs...)
    } else {
        l.LogAttrs(ctx, slog.LevelInfo, "request completed", attrs...)
    }
}

// LogDBQuery logs a database query
func (l *Logger) LogDBQuery(ctx context.Context, operation, table string, duration time.Duration, rowsAffected int64, err error) {
    attrs := []slog.Attr{
        slog.String("db_operation", operation),
        slog.String("db_table", table),
        slog.Duration("duration", duration),
        slog.Int64("rows_affected", rowsAffected),
    }

    if err != nil {
        attrs = append(attrs, slog.String("error", err.Error()))
        l.LogAttrs(ctx, slog.LevelError, "database query failed", attrs...)
    } else if duration > 100*time.Millisecond {
        l.LogAttrs(ctx, slog.LevelWarn, "slow database query", attrs...)
    } else {
        l.LogAttrs(ctx, slog.LevelDebug, "database query completed", attrs...)
    }
}

// LogCacheAccess logs a cache access
func (l *Logger) LogCacheAccess(ctx context.Context, key string, hit bool, duration time.Duration) {
    attrs := []slog.Attr{
        slog.String("cache_key", key),
        slog.Bool("cache_hit", hit),
        slog.Duration("duration", duration),
    }

    l.LogAttrs(ctx, slog.LevelDebug, "cache access", attrs...)
}

// Example usage:
/*
func main() {
    logger := NewLogger("order-service")

    // In an HTTP handler:
    func handleRequest(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()
        start := time.Now()

        // Create operation-specific logger
        log := logger.WithRequestID(r.Header.Get("X-Request-ID")).
                       WithUserID(r.Header.Get("X-User-ID")).
                       WithOperation("CreateOrder")

        // Log business events
        log.InfoContext(ctx, "processing order",
            slog.String("order_id", "ORD-123"),
            slog.Float64("total", 99.99),
        )

        // Process request...

        // Log completion
        log.LogRequest(ctx, r.Method, r.URL.Path, 200, time.Since(start), nil)
    }
}

// Output (JSON, one line per log):
// {
//   "time": "2024-01-15T10:30:00Z",
//   "level": "INFO",
//   "msg": "processing order",
//   "service": "order-service",
//   "request_id": "req-abc123",
//   "user_id": "user-456",
//   "operation": "CreateOrder",
//   "trace_id": "0af7651916cd43dd8448eb211c80319c",
//   "span_id": "b7ad6b7169203331",
//   "trace_sampled": true,
//   "order_id": "ORD-123",
//   "total": 99.99
// }
*/
```

### Junior → FAANG: Using Exercises to Build Interview Confidence

These exercises are structured as the kinds of tasks you will face in FAANG take-home assessments or on-site coding rounds for SRE and platform engineering roles. Each exercise has a hidden verification step: "did I actually check this in a running system?" versus "did I just write code that compiles?"

The most important exercise is the end-to-end instrumentation one, because it forces you to discover the gaps between theory and practice. When you try to correlate a log line to a trace manually for the first time, you will discover why consistent `trace_id` injection matters. That experience is more valuable than reading about it.

Before an interview, be able to whiteboard the full initialization sequence: create resource, create exporter, create provider, set global provider, defer Shutdown. Interviewers often ask candidates to write this from memory as a warm-up question.

### Senior @ FAANG: Exercises as Team Onboarding and Platform Validation

The exercises in this chapter serve a dual purpose at senior level: they are useful for personal skill development, and they are the foundation for team onboarding modules and platform validation suites.

**Onboarding use.** An L6 engineer packages exercises 1 through 4 as a structured onboarding task for engineers joining the platform team. Completing the exercises in a local environment validates that the platform's Collector pipeline, Jaeger instance, and Prometheus setup are correctly configured, and gives new engineers hands-on familiarity with the full observability stack before they touch production.

**Platform regression testing.** Exercise 4 (deploying the Collector with a full pipeline) is the foundation for a platform integration test that runs on every Collector configuration change. The test verifies that spans from a synthetic Go service appear in Jaeger and metrics appear in Prometheus within a specified SLO window (e.g., within 30 seconds of emission). If the test fails, the Collector configuration change is blocked from merging. This automated validation prevents regressions in the core telemetry pipeline.

**Exercise 6 (benchmarking) as a performance gate.** The overhead benchmarks from exercise 6 form the basis for a performance gate in the shared instrumentation library. Any change to the library that increases per-request allocation by more than 5% or increases latency overhead by more than 50 microseconds requires explicit sign-off from the platform team. This gate prevents well-intentioned features from degrading the performance of hundreds of services simultaneously.

---
