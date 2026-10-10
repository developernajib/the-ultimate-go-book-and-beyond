## 44.2 Server Interceptors

### Logging Interceptor

Structured logging emits key-value pairs rather than free-form strings, making log entries machine-parseable for log aggregation systems. The `log/slog` package provides a standard structured logger with handlers for JSON and text output.

```go
package interceptor

import (
    "context"
    "log/slog"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"
)

// LoggingInterceptor logs request details
func LoggingInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        start := time.Now()

        // Extract metadata
        md, _ := metadata.FromIncomingContext(ctx)
        requestID := getFirst(md, "x-request-id")

        // Extract peer info
        clientIP := ""
        if p, ok := peer.FromContext(ctx); ok {
            clientIP = p.Addr.String()
        }

        // Log request
        logger.Info("grpc request",
            "method", info.FullMethod,
            "request_id", requestID,
            "client_ip", clientIP,
        )

        // Handle request
        resp, err := handler(ctx, req)

        // Determine status code
        code := codes.OK
        if err != nil {
            if st, ok := status.FromError(err); ok {
                code = st.Code()
            } else {
                code = codes.Unknown
            }
        }

        // Log response
        logger.Info("grpc response",
            "method", info.FullMethod,
            "request_id", requestID,
            "duration", time.Since(start),
            "code", code.String(),
            "error", err,
        )

        return resp, err
    }
}

// StreamLoggingInterceptor logs streaming RPC details
func StreamLoggingInterceptor(logger *slog.Logger) grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        start := time.Now()
        ctx := ss.Context()

        md, _ := metadata.FromIncomingContext(ctx)
        requestID := getFirst(md, "x-request-id")

        logger.Info("grpc stream started",
            "method", info.FullMethod,
            "request_id", requestID,
            "client_stream", info.IsClientStream,
            "server_stream", info.IsServerStream,
        )

        // Wrap stream to count messages
        wrapped := &wrappedServerStream{
            ServerStream: ss,
        }

        err := handler(srv, wrapped)

        logger.Info("grpc stream ended",
            "method", info.FullMethod,
            "request_id", requestID,
            "duration", time.Since(start),
            "recv_msgs", wrapped.recvCount,
            "sent_msgs", wrapped.sentCount,
            "error", err,
        )

        return err
    }
}

type wrappedServerStream struct {
    grpc.ServerStream
    recvCount int
    sentCount int
}

func (w *wrappedServerStream) RecvMsg(m any) error {
    err := w.ServerStream.RecvMsg(m)
    if err == nil {
        w.recvCount++
    }
    return err
}

func (w *wrappedServerStream) SendMsg(m any) error {
    err := w.ServerStream.SendMsg(m)
    if err == nil {
        w.sentCount++
    }
    return err
}

func getFirst(md metadata.MD, key string) string {
    if values := md.Get(key); len(values) > 0 {
        return values[0]
    }
    return ""
}
```

### Recovery Interceptor

A panic in any gRPC handler kills the entire server process by default. The recovery interceptor wraps the handler call in a `defer`/`recover` block, catches the panic, logs it with a full stack trace, and returns a `codes.Internal` error to the caller instead of crashing. This interceptor should always be the outermost in the chain so it catches panics from every other interceptor too.

```go
package interceptor

import (
    "context"
    "log/slog"
    "runtime/debug"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// RecoveryInterceptor recovers from panics
func RecoveryInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("panic recovered",
                    "method", info.FullMethod,
                    "panic", r,
                    "stack", string(debug.Stack()),
                )
                err = status.Errorf(codes.Internal, "internal error")
            }
        }()

        return handler(ctx, req)
    }
}

// StreamRecoveryInterceptor recovers from panics in streaming RPCs
func StreamRecoveryInterceptor(logger *slog.Logger) grpc.StreamServerInterceptor {
    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) (err error) {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("stream panic recovered",
                    "method", info.FullMethod,
                    "panic", r,
                    "stack", string(debug.Stack()),
                )
                err = status.Errorf(codes.Internal, "internal error")
            }
        }()

        return handler(srv, ss)
    }
}
```

### Authentication Interceptor

The authentication interceptor extracts a Bearer token from gRPC metadata (the equivalent of HTTP headers), validates it through a `TokenValidator` interface, and injects the authenticated `User` into the context. Handlers downstream retrieve the user with `GetUser(ctx)`. Public methods like health checks are skipped by matching against a configurable allowlist. The streaming variant wraps `ServerStream` to override `Context()`, since a stream's context is immutable after creation.

```go
package interceptor

import (
    "context"
    "strings"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type contextKey string

const UserContextKey contextKey = "user"

// AuthConfig holds authentication configuration
type AuthConfig struct {
    // Methods that don't require authentication
    PublicMethods []string
    // Token validator
    Validator TokenValidator
}

type TokenValidator interface {
    Validate(ctx context.Context, token string) (*User, error)
}

// AuthInterceptor validates authentication
func AuthInterceptor(config AuthConfig) grpc.UnaryServerInterceptor {
    publicSet := make(map[string]bool)
    for _, m := range config.PublicMethods {
        publicSet[m] = true
    }

    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Skip authentication for public methods
        if publicSet[info.FullMethod] {
            return handler(ctx, req)
        }

        // Extract token from metadata
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        auth := md.Get("authorization")
        if len(auth) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization header")
        }

        token := strings.TrimPrefix(auth[0], "Bearer ")
        if token == auth[0] {
            return nil, status.Error(codes.Unauthenticated, "invalid authorization format")
        }

        // Validate token
        user, err := config.Validator.Validate(ctx, token)
        if err != nil {
            return nil, status.Error(codes.Unauthenticated, "invalid token")
        }

        // Add user to context
        ctx = context.WithValue(ctx, UserContextKey, user)

        return handler(ctx, req)
    }
}

// StreamAuthInterceptor validates authentication for streaming RPCs
func StreamAuthInterceptor(config AuthConfig) grpc.StreamServerInterceptor {
    publicSet := make(map[string]bool)
    for _, m := range config.PublicMethods {
        publicSet[m] = true
    }

    return func(
        srv any,
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if publicSet[info.FullMethod] {
            return handler(srv, ss)
        }

        ctx := ss.Context()
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return status.Error(codes.Unauthenticated, "missing metadata")
        }

        auth := md.Get("authorization")
        if len(auth) == 0 {
            return status.Error(codes.Unauthenticated, "missing authorization header")
        }

        token := strings.TrimPrefix(auth[0], "Bearer ")
        if token == auth[0] {
            return status.Error(codes.Unauthenticated, "invalid authorization format")
        }

        user, err := config.Validator.Validate(ctx, token)
        if err != nil {
            return status.Error(codes.Unauthenticated, "invalid token")
        }

        // Create new context with user
        ctx = context.WithValue(ctx, UserContextKey, user)

        // Wrap stream with new context
        wrapped := &contextServerStream{
            ServerStream: ss,
            ctx:          ctx,
        }

        return handler(srv, wrapped)
    }
}

type contextServerStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (s *contextServerStream) Context() context.Context {
    return s.ctx
}

// GetUser extracts user from context
func GetUser(ctx context.Context) *User {
    if user, ok := ctx.Value(UserContextKey).(*User); ok {
        return user
    }
    return nil
}
```

### Rate Limiting Interceptor

Rate limiting protects APIs from abuse by capping request frequency per client. A token bucket algorithm, implemented with a `time/rate` limiter keyed by client IP or API key, allows short bursts while enforcing a sustained request rate.

```go
package interceptor

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"
)

// RateLimiter interface
type RateLimiter interface {
    Allow(key string) bool
}

// RateLimitInterceptor limits request rate
func RateLimitInterceptor(limiter RateLimiter, keyFunc func(context.Context) string) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        key := keyFunc(ctx)

        if !limiter.Allow(key) {
            return nil, status.Error(codes.ResourceExhausted, "rate limit exceeded")
        }

        return handler(ctx, req)
    }
}

// Common key functions
func IPKeyFunc(ctx context.Context) string {
    if p, ok := peer.FromContext(ctx); ok {
        return p.Addr.String()
    }
    return "unknown"
}

func UserKeyFunc(ctx context.Context) string {
    if user := GetUser(ctx); user != nil {
        return "user:" + user.ID
    }
    return IPKeyFunc(ctx)
}

func MethodKeyFunc(ctx context.Context, info *grpc.UnaryServerInfo) string {
    return IPKeyFunc(ctx) + ":" + info.FullMethod
}
```

### Validation Interceptor

The validation interceptor checks whether incoming request messages implement a `Validator` interface with a `Validate() error` method. If they do, it calls `Validate()` before the request reaches the handler and returns `codes.InvalidArgument` on failure. This pattern works well with protobuf-generated types: add a `Validate` method to your generated message types (or use a code generator like `protoc-gen-validate`) and every request is checked automatically without handler-level boilerplate.

```go
package interceptor

import (
    "context"
    "errors"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// Validator interface for request validation
type Validator interface {
    Validate() error
}

// ValidationInterceptor validates requests that implement Validator
func ValidationInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Check if request implements Validator
        if v, ok := req.(Validator); ok {
            if err := v.Validate(); err != nil {
                return nil, status.Errorf(codes.InvalidArgument, "validation failed: %v", err)
            }
        }

        return handler(ctx, req)
    }
}

// Example request with validation
type CreateUserRequest struct {
    Email    string
    Name     string
    Password string
}

func (r *CreateUserRequest) Validate() error {
    if r.Email == "" {
        return errors.New("email is required")
    }
    if r.Name == "" {
        return errors.New("name is required")
    }
    if len(r.Password) < 8 {
        return errors.New("password must be at least 8 characters")
    }
    return nil
}
```

### Junior -> FAANG: Five Interceptors, Five First-Job Habits

Each interceptor in this section teaches a habit that separates engineers who write correct production code from those who do not.

**Logging interceptor habit:** Always extract `x-request-id` from metadata and include it in every log line. Without a request ID, correlating client-side and server-side logs during an incident requires timing guesswork. If the caller does not send a request ID, generate one in the logging interceptor and propagate it forward in the context.

**Recovery interceptor habit:** The `defer`/`recover` pattern with named return values is idiomatic Go. The reason the function signature uses named returns (`resp any, err error`) is that the `recover` block needs to assign to `err` after the function body would normally have returned. Without named returns, the assignment in the `recover` block has no effect. This is a subtle Go gotcha that trips up engineers who know the language but have not written production recovery code.

**Auth interceptor habit:** Never log the raw token. Log the user ID extracted from the token, and log it only after validation succeeds. Logging raw tokens exposes credentials in your log aggregation system.

**Rate limiting habit:** The `RateLimiter` interface decouples the interceptor from any specific rate limiting algorithm. In tests, inject a stub that always returns true or always returns false. In production, inject a token-bucket limiter. This is the dependency inversion principle applied to interceptors.

**Validation interceptor habit:** The `Validator` interface pattern means you can add validation to any proto message without modifying interceptor code. This is the open-closed principle: the interceptor is open for extension (add Validate() to any message) without modification.

### Senior @ FAANG: Server Interceptor Design for Scale

**Logging interceptor at scale:** Structured logging with `slog` is correct, but at FAANG scale you also need log sampling. Logging every request at 50,000 RPS generates hundreds of gigabytes of log data per day per service. The platform-level logging interceptor should apply sampling: log 100% of errors, log 100% of slow requests (above p99 threshold), and sample successful fast requests at a configurable rate (for example, 1%). The sampling decision should be recorded in the log entry so alert queries can account for it. This is typically implemented by adding a `log_sample_rate` field and adjusting counts when computing rates from logs.

**Recovery interceptor at scale:** The recovery interceptor should emit a metric (a Prometheus counter labeled by method) in addition to logging. This allows alerting on panic rate without parsing logs. Panic rate above zero in production is a sev2 signal that should page on-call immediately. Also note: the recovery interceptor should not swallow all panics silently. In development and testing environments, it is useful to re-panic after logging so tests catch panics rather than seeing a mysterious `codes.Internal` response. This is achieved by checking an environment variable or a flag injected at server construction time.

**Auth interceptor at scale:** The `TokenValidator` interface hides the cost of validation. At scale, token validation often hits a remote service (JWKS endpoint, token introspection) or a local cache. The interceptor contract should specify latency requirements: if validation takes more than N milliseconds, the interceptor should return `codes.Unavailable` rather than blocking the request indefinitely. The timeout for auth must be independent of the request deadline to avoid situations where a short-deadline request fails auth simply because the deadline expired before the JWKS cache refreshed.

The allowlist for public methods (`PublicMethods []string`) is a security-critical configuration. At L6/L7, expect the interviewer to probe whether this allowlist is statically compiled or dynamically loaded. A dynamically loaded allowlist (from a config service or feature flag) allows adding a new public endpoint without a redeploy, which is useful for health checks and readiness probes that need to bypass auth. However, it also means a misconfigured config push can accidentally make authenticated endpoints public. The correct answer is a belt-and-suspenders approach: static allowlist for structural public endpoints (health, metrics), dynamic allowlist for business-logic bypass with a mandatory audit trail and an approval gate.

**Rate limiting at scale:** IP-based and user-based rate limiting are both necessary but serve different purposes. IP-based rate limits protect against unauthenticated abuse and must run before auth. User-based rate limits enforce per-tenant quotas and must run after auth. A mature platform has both, with the IP limit set high enough to allow auth to succeed for legitimate users even under attack, and the user limit set according to tier (free, paid, enterprise). Rate limit decisions should be observable: emit a metric when a request is shed, including the key (anonymized IP or user ID) and the method, so you can distinguish deliberate abuse from misconfigured clients.

---
