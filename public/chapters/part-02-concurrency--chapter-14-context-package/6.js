export default `## 14.5 Context in HTTP Handlers

HTTP handlers receive context from incoming requests and should propagate it to all downstream operations.

### Request Context Lifecycle

\`r.Context()\` returns a context that is automatically cancelled when the HTTP server shuts down, the client closes the connection, or the handler returns. Checking \`errors.Is(err, context.Canceled)\` before writing a response prevents writing to a connection that is already closed, which would only produce a confusing error log entry.

\`\`\`go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // ctx.Done() is closed when:
    // 1. Client closes the connection
    // 2. Request is cancelled
    // 3. Server calls Shutdown()
    // 4. Handler creates child context that times out

    // Monitor client disconnection
    go func() {
        <-ctx.Done()
        log.Printf("Client disconnected: %v", ctx.Err())
    }()

    // Use context for all operations
    user, err := fetchUser(ctx, r.URL.Query().Get("id"))
    if err != nil {
        if errors.Is(err, context.Canceled) {
            // Client disconnected, don't write response
            return
        }
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(user)
}
\`\`\`

### Production Middleware Stack

Production HTTP servers rely on a chain of middleware functions to handle cross-cutting concerns such as request tracing, timeouts, structured logging, and panic recovery. Each middleware in the stack wraps the next handler and uses \`r.WithContext(ctx)\` to thread an enriched context through the entire request pipeline. The order in which middleware is applied matters: \`RecoverMiddleware\` should be outermost so it catches panics from every layer beneath it, while \`RequestIDMiddleware\` should be innermost so the ID is available to all other middleware.

\`\`\`go
package middleware

import (
    "context"
    "log/slog"
    "net/http"
    "time"

    "github.com/google/uuid"
)

// RequestIDMiddleware adds request ID to context
func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.NewString()
        }

        ctx := WithRequestID(r.Context(), requestID)
        w.Header().Set("X-Request-ID", requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// TimeoutMiddleware adds timeout to requests
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            // Use channel to detect completion
            done := make(chan struct{})
            go func() {
                next.ServeHTTP(w, r.WithContext(ctx))
                close(done)
            }()

            select {
            case <-done:
                // Handler completed normally
            case <-ctx.Done():
                // Timeout occurred
                if ctx.Err() == context.DeadlineExceeded {
                    http.Error(w, "Request timeout", http.StatusGatewayTimeout)
                }
            }
        })
    }
}

// LoggingMiddleware adds structured logger to context
func LoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            requestID := RequestID(r.Context())

            // Create request-scoped logger
            reqLogger := logger.With(
                "request_id", requestID,
                "method", r.Method,
                "path", r.URL.Path,
            )

            ctx := WithLogger(r.Context(), reqLogger)

            // Wrap response writer to capture status
            wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

            next.ServeHTTP(wrapped, r.WithContext(ctx))

            reqLogger.Info("request completed",
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

func (rw *responseWriter) WriteHeader(code int) {
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

// RecoverMiddleware handles panics
func RecoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                logger := Logger(r.Context())
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

// Apply middleware in correct order
func SetupMiddleware(handler http.Handler) http.Handler {
    // Order matters: outermost first
    handler = RecoverMiddleware(handler)
    handler = LoggingMiddleware(slog.Default())(handler)
    handler = TimeoutMiddleware(30 * time.Second)(handler)
    handler = RequestIDMiddleware(handler)
    return handler
}
\`\`\`

### Server-Sent Events with Context

Server-Sent Events (SSE) require the handler to remain open and push data to the client over a long-lived HTTP connection. Because the connection can outlast a typical request, the handler must watch \`ctx.Done()\` to detect when the client disconnects or a server shutdown is triggered, and clean up its event subscription immediately. The \`http.Flusher\` interface is used to push each event frame to the client without buffering, and a periodic keepalive tick prevents intermediary proxies from closing the idle connection.

\`\`\`go
func sseHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Check if streaming is supported
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming not supported", http.StatusInternalServerError)
        return
    }

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Subscribe to events
    events := make(chan Event, 10)
    subscription := eventBus.Subscribe(events)
    defer eventBus.Unsubscribe(subscription)

    // Send keepalive every 15 seconds
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            // Client disconnected
            log.Printf("SSE client disconnected: %v", ctx.Err())
            return

        case event := <-events:
            data, _ := json.Marshal(event)
            fmt.Fprintf(w, "id: %s\\n", event.ID)
            fmt.Fprintf(w, "event: %s\\n", event.Type)
            fmt.Fprintf(w, "data: %s\\n\\n", data)
            flusher.Flush()

        case <-ticker.C:
            // Keepalive
            fmt.Fprintf(w, ": keepalive\\n\\n")
            flusher.Flush()
        }
    }
}
\`\`\`

### r.Context() Is Cancelled on Client Disconnect

\`http.Request.Context()\` is cancelled automatically when the client disconnects. This is the foundation of Go's HTTP cancellation story: use \`r.Context()\` for all downstream calls, and they will abort when the client goes away. The pattern to teach every junior engineer:

\`\`\`go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    result, err := db.QueryContext(ctx, ...)
    // If client disconnects, QueryContext returns with context.Canceled
}
\`\`\`

Without this, slow queries continue after the client is long gone, burning capacity.

### Server-Side Timeout Middleware

\`http.TimeoutHandler\` wraps a handler with a deadline but has a trap: it does not cancel the context of the wrapped handler, just replaces the response with a 503 after the timeout. For modern handlers, use \`http.Server.ReadTimeout\`, \`WriteTimeout\`, and middleware that adds a context deadline:

\`\`\`go
func TimeoutMiddleware(d time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), d)
            defer cancel()
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
\`\`\`

Downstream handlers see the deadline via \`r.Context()\`. If they respect it (pass it to queries and RPC calls), the request completes within \`d\` or cancels.

### Staff Lens: Standard HTTP Middleware Stack

Every production HTTP service should have these middlewares, in this order:

1. Recovery (catch panics).
2. Request ID (add to context and response header).
3. Timeout (set request deadline).
4. Logging (access log with request ID, deadline, status).
5. Tracing (attach span to context).
6. Auth (validate credentials, add user to context).
7. Rate limiting (per-user or per-IP).

Missing any of these is a production gap. Document them as the team's standard. Provide shared implementations. Review every service for compliance.

---
`;
