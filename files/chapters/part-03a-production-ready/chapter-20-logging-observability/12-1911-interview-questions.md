## 20.11 Interview Questions

### Question 1: Design an Observability Stack for a Microservices Platform

**What FAANG expects:** A system-design answer structured as collection, transport, storage, and query/alerting layers, with explicit trade-offs (pull vs push, retention tiers, cardinality limits, sampling strategy). Interviewers look for correlation design (a single request navigable across logs, metrics, and traces via `trace_id`), cost awareness (metrics cardinality, log volume per day, trace storage), and a named debugging workflow, not a tool catalog.

**Problem**: Design an observability solution for a platform with 50+ microservices handling 100K requests/second. The system must support debugging production issues within 5 minutes.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY ARCHITECTURE FRAMEWORK                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         DATA COLLECTION LAYER                           │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │    │
│  │   │   slog/zap   │   │  Prometheus  │   │ OpenTelemetry│                │    │
│  │   │   Structured │   │    Client    │   │     SDK      │                │    │
│  │   │    Logs      │   │   Metrics    │   │    Traces    │                │    │
│  │   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                │    │
│  │          │                  │                  │                        │    │
│  │          └──────────────────┼──────────────────┘                        │    │
│  │                             ▼                                           │    │
│  │                    ┌─────────────────┐                                  │    │
│  │                    │  Correlation ID │                                  │    │
│  │                    │  (trace_id +    │                                  │    │
│  │                    │   request_id)   │                                  │    │
│  │                    └─────────────────┘                                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                     │                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         DATA TRANSPORT LAYER                            │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │    │
│  │   │   Fluent     │   │  Prometheus  │   │    OTEL      │                │    │
│  │   │   Bit/       │   │    Server    │   │  Collector   │                │    │
│  │   │   Filebeat   │   │   (scrape)   │   │  (push/pull) │                │    │
│  │   └──────────────┘   └──────────────┘   └──────────────┘                │    │
│  │                                                                         │    │
│  │   Design Decisions:                                                     │    │
│  │   • Push vs Pull: Prometheus pulls (scrape), OTEL pushes (OTLP)         │    │
│  │   • Buffering: Local buffer for resilience (fluentbit buffer)           │    │
│  │   • Compression: gzip for network efficiency                            │    │
│  │   • Batching: Batch writes (100ms or 1000 records)                      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                     │                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                          DATA STORAGE LAYER                             │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │    │
│  │   │  Loki/       │   │  Prometheus  │   │   Tempo/     │                │    │
│  │   │  Elastic     │   │   /Mimir/    │   │   Jaeger     │                │    │
│  │   │   (Logs)     │   │   Cortex     │   │  (Traces)    │                │    │
│  │   └──────────────┘   └──────────────┘   └──────────────┘                │    │
│  │                                                                         │    │
│  │   Retention Strategy:                                                   │    │
│  │   ├── Hot: 7 days (SSD, full resolution)                                │    │
│  │   ├── Warm: 30 days (HDD, 5min aggregation)                             │    │
│  │   └── Cold: 1 year (S3, 1hr aggregation)                                │    │
│  │                                                                         │    │
│  │   Cardinality Limits:                                                   │    │
│  │   • Metrics: < 1M unique series per service                             │    │
│  │   • Logs: 100GB/day, indexed fields < 20                                │    │
│  │   • Traces: 1% sampling, 100% errors sampled                            │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                     │                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        VISUALIZATION & ALERTING                         │    │
│  ├─────────────────────────────────────────────────────────────────────────┤    │
│  │                                                                         │    │
│  │   ┌──────────────────────────────────────────────────────────────────┐  │    │
│  │   │                         GRAFANA                                  │  │    │
│  │   │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │  │    │
│  │   │  │ Dashboards │  │   Alerts   │  │  Explore   │                  │  │    │
│  │   │  │            │  │            │  │            │                  │  │    │
│  │   │  │ • SLO      │  │ • SLO burn │  │ • Log      │                  │  │    │
│  │   │  │ • RED      │  │ • Error %  │  │   search   │                  │  │    │
│  │   │  │ • USE      │  │ • Latency  │  │ • Trace    │                  │  │    │
│  │   │  │ • Golden   │  │   P99      │  │   view     │                  │  │    │
│  │   │  │   Signals  │  │            │  │            │                  │  │    │
│  │   │  └────────────┘  └────────────┘  └────────────┘                  │  │    │
│  │   └──────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                         │    │
│  │   Alert Routing: Grafana → Alertmanager → PagerDuty/Slack/Email         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  CORRELATION WORKFLOW (5-minute debugging):                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  1. Alert fires (SLO burn rate high)                                    │    │
│  │     ↓                                                                   │    │
│  │  2. Dashboard shows which service/endpoint (metrics)                    │    │
│  │     ↓                                                                   │    │
│  │  3. Click exemplar → Jump to trace                                      │    │
│  │     ↓                                                                   │    │
│  │  4. Trace shows slow span in payment-service                            │    │
│  │     ↓                                                                   │    │
│  │  5. Click trace_id → See all logs for request                           │    │
│  │     ↓                                                                   │    │
│  │  6. Logs show "database connection timeout"                             │    │
│  │     ↓                                                                   │    │
│  │  7. Root cause identified: DB connection pool exhausted                 │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Implementation:**

The stack below wires together a structured JSON logger that automatically injects trace context, an adaptive sampler that always captures errors, and RED metrics per endpoint. The `Middleware` method wraps any `http.Handler` and handles span creation, correlation ID propagation, and metric recording in a single pass.

```go
// observability/stack.go
package observability

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.opentelemetry.io/otel/trace"
)

// Config for observability stack
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string
    OTLPEndpoint   string
    SampleRate     float64
    MetricsPort    int
}

// Stack manages all observability components
type Stack struct {
    config         Config
    logger         *slog.Logger
    tracer         trace.Tracer
    tracerProvider *sdktrace.TracerProvider
    metrics        *ServiceMetrics

    mu       sync.RWMutex
    shutdown []func(context.Context) error
}

// ServiceMetrics holds RED metrics
type ServiceMetrics struct {
    RequestsTotal   *prometheus.CounterVec
    RequestDuration *prometheus.HistogramVec
    RequestSize     *prometheus.HistogramVec
    ErrorsTotal     *prometheus.CounterVec
    ActiveRequests  prometheus.Gauge
}

// New creates observability stack
func New(cfg Config) (*Stack, error) {
    s := &Stack{config: cfg}

    // Initialize structured logger with correlation
    s.initLogger()

    // Initialize distributed tracer
    if err := s.initTracer(); err != nil {
        return nil, fmt.Errorf("init tracer: %w", err)
    }

    // Initialize RED metrics
    s.initMetrics()

    return s, nil
}

func (s *Stack) initLogger() {
    handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level:     slog.LevelInfo,
        AddSource: true,
    })

    // Wrap with tracing handler
    s.logger = slog.New(&tracingHandler{Handler: handler}).With(
        "service", s.config.ServiceName,
        "version", s.config.ServiceVersion,
        "env", s.config.Environment,
    )
    slog.SetDefault(s.logger)
}

// tracingHandler injects trace context into logs.
//
// Two details are mandatory here, and both are silent failures if omitted:
// Handle must Clone before mutating the Record, and WithAttrs/WithGroup must
// re-wrap so that logger.With(...) does not unwrap this handler away.
type tracingHandler struct {
    slog.Handler
}

func (h *tracingHandler) Handle(ctx context.Context, r slog.Record) error {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        r = r.Clone() // never mutate the caller's Record
        r.AddAttrs(
            slog.String("trace_id", span.SpanContext().TraceID().String()),
            slog.String("span_id", span.SpanContext().SpanID().String()),
        )
    }
    return h.Handler.Handle(ctx, r)
}

func (h *tracingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
    return &tracingHandler{Handler: h.Handler.WithAttrs(attrs)}
}

func (h *tracingHandler) WithGroup(name string) slog.Handler {
    return &tracingHandler{Handler: h.Handler.WithGroup(name)}
}

func (s *Stack) initTracer() error {
    ctx := context.Background()

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(s.config.OTLPEndpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return err
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(s.config.ServiceName),
            semconv.ServiceVersion(s.config.ServiceVersion),
            semconv.DeploymentEnvironment(s.config.Environment),
        ),
    )
    if err != nil {
        return err
    }

    // Adaptive sampler: always sample errors
    sampler := &adaptiveSampler{
        baseSampler: sdktrace.TraceIDRatioBased(s.config.SampleRate),
    }

    s.tracerProvider = sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sampler),
    )

    otel.SetTracerProvider(s.tracerProvider)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    s.tracer = otel.Tracer(s.config.ServiceName)
    s.shutdown = append(s.shutdown, s.tracerProvider.Shutdown)

    return nil
}

// adaptiveSampler always samples errors and slow requests
type adaptiveSampler struct {
    baseSampler sdktrace.Sampler
}

func (s *adaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
    // Always sample if parent is sampled
    if p.ParentContext.IsSampled() {
        return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
    }

    // Check for error attribute
    for _, attr := range p.Attributes {
        if attr.Key == "error" && attr.Value.AsBool() {
            return sdktrace.SamplingResult{Decision: sdktrace.RecordAndSample}
        }
    }

    return s.baseSampler.ShouldSample(p)
}

func (s *adaptiveSampler) Description() string {
    return "AdaptiveSampler"
}

func (s *Stack) initMetrics() {
    s.metrics = &ServiceMetrics{
        RequestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Name: s.config.ServiceName + "_requests_total",
                Help: "Total requests by method, path, status",
            },
            []string{"method", "path", "status"},
        ),
        RequestDuration: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    s.config.ServiceName + "_request_duration_seconds",
                Help:    "Request duration in seconds",
                Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
            },
            []string{"method", "path"},
        ),
        ErrorsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Name: s.config.ServiceName + "_errors_total",
                Help: "Total errors by type",
            },
            []string{"type"},
        ),
        ActiveRequests: promauto.NewGauge(
            prometheus.GaugeOpts{
                Name: s.config.ServiceName + "_active_requests",
                Help: "Currently active requests",
            },
        ),
    }
}

// Middleware instruments HTTP handlers
func (s *Stack) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Extract or create trace context
        ctx := otel.GetTextMapPropagator().Extract(
            r.Context(),
            propagation.HeaderCarrier(r.Header),
        )

        // Start span. Name it after the route template once routing has
        // happened (below), not the raw URL: one span name per user ID is
        // unusable in any tracing backend.
        ctx, span := s.tracer.Start(ctx, r.Method,
            trace.WithAttributes(
                attribute.String("http.method", r.Method),
                attribute.String("url.path", r.URL.Path),
            ),
        )
        defer span.End()

        // Create request-scoped logger
        logger := s.logger.With(
            "trace_id", span.SpanContext().TraceID().String(),
            "method", r.Method,
            "path", r.URL.Path,
        )
        ctx = WithLogger(ctx, logger)

        s.metrics.ActiveRequests.Inc()
        defer s.metrics.ActiveRequests.Dec()

        // Wrap response writer
        wrapped := &responseWriter{ResponseWriter: w, status: 200}

        // Keep the request we pass down: ServeMux records the matched
        // pattern on this value, not on the outer r.
        req := r.WithContext(ctx)
        next.ServeHTTP(wrapped, req)

        // Record metrics
        duration := time.Since(start)
        status := fmt.Sprintf("%d", wrapped.status)

        // Bounded route template, never r.URL.Path. A metric label is a
        // time series: one per URL means one per user ID.
        route := req.Pattern
        if route == "" {
            route = "unmatched"
        }

        s.metrics.RequestsTotal.WithLabelValues(r.Method, route, status).Inc()
        s.metrics.RequestDuration.WithLabelValues(r.Method, route).Observe(duration.Seconds())

        span.SetName(route)
        span.SetAttributes(
            attribute.String("http.route", route),
            attribute.Int("http.status_code", wrapped.status),
        )

        if wrapped.status >= 400 {
            span.SetAttributes(attribute.Bool("error", true))
            s.metrics.ErrorsTotal.WithLabelValues("http_error").Inc()
        }

        logger.Info("request completed",
            "status", wrapped.status,
            "duration_ms", duration.Milliseconds(),
        )
    })
}

// Shutdown gracefully shuts down observability
func (s *Stack) Shutdown(ctx context.Context) error {
    for _, fn := range s.shutdown {
        if err := fn(ctx); err != nil {
            return err
        }
    }
    return nil
}

type loggerKey struct{}

func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
    return context.WithValue(ctx, loggerKey{}, l)
}

func LoggerFrom(ctx context.Context) *slog.Logger {
    if l, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
        return l
    }
    return slog.Default()
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (w *responseWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}
```

**Key Design Points:**
- **Correlation IDs**: trace_id links logs, metrics (via exemplars), and traces
- **Adaptive Sampling**: Always sample errors, sample normal traffic at configured rate
- **RED Metrics**: Rate, Errors, Duration for each service
- **5-Minute Debugging**: Alert, Metrics, Trace, Logs workflow

**The two rules every wrapping `slog.Handler` must follow.** `tracingHandler` above is fifteen lines long and there are two ways to write it that compile, run, produce no error, and do not work. Both are worth being able to explain, because "write a handler that adds trace IDs to logs" is a common interview task and these are the details that separate a candidate who has shipped one from a candidate who has read about one.

**Rule 1: `WithAttrs` and `WithGroup` must re-wrap.** Embedding `slog.Handler` promotes the inner handler's `WithAttrs`, which returns the *inner* handler. That silently discards your wrapper. Since `initLogger` calls `.With("service", ...)` immediately after constructing the handler, omitting these two methods means the wrapper is thrown away at startup and not one log line ever gets a trace ID. The feature does not fail loudly. It just never happens:

```
// Without the WithAttrs override, after .With("service", "api"):
{"level":"INFO","msg":"hello","service":"api"}                        // no trace_id, ever

// With it:
{"level":"INFO","msg":"hello","service":"api","trace_id":"TRACE-ABC"}
```

**Rule 2: `Handle` must `Clone` before it mutates.** The `Handler` contract is explicit that a handler should not modify the `Record` it is given. `Record` is passed by value, but it carries a `back []Attr` slice, so a copy still shares that backing array. Two handlers that both `AddAttrs` to the same record can write to the same array slot.

The standard library takes this seriously enough to detect it for you. `AddAttrs` checks whether the slot past the end of `back` is already occupied, and if it is, it appends a literal marker attribute rather than corrupting your data:

```json
{"level":"INFO","msg":"msg","!BUG":"AddAttrs unsafely called on copy of Record made without using Record.Clone","tagged_by":"beta"}
```

If you have ever seen `!BUG` in production logs, this is where it comes from. Note that it only fires when the capacity happens to line up, which depends on how many attributes the call site passed. That is the worst possible failure mode: correct in your tests with three attributes, corrupt in production with eight. `r = r.Clone()` costs one slice clip and removes the entire class of problem.

**Follow-ups:**
- *What do you cut first if budget gets halved?* Trace retention (drop hot to 3 days), then log volume (sample INFO, keep 100% of WARN/ERROR). Do not cut metrics retention, cheap per-byte and feeds every SLO.
- *How does this change if you need multi-region active-active?* Put a Collector per region with local batching, replicate to a global long-term store (Mimir, Thanos). Keep trace_id globally unique (W3C default) so cross-region requests stay stitchable.
- *Where does continuous profiling fit?* Add Pyroscope or Parca as a fifth pillar collecting CPU/memory profiles at 2-3% overhead. Tie profiles to the same trace_id for "slow trace, show me the flame graph for that request's pod at that moment".

---

### Question 2: What are the three pillars of observability?

**What FAANG expects:** A crisp definition that goes beyond "logs, metrics, traces" and explains the cardinality and cost trade-offs that drive when to use each signal. Strong candidates mention that logs/metrics/traces are *signals*, not the full picture, and call out events, exemplars, and continuous profiling as the fourth and fifth pillars that modern stacks (Honeycomb, Datadog, Grafana) now treat as first-class.

**Answer:**

1. **Logs**: Discrete events at a point in time.
 - High cardinality (per-request data), typically unsampled in dev, sampled or summarized in prod.
 - Good for: debugging specific issues, audit trails, unknown-unknowns.
 - Example: "User 123 failed to login, invalid password".

2. **Metrics**: Numeric measurements aggregated over time.
 - Low cardinality by design (aggregated over labels). Cost scales with cardinality, not event rate.
 - Good for: alerting, dashboards, capacity planning, SLO/SLI math.
 - Example: request rate, error percentage, latency percentiles.

3. **Traces**: Request flow across distributed systems.
 - Sampled (1-10% head-based, plus 100% of errors via tail sampling).
 - Good for: understanding dependencies, finding slow services, cross-service causal analysis.
 - Example: trace showing request through API, Auth, DB, Cache.

Correlation through a single `trace_id` propagated via W3C traceparent headers (and injected into every log line) is what turns three separate data stores into one coherent debugging surface.

**Follow-ups:**
- *How do you decide whether something should be a log, a metric, or a span attribute?* High-cardinality per-event data (user_id, order_id) belongs in logs or span attributes. Aggregatable quantities (latency, count) belong in metrics. Causal relationships (A called B called C) belong in traces.
- *What is an exemplar and why does it matter?* A sample metric observation that carries a trace_id, so a spike in a Grafana panel links directly to a representative slow trace. Prometheus supports exemplars on histograms via the OpenMetrics format.
- *What are the fourth and fifth pillars people talk about?* Events (deploys, feature flag flips, config changes) for change correlation, and continuous profiling for CPU/memory attribution over time.

### Question 3: How do you handle high-cardinality data in metrics?

**What FAANG expects:** Concrete numbers (rough cost of a series at your scale), a framework for deciding what belongs on a label versus a log field, and awareness that Prometheus native histograms and wide-events systems (Honeycomb, Clickhouse-backed stacks) change the trade-off.

**Answer:**

High cardinality (many unique label values) can crash Prometheus by creating millions of time series. Each active series costs memory, disk, and query CPU, order of a few KB per series in RAM at scale. Three strategies keep metrics manageable: push high-cardinality data into logs and traces instead, bucket raw values into small fixed sets, and attach exemplars that link a sample metric observation back to its trace.

```go
// 1. Use logs/traces for high-cardinality data
// Put user_id in logs, not metrics
logger.Info("request", "user_id", userID)

// 2. Use bucketed labels instead of raw values
func latencyBucket(d time.Duration) string {
    switch {
    case d < 10*time.Millisecond:
        return "fast"
    case d < 100*time.Millisecond:
        return "normal"
    case d < time.Second:
        return "slow"
    default:
        return "very_slow"
    }
}

// 3. Use exemplars for correlation
histogram.WithLabelValues(method, path).(prometheus.ExemplarObserver).
    ObserveWithExemplar(duration, prometheus.Labels{"trace_id": traceID})
```

**Follow-ups:**
- *What is a Prometheus native histogram and why does it help here?* A sparse, auto-bucketed histogram (stable in Prometheus 2.40+, GA path in 3.x) that stores exponential buckets covering the full float64 range. You get better percentile accuracy without committing to static buckets and without exploding series for `le` labels.
- *When would you deliberately accept high cardinality?* When you're using a wide-events system (Honeycomb, Loki with structured metadata, Elastic) where the storage is designed for it. Prometheus is the wrong tool for per-user-id metrics, a columnar event store is the right one.
- *How do you enforce cardinality limits in practice?* Set `--query.max-series` on Prometheus, use recording rules to aggregate away labels at ingest, and fail builds when a new label is added to a hot metric in code review.

### Question 4: How do you implement distributed tracing across microservices?

**What FAANG expects:** Name the W3C Trace Context standard (`traceparent`, `tracestate`) as the propagation format, explain head-based vs tail-based sampling and when each is appropriate, and describe how async boundaries (queues, cron jobs) require you to carry context through the payload rather than the transport headers.

**Answer:**

The key mechanism is context propagation: the calling service injects its trace context into outgoing request headers, and the receiving service extracts it to create child spans. For asynchronous communication over queues, embed the `traceparent` header in the message payload so the consumer can resume the same trace.

```go
// 1. Propagate context in HTTP requests
func makeRequest(ctx context.Context, url string) (*http.Response, error) {
    req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)

    // Inject trace context into headers
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    return http.DefaultClient.Do(req)
}

// 2. Extract context in handlers
func handler(w http.ResponseWriter, r *http.Request) {
    // Extract trace context from headers
    ctx := otel.GetTextMapPropagator().Extract(
        r.Context(),
        propagation.HeaderCarrier(r.Header),
    )

    ctx, span := tracer.Start(ctx, "handleRequest")
    defer span.End()

    // Now this span is a child of the caller's span
}

// 3. For async processing (queues), include trace context in message
type Message struct {
    Data        []byte
    TraceParent string `json:"traceparent"`
}
```

**Follow-ups:**
- *Head sampling vs tail sampling, which and when?* Head sampling (decide at the root span) is cheap but blind to outcomes. Tail sampling (buffer all spans, decide after seeing the full trace) is required if you want "always sample errors and slow traces". In practice run both: head sampling at the SDK for baseline ratio, tail sampling in the OTel Collector for outcome-based retention.
- *How do you trace a background job that has no incoming request?* Start a new root span at job entry and record the job_id as a span attribute. If the job was scheduled by an API call, store the original `trace_id` as a span link so operators can navigate both ways.
- *What's the status of the OpenTelemetry logs SDK in Go?* The OTel Go Logs API and SDK (`go.opentelemetry.io/otel/sdk/log`) reached release-candidate status in August 2026 (v1.47.0-rc.1), with exporters still experimental. In a greenfield service you can already route `slog` through an `otelslog` bridge and ship logs, metrics, and traces through a single OTLP pipeline.

### Question 5: What's the difference between liveness and readiness probes?

**What FAANG expects:** The precise semantic difference (restart vs remove-from-endpoints), why checking dependencies in liveness is a production anti-pattern (a brief DB blip cascades into a restart storm), and awareness of the third probe (`startupProbe`) for slow-starting services.

**Answer:**

**Liveness probe**: "Is the process alive?"
- Failing liveness, Kubernetes restarts the pod.
- Should be simple, just return 200.
- Do not check downstream dependencies, a transient DB outage should not trigger pod restarts.

**Readiness probe**: "Can the process accept traffic?"
- Failing readiness, pod removed from service endpoints, no restart.
- Should check dependencies (database, cache, queue) with short timeouts.
- Safe to fail briefly, the pod will be returned to rotation when it recovers.

**Startup probe** (often forgotten): gates liveness and readiness until initial setup finishes. Use it for services with slow migrations, large cache warm-ups, or model loading so a 60-second boot does not trip liveness and restart-loop forever.

```go
// Liveness: just check if we're running
http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
})

// Readiness: check if we can serve traffic
http.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    if err := redis.Ping(ctx).Err(); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    w.WriteHeader(http.StatusOK)
})
```

**Follow-ups:**
- *Should readiness fail if Redis is down but the service can degrade gracefully?* No. If the service can serve meaningful traffic without Redis, keep readiness green and expose the degraded state through a metric or a separate `/status` endpoint. Readiness is a binary traffic gate, not a health indicator.
- *What timeout should readiness use for dependency checks?* Shorter than the kubelet probe interval (default 10s). One to two seconds is typical, if your DB cannot answer a ping in that window, the downstream pool is already wedged.
- *Why did Google's SRE playbook recommend separating liveness from health-check-of-everything?* Coupling them turns partial outages into total outages. A single bad downstream propagates restart storms through the cluster.

### Question 6: How would you debug a slow API endpoint in production?

**What FAANG expects:** A top-down workflow that moves from symptom (latency SLO alert) to cause (specific span or log line) without spending hours in irrelevant dashboards. Strong answers name the RED/USE methodology, mention exemplars for the metrics-to-trace jump, and note when to reach for continuous profiling.

**Answer:**

1. **Check metrics**: Look at latency percentiles
```promql
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{path="/api/users"}[5m])))
```

2. **Find slow traces**: Query Jaeger/Tempo for slow requests
```
service=api-gateway operation=handleUsers duration>1s
```

3. **Analyze trace**: Look at span breakdown
 - Which child span is slowest?
 - Is it database, cache, or external API?

4. **Check logs**: Filter by trace_id
```
trace_id="abc123" | json | line_format "{{.level}} {{.msg}}"
```

5. **Profile if needed**: Take CPU/memory profile during slow period, or pull the continuous profiler (Pyroscope, Parca, Datadog) for the exact time window.

**Follow-ups:**
- *What if P99 is fine but a customer is still complaining?* Look at per-tenant slices, an aggregate P99 hides a small cohort's P99. Filter metrics by customer_id (if it is in logs) or query traces for that user's recent requests directly.
- *How do you correlate a metrics spike to the deploy that caused it?* Overlay deploy events on the metric panel (Grafana annotations driven by CI events) and diff a trace from before/after the deploy. Regression is almost always in a span that grew in count or duration.
- *When do metrics and traces disagree?* Usually sampling, your 1% trace sample missed the outliers that are driving P99. The fix is tail sampling in the OTel Collector to always keep slow and error traces.

### Q (Staff track): Walk through designing SLOs for a new service.

**Answer**: Four steps.

1. **Identify the critical user journey.** What does the user actually care about? Usually latency and availability of the main API.
2. **Define SLIs.** Specific measurable metrics: "successful responses" = HTTP 2xx or 3xx. "Fast responses" = p99 under 500ms.
3. **Set SLO targets.** Based on business expectations and historical performance. 99.9% availability gives 43 minutes downtime per month.
4. **Define error budget and alerts.** Alert when error budget burns faster than the monthly budget allows. Page on fast burn, ticket on slow burn.

Socialise with stakeholders (product, SRE, engineering). Revise quarterly based on actual operational experience.

### Q (Staff track): Your observability bill has doubled in a year. What do you do?

**Answer**: Audit and reduce.

1. **Log volume:** find the top log-generating services. Reduce verbosity in hot paths, especially HTTP 4xx that are not actual errors.
2. **Metric cardinality:** find high-cardinality metrics. Reduce label cardinality. Drop metrics nobody uses.
3. **Trace sampling:** reduce sample rate for normal traffic, tail-sample for errors only.
4. **Retention:** shorten retention for non-critical data.

Measure before and after. Observability bills grow superlinearly with traffic, so active management is mandatory beyond a certain scale.

---
