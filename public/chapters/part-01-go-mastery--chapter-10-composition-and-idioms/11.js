export default `## 10.10 Complete Example: HTTP Service Framework

This section ties together functional options, middleware composition, interface-based dependency injection, and idiomatic error handling into a complete HTTP service framework.

### Project Structure

A well-structured Go project separates concerns across predictable directories, making it immediately navigable to any Go developer. The following layout follows the widely adopted convention for Go module organization.

\`\`\`
httpframework/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── framework/
│   │   ├── server.go
│   │   ├── middleware.go
│   │   ├── handler.go
│   │   └── server_test.go
│   └── user/
│       ├── handler.go
│       ├── service.go
│       └── repository.go
├── Makefile
├── Dockerfile
└── go.mod
\`\`\`

### server.go, Server with Functional Options

The server implementation uses the functional options pattern to configure timeouts, middleware, and routing, providing a clean API that scales gracefully as configuration options grow.

\`\`\`go
// internal/framework/server.go
package framework

import (
    "context"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

type Server struct {
    host           string
    port           int
    readTimeout    time.Duration
    writeTimeout   time.Duration
    shutdownTimeout time.Duration
    logger         *slog.Logger
    middleware     []Middleware
    mux            *http.ServeMux
}

type Option func(*Server)

func WithPort(port int) Option {
    return func(s *Server) {
        s.port = port
    }
}

func WithReadTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.readTimeout = d
    }
}

func WithWriteTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.writeTimeout = d
    }
}

func WithShutdownTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.shutdownTimeout = d
    }
}

func WithLogger(logger *slog.Logger) Option {
    return func(s *Server) {
        s.logger = logger
    }
}

func WithMiddleware(mw ...Middleware) Option {
    return func(s *Server) {
        s.middleware = append(s.middleware, mw...)
    }
}

func NewServer(host string, opts ...Option) *Server {
    s := &Server{
        host:           host,
        port:           8080,
        readTimeout:    10 * time.Second,
        writeTimeout:   10 * time.Second,
        shutdownTimeout: 30 * time.Second,
        logger:         slog.Default(),
        mux:            http.NewServeMux(),
    }

    for _, opt := range opts {
        opt(s)
    }

    return s
}

func (s *Server) Handle(pattern string, handler Handler) {
    s.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        resp, err := handler(ctx, r)
        if err != nil {
            s.handleError(w, r, err)
            return
        }

        s.writeResponse(w, resp)
    })
}

func (s *Server) Run() error {
    // Build handler with middleware
    var handler http.Handler = s.mux
    for i := len(s.middleware) - 1; i >= 0; i-- {
        handler = s.middleware[i](handler)
    }

    server := &http.Server{
        Addr:         fmt.Sprintf("%s:%d", s.host, s.port),
        Handler:      handler,
        ReadTimeout:  s.readTimeout,
        WriteTimeout: s.writeTimeout,
    }

    // Graceful shutdown
    errChan := make(chan error, 1)
    go func() {
        s.logger.Info("server starting", "addr", server.Addr)
        errChan <- server.ListenAndServe()
    }()

    // Wait for interrupt
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errChan:
        return err
    case sig := <-sigChan:
        s.logger.Info("received signal", "signal", sig)
    }

    // Shutdown gracefully
    ctx, cancel := context.WithTimeout(context.Background(), s.shutdownTimeout)
    defer cancel()

    s.logger.Info("shutting down server")
    return server.Shutdown(ctx)
}

func (s *Server) handleError(w http.ResponseWriter, r *http.Request, err error) {
    var appErr *AppError
    if !errors.As(err, &appErr) {
        appErr = InternalError(err)
    }

    s.logger.Error("request error",
        "path", r.URL.Path,
        "method", r.Method,
        "error", err.Error(),
    )

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(appErr.Status)
    json.NewEncoder(w).Encode(map[string]any{
        "error": map[string]any{
            "code":    appErr.Code,
            "message": appErr.Message,
        },
    })
}

func (s *Server) writeResponse(w http.ResponseWriter, resp *Response) {
    for k, v := range resp.Headers {
        w.Header().Set(k, v)
    }

    if resp.ContentType != "" {
        w.Header().Set("Content-Type", resp.ContentType)
    } else {
        w.Header().Set("Content-Type", "application/json")
    }

    w.WriteHeader(resp.Status)

    if resp.Body != nil {
        if resp.ContentType == "application/json" || resp.ContentType == "" {
            json.NewEncoder(w).Encode(resp.Body)
        } else if data, ok := resp.Body.([]byte); ok {
            w.Write(data)
        }
    }
}
\`\`\`

### handler.go, Handler Types

The handler types implement the HTTP handler interface and delegate to the service layer. Each handler validates input, invokes the service, and translates domain errors to HTTP responses.

\`\`\`go
// internal/framework/handler.go
package framework

import (
    "context"
    "net/http"
)

// Handler is the signature for route handlers
type Handler func(ctx context.Context, r *http.Request) (*Response, error)

// Response represents an HTTP response
type Response struct {
    Status      int
    ContentType string
    Headers     map[string]string
    Body        any
}

// Success helpers
func OK(body any) *Response {
    return &Response{Status: http.StatusOK, Body: body}
}

func Created(body any) *Response {
    return &Response{Status: http.StatusCreated, Body: body}
}

func NoContent() *Response {
    return &Response{Status: http.StatusNoContent}
}

// AppError represents an application error
type AppError struct {
    Status  int
    Code    string
    Message string
    cause   error
}

func (e *AppError) Error() string {
    if e.cause != nil {
        return fmt.Sprintf("%s: %v", e.Message, e.cause)
    }
    return e.Message
}

func (e *AppError) Unwrap() error {
    return e.cause
}

// Error constructors
func BadRequest(message string) *AppError {
    return &AppError{
        Status:  http.StatusBadRequest,
        Code:    "BAD_REQUEST",
        Message: message,
    }
}

func NotFound(resource string) *AppError {
    return &AppError{
        Status:  http.StatusNotFound,
        Code:    "NOT_FOUND",
        Message: fmt.Sprintf("%s not found", resource),
    }
}

func InternalError(cause error) *AppError {
    return &AppError{
        Status:  http.StatusInternalServerError,
        Code:    "INTERNAL_ERROR",
        Message: "internal server error",
        cause:   cause,
    }
}
\`\`\`

### middleware.go, Middleware

Middleware wraps HTTP handlers to provide cross-cutting concerns such as logging, authentication, and panic recovery without cluttering individual handler implementations.

\`\`\`go
// internal/framework/middleware.go
package framework

import (
    "context"
    "log/slog"
    "net/http"
    "runtime/debug"
    "time"

    "github.com/google/uuid"
)

type Middleware func(http.Handler) http.Handler

type contextKey string

const RequestIDKey contextKey = "request_id"

func RequestID() Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            id := r.Header.Get("X-Request-ID")
            if id == "" {
                id = uuid.New().String()
            }

            ctx := context.WithValue(r.Context(), RequestIDKey, id)
            w.Header().Set("X-Request-ID", id)

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func Logging(logger *slog.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            wrapped := &responseWriter{ResponseWriter: w, status: 200}
            next.ServeHTTP(wrapped, r)

            reqID, _ := r.Context().Value(RequestIDKey).(string)
            logger.Info("request",
                "request_id", reqID,
                "method", r.Method,
                "path", r.URL.Path,
                "status", wrapped.status,
                "duration", time.Since(start),
            )
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (w *responseWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

func Recovery(logger *slog.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rec := recover(); rec != nil {
                    logger.Error("panic",
                        "error", rec,
                        "stack", string(debug.Stack()),
                    )

                    w.Header().Set("Content-Type", "application/json")
                    w.WriteHeader(http.StatusInternalServerError)
                    w.Write([]byte(\`{"error":{"code":"INTERNAL_ERROR","message":"internal server error"}}\`))
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
\`\`\`

### main.go, Application Entry

The application entry point wires together all components, configures the server, and handles graceful shutdown. This file should remain thin, delegating business logic to internal packages.

\`\`\`go
// cmd/server/main.go
package main

import (
    "log"
    "log/slog"
    "os"
    "time"

    "myapp/internal/framework"
    "myapp/internal/user"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Create dependencies
    userRepo := user.NewInMemoryRepository()
    userService := user.NewService(userRepo)
    userHandler := user.NewHandler(userService)

    // Create server
    server := framework.NewServer("0.0.0.0",
        framework.WithPort(8080),
        framework.WithReadTimeout(10*time.Second),
        framework.WithWriteTimeout(10*time.Second),
        framework.WithLogger(logger),
        framework.WithMiddleware(
            framework.Recovery(logger),
            framework.RequestID(),
            framework.Logging(logger),
        ),
    )

    // Register routes
    server.Handle("GET /users", userHandler.List)
    server.Handle("GET /users/{id}", userHandler.Get)
    server.Handle("POST /users", userHandler.Create)
    server.Handle("PUT /users/{id}", userHandler.Update)
    server.Handle("DELETE /users/{id}", userHandler.Delete)

    // Run server
    if err := server.Run(); err != nil {
        log.Fatal(err)
    }
}
\`\`\`

### Framework Adoption Discipline

A "framework" accumulates dependencies on its patterns throughout the codebase. For a senior engineer, the trade-off is real: an internal HTTP framework removes boilerplate but locks every service into the framework's conventions. Adopt an internal framework only when the team commits to maintaining it. Otherwise, the framework rots and every service has to migrate off it.

### What This Example Gets Right and Wrong

This is a teaching reference, not a production framework. A staff reviewer would flag:

**Right:**
- \`net/http\` with \`slog\` and no third-party router. Go 1.22+ pattern matching (\`GET /users/{id}\`) removes the historical need for gorilla/mux or chi in simple services.
- Functional options on the server. Composable middleware. Clean separation between handler, service, repository.
- Graceful shutdown with signal handling and a bounded shutdown timeout.

**Wrong or incomplete:**
- The \`Recovery\` middleware writes the panic response but does not mark the request as failed for metrics or tracing. In production, panic handling must emit a tracing span with error status and a metric increment.
- No tracing middleware. In 2026, any production HTTP service has OpenTelemetry instrumentation as table stakes.
- No explicit request body size limit. \`MaxBytesReader\` should wrap the request body for any POST/PUT endpoint.
- \`application/json\` is assumed but not enforced. Production services should reject non-JSON POSTs with 415.
- The \`responseWriter\` wrapper misses \`Hijacker\`, \`Flusher\`, and \`http/2 Pusher\`. A server that is ever upgraded to websockets or SSE will break. The fix is the optional-interface pattern: wrap, then assert through to the underlying writer for those interfaces on demand.

### Staff Lens: The Gravitational Pull Toward a Framework

Every team that builds a few Go services starts noticing the boilerplate. The natural next step is to extract a framework. Resist for as long as possible. The reasons:

1. **Frameworks have maintenance owners.** If no team commits to owning the framework for three years, it will be abandoned. Every service that depends on it will rewrite around the abandonment.
2. **Frameworks make non-trivial upgrades coordinated.** The framework version shipped with \`slog\` (Go 1.21) replaced the one shipped with \`zap\`. Every service had to migrate on the framework's schedule, not their own.
3. **Frameworks embed assumptions.** This example's \`Handler func(ctx, r) (*Response, error)\` signature is elegant. It also mandates JSON. A service that needs to stream protobuf or serve binary files must escape the framework, at which point the framework has become overhead without benefit.

The staff recommendation for most teams: a shared package of middleware (\`Recovery\`, \`Logging\`, \`RequestID\`, \`Tracing\`), a shared error-response helper, a shared \`slog\` setup. Each service wires its own \`http.Server\` explicitly. This is more lines per service but zero framework lock-in. The shared code is library, not framework. When a service needs to diverge, it diverges without rewriting.

### Principal Lens: When a Framework Is Actually Justified

A framework is justified when the team has 20+ Go services with genuinely homogeneous concerns (same auth, same telemetry, same configuration). At that scale, the cost of framework maintenance is amortised, and the consistency benefit is large. Below that scale, prefer a shared library of small components. The Go community's track record with internal frameworks is mixed. Every major Go-heavy company has a graveyard of internal HTTP frameworks that looked like a good idea at version 1 and a liability by version 4. Principal engineers who have lived through one abandonment learn to resist framework-building unless the justification is overwhelming.

---
`;
