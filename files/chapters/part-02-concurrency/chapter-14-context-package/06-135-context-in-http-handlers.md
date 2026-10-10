## 14.5 Context in HTTP Handlers

HTTP handlers receive context from incoming requests and should propagate it to all downstream operations.

### Request Context Lifecycle

`r.Context()` returns a context that is automatically canceled when the HTTP server shuts down, the client closes the connection, or the handler returns. Checking `errors.Is(err, context.Canceled)` before writing a response prevents writing to a connection that is already closed, which would only produce a confusing error log entry.

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // ctx.Done() is closed when:
    // 1. Client closes the connection
    // 2. Request is canceled
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
```

### Production Middleware Stack

Production HTTP servers rely on a chain of middleware functions to handle cross-cutting concerns such as request tracing, timeouts, structured logging, and panic recovery. Each middleware wraps the next handler and uses `r.WithContext(ctx)` to thread an enriched context through the pipeline.

Order matters, and it is determined by data dependencies rather than taste. `RequestIDMiddleware` must be **outermost**, because every other middleware wants the ID. `LoggingMiddleware` must come before `RecoverMiddleware`, because `RecoverMiddleware` reads the request-scoped logger out of the context, and a logger that has not been installed yet is a nil pointer waiting to panic inside your panic handler. Everything else nests inward from there.

```go
package middleware

import (
    "context"
    "log/slog"
    "net/http"
    "regexp"
    "runtime/debug"
    "time"

    "uuid"

    "lifecycle/internal/appctx"
)

// validRequestID reports whether a client-supplied request ID is safe to
// use verbatim. Anything else is replaced with a fresh ID: an arbitrary
// header value would sail past rate limiting, poison trace correlation,
// and (section 14.8) can break out of SQL comments.
var validRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// RequestIDMiddleware adds request ID to context
func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        requestID := r.Header.Get("X-Request-ID")
        if !validRequestIDPattern.MatchString(requestID) {
            requestID = uuid.New().String()
        }

        ctx := appctx.WithRequestID(r.Context(), requestID)
        w.Header().Set("X-Request-ID", requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// TimeoutMiddleware sets a deadline on the request context.
//
// Note what it does NOT do: it does not run the handler in a goroutine and
// race it against the timeout. See "Why the goroutine version is wrong" below.
func TimeoutMiddleware(timeout time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), timeout)
            defer cancel()

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// LoggingMiddleware adds structured logger to context
func LoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            requestID := appctx.RequestID(r.Context())

            // Create request-scoped logger
            reqLogger := logger.With(
                "request_id", requestID,
                "method", r.Method,
                "path", r.URL.Path,
            )

            ctx := appctx.WithLogger(r.Context(), reqLogger)

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
    status      int
    wroteHeader bool
}

func (rw *responseWriter) WriteHeader(code int) {
    if rw.wroteHeader {
        return // don't double-write, as the real writer would log "superfluous"
    }
    rw.wroteHeader = true
    rw.status = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    if !rw.wroteHeader {
        rw.WriteHeader(http.StatusOK) // mirror net/http's implicit 200
    }
    return rw.ResponseWriter.Write(b)
}

// Unwrap lets http.NewResponseController reach the underlying writer,
// so wrapping does not destroy Flush/Hijack/SetDeadline support.
// Without this, the SSE handler below silently breaks. See the discussion.
func (rw *responseWriter) Unwrap() http.ResponseWriter {
    return rw.ResponseWriter
}

// RecoverMiddleware handles panics
func RecoverMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                // http.ErrAbortHandler is the documented way to abort a
                // handler without logging noise. Re-panic so net/http
                // handles it as intended.
                if err == http.ErrAbortHandler {
                    panic(err)
                }
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

// SetupMiddleware wires the stack.
//
// Read this bottom-up: the LAST line applied is the OUTERMOST wrapper,
// so RequestID runs first and Recover runs closest to the handler.
// Request flow: RequestID -> Logging -> Recover -> Timeout -> handler
func SetupMiddleware(handler http.Handler) http.Handler {
    handler = TimeoutMiddleware(30 * time.Second)(handler)
    handler = RecoverMiddleware(handler)                  // needs the logger
    handler = LoggingMiddleware(slog.Default())(handler)  // installs the logger
    handler = RequestIDMiddleware(handler)                // needed by logging
    return handler
}
```

**Read the wiring order carefully, because it is the opposite of how it looks.** Each line wraps the accumulated handler, so the *last* line applied ends up outermost and runs first. Writing `handler = RecoverMiddleware(handler)` on the first line does not make recovery outermost, it makes it innermost, where it catches panics only from the final handler and not from any middleware above it.

The dependency chain forces the order:

- `RequestIDMiddleware` outermost, because `LoggingMiddleware` calls `appctx.RequestID(r.Context())`. Invert these and every access log carries an empty request ID.
- `LoggingMiddleware` before `RecoverMiddleware`, because `RecoverMiddleware` calls `appctx.Logger(r.Context())`. Invert these and the recover handler dereferences a nil logger *while already handling a panic*, turning a recoverable handler panic into a process-killing one. The panic handler is the worst possible place for a latent nil dereference, since it only executes when something has already gone wrong.

**Why the goroutine version of TimeoutMiddleware is wrong.** The tempting implementation runs the handler in a goroutine and races it against the deadline:

```go
// BROKEN: two goroutines write to the same ResponseWriter
done := make(chan struct{})
go func() {
    next.ServeHTTP(w, r.WithContext(ctx)) // goroutine writes w
    close(done)
}()

select {
case <-done:
case <-ctx.Done():
    http.Error(w, "Request timeout", http.StatusGatewayTimeout) // parent writes w
}
```

When the timeout fires, the parent writes a 504 while the handler goroutine is still running and may write at any moment. A `ResponseWriter` is not safe for concurrent use, and this is a genuine data race, confirmed by the race detector:

```
WARNING: DATA RACE
Write at 0x00c00021a068 by goroutine 15:
  net/http.(*response).write()
...
Previous read at 0x00c00021a068 by goroutine 12:
  net/http.(*response).shouldReuseConnection()
```

Alongside it: `http: superfluous response.WriteHeader call`, because both parties tried to write a status. The corruption is not limited to one response, since `shouldReuseConnection` participates, a mangled response can poison a keep-alive connection for the next request on it.

Worse, the goroutine buys nothing. Go cannot kill a goroutine, so the handler keeps running to completion no matter what the middleware does. The timeout does not stop the work, it only stops *waiting* for the work, and then races the work it failed to stop.

The version in the stack above simply sets a deadline on the context and calls the handler directly. Cooperative cancellation is the only cancellation Go has: handlers that pass `ctx` to their queries and RPCs stop promptly, and handlers that ignore `ctx` cannot be stopped by any means. If you need the server to *respond* at the deadline even when the handler is uncooperative, that is exactly what `http.TimeoutHandler` is for, and it gets the concurrency right by buffering the handler's output and taking a lock, at the cost of not supporting streaming.

### Server-Sent Events with Context

Server-Sent Events (SSE) require the handler to remain open and push data to the client over a long-lived HTTP connection. Because the connection can outlast a typical request, the handler must watch `ctx.Done()` to detect when the client disconnects or a server shutdown is triggered, and clean up its event subscription immediately. Each event frame must be flushed rather than buffered, and a periodic keepalive tick prevents intermediary proxies from closing the idle connection.

Use `http.NewResponseController` (Go 1.20) rather than a `w.(http.Flusher)` type assertion. The reason is the `LoggingMiddleware` above: the moment any middleware wraps the `ResponseWriter`, the assertion fails and this handler starts returning "Streaming not supported" for reasons that have nothing to do with the client.

```go
func sseHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // ResponseController follows Unwrap() through middleware wrappers.
    // w.(http.Flusher) does not, and silently fails behind any wrapper.
    rc := http.NewResponseController(w)

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    if err := rc.Flush(); err != nil {
        // Reports ErrNotSupported when the writer chain cannot stream.
        http.Error(w, "Streaming not supported", http.StatusInternalServerError)
        return
    }

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
            fmt.Fprintf(w, "id: %s\n", event.ID)
            fmt.Fprintf(w, "event: %s\n", event.Type)
            fmt.Fprintf(w, "data: %s\n\n", data)
            rc.Flush()

        case <-ticker.C:
            // Keepalive
            fmt.Fprintf(w, ": keepalive\n\n")
            rc.Flush()
        }
    }
}
```

This interaction is worth dwelling on, because it is a genuinely nasty class of bug: **middleware that wraps `ResponseWriter` silently strips its optional interfaces.** `http.ResponseWriter` is a small interface, but the concrete value the server passes you also implements `http.Flusher`, `http.Hijacker`, and more. A wrapper that embeds `http.ResponseWriter` to intercept `WriteHeader` satisfies only `ResponseWriter`, so every optional interface disappears. Measured with the `LoggingMiddleware` wrapper from above:

```
plainWrapper     w.(http.Flusher) ok = false | ResponseController.Flush err = feature not supported
unwrapWrapper    w.(http.Flusher) ok = false | ResponseController.Flush err = <nil>
```

Read the second row carefully. Adding `Unwrap()` does **not** rescue the type assertion, since the wrapper still does not implement `Flush`. It only rescues `ResponseController`, which knows to follow `Unwrap`. So both halves of the fix are required: the wrapper must provide `Unwrap()`, and the handler must use `ResponseController` instead of a type assertion. Do one without the other and SSE stays broken.

The old alternative was to hand-write pass-through methods for `Flush`, `Hijack`, and `ReadFrom` on every wrapper, get one wrong, and discover it in production. `Unwrap` plus `ResponseController` is why that era is over.

### r.Context() Is Canceled on Client Disconnect

`http.Request.Context()` is canceled automatically when the client disconnects. This is the foundation of Go's HTTP cancellation story: use `r.Context()` for all downstream calls, and they will abort when the client goes away. The pattern to teach every junior engineer:

```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    result, err := db.QueryContext(ctx, ...)
    // If client disconnects, QueryContext returns with context.Canceled
}
```

Without this, slow queries continue after the client is long gone, burning capacity.

### Server-Side Timeout Middleware

`http.TimeoutHandler` wraps a handler with a deadline, cancels the wrapped handler's request context, and writes a 503 after the timeout. It is the one safe way to guarantee a response at the deadline regardless of what the handler does, because it buffers the handler's output and serializes access with a lock instead of racing on the `ResponseWriter`.

That buffering is also its main limitation: the whole response is held in memory, so it is unsuitable for streaming (the SSE handler above would never emit an event) and expensive for large responses. And like every timeout in Go, it cannot forcibly stop a handler goroutine that ignores cancellation. It stops *waiting*, writes 503, and the orphaned goroutine keeps running until it checks `ctx.Done()` or finishes.

The choice between the two:

- **`TimeoutMiddleware` (the deadline-only version in the stack above)**: cheap, streaming-safe, no buffering. Relies on the handler cooperating. Correct default.
- **`http.TimeoutHandler`**: guarantees a timely 503 even from an uncooperative handler, at the cost of buffering. Use it at the edge for non-streaming routes when you cannot trust every handler.

Both compose with `http.Server.ReadTimeout` and `WriteTimeout`, which protect against slow clients rather than slow handlers and are a different concern entirely. Set those too.

Downstream handlers see the deadline via `r.Context()`. If they respect it, passing `ctx` to every query and RPC, the request completes within `d` or cancels. If they do not, no middleware can save you.

### Staff Lens: Standard HTTP Middleware Stack

Every production HTTP service should have these middlewares, ordered outermost (runs first) to innermost:

1. **Request ID** (add to context and response header). First, because everything below wants it.
2. **Logging** (installs the request-scoped logger, writes the access log). Must precede anything that reads the logger from context.
3. **Recovery** (catch panics). Needs the logger from step 2. Placed here it also covers tracing, auth, rate limiting, and the handler.
4. **Tracing** (attach span to context).
5. **Auth** (validate credentials, add user identity to context).
6. **Rate limiting** (per-user or per-IP). After auth, so limits can key on the authenticated identity rather than a spoofable header.
7. **Timeout** (set the request deadline). Innermost, so the budget covers the handler rather than the middleware overhead.

The ordering is not aesthetic. Each position is forced by a data dependency: logging needs the request ID, recovery needs the logger, rate limiting needs the authenticated identity. Get one wrong and the failure is silent (empty request IDs in logs) or catastrophic (nil logger dereference inside the panic handler).

Remember that the wiring code reads in reverse: the last `handler = X(handler)` line is the outermost middleware. Write the list in a comment next to the wiring, in request order, so the next reader does not have to mentally invert it.

Missing any of these is a production gap. Document them as the team's standard, provide shared implementations, and review every service for compliance.

---
