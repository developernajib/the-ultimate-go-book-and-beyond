## 29.3 Middleware

### Middleware Pattern

Middleware in Go is a function that accepts and returns an `http.Handler`, inserting logic before or after the inner handler executes. Chaining middleware produces a pipeline where cross-cutting concerns, logging, authentication, compression, are composed without modifying the handler itself.

```go
package middleware

import (
    "log/slog"
    "net/http"
    "time"

    "golang.org/x/time/rate"
)

type Middleware func(http.Handler) http.Handler

// Chain applies middlewares in order
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    return h
}

// Logging middleware
func Logging(logger *slog.Logger) Middleware {
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
                "ip", r.RemoteAddr,
            )
        })
    }
}

// Recovery middleware
func Recovery(logger *slog.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if err := recover(); err != nil {
                    logger.Error("panic recovered",
                        "error", err,
                        "path", r.URL.Path,
                    )
                    http.Error(w, "Internal Server Error", http.StatusInternalServerError)
                }
            }()

            next.ServeHTTP(w, r)
        })
    }
}

// CORS middleware
func CORS(allowedOrigins []string) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            for _, allowed := range allowedOrigins {
                if allowed == "*" || allowed == origin {
                    w.Header().Set("Access-Control-Allow-Origin", origin)
                    break
                }
            }

            w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
            w.Header().Set("Access-Control-Max-Age", "86400")

            if r.Method == "OPTIONS" {
                w.WriteHeader(http.StatusOK)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Rate limiting middleware
func RateLimit(rps int) Middleware {
    limiter := rate.NewLimiter(rate.Limit(rps), rps)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow() {
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    status int
}

func (w *responseWriter) WriteHeader(code int) {
    w.status = code
    w.ResponseWriter.WriteHeader(code)
}
```

### Authentication Middleware

JWT authentication middleware validates the token signature and expiry on every request before the handler executes. Extracting claims from the validated token and storing them in the request context makes identity available to downstream handlers without repeating validation.

```go
package middleware

import (
    "context"
    "net/http"
    "strings"
)

type contextKey string

const UserContextKey contextKey = "user"

func Auth(tokenValidator TokenValidator) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract token from header
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            parts := strings.Split(authHeader, " ")
            if len(parts) != 2 || parts[0] != "Bearer" {
                http.Error(w, "Invalid authorization header", http.StatusUnauthorized)
                return
            }

            token := parts[1]

            // Validate token
            user, err := tokenValidator.Validate(token)
            if err != nil {
                http.Error(w, "Invalid token", http.StatusUnauthorized)
                return
            }

            // Add user to context
            ctx := context.WithValue(r.Context(), UserContextKey, user)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetUser(ctx context.Context) (*User, bool) {
    user, ok := ctx.Value(UserContextKey).(*User)
    return user, ok
}

// Optional auth - doesn't fail if no token
func OptionalAuth(tokenValidator TokenValidator) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader != "" {
                parts := strings.Split(authHeader, " ")
                if len(parts) == 2 && parts[0] == "Bearer" {
                    if user, err := tokenValidator.Validate(parts[1]); err == nil {
                        ctx := context.WithValue(r.Context(), UserContextKey, user)
                        r = r.WithContext(ctx)
                    }
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Junior to FAANG: Thinking in Pipelines

Middleware is function composition dressed up in HTTP vocabulary. `Chain(h, A, B, C)` runs A first, then B, then C, then the handler, then the handler returns through C, B, A on the way out. Visualize it as an onion. If you can sketch this on a whiteboard, you can explain middleware in any interview.

A mistake to watch for. Wrapping `ResponseWriter` once per middleware creates nested wrappers where each `WriteHeader` call travels through all layers. This is fine, but if two different middlewares both try to intercept status code, the inner one writes first and the outer sees its own wrapper's cached status rather than the real underlying one. Use one canonical `wrapped` writer built at the outermost layer and let inner layers only read from it. Learn `httpsnoop` as a library that does this correctly.

Worked example, adding a request ID and propagating it into logs.

```go
func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-ID")
        if id == "" {
            id = uuid.NewString()
        }
        ctx := context.WithValue(r.Context(), reqIDKey{}, id)
        w.Header().Set("X-Request-ID", id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

Then the Logging middleware reads `reqIDKey{}` from context and includes it in every log line. This pattern, once internalized, makes distributed debugging feel easy rather than painful.

### Senior at FAANG: Middleware as Org Platform

Publish a canonical middleware ordering and enforce it via a builder. The `router.Build` function takes middlewares in a fixed order and rejects misorderings at startup. The order, from outermost to innermost. panic recovery, request ID, OTEL tracing, structured logging, metrics, timeout, max body size, CORS, auth, rate limit, idempotency check, handler. Document the reason for each position. Request ID must precede logging so logs carry it. Auth must precede rate limit so per-user limits work. Max body size must precede handler to avoid OOM on malformed uploads.

Ban custom panic recovery per service. The platform recovery middleware emits a structured error with a stable `code: internal_panic`, records a `panic_total` counter, captures the stack to the error-tracking system (Sentry, Honeycomb, etc.), and writes an RFC 7807 problem+json response. If teams roll their own, you get inconsistent incident signal.

CORS governance. CORS is one of the most common FAANG misconfigurations. `Access-Control-Allow-Origin: *` with `Allow-Credentials: true` is both illegal and silently ignored by browsers, leading to confusing "CORS error" debugging. Publish a `CORSPolicy` type, require teams to declare their allowed origins, forbid the wildcard when credentials are allowed, and unit-test the resulting middleware against a matrix of origin and method combinations. Run a quarterly audit that scans all services for CORS config and compares against the declared external-domain list.

Rate limiting at scale. The `rate.NewLimiter` in-process limiter is per-pod. Under 20 pods, that is "rate limit times 20." Use it as a last-ditch defense only. Real rate limiting lives in a shared Redis cluster using a sliding-log or token-bucket Lua script. Layer the hierarchy. WAF (per-IP, coarse), API gateway (per-key, medium), service middleware (per-user, fine), database pool (per-tenant, protective). Publish a `ratelimit.Client` that handles the Lua execution, caches the counter locally for 100 ms to absorb bursts, and falls open when Redis is unreachable (fail-open or fail-closed is a policy decision, document which per endpoint class).

Authentication middleware as a platform. JWT parsing is a foot-gun surface. Use a shared `platform/auth` package that encapsulates JWKS rotation, algorithm allowlisting (ban `none`, require RS256 or EdDSA), clock skew tolerance (60 seconds), `aud` and `iss` validation, and revocation-list check. One library, one CVE response path. Services wire it in with one line and inherit patches centrally.

Observability middleware, the RED standard. Every request emits `http_requests_total{method,route,status}`, `http_request_duration_seconds{method,route}` as a histogram with buckets aligned to your SLO (5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s), and `http_in_flight_requests` as a gauge. Route labels must be the route pattern not the URL (avoid cardinality explosion on `/users/{id}`). Enforce this via a middleware that pulls the pattern from chi's `RouteContext` or stdlib's matched pattern.

OTEL instrumentation. The `otelhttp.NewHandler` wrapper is the standard. Place it immediately inside request-ID so traces carry the request ID and outside auth so the span captures auth errors. Configure sampling at 100 percent for error spans, head-based 1 percent for success. Staff-level roadmap, move to tail-based sampling in year 2 via OTEL collector, which removes the 1-percent blind spot on slow requests.

Idempotency middleware. For POST and PUT on mutating endpoints, require `Idempotency-Key`, store `(key, request-hash)` to response in Redis for 24 hours, replay on collision (same key same hash), reject on collision (same key different hash). Publish as platform middleware. Stripe's public post on this is the canonical reference, copy their semantics.

Middleware testing discipline. Every middleware in the platform library has a table-driven test matrix covering the happy path, the preconditions failing, and the downstream panic path. Property-based tests via `gopter` or `testing/quick` for the rate-limit and auth middlewares catch algorithmic bugs the example-based tests miss.

Versioning middleware. When you change middleware behavior (tighter rate limit, stricter auth), version the middleware (`auth.V2`) and migrate services explicitly. Silent behavior changes in platform middleware have caused multi-hour outages at every FAANG I know of. Treat platform middleware as a public API with semver.

Staff archetype in middleware work. The Platform PM owns the middleware catalog and the adoption dashboard. The Incident Reviewer tags every incident post-mortem with the middleware area it touched (auth, rate limit, observability) and drives the top-3 areas each quarter. The Migrator handles the once-a-year ordering or semantics change that touches 400 services.

---
