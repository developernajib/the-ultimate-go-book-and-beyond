## 61.4 Rate Limiter Middleware

### HTTP Middleware

HTTP middleware is the correct place to enforce rate limiting because it intercepts all requests before they reach handler code, ensuring consistent enforcement regardless of which handler is called. The middleware extracts the rate limit key, typically the client IP or an authenticated user ID, and returns `429 Too Many Requests` with a `Retry-After` header when the limit is exceeded, following RFC 6585. Setting `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on every response (not just rejected ones) enables clients to implement proactive rate limit awareness rather than relying on 429 responses.

```go
// middleware/rate_limit.go
package middleware

import (
    "log"
    "net"
    "net/http"
    "strconv"
    "strings"
    "time"

    "yourproject/distributed"
)

// RateLimitConfig configures rate limiting behavior
type RateLimitConfig struct {
    // Key extraction
    KeyFunc func(r *http.Request) string

    // Limits
    Limit      int64
    WindowSize time.Duration

    // Headers
    HeaderPrefix string

    // Behavior
    SkipFunc   func(r *http.Request) bool
    DenyHandler http.HandlerFunc
}

// DefaultConfig returns default configuration
func DefaultConfig() RateLimitConfig {
    return RateLimitConfig{
        KeyFunc:      ExtractIP,
        Limit:        100,
        WindowSize:   time.Minute,
        HeaderPrefix: "X-RateLimit",
        DenyHandler:  DefaultDenyHandler,
    }
}

// RateLimiter is the HTTP middleware
type RateLimiter struct {
    limiter *distributed.RedisSlidingWindow
    config  RateLimitConfig
}

// NewRateLimiter creates a new rate limiting middleware
func NewRateLimiter(limiter *distributed.RedisSlidingWindow, config RateLimitConfig) *RateLimiter {
    return &RateLimiter{
        limiter: limiter,
        config:  config,
    }
}

// Middleware returns the HTTP middleware handler
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Check if request should skip rate limiting
        if rl.config.SkipFunc != nil && rl.config.SkipFunc(r) {
            next.ServeHTTP(w, r)
            return
        }

        // Extract key
        key := rl.config.KeyFunc(r)

        // Check rate limit
        allowed, result, err := rl.limiter.Allow(r.Context(), key)
        if err != nil {
            // On error, allow request but log (fail-open)
            log.Printf("rate limiter error: %v", err)
            next.ServeHTTP(w, r)
            return
        }

        // Set rate limit headers
        rl.setHeaders(w, result)

        if !allowed {
            rl.config.DenyHandler(w, r)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// setHeaders adds rate limit headers to response
func (rl *RateLimiter) setHeaders(w http.ResponseWriter, result *distributed.RateLimitResult) {
    prefix := rl.config.HeaderPrefix
    w.Header().Set(prefix+"-Limit", strconv.FormatInt(result.Limit, 10))
    w.Header().Set(prefix+"-Remaining", strconv.FormatInt(result.Remaining, 10))
    w.Header().Set(prefix+"-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))

    if !result.Allowed && result.RetryAfter > 0 {
        w.Header().Set("Retry-After", strconv.Itoa(int(result.RetryAfter.Seconds())))
    }
}

// DefaultDenyHandler returns 429 Too Many Requests
func DefaultDenyHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusTooManyRequests)
    w.Write([]byte(`{"error":"rate limit exceeded","message":"too many requests"}`))
}

// Key extraction functions

// ExtractIP extracts client IP from request
func ExtractIP(r *http.Request) string {
    // Check X-Forwarded-For header
    xff := r.Header.Get("X-Forwarded-For")
    if xff != "" {
        ips := strings.Split(xff, ",")
        return strings.TrimSpace(ips[0])
    }

    // Check X-Real-IP header
    xri := r.Header.Get("X-Real-IP")
    if xri != "" {
        return xri
    }

    // Fall back to RemoteAddr
    ip, _, _ := net.SplitHostPort(r.RemoteAddr)
    return ip
}

// ExtractAPIKey extracts API key from header
func ExtractAPIKey(r *http.Request) string {
    return r.Header.Get("X-API-Key")
}

// ExtractUserID extracts user ID from context (assumes auth middleware
// ran first). Production code should share a typed context key with
// the auth middleware instead of a raw string, which go vet flags.
func ExtractUserID(r *http.Request) string {
    if userID, ok := r.Context().Value("user_id").(string); ok {
        return userID
    }
    return ExtractIP(r)
}

// CombinedKey combines multiple factors
func CombinedKey(factors ...func(*http.Request) string) func(*http.Request) string {
    return func(r *http.Request) string {
        parts := make([]string, len(factors))
        for i, f := range factors {
            parts[i] = f(r)
        }
        return strings.Join(parts, ":")
    }
}
```

### gRPC Interceptor

gRPC services need their own rate limiting layer because HTTP middleware does not intercept binary RPC frames. The `GRPCRateLimiter` plugs into gRPC's interceptor chain, applying the token-bucket limiter before any handler executes and returning a `codes.ResourceExhausted` status so clients can use the standard gRPC status API instead of parsing HTTP bodies. Keying on both peer address and full method name (`/package.Service/Method`) means limits can be tuned per-RPC rather than per-connection, preventing a single high-frequency call from exhausting the quota of lower-frequency calls on the same client.

```go
// middleware/grpc_rate_limit.go
package middleware

import (
    "context"
    "fmt"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/peer"
    "google.golang.org/grpc/status"

    "yourproject/distributed"
)

// GRPCRateLimiter provides rate limiting for gRPC
type GRPCRateLimiter struct {
    limiter *distributed.RedisTokenBucket
    keyFunc func(ctx context.Context, method string) string
}

// NewGRPCRateLimiter creates a new gRPC rate limiter
func NewGRPCRateLimiter(limiter *distributed.RedisTokenBucket) *GRPCRateLimiter {
    return &GRPCRateLimiter{
        limiter: limiter,
        keyFunc: defaultGRPCKeyFunc,
    }
}

// UnaryInterceptor returns a unary server interceptor
func (rl *GRPCRateLimiter) UnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
        key := rl.keyFunc(ctx, info.FullMethod)

        allowed, result, err := rl.limiter.Allow(ctx, key, 1)
        if err != nil {
            // On error, allow but log
            return handler(ctx, req)
        }

        // Set headers in response metadata
        header := metadata.Pairs(
            "x-ratelimit-limit", fmt.Sprintf("%d", result.Limit),
            "x-ratelimit-remaining", fmt.Sprintf("%d", result.Remaining),
        )
        grpc.SetHeader(ctx, header)

        if !allowed {
            return nil, status.Errorf(codes.ResourceExhausted,
                "rate limit exceeded, retry after %v", result.RetryAfter)
        }

        return handler(ctx, req)
    }
}

// StreamInterceptor returns a stream server interceptor
func (rl *GRPCRateLimiter) StreamInterceptor() grpc.StreamServerInterceptor {
    return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
        ctx := ss.Context()
        key := rl.keyFunc(ctx, info.FullMethod)

        allowed, _, err := rl.limiter.Allow(ctx, key, 1)
        if err != nil {
            return handler(srv, ss)
        }

        if !allowed {
            return status.Error(codes.ResourceExhausted, "rate limit exceeded")
        }

        return handler(srv, ss)
    }
}

func defaultGRPCKeyFunc(ctx context.Context, method string) string {
    // Try to get client IP from peer
    if p, ok := peer.FromContext(ctx); ok {
        return p.Addr.String() + ":" + method
    }

    // Fall back to metadata
    if md, ok := metadata.FromIncomingContext(ctx); ok {
        if apiKeys := md.Get("x-api-key"); len(apiKeys) > 0 {
            return apiKeys[0] + ":" + method
        }
    }

    return "unknown:" + method
}
```

---

### Junior → FAANG: HTTP Middleware Integration and Response Headers

Middleware is the correct place to implement rate limiting because it is the only layer that sees every request. Understanding how to write correct HTTP middleware in Go is a prerequisite.

**Middleware wraps the next handler.** The `Middleware` method returns an `http.Handler` that calls `next.ServeHTTP` if the request is allowed. This chaining pattern is the standard Go HTTP middleware idiom. The middleware can inspect the request (read headers, extract the IP, check the auth token), modify the request (add context values), call the next handler, and modify the response (set headers after the next handler returns). Rate limiting happens before calling next: if the limit is exceeded, you write a 429 response and return without calling next.

**X-RateLimit headers are the client contract.** Setting `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` on every response (not just 429 responses) enables clients to implement proactive rate limit awareness. A well-behaved client reads these headers and slows down before hitting the limit rather than retrying after a 429. The `Retry-After` header on a 429 response tells the client exactly how long to wait. RFC 6585 defines 429 and recommends `Retry-After`. Follow the standard.

**Key extraction must handle X-Forwarded-For correctly.** The `ExtractIP` function checks `X-Forwarded-For` first. This header is set by load balancers and proxies, but it is also spoofable by clients who set it directly. Only trust `X-Forwarded-For` when the request comes from a trusted proxy. The code here does not validate the proxy origin, which is a security gap: a client behind a shared NAT can set `X-Forwarded-For: 1.2.3.4` to impersonate a different IP and bypass a per-IP rate limit. In production, only trust `X-Forwarded-For` when the request comes from a known load balancer IP range.

**The `SkipFunc` enables selective enforcement.** Internal health check requests, admin endpoints, and monitoring probes should not consume rate limit quota. The `SkipFunc` in the config allows the caller to define which requests to exempt. A common implementation: skip requests from internal IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and requests with a specific internal header (`X-Internal: true`).

---

### Senior @ FAANG: Middleware Design as a Platform API

At L6/L7, the rate limiter middleware is not just code in a service. It is a platform API consumed by every service team in the organization. Its design must prioritize ease of correct use and resistance to misconfiguration.

**The middleware configuration API is a product.** The `RateLimitConfig` struct in this section is the API that service teams use to configure rate limiting. Its design determines how easy it is to configure correctly and how hard it is to misconfigure. A common mistake: making `SkipFunc` too powerful. If any service can skip rate limiting for any request, then the rate limiter provides no security guarantee. The platform should define which conditions are allowed in `SkipFunc` (internal IPs, health checks) and validate the configuration at startup rather than trusting the caller.

**The `DenyHandler` customization has security implications.** The default deny handler returns a JSON body with "rate limit exceeded." A custom deny handler that returns the current rate limit state in the response body (count, limit, next reset time) may leak information about the rate limiting algorithm and parameters, enabling attackers to time their requests to exploit window boundaries. The deny handler should return enough information for the client to retry correctly (`Retry-After` in seconds) without revealing algorithm internals.

**gRPC rate limiting requires separate consideration from HTTP.** The gRPC interceptor in this section applies a token bucket at the stream or unary call level. However, gRPC streams are long-lived connections: a single stream can send thousands of messages over minutes. Rate limiting at the connection level (one token per stream initiation) does not limit the message throughput within a stream. For gRPC services with high-message-rate streaming RPCs, the interceptor must track messages within the stream and apply per-message rate limiting, which requires wrapping the `grpc.ServerStream` to intercept each message. Document which type of limiting is applied (connection-level vs message-level) in the interceptor's documentation.

**Observability of the middleware is a first-class concern.** Every rate limit decision (allowed, denied, error, skipped) should emit a metric. The key dimensions: allowed/denied/error/skipped label, the rate limit key prefix (user, IP, API key), and the endpoint. These metrics let you answer: "What fraction of requests to `/api/payments` are being rate limited?" and "Is the error rate on rate limit checks increasing?" Without these metrics, you cannot detect misconfigurations (a limit set too low), abuse (a single user consuming 50% of the rate limit budget), or infrastructure problems (Redis error rate increasing). This observability requirement should be part of the platform contract: any service that uses the rate limiter middleware automatically gets these metrics.
