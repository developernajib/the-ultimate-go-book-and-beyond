## 48.9 Exercises with Complete Solutions

### Exercise 1: Build a Mesh-Ready Go Service

Create a Go service that integrates properly with Istio service mesh.

```go
// Solution: cmd/mesh-service/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "strconv"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
)

// Service configuration
type Config struct {
    ServiceName string
    Port        int
    OTLPEndpoint string
}

func loadConfig() *Config {
    return &Config{
        ServiceName:  getEnv("SERVICE_NAME", "mesh-service"),
        Port:         getEnvInt("PORT", 8080),
        OTLPEndpoint: getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    }
}

// Metrics
var (
    requestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "app_requests_total",
            Help: "Total requests processed by the application",
        },
        []string{"method", "path", "status"},
    )

    requestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "app_request_duration_seconds",
            Help:    "Request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )

    businessMetric = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "app_items_processed_total",
            Help: "Total items processed (business metric)",
        },
    )
)

// MeshService is a service mesh aware Go service
type MeshService struct {
    config     *Config
    tracer     trace.Tracer
    propagator propagation.TextMapPropagator
    httpClient *http.Client
    logger     *slog.Logger
}

// NewMeshService returns the service plus the tracer shutdown function.
// The shutdown must run at process exit, not here: a defer in the
// constructor would tear the tracer provider down the moment construction
// returns, and the service would never export a single span.
func NewMeshService(config *Config) (*MeshService, func(context.Context) error, error) {
    tracer, shutdown, err := setupTracer(config)
    if err != nil {
        return nil, nil, fmt.Errorf("setup tracer: %w", err)
    }

    return &MeshService{
        config:     config,
        tracer:     tracer,
        propagator: otel.GetTextMapPropagator(),
        httpClient: &http.Client{Timeout: 10 * time.Second},
        logger:     slog.Default(),
    }, shutdown, nil
}

func setupTracer(config *Config) (trace.Tracer, func(context.Context) error, error) {
    if config.OTLPEndpoint == "" {
        // No-op tracer if OTLP endpoint not configured
        return otel.Tracer(config.ServiceName), func(ctx context.Context) error { return nil }, nil
    }

    ctx := context.Background()

    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(config.OTLPEndpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, nil, err
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(config.ServiceName),
        ),
    )
    if err != nil {
        return nil, nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp.Tracer(config.ServiceName), tp.Shutdown, nil
}

// TracingMiddleware extracts and propagates trace context
func (s *MeshService) TracingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Extract trace context from incoming headers
        ctx := s.propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

        // Start span for this request. Route pattern, not raw path: raw URLs
        // with IDs explode span-name cardinality.
        spanName := r.Pattern
        if spanName == "" {
            spanName = "http.request"
        }
        ctx, span := s.tracer.Start(ctx, spanName,
            trace.WithSpanKind(trace.SpanKindServer),
        )
        defer span.End()

        // Add trace ID to response for debugging
        if span.SpanContext().HasTraceID() {
            w.Header().Set("X-Trace-ID", span.SpanContext().TraceID().String())
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// MetricsMiddleware records request metrics
func (s *MeshService) MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()
        route := r.Pattern
        if route == "" {
            route = "unmatched"
        }
        requestsTotal.WithLabelValues(r.Method, route, fmt.Sprintf("%d", wrapped.statusCode)).Inc()
        requestDuration.WithLabelValues(r.Method, route).Observe(duration)
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (w *responseWriter) WriteHeader(code int) {
    w.statusCode = code
    w.ResponseWriter.WriteHeader(code)
}

// CallDownstream demonstrates proper context propagation
func (s *MeshService) CallDownstream(ctx context.Context, url string) ([]byte, error) {
    // Create span for outbound call
    ctx, span := s.tracer.Start(ctx, "CallDownstream",
        trace.WithSpanKind(trace.SpanKindClient),
    )
    defer span.End()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }

    // CRITICAL: Inject trace context into outbound request
    s.propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := s.httpClient.Do(req)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}

// Handlers
func (s *MeshService) handleProcess(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Simulate work
    time.Sleep(50 * time.Millisecond)
    businessMetric.Inc()

    // Call downstream service (demonstrates context propagation)
    if downstream := r.URL.Query().Get("downstream"); downstream != "" {
        data, err := s.CallDownstream(ctx, downstream)
        if err != nil {
            http.Error(w, err.Error(), http.StatusBadGateway)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        w.Write(data)
        return
    }

    json.NewEncoder(w).Encode(map[string]any{
        "status":    "processed",
        "service":   s.config.ServiceName,
        "timestamp": time.Now().Format(time.RFC3339),
    })
}

// Health endpoints
func (s *MeshService) handleLiveness(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"alive"}`))
}

func (s *MeshService) handleReadiness(w http.ResponseWriter, r *http.Request) {
    // Add actual dependency checks here
    w.WriteHeader(http.StatusOK)
    w.Write([]byte(`{"status":"ready"}`))
}

func (s *MeshService) SetupRoutes() http.Handler {
    mux := http.NewServeMux()

    // Business endpoints
    mux.HandleFunc("/api/v1/process", s.handleProcess)

    // Health endpoints (no tracing/metrics middleware)
    mux.HandleFunc("/health", s.handleLiveness)
    mux.HandleFunc("/healthz", s.handleLiveness)
    mux.HandleFunc("/ready", s.handleReadiness)
    mux.HandleFunc("/readyz", s.handleReadiness)

    // Metrics endpoint
    mux.Handle("/metrics", promhttp.Handler())

    // Apply middleware to all routes
    var handler http.Handler = mux
    handler = s.MetricsMiddleware(handler)
    handler = s.TracingMiddleware(handler)

    return handler
}

func main() {
    config := loadConfig()

    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    slog.SetDefault(logger)

    service, tracerShutdown, err := NewMeshService(config)
    if err != nil {
        logger.Error("failed to create service", "error", err)
        os.Exit(1)
    }
    defer tracerShutdown(context.Background())

    server := &http.Server{
        Addr:         fmt.Sprintf(":%d", config.Port),
        Handler:      service.SetupRoutes(),
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
    }

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        logger.Info("shutting down")
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        server.Shutdown(ctx)
    }()

    logger.Info("starting server", "port", config.Port)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}

func getEnv(key, defaultValue string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
    if v := os.Getenv(key); v != "" {
        if i, err := strconv.Atoi(v); err == nil {
            return i
        }
    }
    return defaultValue
}
```

The Kubernetes manifests below deploy this service with Istio sidecar injection enabled. The Deployment sets resource limits, configures liveness and readiness probes pointing at the health endpoints defined in the Go code, and passes the OTLP exporter endpoint as an environment variable.

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mesh-service
  labels:
    app: mesh-service
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mesh-service
  template:
    metadata:
      labels:
        app: mesh-service
        version: v1
      annotations:
        sidecar.istio.io/inject: "true"
    spec:
      containers:
      - name: mesh-service
        image: myapp/mesh-service:v1
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: SERVICE_NAME
          value: "mesh-service"
        - name: PORT
          value: "8080"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "jaeger-collector.observability:4317"
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "256Mi"
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: mesh-service
spec:
  ports:
  - port: 80
    targetPort: 8080
    name: http
  selector:
    app: mesh-service
```

The Istio resources below configure retry and timeout policies via a `VirtualService`, set connection pool limits and outlier detection via a `DestinationRule`, and enforce strict mTLS via a `PeerAuthentication` policy. These three resources give the service automatic retries on transient failures, circuit-breaking protection against unhealthy endpoints, and encrypted identity-verified communication, all without any changes to the Go code above.

```yaml
# istio/traffic-management.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: mesh-service
spec:
  hosts:
  - mesh-service
  http:
  - route:
    - destination:
        host: mesh-service
    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: 5xx,reset,connect-failure
    timeout: 10s
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: mesh-service
spec:
  host: mesh-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 100
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
---
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: mesh-service
spec:
  selector:
    matchLabels:
      app: mesh-service
  mtls:
    mode: STRICT
```

### Junior → FAANG: What to Do After Completing This Exercise

Running this exercise end-to-end teaches something no amount of reading can replace: the gap between "the manifest is applied" and "the service is actually working through the mesh" requires active verification.

After deploying, verify mesh enrollment before assuming it works:

```bash
# Verify sidecar injection happened
kubectl get pod -l app=mesh-service -o jsonpath='{.items[*].spec.containers[*].name}'
# Expected output includes both "mesh-service" and "istio-proxy"

# Verify the proxy is synced with the control plane
istioctl proxy-status

# Verify mTLS is actually enforced
istioctl x describe pod <pod-name>
# Look for "mTLS" in the output

# Verify the VirtualService is applying
istioctl proxy-config route <pod-name> --name 80
# Should show the retry configuration
```

These four commands are the minimum verification checklist after any mesh-related deployment. Running them once, seeing what the output looks like in a healthy state, gives you a reference point for debugging when something goes wrong.

For the tracing integration specifically: after running the service, make a request that calls a downstream service (using the `downstream` query parameter in the exercise). Then open Jaeger or Tempo and verify you see a single trace with connected spans, not two disconnected single-hop spans. If you see disconnected spans, the `propagator.Inject` call in `CallDownstream` is the first place to check.

The exercise deliberately leaves out error handling in a few places (`_, err` patterns). Identify them and add proper error returns as a follow-up. In production code, every error must be handled or explicitly documented as intentionally ignored.

### Senior @ FAANG: Design Gaps in the Exercise and Production Hardening

The exercise is a correct starting point, but production hardening requires addressing five gaps that the exercise deliberately simplifies.

**Graceful shutdown race condition.** The `server.Shutdown(ctx)` call in `main` stops accepting new connections and waits for in-flight requests to complete. But if the pod receives `SIGTERM` while the Envoy sidecar is still routing traffic to it, new requests arrive after shutdown begins and get connection refused. The correct pattern is: (1) set the readiness endpoint to return 503 immediately on SIGTERM receipt, (2) wait for Kubernetes to update the endpoint slice and for Envoy to drain connections (approximately 5-10 seconds), (3) then call `server.Shutdown`. This requires a `preStop` hook in the pod spec: `preStop: exec: command: ["/bin/sleep", "10"]`.

**Tracer provider lifecycle.** A common mistake is calling `defer shutdown(context.Background())` inside `NewMeshService`, which would shut down the tracer when the constructor returns, before any requests are served. As shown in the solution, `NewMeshService` returns the shutdown function so it can be deferred in `main` to ensure all spans are flushed after the HTTP server stops accepting requests.

**Connection pool sizing.** The `http.Client` in the exercise has no transport configured, which means it uses Go's default transport with `MaxIdleConnsPerHost: 2`. In a service making hundreds of concurrent downstream calls, this creates connection thrash (constantly opening and closing connections rather than reusing idle ones). The production transport sets `MaxIdleConnsPerHost` to a value proportional to expected concurrency.

**Metrics cardinality.** The `requestsTotal` counter uses `r.URL.Path` as a label value. For any service with path parameters (`/api/v1/users/12345`), this creates unbounded label cardinality. The production pattern is to use the route template (`/api/v1/users/:id`) instead. With Go's `net/http` standard mux, you must normalize the path before labeling. With `httprouter` or `chi`, the route pattern is available as a context value.

**Structured logging correlation.** The exercise uses `slog.Default()` but does not add the trace ID to log entries. In a production service, every log entry should carry the trace ID so that logs and traces can be correlated in Grafana. The pattern is to extract the trace ID from the span context and add it as a structured field: `slog.With("trace_id", span.SpanContext().TraceID().String())`.

---
