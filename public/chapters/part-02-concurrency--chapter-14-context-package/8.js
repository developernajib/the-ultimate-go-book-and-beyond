export default `## 14.7 Complete Application: Request Lifecycle Manager

This section builds a production-grade request lifecycle manager that ties together every context pattern covered so far: typed keys, middleware propagation, timeout budgeting, trace correlation, and graceful shutdown.

### Project Structure

\`\`\`
lifecycle/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── context/
│   │   ├── context.go
│   │   ├── trace.go
│   │   └── logger.go
│   ├── middleware/
│   │   ├── middleware.go
│   │   └── middleware_test.go
│   ├── handler/
│   │   ├── handler.go
│   │   └── handler_test.go
│   └── service/
│       ├── service.go
│       └── service_test.go
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
\`\`\`

### Context Package

The \`appctx\` package defines typed context keys and accessor functions for all request-scoped values: request IDs, authenticated users, start times, and tracing metadata. Using an unexported \`contextKey\` integer type prevents key collisions with other packages that may store values on the same context. Each value has a paired \`WithX\` setter and \`X\` getter, making the API explicit and safe to use across package boundaries.

\`\`\`go
// internal/context/context.go
package appctx

import (
    "context"
    "log/slog"
    "time"
)

type contextKey int

const (
    requestIDKey contextKey = iota
    userKey
    traceKey
    loggerKey
    startTimeKey
)

// RequestInfo contains request metadata
type RequestInfo struct {
    ID        string
    UserID    string
    StartTime time.Time
    Method    string
    Path      string
}

// WithRequestID adds request ID to context
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

// RequestID retrieves request ID from context
func RequestID(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey).(string); ok {
        return id
    }
    return ""
}

// WithUser adds authenticated user to context
func WithUser(ctx context.Context, user *User) context.Context {
    return context.WithValue(ctx, userKey, user)
}

// User retrieves authenticated user from context
func User(ctx context.Context) (*User, bool) {
    user, ok := ctx.Value(userKey).(*User)
    return user, ok
}

// WithStartTime adds request start time to context
func WithStartTime(ctx context.Context, t time.Time) context.Context {
    return context.WithValue(ctx, startTimeKey, t)
}

// StartTime retrieves request start time
func StartTime(ctx context.Context) time.Time {
    if t, ok := ctx.Value(startTimeKey).(time.Time); ok {
        return t
    }
    return time.Time{}
}

// Elapsed returns time since request start
func Elapsed(ctx context.Context) time.Duration {
    if start := StartTime(ctx); !start.IsZero() {
        return time.Since(start)
    }
    return 0
}

// User represents an authenticated user
type User struct {
    ID       string
    Email    string
    Role     string
    TenantID string
}
\`\`\`

### Trace Package

This file implements W3C Trace Context propagation, generating hierarchical trace and span IDs using cryptographically random bytes so each request can be correlated across service boundaries. \`StartSpan\` creates a child span from whatever trace is already in context, logs span start and end with duration, and returns a cleanup function intended for use with \`defer\`. The \`ToHeader\` and \`ParseTraceHeader\` functions handle serialization to and from the standard \`Traceparent\` HTTP header format.

\`\`\`go
// internal/context/trace.go
package appctx

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "strings"
)

// TraceInfo contains distributed tracing information
type TraceInfo struct {
    TraceID    string
    SpanID     string
    ParentSpan string
    Sampled    bool
    Baggage    map[string]string
}

// WithTrace adds trace info to context
func WithTrace(ctx context.Context, trace TraceInfo) context.Context {
    return context.WithValue(ctx, traceKey, trace)
}

// Trace retrieves trace info from context
func Trace(ctx context.Context) (TraceInfo, bool) {
    trace, ok := ctx.Value(traceKey).(TraceInfo)
    return trace, ok
}

// NewTrace creates a new trace
func NewTrace() TraceInfo {
    return TraceInfo{
        TraceID: generateID(16),
        SpanID:  generateID(8),
        Sampled: true,
        Baggage: make(map[string]string),
    }
}

// NewSpan creates a child span
func NewSpan(parent TraceInfo) TraceInfo {
    return TraceInfo{
        TraceID:    parent.TraceID,
        SpanID:     generateID(8),
        ParentSpan: parent.SpanID,
        Sampled:    parent.Sampled,
        Baggage:    copyBaggage(parent.Baggage),
    }
}

// StartSpan creates a child span context
func StartSpan(ctx context.Context, name string) (context.Context, func()) {
    parent, ok := Trace(ctx)
    if !ok {
        parent = NewTrace()
    }

    span := NewSpan(parent)
    ctx = WithTrace(ctx, span)

    logger := Logger(ctx)
    startTime := time.Now()

    logger.Debug("span started",
        "span_name", name,
        "trace_id", span.TraceID,
        "span_id", span.SpanID,
        "parent_span", span.ParentSpan,
    )

    return ctx, func() {
        logger.Debug("span ended",
            "span_name", name,
            "span_id", span.SpanID,
            "duration", time.Since(startTime),
        )
    }
}

// ToHeader formats trace for HTTP header
func (t TraceInfo) ToHeader() string {
    sampled := "00"
    if t.Sampled {
        sampled = "01"
    }
    return fmt.Sprintf("00-%s-%s-%s", t.TraceID, t.SpanID, sampled)
}

// ParseTraceHeader parses W3C trace context header
func ParseTraceHeader(header string) (TraceInfo, error) {
    parts := strings.Split(header, "-")
    if len(parts) != 4 {
        return TraceInfo{}, fmt.Errorf("invalid trace header format")
    }

    return TraceInfo{
        TraceID: parts[1],
        SpanID:  parts[2],
        Sampled: parts[3] == "01",
        Baggage: make(map[string]string),
    }, nil
}

func generateID(bytes int) string {
    b := make([]byte, bytes)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func copyBaggage(src map[string]string) map[string]string {
    dst := make(map[string]string, len(src))
    for k, v := range src {
        dst[k] = v
    }
    return dst
}
\`\`\`

### Logger Package

\`NewRequestLogger\` constructs a structured JSON logger that automatically extracts the request ID, trace ID, span ID, user ID, and tenant ID from context and attaches them as permanent fields on every log entry. This approach ensures that all log lines emitted during a request are automatically correlated without requiring callers to manually pass identifiers. Falling back to \`slog.Default()\` in the \`Logger\` getter means the system degrades gracefully when no logger has been stored in the context.

\`\`\`go
// internal/context/logger.go
package appctx

import (
    "context"
    "log/slog"
    "os"
)

// WithLogger adds logger to context
func WithLogger(ctx context.Context, logger *slog.Logger) context.Context {
    return context.WithValue(ctx, loggerKey, logger)
}

// Logger retrieves logger from context with request-scoped fields
func Logger(ctx context.Context) *slog.Logger {
    if logger, ok := ctx.Value(loggerKey).(*slog.Logger); ok {
        return logger
    }
    return slog.Default()
}

// NewRequestLogger creates a logger with request-scoped fields
func NewRequestLogger(ctx context.Context) *slog.Logger {
    base := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelDebug,
    }))

    attrs := []any{}

    if id := RequestID(ctx); id != "" {
        attrs = append(attrs, "request_id", id)
    }

    if trace, ok := Trace(ctx); ok {
        attrs = append(attrs, "trace_id", trace.TraceID)
        attrs = append(attrs, "span_id", trace.SpanID)
    }

    if user, ok := User(ctx); ok {
        attrs = append(attrs, "user_id", user.ID)
        attrs = append(attrs, "tenant_id", user.TenantID)
    }

    return base.With(attrs...)
}
\`\`\`

### Middleware Package

This package provides a composable middleware chain where each layer enriches the context before passing the request downstream: \`RequestID\` generates or preserves correlation IDs, \`Trace\` handles W3C trace propagation, \`Logging\` records request duration and status, and \`Timeout\` enforces a hard deadline using \`context.WithTimeout\`. The \`Auth\` middleware validates bearer tokens through a \`TokenValidator\` interface, keeping the JWT verification logic replaceable without touching the HTTP plumbing. A custom \`responseWriter\` wrapper captures the status code and byte count written downstream so the logging middleware can record them after the handler returns.

\`\`\`go
// internal/middleware/middleware.go
package middleware

import (
    "context"
    "net/http"
    "runtime/debug"
    "time"

    "lifecycle/internal/appctx"
    "github.com/google/uuid"
)

// Chain applies middleware in order
func Chain(h http.Handler, middleware ...func(http.Handler) http.Handler) http.Handler {
    for i := len(middleware) - 1; i >= 0; i-- {
        h = middleware[i](h)
    }
    return h
}

// RequestID adds request ID
func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.NewString()
        }

        ctx := appctx.WithRequestID(r.Context(), requestID)
        ctx = appctx.WithStartTime(ctx, time.Now())

        w.Header().Set("X-Request-ID", requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Trace propagates distributed tracing
func Trace(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        var trace appctx.TraceInfo

        if header := r.Header.Get("Traceparent"); header != "" {
            var err error
            trace, err = appctx.ParseTraceHeader(header)
            if err != nil {
                trace = appctx.NewTrace()
            }
        } else {
            trace = appctx.NewTrace()
        }

        ctx := appctx.WithTrace(r.Context(), trace)
        w.Header().Set("Traceparent", trace.ToHeader())

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Logging adds structured logging
func Logging(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        logger := appctx.NewRequestLogger(r.Context())
        ctx := appctx.WithLogger(r.Context(), logger)

        wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

        logger.Info("request started",
            "method", r.Method,
            "path", r.URL.Path,
            "remote_addr", r.RemoteAddr,
        )

        next.ServeHTTP(wrapped, r.WithContext(ctx))

        logger.Info("request completed",
            "status", wrapped.status,
            "bytes", wrapped.bytes,
            "duration", appctx.Elapsed(ctx),
        )
    })
}

// Timeout adds request timeout
func Timeout(d time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), d)
            defer cancel()

            done := make(chan struct{})
            go func() {
                next.ServeHTTP(w, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                return
            case <-ctx.Done():
                if ctx.Err() == context.DeadlineExceeded {
                    http.Error(w, "Request Timeout", http.StatusGatewayTimeout)
                }
            }
        })
    }
}

// Recover handles panics
func Recover(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                logger := appctx.Logger(r.Context())
                logger.Error("panic recovered",
                    "error", err,
                    "stack", string(debug.Stack()),
                )
                http.Error(w, "Internal Server Error", http.StatusInternalServerError)
            }
        }()

        next.ServeHTTP(w, r)
    })
}

// Auth validates authentication and adds user to context
func Auth(validator TokenValidator) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := extractToken(r)
            if token == "" {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            user, err := validator.Validate(r.Context(), token)
            if err != nil {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            ctx := appctx.WithUser(r.Context(), user)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
    bytes  int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    n, err := rw.ResponseWriter.Write(b)
    rw.bytes += n
    return n, err
}

type TokenValidator interface {
    Validate(ctx context.Context, token string) (*appctx.User, error)
}

func extractToken(r *http.Request) string {
    auth := r.Header.Get("Authorization")
    if len(auth) > 7 && auth[:7] == "Bearer " {
        return auth[7:]
    }
    return ""
}
\`\`\`

### Service Layer

\`OrderService\` demonstrates fine-grained timeout budgeting: each sub-operation (inventory check, payment, database write) derives its own child context with an independent deadline carved from the parent request's remaining budget, so a slow payment gateway cannot silently consume time reserved for the database write. Notifications are dispatched on a fresh \`context.Background()\` derived goroutine so they survive the request context's cancellation, but still carry the original trace information for cross-service correlation. The cache read in \`GetOrder\` uses an aggressively short 100 ms timeout, falling back to the database and backfilling the cache asynchronously so the caller is never blocked by a slow cache tier.

\`\`\`go
// internal/service/service.go
package service

import (
    "context"
    "fmt"
    "time"

    "lifecycle/internal/appctx"
)

type OrderService struct {
    db       *Database
    cache    *Cache
    payments *PaymentClient
    notify   *NotificationService
}

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
    ctx, end := appctx.StartSpan(ctx, "CreateOrder")
    defer end()

    logger := appctx.Logger(ctx)

    // Validate user
    user, ok := appctx.User(ctx)
    if !ok {
        return nil, ErrUnauthorized
    }

    // Create order with timeout budget management
    deadline, hasDeadline := ctx.Deadline()
    if hasDeadline {
        remaining := time.Until(deadline)
        logger.Debug("deadline budget",
            "remaining", remaining,
            "deadline", deadline,
        )
    }

    // Step 1: Validate inventory (max 2s)
    inventoryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    if err := s.validateInventory(inventoryCtx, req.Items); err != nil {
        cancel()
        return nil, fmt.Errorf("inventory validation: %w", err)
    }
    cancel()

    // Step 2: Process payment (max 10s)
    paymentCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    paymentID, err := s.payments.Charge(paymentCtx, user.ID, req.Total)
    if err != nil {
        cancel()
        return nil, fmt.Errorf("payment processing: %w", err)
    }
    cancel()

    // Step 3: Create order record (max 3s)
    order := &Order{
        ID:        generateOrderID(),
        UserID:    user.ID,
        Items:     req.Items,
        Total:     req.Total,
        PaymentID: paymentID,
        Status:    OrderStatusPending,
        CreatedAt: time.Now(),
    }

    dbCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
    if err := s.db.CreateOrder(dbCtx, order); err != nil {
        cancel()
        // Refund payment on failure
        s.payments.Refund(context.Background(), paymentID)
        return nil, fmt.Errorf("database error: %w", err)
    }
    cancel()

    // Step 4: Send notification (async, don't block)
    go func() {
        // Use fresh context for async operation
        notifyCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        // Propagate trace for correlation
        if trace, ok := appctx.Trace(ctx); ok {
            notifyCtx = appctx.WithTrace(notifyCtx, trace)
        }

        if err := s.notify.SendOrderConfirmation(notifyCtx, order); err != nil {
            // Log but don't fail the order
            appctx.Logger(ctx).Warn("notification failed",
                "order_id", order.ID,
                "error", err,
            )
        }
    }()

    logger.Info("order created",
        "order_id", order.ID,
        "total", req.Total,
        "items", len(req.Items),
    )

    return order, nil
}

func (s *OrderService) GetOrder(ctx context.Context, orderID string) (*Order, error) {
    ctx, end := appctx.StartSpan(ctx, "GetOrder")
    defer end()

    // Try cache first with short timeout
    cacheCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    if order, err := s.cache.GetOrder(cacheCtx, orderID); err == nil {
        cancel()
        return order, nil
    }
    cancel()

    // Fall back to database
    dbCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
    defer cancel()

    order, err := s.db.GetOrder(dbCtx, orderID)
    if err != nil {
        return nil, err
    }

    // Cache for next time (async)
    go func() {
        cacheCtx, cancel := context.WithTimeout(context.Background(), time.Second)
        defer cancel()
        s.cache.SetOrder(cacheCtx, order)
    }()

    return order, nil
}

func (s *OrderService) validateInventory(ctx context.Context, items []OrderItem) error {
    ctx, end := appctx.StartSpan(ctx, "validateInventory")
    defer end()

    for _, item := range items {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := s.db.CheckInventory(ctx, item.ProductID, item.Quantity); err != nil {
                return err
            }
        }
    }
    return nil
}
\`\`\`

### Main Application

The entry point wires together all layers: it initializes the service and handler, applies the middleware chain in the correct order (recovery outermost, timeout innermost), and configures conservative HTTP server timeouts to prevent slow-client attacks. Graceful shutdown is handled by listening for \`SIGINT\` or \`SIGTERM\` on a separate goroutine that cancels a root context, which in turn triggers \`server.Shutdown\` with its own 30-second deadline so in-flight requests can complete cleanly before the process exits.

\`\`\`go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "lifecycle/internal/handler"
    "lifecycle/internal/middleware"
    "lifecycle/internal/service"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelDebug,
    }))
    slog.SetDefault(logger)

    // Initialize services
    orderService := service.NewOrderService(/* dependencies */)
    orderHandler := handler.NewOrderHandler(orderService)

    // Setup routes
    mux := http.NewServeMux()
    mux.HandleFunc("POST /orders", orderHandler.Create)
    mux.HandleFunc("GET /orders/{id}", orderHandler.Get)
    mux.HandleFunc("GET /health", healthHandler)

    // Apply middleware
    handler := middleware.Chain(mux,
        middleware.Recover,
        middleware.RequestID,
        middleware.Trace,
        middleware.Logging,
        middleware.Timeout(30*time.Second),
    )

    server := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    // Graceful shutdown setup
    ctx, cancel := context.WithCancel(context.Background())

    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        sig := <-sigCh
        logger.Info("shutdown signal received", "signal", sig)
        cancel()
    }()

    // Start server
    go func() {
        logger.Info("server starting", "addr", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            logger.Error("server error", "error", err)
            cancel()
        }
    }()

    // Wait for shutdown signal
    <-ctx.Done()

    // Graceful shutdown with timeout
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    logger.Info("shutting down server")
    if err := server.Shutdown(shutdownCtx); err != nil {
        logger.Error("shutdown error", "error", err)
    }

    logger.Info("server stopped")
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
\`\`\`

### Dockerfile and docker-compose.yml

The Dockerfile uses a two-stage build: a \`golang:1.23-alpine\` builder compiles a statically linked binary with debug symbols stripped (\`-ldflags="-s -w"\`), and a minimal \`alpine\` runtime image copies only the final executable, keeping the production image small and free of build toolchain. The \`docker-compose.yml\` brings up the application alongside Jaeger for distributed trace visualization and Prometheus for metrics scraping, providing a complete local observability stack that mirrors a production environment. The server container includes an HTTP health check so Docker can mark it unhealthy and restart it automatically if the \`/health\` endpoint stops responding.

\`\`\`dockerfile
# Dockerfile
FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o server ./cmd/server

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/server .

EXPOSE 8080
USER nobody:nobody
ENTRYPOINT ["./server"]
\`\`\`

\`\`\`yaml
# docker-compose.yml
version: '3.8'

services:
  server:
    build: .
    ports:
      - "8080:8080"
    environment:
      - LOG_LEVEL=debug
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"  # UI
      - "14268:14268"  # Collector

  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
\`\`\`

### Tests

The test suite covers each middleware in isolation using \`httptest.NewRequest\` and \`httptest.NewRecorder\`, verifying both the happy path and edge cases such as missing headers, pre-supplied IDs, and timeout expiry. \`TestTimeoutMiddleware\` deliberately injects a handler that sleeps longer than the configured deadline, confirming that the middleware responds with \`504 Gateway Timeout\` rather than silently waiting. \`TestContextCancellation\` validates the core context propagation guarantee by cancelling a context mid-operation and asserting that the goroutine observes \`context.Canceled\` within a bounded window.

\`\`\`go
// internal/middleware/middleware_test.go
package middleware

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "lifecycle/internal/appctx"
)

func TestRequestIDMiddleware(t *testing.T) {
    handler := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := appctx.RequestID(r.Context())
        if id == "" {
            t.Error("expected request ID in context")
        }
        w.Write([]byte(id))
    }))

    t.Run("generates ID if not provided", func(t *testing.T) {
        req := httptest.NewRequest("GET", "/", nil)
        rr := httptest.NewRecorder()

        handler.ServeHTTP(rr, req)

        if rr.Header().Get("X-Request-ID") == "" {
            t.Error("expected X-Request-ID header")
        }
    })

    t.Run("uses provided ID", func(t *testing.T) {
        req := httptest.NewRequest("GET", "/", nil)
        req.Header.Set("X-Request-ID", "test-id-123")
        rr := httptest.NewRecorder()

        handler.ServeHTTP(rr, req)

        if rr.Header().Get("X-Request-ID") != "test-id-123" {
            t.Error("expected provided request ID")
        }
        if rr.Body.String() != "test-id-123" {
            t.Error("expected ID in context")
        }
    })
}

func TestTimeoutMiddleware(t *testing.T) {
    t.Run("completes within timeout", func(t *testing.T) {
        handler := Timeout(100 * time.Millisecond)(
            http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.WriteHeader(http.StatusOK)
            }),
        )

        req := httptest.NewRequest("GET", "/", nil)
        rr := httptest.NewRecorder()

        handler.ServeHTTP(rr, req)

        if rr.Code != http.StatusOK {
            t.Errorf("expected 200, got %d", rr.Code)
        }
    })

    t.Run("timeout exceeded", func(t *testing.T) {
        handler := Timeout(10 * time.Millisecond)(
            http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                time.Sleep(100 * time.Millisecond)
                w.WriteHeader(http.StatusOK)
            }),
        )

        req := httptest.NewRequest("GET", "/", nil)
        rr := httptest.NewRecorder()

        handler.ServeHTTP(rr, req)

        if rr.Code != http.StatusGatewayTimeout {
            t.Errorf("expected 504, got %d", rr.Code)
        }
    })
}

func TestTracePropagation(t *testing.T) {
    handler := Trace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        trace, ok := appctx.Trace(r.Context())
        if !ok {
            t.Error("expected trace in context")
        }
        if trace.TraceID == "" {
            t.Error("expected trace ID")
        }
    }))

    t.Run("creates new trace", func(t *testing.T) {
        req := httptest.NewRequest("GET", "/", nil)
        rr := httptest.NewRecorder()

        handler.ServeHTTP(rr, req)

        if rr.Header().Get("Traceparent") == "" {
            t.Error("expected Traceparent header")
        }
    })

    t.Run("propagates existing trace", func(t *testing.T) {
        req := httptest.NewRequest("GET", "/", nil)
        req.Header.Set("Traceparent", "00-abc123-def456-01")
        rr := httptest.NewRecorder()

        var capturedTrace appctx.TraceInfo
        handler := Trace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            capturedTrace, _ = appctx.Trace(r.Context())
        }))

        handler.ServeHTTP(rr, req)

        if capturedTrace.TraceID != "abc123" {
            t.Errorf("expected trace ID abc123, got %s", capturedTrace.TraceID)
        }
    })
}

func TestContextCancellation(t *testing.T) {
    ctx, cancel := context.WithCancel(context.Background())

    resultCh := make(chan error)
    go func() {
        // Simulate work that checks context
        for {
            select {
            case <-ctx.Done():
                resultCh <- ctx.Err()
                return
            default:
                time.Sleep(10 * time.Millisecond)
            }
        }
    }()

    // Cancel after short delay
    time.Sleep(50 * time.Millisecond)
    cancel()

    select {
    case err := <-resultCh:
        if err != context.Canceled {
            t.Errorf("expected Canceled, got %v", err)
        }
    case <-time.After(time.Second):
        t.Error("timeout waiting for cancellation")
    }
}
\`\`\`

### Staff Lens: Request Lifecycle as Org-Wide Standard

The lifecycle pattern shown in this example (root context, per-request deadline, structured cancellation, bounded shutdown) should be the same across every service in the org. When every service uses the same shape, on-call rotation is easier, shutdown bugs are rarer, and deadline propagation works end-to-end. The staff-level deliverable is a shared library or template that encodes this shape, adopted by every new service.

### Production Hardening Checklist

1. **Cancellation reason visibility.** Use \`context.WithCancelCause\` at request entry so downstream cancellation reports the cause.
2. **Metric per cancellation reason.** Count cancellations by cause (client disconnect, deadline, admin shutdown).
3. **Deadline buffer.** Each downstream call uses remaining deadline minus a buffer for response handling.
4. **Detached background work.** Audit logs and metric flushes use \`context.WithoutCancel\` so they survive client disconnect.
5. **Shutdown trace.** On shutdown, log every goroutine that does not exit within the drain deadline. These are leaks to fix.

---
`;
