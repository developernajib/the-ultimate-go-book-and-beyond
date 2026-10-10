## 20.8 Complete Application: Production Observability Stack

The following framework integrates all three pillars, logs, metrics, and traces, into a single reusable `Stack` type. Application code initializes the stack once in `main`, registers health checks for its dependencies, and wraps the HTTP router with a middleware that automatically instruments every request. The `Stack` owns the lifecycle of the tracer provider and exposes a `Shutdown` method that flushes buffered spans and metrics before the process exits.

```go
// observability/observability.go
package observability

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "math/rand/v2"
    "net/http"
    "os"
    "regexp"
    "runtime"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
    "go.opentelemetry.io/otel/trace"
)

// Config holds observability configuration
type Config struct {
    ServiceName    string
    ServiceVersion string
    Environment    string

    // Logging
    LogLevel       slog.Level
    LogFormat      string // "json" or "text"

    // Metrics
    MetricsEnabled bool
    MetricsPath    string
    MetricsPort    int

    // Tracing
    TracingEnabled bool
    TracingEndpoint string
    SampleRate     float64

    // Health
    HealthPath     string
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        ServiceName:    "unknown",
        ServiceVersion: "unknown",
        Environment:    "development",
        LogLevel:       slog.LevelInfo,
        LogFormat:      "json",
        MetricsEnabled: true,
        MetricsPath:    "/metrics",
        MetricsPort:    9090,
        TracingEnabled: true,
        TracingEndpoint: "localhost:4317",
        SampleRate:     0.1,
        HealthPath:     "/health",
    }
}

// Stack is the main observability container
type Stack struct {
    config        Config
    logger        *slog.Logger
    tracer        trace.Tracer
    tracerProvider *sdktrace.TracerProvider
    metrics       *Metrics
    health        *HealthChecker

    mu            sync.RWMutex
    shutdown      []func(context.Context) error
}

// New creates a new observability stack
func New(cfg Config) (*Stack, error) {
    s := &Stack{
        config:   cfg,
        shutdown: make([]func(context.Context) error, 0),
    }

    // Initialize logger
    s.initLogger()

    // Initialize metrics
    if cfg.MetricsEnabled {
        s.initMetrics()
    }

    // Initialize tracing
    if cfg.TracingEnabled {
        if err := s.initTracing(); err != nil {
            return nil, fmt.Errorf("init tracing: %w", err)
        }
    }

    // Initialize health checker
    s.health = NewHealthChecker()

    return s, nil
}

func (s *Stack) initLogger() {
    var handler slog.Handler

    opts := &slog.HandlerOptions{
        Level:     s.config.LogLevel,
        AddSource: s.config.LogLevel == slog.LevelDebug,
    }

    if s.config.LogFormat == "json" {
        handler = slog.NewJSONHandler(os.Stdout, opts)
    } else {
        handler = slog.NewTextHandler(os.Stdout, opts)
    }

    // Add default attributes
    s.logger = slog.New(handler).With(
        "service", s.config.ServiceName,
        "version", s.config.ServiceVersion,
        "env", s.config.Environment,
    )

    slog.SetDefault(s.logger)
}

func (s *Stack) initMetrics() {
    s.metrics = NewMetrics(s.config.ServiceName)
}

func (s *Stack) initTracing() error {
    ctx := context.Background()

    // Create OTLP exporter
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(s.config.TracingEndpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return fmt.Errorf("create exporter: %w", err)
    }

    // Create resource
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(s.config.ServiceName),
            semconv.ServiceVersion(s.config.ServiceVersion),
            semconv.DeploymentEnvironment(s.config.Environment),
        ),
        resource.WithHost(),
        resource.WithProcess(),
    )
    if err != nil {
        return fmt.Errorf("create resource: %w", err)
    }

    // Create sampler
    sampler := sdktrace.ParentBased(
        sdktrace.TraceIDRatioBased(s.config.SampleRate),
    )

    // Create tracer provider
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

// Logger returns the configured logger
func (s *Stack) Logger() *slog.Logger {
    return s.logger
}

// Tracer returns the configured tracer
func (s *Stack) Tracer() trace.Tracer {
    return s.tracer
}

// Metrics returns the metrics registry
func (s *Stack) Metrics() *Metrics {
    return s.metrics
}

// Health returns the health checker
func (s *Stack) Health() *HealthChecker {
    return s.health
}

// Shutdown gracefully shuts down the observability stack
func (s *Stack) Shutdown(ctx context.Context) error {
    s.logger.Info("shutting down observability stack")

    var errs []error
    for _, fn := range s.shutdown {
        if err := fn(ctx); err != nil {
            errs = append(errs, err)
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("shutdown errors: %v", errs)
    }
    return nil
}

// HTTPHandler returns an HTTP handler with metrics and health endpoints
func (s *Stack) HTTPHandler() http.Handler {
    mux := http.NewServeMux()

    if s.config.MetricsEnabled {
        mux.Handle(s.config.MetricsPath, promhttp.Handler())
    }

    mux.HandleFunc(s.config.HealthPath, s.health.HTTPHandler)
    mux.HandleFunc(s.config.HealthPath+"/live", s.health.LivenessHandler)
    mux.HandleFunc(s.config.HealthPath+"/ready", s.health.ReadinessHandler)

    return mux
}

// Middleware returns HTTP middleware for observability
func (s *Stack) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Extract or create request ID. The header is untrusted input:
        // validate its shape rather than propagating it into logs verbatim.
        requestID := r.Header.Get("X-Request-ID")
        if !validRequestID.MatchString(requestID) {
            requestID = generateRequestID()
        }

        // Start span. The span name is set to the route template after
        // routing (see below); start with the method as a safe placeholder
        // so we never create one span name per unique URL.
        ctx, span := s.tracer.Start(r.Context(), r.Method,
            trace.WithAttributes(
                attribute.String("http.method", r.Method),
                attribute.String("http.route", r.URL.Path),
                attribute.String("http.request_id", requestID),
            ),
        )
        defer span.End()

        // Add request ID to context and response
        ctx = context.WithValue(ctx, requestIDKey{}, requestID)
        w.Header().Set("X-Request-ID", requestID)

        // Create request-scoped logger
        logger := s.logger.With(
            "request_id", requestID,
            "method", r.Method,
            "path", r.URL.Path,
            "trace_id", span.SpanContext().TraceID().String(),
        )
        ctx = WithLogger(ctx, logger)

        // Wrap response writer
        wrapped := &responseWriter{ResponseWriter: w, status: 200}

        // Call handler. Keep the request we pass down: ServeMux records the
        // matched pattern on THIS value, not on the outer r.
        req := r.WithContext(ctx)
        next.ServeHTTP(wrapped, req)

        // Record metrics and log
        duration := time.Since(start)
        status := wrapped.status

        // Route template ("GET /users/{id}"), bounded by the routing table.
        // Never label metrics with r.URL.Path: that is one series per URL.
        route := req.Pattern
        if route == "" {
            route = "unmatched"
        }

        span.SetName(route)
        span.SetAttributes(
            attribute.String("http.route", route),
            attribute.Int("http.status_code", status),
            attribute.Int64("http.response_size", int64(wrapped.size)),
        )

        if s.metrics != nil {
            s.metrics.RecordHTTPRequest(r.Method, route, status, duration)
        }

        logger.Info("request completed",
            "status", status,
            "size", wrapped.size,
            "duration_ms", duration.Milliseconds(),
        )
    })
}

// ============================================================================
// METRICS
// ============================================================================

// Metrics holds all application metrics
type Metrics struct {
    prefix string

    // HTTP metrics
    HTTPRequestsTotal    *prometheus.CounterVec
    HTTPRequestDuration  *prometheus.HistogramVec
    HTTPResponseSize     *prometheus.HistogramVec
    HTTPActiveRequests   prometheus.Gauge

    // Business metrics
    EventsProcessed      *prometheus.CounterVec
    ProcessingDuration   *prometheus.HistogramVec
    QueueDepth           *prometheus.GaugeVec
    ErrorsTotal          *prometheus.CounterVec

    // Runtime metrics
    GoroutinesGauge      prometheus.Gauge
    MemoryAllocGauge     prometheus.Gauge
    GCPauseHistogram     prometheus.Histogram
}

// NewMetrics creates a new metrics registry
func NewMetrics(prefix string) *Metrics {
    m := &Metrics{prefix: prefix}

    // HTTP metrics
    m.HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: prefix + "_http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    m.HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    prefix + "_http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
        },
        []string{"method", "path"},
    )

    m.HTTPResponseSize = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    prefix + "_http_response_size_bytes",
            Help:    "HTTP response size in bytes",
            Buckets: prometheus.ExponentialBuckets(100, 10, 8),
        },
        []string{"method", "path"},
    )

    m.HTTPActiveRequests = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: prefix + "_http_active_requests",
            Help: "Number of active HTTP requests",
        },
    )

    // Business metrics
    m.EventsProcessed = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: prefix + "_events_processed_total",
            Help: "Total number of events processed",
        },
        []string{"type", "status"},
    )

    m.ProcessingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    prefix + "_processing_duration_seconds",
            Help:    "Event processing duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"type"},
    )

    m.QueueDepth = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: prefix + "_queue_depth",
            Help: "Current queue depth",
        },
        []string{"queue"},
    )

    m.ErrorsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: prefix + "_errors_total",
            Help: "Total number of errors",
        },
        []string{"type"},
    )

    // Runtime metrics
    m.GoroutinesGauge = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: prefix + "_goroutines",
            Help: "Number of goroutines",
        },
    )

    m.MemoryAllocGauge = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: prefix + "_memory_alloc_bytes",
            Help: "Allocated memory in bytes",
        },
    )

    m.GCPauseHistogram = promauto.NewHistogram(
        prometheus.HistogramOpts{
            Name:    prefix + "_gc_pause_seconds",
            Help:    "GC pause duration in seconds",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15),
        },
    )

    // Start runtime metrics collector
    go m.collectRuntimeMetrics()

    return m
}

// RecordHTTPRequest records HTTP request metrics
func (m *Metrics) RecordHTTPRequest(method, path string, status int, duration time.Duration) {
    statusStr := fmt.Sprintf("%d", status)
    m.HTTPRequestsTotal.WithLabelValues(method, path, statusStr).Inc()
    m.HTTPRequestDuration.WithLabelValues(method, path).Observe(duration.Seconds())
}

// RecordEvent records a business event
func (m *Metrics) RecordEvent(eventType, status string, duration time.Duration) {
    m.EventsProcessed.WithLabelValues(eventType, status).Inc()
    m.ProcessingDuration.WithLabelValues(eventType).Observe(duration.Seconds())
}

// RecordError records an error
func (m *Metrics) RecordError(errorType string) {
    m.ErrorsTotal.WithLabelValues(errorType).Inc()
}

func (m *Metrics) collectRuntimeMetrics() {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    var lastNumGC uint32
    var ms runtime.MemStats

    for range ticker.C {
        runtime.ReadMemStats(&ms)

        m.GoroutinesGauge.Set(float64(runtime.NumGoroutine()))
        m.MemoryAllocGauge.Set(float64(ms.Alloc))

        // Record new GC pauses
        if ms.NumGC > lastNumGC {
            for i := lastNumGC; i < ms.NumGC; i++ {
                idx := i % 256
                pause := float64(ms.PauseNs[idx]) / 1e9
                m.GCPauseHistogram.Observe(pause)
            }
            lastNumGC = ms.NumGC
        }
    }
}

// ============================================================================
// HEALTH CHECKING
// ============================================================================

// HealthChecker manages health checks
type HealthChecker struct {
    mu       sync.RWMutex
    checks   map[string]HealthCheck
    ready    bool
}

// HealthCheck is a health check function
type HealthCheck func(ctx context.Context) error

// HealthResult is the result of a health check
type HealthResult struct {
    Status  string            `json:"status"`
    Checks  map[string]string `json:"checks"`
    Details map[string]any    `json:"details,omitempty"`
}

// NewHealthChecker creates a new health checker
func NewHealthChecker() *HealthChecker {
    return &HealthChecker{
        checks: make(map[string]HealthCheck),
        ready:  false,
    }
}

// Register registers a health check
func (h *HealthChecker) Register(name string, check HealthCheck) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.checks[name] = check
}

// SetReady marks the service as ready
func (h *HealthChecker) SetReady(ready bool) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.ready = ready
}

// Check runs all health checks
func (h *HealthChecker) Check(ctx context.Context) HealthResult {
    h.mu.RLock()
    defer h.mu.RUnlock()

    result := HealthResult{
        Status: "healthy",
        Checks: make(map[string]string),
        Details: map[string]any{
            "goroutines": runtime.NumGoroutine(),
            "timestamp":  time.Now().UTC().Format(time.RFC3339),
        },
    }

    for name, check := range h.checks {
        if err := check(ctx); err != nil {
            // Detail goes to the log, not to the response body: dependency
            // errors leak internal hosts, ports, and DSNs to any caller.
            slog.ErrorContext(ctx, "health check failed", "check", name, "error", err)
            result.Checks[name] = "unhealthy"
            result.Status = "unhealthy"
        } else {
            result.Checks[name] = "healthy"
        }
    }

    return result
}

// HTTPHandler handles /health requests
func (h *HealthChecker) HTTPHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    result := h.Check(ctx)

    w.Header().Set("Content-Type", "application/json")
    if result.Status != "healthy" {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
    json.NewEncoder(w).Encode(result)
}

// LivenessHandler handles /health/live requests
func (h *HealthChecker) LivenessHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness: is the process running?
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// ReadinessHandler handles /health/ready requests
func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    h.mu.RLock()
    ready := h.ready
    h.mu.RUnlock()

    if !ready {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("NOT READY"))
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    result := h.Check(ctx)
    if result.Status != "healthy" {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("UNHEALTHY"))
        return
    }

    w.WriteHeader(http.StatusOK)
    w.Write([]byte("READY"))
}

// ============================================================================
// CONTEXT HELPERS
// ============================================================================

type requestIDKey struct{}
type loggerKey struct{}

// validRequestID bounds the shape and length of a caller-supplied
// X-Request-ID. Anything else is replaced with an ID we generate.
var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// WithLogger adds a logger to context
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, loggerKey{}, logger)
}

// LoggerFromContext gets logger from context
func LoggerFromContext(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

// RequestIDFromContext gets request ID from context
func RequestIDFromContext(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey{}).(string); ok {
        return id
    }
    return ""
}

func generateRequestID() string {
    return fmt.Sprintf("%d-%d", time.Now().UnixNano(), rand.Int64())
}

// responseWriter wraps http.ResponseWriter to capture status
type responseWriter struct {
    http.ResponseWriter
    status int
    size   int
}

func (w *responseWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(b []byte) (int, error) {
    n, err := w.ResponseWriter.Write(b)
    w.size += n
    return n, err
}
```

### Usage Example

The following `main.go` wires together all three pillars of the observability stack, logging, metrics, and tracing, by initializing the `Stack` with environment-driven configuration and registering concrete health checks for the database and Redis. Calling `obs.Middleware(mux)` wraps the entire HTTP router so that every incoming request automatically gets a trace span, a scoped logger, and metric recording without any per-handler boilerplate.

```go
// main.go
package main

import (
    "context"
    "database/sql"
    "encoding/json"
    "log"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "time"

    "go.opentelemetry.io/otel"
    "myapp/observability"
)

func main() {
    // Configure observability
    cfg := observability.Config{
        ServiceName:     "api-gateway",
        ServiceVersion:  "1.0.0",
        Environment:     os.Getenv("ENV"),
        LogLevel:        slog.LevelInfo,
        LogFormat:       "json",
        MetricsEnabled:  true,
        MetricsPort:     9090,
        TracingEnabled:  true,
        TracingEndpoint: os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        SampleRate:      0.1,
    }

    // Initialize observability
    obs, err := observability.New(cfg)
    if err != nil {
        log.Fatalf("Failed to initialize observability: %v", err)
    }
    defer obs.Shutdown(context.Background())

    // Register health checks
    db, _ := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    obs.Health().Register("database", func(ctx context.Context) error {
        return db.PingContext(ctx)
    })
    obs.Health().Register("redis", func(ctx context.Context) error {
        // Check Redis connection
        return redisClient.Ping(ctx).Err()
    })

    // Create HTTP handler with observability
    mux := http.NewServeMux()
    mux.HandleFunc("/api/users", handleUsers)
    mux.HandleFunc("/api/orders", handleOrders)

    // Apply middleware
    handler := obs.Middleware(mux)

    // Start metrics server
    go func() {
        metricsMux := obs.HTTPHandler()
        http.ListenAndServe(":9090", metricsMux)
    }()

    // Mark service as ready
    obs.Health().SetReady(true)

    // Start main server
    server := &http.Server{
        Addr:    ":8080",
        Handler: handler,
    }

    go server.ListenAndServe()

    // Graceful shutdown
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, os.Interrupt)
    <-stop

    obs.Health().SetReady(false)
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    server.Shutdown(ctx)
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    logger := observability.LoggerFromContext(ctx)

    logger.Info("handling users request")

    // Business logic with tracing
    _, span := otel.Tracer("api-gateway").Start(ctx, "database.query")
    defer span.End()

    // Do work...
    users := getUsers(ctx)

    json.NewEncoder(w).Encode(users)
}
```

### Docker Compose for Full Stack

Running the full observability stack locally requires several cooperating services: the OpenTelemetry Collector to receive and route telemetry, Jaeger for distributed trace visualization, Prometheus to scrape and store metrics, Loki to aggregate logs, and Grafana as the unified dashboard. This Compose file connects them all and exposes the application alongside each tool's UI port, making it straightforward to validate end-to-end observability during development before deploying to a managed cluster.

```yaml
# docker-compose.observability.yml
# Images are pinned: :latest moves under you, and the v1 Jaeger
# all-in-one image is deprecated in favor of the v2 collector-based one.

services:
  app:
    build: .
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      - OTEL_EXPORTER_OTLP_ENDPOINT=otel-collector:4317
      - DATABASE_URL=postgres://postgres:postgres@postgres:5432/app
    depends_on:
      - postgres
      - otel-collector

  # OpenTelemetry Collector
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.150.0
    command: ["--config=/etc/otel-config.yaml"]
    volumes:
      - ./otel-config.yaml:/etc/otel-config.yaml
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP

  # Jaeger v2 for traces (collector-based - the v1 all-in-one is deprecated)
  jaeger:
    image: jaegertracing/jaeger:2.20.0
    ports:
      - "16686:16686" # UI
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP

  # Prometheus for metrics
  prometheus:
    image: prom/prometheus:v3.14.0
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9091:9090"

  # Loki for logs
  loki:
    image: grafana/loki:3.6.13
    ports:
      - "3100:3100"

  # Grafana for visualization
  grafana:
    image: grafana/grafana:13.2.1
    ports:
      - "3000:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_PASSWORD=postgres

volumes:
  grafana-data:
```

### Staff Lens: Shared Observability Stack

Every new service should have this stack available by default. Build a shared observability library that handles slog setup, Prometheus registration, OpenTelemetry initialization, health check endpoints, and correlation-ID middleware. New services import it, so consistency is the default.

Without this, every team builds observability from scratch, with slightly different conventions. With it, adding observability to a new service is one import and five lines of wiring.

### Principal Lens: Observability Investment Pays Back in Incident Response

A service with proper observability resolves incidents in minutes. A service without resolves in hours. Scale that across an org with hundreds of services and millions of requests per second, and the investment pays back many times over in preserved engineering time and reduced customer impact.

---
