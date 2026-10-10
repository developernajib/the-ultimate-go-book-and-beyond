## 46.10 Exercises with Complete Solutions

These exercises build progressively more complex gRPC-Gateway deployments. Exercise 1 focuses on routing and health checking across multiple backend services. Exercise 2 adds real-time event aggregation using Server-Sent Events.

### Exercise 1: Multi-Service Gateway with Health Aggregation

Build a gateway that routes to multiple gRPC services and provides aggregated health status. The gateway should register each backend dynamically, expose a `/health` endpoint that checks every backend's gRPC health service in parallel, and report degraded status if any backend is unhealthy.

```go
// Solution: gateway/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/grpc"
    "google.golang.org/grpc/connectivity"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/protobuf/encoding/protojson"

    orderv1 "github.com/myapp/gen/order/v1"
    productv1 "github.com/myapp/gen/product/v1"
    userv1 "github.com/myapp/gen/user/v1"
)

// ServiceConfig defines a backend service
type ServiceConfig struct {
    Name     string
    Address  string
    Register func(context.Context, *runtime.ServeMux, *grpc.ClientConn) error
}

// MultiServiceGateway manages multiple gRPC backends
type MultiServiceGateway struct {
    logger      *slog.Logger
    mux         *runtime.ServeMux
    connections map[string]*grpc.ClientConn
    connMu      sync.RWMutex
    httpServer  *http.Server
}

func NewMultiServiceGateway(logger *slog.Logger) *MultiServiceGateway {
    mux := runtime.NewServeMux(
        runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
            MarshalOptions: protojson.MarshalOptions{
                UseProtoNames:   true,
                EmitUnpopulated: false,
            },
            UnmarshalOptions: protojson.UnmarshalOptions{
                DiscardUnknown: true,
            },
        }),
        runtime.WithIncomingHeaderMatcher(func(key string) (string, bool) {
            switch key {
            case "Authorization", "X-Request-Id", "X-Trace-Id":
                return key, true
            default:
                return "", false
            }
        }),
        runtime.WithErrorHandler(customErrorHandler),
    )

    return &MultiServiceGateway{
        logger:      logger,
        mux:         mux,
        connections: make(map[string]*grpc.ClientConn),
    }
}

func (g *MultiServiceGateway) RegisterService(ctx context.Context, cfg ServiceConfig) error {
    g.connMu.Lock()
    defer g.connMu.Unlock()

    conn, err := grpc.NewClient(cfg.Address,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return fmt.Errorf("dial %s (%s): %w", cfg.Name, cfg.Address, err)
    }

    if err := cfg.Register(ctx, g.mux, conn); err != nil {
        conn.Close()
        return fmt.Errorf("register %s: %w", cfg.Name, err)
    }

    g.connections[cfg.Name] = conn
    g.logger.Info("registered service", "name", cfg.Name, "address", cfg.Address)
    return nil
}

// HealthStatus represents aggregated health
type HealthStatus struct {
    Status   string                   `json:"status"`
    Services map[string]ServiceHealth `json:"services"`
}

type ServiceHealth struct {
    Status  string `json:"status"`
    Latency string `json:"latency,omitempty"`
    Error   string `json:"error,omitempty"`
}

func (g *MultiServiceGateway) HealthHandler(w http.ResponseWriter, r *http.Request) {
    g.connMu.RLock()
    defer g.connMu.RUnlock()

    status := HealthStatus{
        Status:   "healthy",
        Services: make(map[string]ServiceHealth),
    }

    var wg sync.WaitGroup
    var mu sync.Mutex
    allHealthy := true

    for name, conn := range g.connections {
        wg.Add(1)
        go func(name string, conn *grpc.ClientConn) {
            defer wg.Done()

            health := ServiceHealth{Status: "unknown"}
            start := time.Now()

            // Check connection state
            state := conn.GetState()
            if state != connectivity.Ready {
                health.Status = "unhealthy"
                health.Error = fmt.Sprintf("connection state: %s", state)
                mu.Lock()
                allHealthy = false
                status.Services[name] = health
                mu.Unlock()
                return
            }

            // Perform health check RPC
            ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
            defer cancel()

            healthClient := grpc_health_v1.NewHealthClient(conn)
            resp, err := healthClient.Check(ctx, &grpc_health_v1.HealthCheckRequest{})

            health.Latency = time.Since(start).String()

            if err != nil {
                health.Status = "unhealthy"
                health.Error = err.Error()
                mu.Lock()
                allHealthy = false
                mu.Unlock()
            } else if resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
                health.Status = "unhealthy"
                health.Error = resp.Status.String()
                mu.Lock()
                allHealthy = false
                mu.Unlock()
            } else {
                health.Status = "healthy"
            }

            mu.Lock()
            status.Services[name] = health
            mu.Unlock()
        }(name, conn)
    }

    wg.Wait()

    if !allHealthy {
        status.Status = "degraded"
        w.WriteHeader(http.StatusServiceUnavailable)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(status)
}

func (g *MultiServiceGateway) Start(addr string) error {
    rootMux := http.NewServeMux()

    // Health endpoint
    rootMux.HandleFunc("/health", g.HealthHandler)
    rootMux.HandleFunc("/ready", g.HealthHandler)

    // Metrics placeholder
    rootMux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("# Prometheus metrics here\n"))
    })

    // Gateway routes
    handler := corsMiddleware(g.mux)
    handler = loggingMiddleware(g.logger)(handler)
    handler = recoveryMiddleware(g.logger)(handler)
    rootMux.Handle("/", handler)

    g.httpServer = &http.Server{
        Addr:         addr,
        Handler:      rootMux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    g.logger.Info("starting gateway", "addr", addr)
    return g.httpServer.ListenAndServe()
}

func (g *MultiServiceGateway) Shutdown(ctx context.Context) error {
    g.connMu.Lock()
    defer g.connMu.Unlock()

    // Close all gRPC connections
    for name, conn := range g.connections {
        if err := conn.Close(); err != nil {
            g.logger.Error("close connection", "name", name, "error", err)
        }
    }

    // Shutdown HTTP server
    return g.httpServer.Shutdown(ctx)
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    gateway := NewMultiServiceGateway(logger)
    ctx := context.Background()

    // Register services
    services := []ServiceConfig{
        {
            Name:     "user-service",
            Address:  getEnv("USER_SERVICE_ADDR", "localhost:50051"),
            Register: userv1.RegisterUserServiceHandler,
        },
        {
            Name:     "product-service",
            Address:  getEnv("PRODUCT_SERVICE_ADDR", "localhost:50052"),
            Register: productv1.RegisterProductServiceHandler,
        },
        {
            Name:     "order-service",
            Address:  getEnv("ORDER_SERVICE_ADDR", "localhost:50053"),
            Register: orderv1.RegisterOrderServiceHandler,
        },
    }

    for _, svc := range services {
        if err := gateway.RegisterService(ctx, svc); err != nil {
            logger.Error("register service failed", "name", svc.Name, "error", err)
            // Continue without this service
        }
    }

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        logger.Info("shutting down")
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        if err := gateway.Shutdown(shutdownCtx); err != nil {
            logger.Error("shutdown error", "error", err)
        }
    }()

    addr := getEnv("GATEWAY_ADDR", ":8080")
    if err := gateway.Start(addr); err != http.ErrServerClosed {
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

// Middleware implementations
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}

func loggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
            next.ServeHTTP(rec, r)

            logger.Info("request",
                "method", r.Method,
                "path", r.URL.Path,
                "status", rec.statusCode,
                "duration", time.Since(start),
                "request_id", r.Header.Get("X-Request-Id"),
            )
        })
    }
}

type statusRecorder struct {
    http.ResponseWriter
    statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
    r.statusCode = code
    r.ResponseWriter.WriteHeader(code)
}

func recoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if err := recover(); err != nil {
                    logger.Error("panic recovered", "error", err)
                    http.Error(w, "internal error", http.StatusInternalServerError)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}

func customErrorHandler(ctx context.Context, mux *runtime.ServeMux,
    marshaler runtime.Marshaler, w http.ResponseWriter, r *http.Request, err error) {
    runtime.DefaultHTTPErrorHandler(ctx, mux, marshaler, w, r, err)
}
```

### Exercise 2: Real-Time Dashboard with SSE

Build an SSE endpoint that aggregates events from multiple gRPC streaming services into a single browser-consumable event stream. The broadcaster should manage client connections, apply per-client type and source filters from query parameters, and send keepalive comments to detect dead connections.

```go
// Solution: gateway/sse.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "google.golang.org/grpc"

    metricsv1 "github.com/myapp/gen/metrics/v1"
    alertsv1 "github.com/myapp/gen/alerts/v1"
    eventsv1 "github.com/myapp/gen/events/v1"
)

// DashboardEvent is a unified event for the dashboard
type DashboardEvent struct {
    ID        string      `json:"id"`
    Type      string      `json:"type"`
    Source    string      `json:"source"`
    Timestamp time.Time   `json:"timestamp"`
    Data      any `json:"data"`
}

// SSEBroadcaster manages client connections and broadcasts events
type SSEBroadcaster struct {
    logger    *slog.Logger
    clients   map[chan DashboardEvent]struct{}
    clientsMu sync.RWMutex

    metricsClient metricsv1.MetricsServiceClient
    alertsClient  alertsv1.AlertsServiceClient
    eventsClient  eventsv1.EventsServiceClient
}

func NewSSEBroadcaster(logger *slog.Logger, metricsConn, alertsConn, eventsConn *grpc.ClientConn) *SSEBroadcaster {
    return &SSEBroadcaster{
        logger:        logger,
        clients:       make(map[chan DashboardEvent]struct{}),
        metricsClient: metricsv1.NewMetricsServiceClient(metricsConn),
        alertsClient:  alertsv1.NewAlertsServiceClient(alertsConn),
        eventsClient:  eventsv1.NewEventsServiceClient(eventsConn),
    }
}

// StartAggregator begins consuming from all gRPC streams
func (b *SSEBroadcaster) StartAggregator(ctx context.Context) {
    // Start metric stream consumer
    go b.consumeMetrics(ctx)

    // Start alerts stream consumer
    go b.consumeAlerts(ctx)

    // Start events stream consumer
    go b.consumeEvents(ctx)
}

func (b *SSEBroadcaster) consumeMetrics(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        stream, err := b.metricsClient.StreamMetrics(ctx, &metricsv1.StreamMetricsRequest{
            Interval: "5s",
        })
        if err != nil {
            b.logger.Error("metrics stream error", "error", err)
            time.Sleep(5 * time.Second)
            continue
        }

        for {
            metric, err := stream.Recv()
            if err == io.EOF {
                break
            }
            if err != nil {
                b.logger.Error("metrics recv error", "error", err)
                break
            }

            event := DashboardEvent{
                ID:        fmt.Sprintf("metric-%d", time.Now().UnixNano()),
                Type:      "metric",
                Source:    "metrics-service",
                Timestamp: time.Now(),
                Data: map[string]any{
                    "name":  metric.GetName(),
                    "value": metric.GetValue(),
                    "tags":  metric.GetTags(),
                },
            }

            b.broadcast(event)
        }

        time.Sleep(time.Second)
    }
}

func (b *SSEBroadcaster) consumeAlerts(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        stream, err := b.alertsClient.StreamAlerts(ctx, &alertsv1.StreamAlertsRequest{
            Severity: []string{"critical", "warning"},
        })
        if err != nil {
            b.logger.Error("alerts stream error", "error", err)
            time.Sleep(5 * time.Second)
            continue
        }

        for {
            alert, err := stream.Recv()
            if err == io.EOF {
                break
            }
            if err != nil {
                b.logger.Error("alerts recv error", "error", err)
                break
            }

            event := DashboardEvent{
                ID:        alert.GetId(),
                Type:      "alert",
                Source:    "alerts-service",
                Timestamp: alert.GetTimestamp().AsTime(),
                Data: map[string]any{
                    "severity": alert.GetSeverity(),
                    "title":    alert.GetTitle(),
                    "message":  alert.GetMessage(),
                    "labels":   alert.GetLabels(),
                },
            }

            b.broadcast(event)
        }

        time.Sleep(time.Second)
    }
}

func (b *SSEBroadcaster) consumeEvents(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        stream, err := b.eventsClient.StreamEvents(ctx, &eventsv1.StreamEventsRequest{
            Types: []string{"deployment", "scaling", "incident"},
        })
        if err != nil {
            b.logger.Error("events stream error", "error", err)
            time.Sleep(5 * time.Second)
            continue
        }

        for {
            evt, err := stream.Recv()
            if err == io.EOF {
                break
            }
            if err != nil {
                b.logger.Error("events recv error", "error", err)
                break
            }

            event := DashboardEvent{
                ID:        evt.GetId(),
                Type:      evt.GetType(),
                Source:    "events-service",
                Timestamp: evt.GetTimestamp().AsTime(),
                Data:      evt.GetPayload().AsMap(),
            }

            b.broadcast(event)
        }

        time.Sleep(time.Second)
    }
}

func (b *SSEBroadcaster) broadcast(event DashboardEvent) {
    b.clientsMu.RLock()
    defer b.clientsMu.RUnlock()

    for client := range b.clients {
        select {
        case client <- event:
        default:
            // Client buffer full, skip
            b.logger.Warn("client buffer full, dropping event")
        }
    }
}

// addClient registers a new SSE client
func (b *SSEBroadcaster) addClient() chan DashboardEvent {
    ch := make(chan DashboardEvent, 100)

    b.clientsMu.Lock()
    b.clients[ch] = struct{}{}
    b.clientsMu.Unlock()

    b.logger.Info("client connected", "total", len(b.clients))
    return ch
}

// removeClient unregisters an SSE client
func (b *SSEBroadcaster) removeClient(ch chan DashboardEvent) {
    b.clientsMu.Lock()
    delete(b.clients, ch)
    close(ch)
    b.clientsMu.Unlock()

    b.logger.Info("client disconnected", "total", len(b.clients))
}

// SSEHandler handles SSE connections
func (b *SSEBroadcaster) SSEHandler(w http.ResponseWriter, r *http.Request) {
    // Check for SSE support
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no")
    w.Header().Set("Access-Control-Allow-Origin", "*")

    // Register client
    eventCh := b.addClient()
    defer b.removeClient(eventCh)

    // Parse filters from query params
    typeFilter := r.URL.Query()["type"]
    sourceFilter := r.URL.Query()["source"]

    // Send initial connection event
    fmt.Fprintf(w, "event: connected\ndata: {\"message\": \"connected to dashboard stream\"}\n\n")
    flusher.Flush()

    // Keepalive ticker
    keepalive := time.NewTicker(30 * time.Second)
    defer keepalive.Stop()

    ctx := r.Context()

    for {
        select {
        case <-ctx.Done():
            fmt.Fprintf(w, "event: disconnect\ndata: {\"reason\": \"client closed\"}\n\n")
            flusher.Flush()
            return

        case <-keepalive.C:
            fmt.Fprintf(w, ": keepalive\n\n")
            flusher.Flush()

        case event := <-eventCh:
            // Apply filters
            if len(typeFilter) > 0 && !contains(typeFilter, event.Type) {
                continue
            }
            if len(sourceFilter) > 0 && !contains(sourceFilter, event.Source) {
                continue
            }

            // Serialize and send
            data, err := json.Marshal(event)
            if err != nil {
                b.logger.Error("marshal event", "error", err)
                continue
            }

            fmt.Fprintf(w, "id: %s\n", event.ID)
            fmt.Fprintf(w, "event: %s\n", event.Type)
            fmt.Fprintf(w, "data: %s\n\n", data)
            flusher.Flush()
        }
    }
}

func contains(slice []string, item string) bool {
    for _, s := range slice {
        if s == item {
            return true
        }
    }
    return false
}

// Client-side JavaScript for consuming the SSE
/*
const eventSource = new EventSource('/api/v1/dashboard/stream?type=alert&type=metric');

eventSource.onopen = () => {
    console.log('Connected to dashboard stream');
};

eventSource.addEventListener('connected', (e) => {
    console.log('Server confirmed connection:', JSON.parse(e.data));
});

eventSource.addEventListener('metric', (e) => {
    const metric = JSON.parse(e.data);
    updateMetricChart(metric.data);
});

eventSource.addEventListener('alert', (e) => {
    const alert = JSON.parse(e.data);
    showAlertNotification(alert.data);
});

eventSource.onerror = (e) => {
    console.error('SSE error:', e);
    // Implement exponential backoff reconnection
    setTimeout(() => {
        // Reconnect logic
    }, 5000);
};
*/
```

The following Docker Compose file wires the gateway to the backend services for local testing. Each service runs on its own gRPC port and the gateway connects to them by container name.

```yaml
# docker-compose.yml for testing
version: '3.8'

services:
  gateway:
    build: .
    ports:
      - "8080:8080"
    environment:
      - USER_SERVICE_ADDR=user-service:50051
      - PRODUCT_SERVICE_ADDR=product-service:50052
      - ORDER_SERVICE_ADDR=order-service:50053
      - METRICS_SERVICE_ADDR=metrics-service:50054
      - ALERTS_SERVICE_ADDR=alerts-service:50055
      - EVENTS_SERVICE_ADDR=events-service:50056
    depends_on:
      - user-service
      - product-service
      - order-service
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  user-service:
    image: myapp/user-service:latest
    ports:
      - "50051:50051"

  product-service:
    image: myapp/product-service:latest
    ports:
      - "50052:50052"

  order-service:
    image: myapp/order-service:latest
    ports:
      - "50053:50053"
```

A Makefile collects the common development commands: generating proto code, building the binary, running tests, and verifying the SSE endpoint.

```makefile
# Makefile
.PHONY: proto build test run

proto:
	buf generate

build:
	go build -o bin/gateway ./cmd/gateway

test:
	go test -v ./...

run:
	go run ./cmd/gateway

docker-build:
	docker build -t myapp/gateway:latest .

docker-run:
	docker-compose up -d

health-check:
	curl -s http://localhost:8080/health | jq

test-sse:
	curl -N http://localhost:8080/api/v1/dashboard/stream
```

### Junior -> FAANG: What to Learn From Building These Exercises

Exercise 1 (multi-service gateway) teaches you three concepts that appear repeatedly in production systems.

First, the `RegisterService` pattern using `grpc.NewClient`. In Go 1.27 and modern grpc-go, `grpc.NewClient` creates non-blocking client connections that initialize in the background without stalling gateway startup, while the parallel `HealthHandler` actively verifies connection readiness before routing traffic.

Second, the parallel health check in `HealthHandler`. Each backend is checked concurrently using a goroutine, a `sync.WaitGroup`, and a shared mutex for result collection. This is a pattern you will use repeatedly for fan-out operations. Practice writing it without looking at the reference. The common mistakes are: forgetting to capture the loop variable before passing it to the goroutine (fixed by the `name, conn` parameters in the goroutine signature), and forgetting to wait for all goroutines before reading the results (the `wg.Wait()` call).

Third, the `ServiceConfig` struct with a `Register func` field. This is the Strategy pattern applied to service registration. Instead of a switch statement that handles each service type differently, the config struct holds the behavior as a function. Adding a new service requires adding a new `ServiceConfig` literal, not modifying the gateway code. This is Open-Closed principle in practice.

Exercise 2 (SSE broadcaster) teaches the fan-out pattern and the importance of backpressure. The channel buffer size (`make(chan DashboardEvent, 100)`) is the backpressure mechanism: if a slow client cannot keep up, events are dropped rather than blocking the broadcast for all other clients. Know why 100 is the buffer size in the example (arbitrary, chosen for the exercise) versus what you would choose in production (based on the expected event rate and the acceptable staleness window).

First-job habit: run Exercise 1 with one backend intentionally unavailable and observe the health check behavior. Then run Exercise 2 with a slow SSE client (add a `time.Sleep` after each event in the receive loop) and observe the "client buffer full, dropping event" log. These failure mode observations are more educational than reading the code.

### Senior @ FAANG: Evaluating These Exercises as a Code Reviewer

A senior engineer reviewing these exercise solutions would flag several items for improvement before approving them for production use. Walking through those flags is a useful staff-level exercise.

**Exercise 1 concerns:**

The `corsMiddleware` sets `Access-Control-Allow-Origin: *`. This is acceptable in an exercise but unacceptable for a production gateway that handles authenticated requests. A code review comment would require an origin allowlist configured via environment variable, with a lint rule or startup check that rejects the wildcard in non-development environments.

The `ServiceConfig.Register` field has type `func(context.Context, *runtime.ServeMux, *grpc.ClientConn) error`. This matches the generated `RegisterXxxHandler` signature, but it does not capture the endpoint address. If the gateway needs to reconnect to a failed backend with exponential backoff, the `ServiceConfig` needs to hold the address as well as the registration function. The current design makes automatic reconnection difficult to add later.

The `HealthHandler` calls `healthClient.Check` with a 3-second timeout per backend. If there are 10 backends and all are slow, the health check takes up to 3 seconds despite running concurrently. Add a top-level context with a 5-second timeout for the entire health check fan-out so the endpoint always returns within a bounded time regardless of backend behavior.

**Exercise 2 concerns:**

The `SSEBroadcaster.broadcast` method drops events for slow clients but has no metric or log line tracking the drop count. At scale, silent event dropping is invisible until a client reports missing data. Add a counter (`eventsDropped`) labeled by the client's remote address or a client ID and expose it in the `/metrics` endpoint.

The `consumeMetrics`, `consumeAlerts`, and `consumeEvents` functions each implement the same reconnect loop with a `time.Sleep(5 * time.Second)` on error. This should be extracted into a `withRetry(ctx, fn, backoff)` helper function. The duplication means that when the backoff strategy changes (from fixed 5 seconds to exponential with jitter), three places must be updated instead of one.

The `addClient` and `removeClient` methods use a `map[chan DashboardEvent]struct{}` keyed by the channel itself. This works, but it makes it impossible to look up a client by any other key (user ID, connection ID) for administrative operations (kick a specific client, check a specific client's status). A production broadcaster would key on a string client ID and store the channel as the value.

The Docker Compose file uses `depends_on` without a health check condition. This means the gateway starts when the backend containers start, not when they are ready to accept connections. Add `condition: service_healthy` to `depends_on` and add `healthcheck` entries to each backend service definition. Otherwise, the gateway's startup dial may fail on a fast machine where the gateway container starts before the backend's gRPC port is listening.

---
