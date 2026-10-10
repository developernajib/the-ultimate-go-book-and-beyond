## 38.7 Middleware Patterns

### The net/http middleware signature

In Go there is no "middleware framework": a middleware is simply a function that takes a handler and returns a handler:

```go
type Middleware = func(http.Handler) http.Handler
```

That single type composes: `Chain(h, A, B, C)` returns `A(B(C(h)))`, so request flow is `A -> B -> C -> handler -> C -> B -> A` on the way out. Any library middleware (chi, gorilla, alice) ultimately wraps or unwraps around this signature, which is why you can mix and match freely.

### Common Middleware

Middleware provides a clean mechanism for applying cross-cutting concerns (logging, authentication, metrics, request tracing) across all operations without modifying individual handlers. They receive the full request context and can short-circuit the chain by writing a response and not calling `next.ServeHTTP`.

```go
// ... imports omitted for brevity (context, log/slog, net/http, runtime/debug, time)

// Logging middleware
func Logging(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Wrap response writer to capture status
            wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

            next.ServeHTTP(wrapped, r)

            logger.Info("request",
                "method", r.Method,
                "path", r.URL.Path,
                "status", wrapped.status,
                "duration", time.Since(start),
                "size", wrapped.size,
            )
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
    size   int
}

func (rw *responseWriter) WriteHeader(status int) {
    rw.status = status
    rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    size, err := rw.ResponseWriter.Write(b)
    rw.size += size
    return size, err
}

// Recovery middleware
func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if err := recover(); err != nil {
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
}

// Timeout middleware
func Timeout(duration time.Duration) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), duration)
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
                http.Error(w, "Request timeout", http.StatusGatewayTimeout)
            }
        })
    }
}

// CORS middleware
func CORS(allowedOrigins []string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            // Check if origin is allowed
            allowed := false
            for _, o := range allowedOrigins {
                if o == "*" || o == origin {
                    allowed = true
                    break
                }
            }

            if allowed {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
                w.Header().Set("Access-Control-Max-Age", "86400")
            }

            // Handle preflight
            if r.Method == http.MethodOptions {
                w.WriteHeader(http.StatusNoContent)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Request ID Middleware

A request ID follows a single HTTP request through every layer of your system. The middleware below checks for an incoming `X-Request-ID` header (set by a load balancer or upstream service) and generates a UUID if none exists. It stores the ID in both the response header and the request context, making it available to loggers, error reporters, and downstream service calls without any coupling to the middleware itself.

```go
// ... imports omitted for brevity (context, net/http, uuid)

type contextKey string

const RequestIDKey contextKey = "request_id"

// RequestID adds a unique request ID to each request
func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check for existing ID from upstream
        id := r.Header.Get("X-Request-ID")
        if id == "" {
            id = uuid.New().String()
        }

        // Set in response header
        w.Header().Set("X-Request-ID", id)

        // Add to context
        ctx := context.WithValue(r.Context(), RequestIDKey, id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// GetRequestID extracts request ID from context
func GetRequestID(ctx context.Context) string {
    if id, ok := ctx.Value(RequestIDKey).(string); ok {
        return id
    }
    return ""
}
```

### Junior → FAANG: middleware patterns prerequisites

Middleware is the most interview-heavy topic in this chapter because it concentrates three Go concepts in one place: closures, interfaces, and the decorator pattern. If you can explain the `func(http.Handler) http.Handler` signature without hesitating, you pass most phone screens for a Go-focused backend role.

The mental model is that middleware is a Russian doll. The outermost doll sees the request first and the response last. `Chain(h, A, B, C)` produces `A(B(C(h)))`, so request flow is A then B then C then handler, and response flow is handler then C then B then A. A junior mistake is assuming middleware "runs before the handler". Half of a middleware's work often happens after `next.ServeHTTP` returns (logging the status code, recording latency, emitting the metric). A middleware that only has pre-handler logic is unusual.

Worked example for a first job. A teammate's PR adds an auth middleware that calls `w.WriteHeader(401)` when the token is invalid but still calls `next.ServeHTTP`. You spot it in review. Why is it a bug? Because the handler will try to write its own status, see headers already sent, and log a "superfluous response.WriteHeader call" warning, and the response body will be a mix of the auth error and whatever the handler produced. The fix is `return` immediately after writing the error. This is the single most common middleware bug in every codebase.

Interview entry-point: be ready to implement a request-timing middleware from scratch at the whiteboard. The answer is 10 lines. Start time before `next.ServeHTTP`, duration after, log with slog. Be ready to extend it to capture the status code (wrap `http.ResponseWriter` in a struct that overrides `WriteHeader`). Be ready to explain why you cannot wrap `ResponseWriter` and still support HTTP/2 push or hijacking (because your wrapper does not implement `http.Pusher` or `http.Hijacker`, you have to type-assert and delegate). The Go 1.20+ `http.ResponseController` helps with this, know that it exists.

### Senior @ FAANG: middleware patterns at staff and principal scope

Middleware is where cross-cutting architecture lives, and at staff level the questions move from "how do you write one" to "what should be a middleware versus what should not". The answer is not obvious and gets litigated in every code review.

The rule I use: a concern belongs in middleware if and only if it is (a) independent of the handler's business logic, (b) either universal across routes or selectable by a simple per-route predicate, and (c) correct to apply in isolation. Observability, auth, rate limiting, timeout, recovery, CORS, compression, and request ID all meet these criteria. Validation, authorization, and caching mostly do not. Input validation depends on the request schema, which is per-handler. Authorization depends on the resource being accessed, which requires loading the resource, which is handler work. Response caching depends on the semantics of the handler (which query params are cache-significant, what TTL is safe), which is handler work. Push these concerns into the handler or the service layer, not middleware.

The `ResponseWriter` wrapping problem is a rabbit hole that every production Go codebase eventually falls into. The naive wrapper in the `Logging` middleware above captures `status` and `size` but breaks three things. (1) HTTP/2 server push via `http.Pusher`, because the wrapper does not implement the interface. (2) Connection hijacking for WebSocket upgrades via `http.Hijacker`. (3) Flushing for streaming responses via `http.Flusher`. The correct implementation either type-asserts the embedded writer to each optional interface and exposes it conditionally, or uses `http.ResponseController` (Go 1.20+) which walks the wrapper chain automatically. For new code use ResponseController. For legacy code, the `httpsnoop` package implements the full wrapping correctly and is worth the dependency.

The timeout middleware shown above has a subtle bug that senior engineers will flag in review. It runs the handler in a goroutine and selects on context done. But `http.ResponseWriter` is not safe for concurrent use, and once the timeout fires and `http.Error` writes the 504 response, the handler goroutine is still running and may try to write to the same ResponseWriter. This is a data race. The correct implementation is `http.TimeoutHandler` from the standard library, which wraps the response in a buffered writer and discards the handler's late writes. `http.TimeoutHandler` has its own limitation: it cancels the request context on timeout but cannot preempt the handler goroutine, which keeps running until it returns on its own. That is the fundamental tradeoff. There is no way in Go to preemptively kill a goroutine. The senior choice is usually `http.TimeoutHandler` at the middleware layer plus handlers that pass the request context to every downstream call (database, cache, RPC), so the handler work actually stops when the context is canceled even if the goroutine lives.

Request ID propagation has three hard problems. (1) Trust boundary. If the request comes from outside the trust zone, accepting an incoming `X-Request-ID` header lets an attacker pollute your logs with forged IDs (log injection, log spoofing, collision attacks against your log aggregator's deduplication). The correct rule is: accept the incoming ID only if the request entered through a trusted proxy (verify by source IP), otherwise generate a new one and optionally record the claimed one in a separate field. (2) Format. UUID v4 is fine but is 36 characters. For high-cardinality systems consider ULID (26 characters, lexically sortable, includes timestamp) or a 16-byte random hex. Never use an incrementing counter because it leaks traffic volume to anyone who sees two IDs. (3) Propagation. The request ID must flow to every downstream RPC, every log line, every metric emission, and every database query comment. The correct way is to inject it into `context.Context`, have every HTTP client and gRPC client inject it into outgoing headers, have every logger pull it from context, have every database driver emit it as a comment. In 2026 the right answer is to use OpenTelemetry's trace ID as the request ID, because the propagation infrastructure is already there via `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` and every observability vendor understands it.

Panic recovery has a correctness trap. The middleware above recovers and returns 500. But if the panic happened after the handler already called `w.WriteHeader(200)` and wrote part of the body, the 500 status is silently dropped and the client sees a truncated 200 response. There is no way to fix this from the middleware. The service then reports success when it actually failed. The correct architectural response is to buffer response bodies in the handler for any endpoint where mid-response panic is plausible (template rendering, streaming encoders without error checks), so the handler can detect the error before the first write. For endpoints that genuinely stream (SSE, large downloads), accept the tradeoff and make sure your client libraries verify the content-length or the trailing frame.

Rate limiting middleware design is a chapter on its own. The staff-level decision tree: per-IP limits are cheap but useless against distributed attackers and break behind NAT (a dorm full of students shares one IP). Per-user limits require authentication to have run first, so they cannot rate-limit the login endpoint itself. Per-user-per-endpoint limits have combinatorial cardinality and need careful storage (not in-memory unless your instance count is fixed). The production answer for an API tier is usually a two-layer scheme: a generous per-IP limit at the edge (WAF, Cloudflare, AWS API Gateway) and a strict per-user-per-endpoint limit in application middleware backed by Redis with a sliding-window or token-bucket algorithm. Algorithms: fixed-window is trivial but allows 2x the limit at window boundaries. Sliding-window is accurate but requires more storage. Token bucket is what every real system uses, because it allows bursts while enforcing a sustained rate. The Redis atomic-script implementation is ~15 lines and is the canonical pattern. Do not implement rate limiting in pure Go with `golang.org/x/time/rate` for a multi-instance service, that limiter is per-process and gives each instance the full budget.

Middleware composition at scale. When the chain grows past 10 entries, the stack traces become unreadable and the ordering ADR is the only thing keeping the team sane. Write it once, link to it from the router setup code, review it on every middleware addition. The ADR should cover the ordering rule (see section 38.6), the rationale for each entry, and the explicit list of things that are not middleware and why. This document prevents the 18-month cycle where the team slowly adds one middleware per quarter, each justified in isolation, until the chain is 20 deep and nobody remembers why auth runs before tracing.

Finally, middleware testing. Unit-test each middleware in isolation against a mock `next` handler that records whether it was called. Integration-test the full chain against a real handler, assert on observable side effects (log lines, metric emissions, response headers). Do not skip this. The class of bug that kills production is ordering regressions (someone reorders the chain in a refactor, auth now runs after rate limiting, the rate limiter keys on an empty user ID, and the whole service shares one rate-limit bucket). An ordering test that asserts the exact sequence of middleware entry and exit catches this before it ships.

---
