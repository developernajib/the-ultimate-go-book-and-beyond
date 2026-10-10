## 51.3 Gateway Middleware

### Authentication Middleware

JWT authentication middleware validates the token signature and expiry on every request before the handler executes. Extracting claims from the validated token and storing them in the request context makes identity available to downstream handlers without repeating validation.

```go
// pkg/gateway/middleware/auth.go
package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// AuthMiddleware handles authentication
type AuthMiddleware struct {
	jwtSecret    []byte
	apiKeyStore  APIKeyStore
	excludePaths []string
}

// APIKeyStore retrieves API key information
type APIKeyStore interface {
	GetKey(ctx context.Context, key string) (*APIKey, error)
}

// APIKey represents an API key
type APIKey struct {
	Key       string
	Name      string
	Scopes    []string
	RateLimit int
	Active    bool
	ExpiresAt *time.Time
}

// AuthConfig for middleware configuration
type AuthMiddlewareConfig struct {
	JWTSecret    string
	APIKeyHeader string
	ExcludePaths []string
}

// NewAuthMiddleware creates authentication middleware
func NewAuthMiddleware(config AuthMiddlewareConfig, keyStore APIKeyStore) *AuthMiddleware {
	return &AuthMiddleware{
		jwtSecret:    []byte(config.JWTSecret),
		apiKeyStore:  keyStore,
		excludePaths: config.ExcludePaths,
	}
}

// Middleware returns the HTTP middleware
func (m *AuthMiddleware) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check if path is excluded
		for _, path := range m.excludePaths {
			if strings.HasPrefix(r.URL.Path, path) {
				next(w, r)
				return
			}
		}

		// Try JWT token first
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			token := strings.TrimPrefix(authHeader, "Bearer ")
			claims, err := m.validateJWT(token)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid token: "+err.Error())
				return
			}

			ctx := context.WithValue(r.Context(), userClaimsKey, claims)
			r = r.WithContext(ctx)
			next(w, r)
			return
		}

		// Try API key
		apiKey := r.Header.Get("X-API-Key")
		if apiKey == "" {
			apiKey = r.URL.Query().Get("api_key")
		}

		if apiKey != "" {
			key, err := m.apiKeyStore.GetKey(r.Context(), apiKey)
			if err != nil || !key.Active {
				writeError(w, http.StatusUnauthorized, "Invalid API key")
				return
			}

			if key.ExpiresAt != nil && key.ExpiresAt.Before(time.Now()) {
				writeError(w, http.StatusUnauthorized, "API key expired")
				return
			}

			ctx := context.WithValue(r.Context(), apiKeyInfoKey, key)
			r = r.WithContext(ctx)
			next(w, r)
			return
		}

		writeError(w, http.StatusUnauthorized, "Authentication required")
	}
}

// JWTClaims represents JWT claims
type JWTClaims struct {
	jwt.RegisteredClaims
	UserID   string   `json:"user_id"`
	Email    string   `json:"email"`
	Scopes   []string `json:"scopes"`
	TenantID string   `json:"tenant_id,omitempty"`
}

func (m *AuthMiddleware) validateJWT(tokenString string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &JWTClaims{}, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return m.jwtSecret, nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*JWTClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

// Context keys
type contextKeyType string

const (
	userClaimsKey contextKeyType = "userClaims"
	apiKeyInfoKey contextKeyType = "apiKeyInfo"
)

// GetUserClaims retrieves user claims from context
func GetUserClaims(ctx context.Context) *JWTClaims {
	if claims, ok := ctx.Value(userClaimsKey).(*JWTClaims); ok {
		return claims
	}
	return nil
}

// GetAPIKeyInfo retrieves API key info from context
func GetAPIKeyInfo(ctx context.Context) *APIKey {
	if key, ok := ctx.Value(apiKeyInfoKey).(*APIKey); ok {
		return key
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{
		"error": message,
	})
}
```

### Rate Limiting Middleware

Rate limiting protects APIs from abuse by capping request frequency per client. A token bucket algorithm, implemented with a `time/rate` limiter keyed by client IP or API key, allows short bursts while enforcing a sustained request rate.

```go
// pkg/gateway/middleware/ratelimit.go
package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// RateLimiter limits request rates
type RateLimiter interface {
	Allow(ctx context.Context, key string, limit, window int) (bool, int, time.Duration, error)
}

// RateLimitMiddleware rate limits requests
type RateLimitMiddleware struct {
	limiter      RateLimiter
	defaultLimit int
	defaultWindow int // seconds
	keyFunc      func(*http.Request) string
}

// NewRateLimitMiddleware creates rate limit middleware
func NewRateLimitMiddleware(limiter RateLimiter, defaultLimit, defaultWindow int) *RateLimitMiddleware {
	return &RateLimitMiddleware{
		limiter:       limiter,
		defaultLimit:  defaultLimit,
		defaultWindow: defaultWindow,
		keyFunc:       defaultKeyFunc,
	}
}

func defaultKeyFunc(r *http.Request) string {
	// Use API key if present, otherwise IP
	if key := r.Header.Get("X-API-Key"); key != "" {
		return "api:" + key
	}
	return "ip:" + getClientIP(r)
}

func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For first
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	return r.RemoteAddr
}

// Middleware returns the HTTP middleware
func (m *RateLimitMiddleware) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := m.keyFunc(r)

		// Get limit from API key if available
		limit := m.defaultLimit
		window := m.defaultWindow

		if apiKey := GetAPIKeyInfo(r.Context()); apiKey != nil && apiKey.RateLimit > 0 {
			limit = apiKey.RateLimit
		}

		allowed, remaining, retryAfter, err := m.limiter.Allow(r.Context(), key, limit, window)
		if err != nil {
			// On error, allow request but log
			next(w, r)
			return
		}

		// Set rate limit headers
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Duration(window)*time.Second).Unix(), 10))

		if !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]any{
				"error":       "Rate limit exceeded",
				"retry_after": retryAfter.Seconds(),
			})
			return
		}

		next(w, r)
	}
}

// SlidingWindowLimiter implements sliding window rate limiting with Redis
type SlidingWindowLimiter struct {
	client *redis.Client
}

// NewSlidingWindowLimiter creates a Redis-based rate limiter
func NewSlidingWindowLimiter(client *redis.Client) *SlidingWindowLimiter {
	return &SlidingWindowLimiter{client: client}
}

// Allow checks if request is allowed
func (l *SlidingWindowLimiter) Allow(ctx context.Context, key string, limit, window int) (bool, int, time.Duration, error) {
	now := time.Now().UnixMilli()
	windowStart := now - int64(window*1000)

	pipe := l.client.Pipeline()

	// Remove old entries
	pipe.ZRemRangeByScore(ctx, key, "0", strconv.FormatInt(windowStart, 10))

	// Count current entries
	countCmd := pipe.ZCard(ctx, key)

	// Add current request
	pipe.ZAdd(ctx, key, redis.Z{
		Score:  float64(now),
		Member: now,
	})

	// Set expiry
	pipe.Expire(ctx, key, time.Duration(window)*time.Second)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return false, 0, 0, err
	}

	count := countCmd.Val()
	remaining := int(int64(limit) - count - 1)
	if remaining < 0 {
		remaining = 0
	}

	if count >= int64(limit) {
		// Calculate retry after
		oldestStr, err := l.client.ZRange(ctx, key, 0, 0).Result()
		if err != nil || len(oldestStr) == 0 {
			return false, remaining, time.Duration(window) * time.Second, nil
		}

		var oldest int64
		fmt.Sscanf(oldestStr[0], "%d", &oldest)
		retryAfter := time.Duration(oldest+int64(window*1000)-now) * time.Millisecond

		return false, remaining, retryAfter, nil
	}

	return true, remaining, 0, nil
}

// InMemoryLimiter implements in-memory rate limiting
type InMemoryLimiter struct {
	windows map[string]*slidingWindow
	mu      sync.RWMutex
}

type slidingWindow struct {
	timestamps []int64
	mu         sync.Mutex
}

// NewInMemoryLimiter creates an in-memory rate limiter
func NewInMemoryLimiter() *InMemoryLimiter {
	return &InMemoryLimiter{
		windows: make(map[string]*slidingWindow),
	}
}

// Allow checks if request is allowed
func (l *InMemoryLimiter) Allow(ctx context.Context, key string, limit, window int) (bool, int, time.Duration, error) {
	l.mu.Lock()
	w, exists := l.windows[key]
	if !exists {
		w = &slidingWindow{}
		l.windows[key] = w
	}
	l.mu.Unlock()

	w.mu.Lock()
	defer w.mu.Unlock()

	now := time.Now().UnixMilli()
	windowStart := now - int64(window*1000)

	// Remove old timestamps
	valid := make([]int64, 0, len(w.timestamps))
	for _, ts := range w.timestamps {
		if ts > windowStart {
			valid = append(valid, ts)
		}
	}
	w.timestamps = valid

	remaining := limit - len(w.timestamps) - 1
	if remaining < 0 {
		remaining = 0
	}

	if len(w.timestamps) >= limit {
		retryAfter := time.Duration(w.timestamps[0]+int64(window*1000)-now) * time.Millisecond
		return false, remaining, retryAfter, nil
	}

	w.timestamps = append(w.timestamps, now)
	return true, remaining, 0, nil
}
```

### Request Logging and Tracing

Structured logging emits key-value pairs rather than free-form strings, making log entries machine-parseable for log aggregation systems. The `log/slog` package provides a standard structured logger with handlers for JSON and text output.

```go
// pkg/gateway/middleware/logging.go
package middleware

import (
	"bufio"
	"bytes"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// LoggingMiddleware logs requests
type LoggingMiddleware struct {
	logger *slog.Logger
}

// NewLoggingMiddleware creates logging middleware
func NewLoggingMiddleware(logger *slog.Logger) *LoggingMiddleware {
	return &LoggingMiddleware{logger: logger}
}

// Middleware returns the HTTP middleware
func (m *LoggingMiddleware) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Generate request ID
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = uuid.New().String()
		}

		// Add request ID to response headers
		w.Header().Set("X-Request-ID", requestID)

		// Create response wrapper to capture status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		// Store request ID in context
		ctx := r.Context()
		ctx = setRequestID(ctx, requestID)
		r = r.WithContext(ctx)

		// Execute handler
		next(wrapped, r)

		// Log request
		duration := time.Since(start)

		m.logger.Info("Request",
			"request_id", requestID,
			"method", r.Method,
			"path", r.URL.Path,
			"query", r.URL.RawQuery,
			"status", wrapped.statusCode,
			"duration_ms", duration.Milliseconds(),
			"client_ip", getClientIP(r),
			"user_agent", r.UserAgent(),
			"bytes_written", wrapped.bytesWritten,
		)
	}
}

// TracingMiddleware adds distributed tracing
type TracingMiddleware struct {
	tracer trace.Tracer
}

// NewTracingMiddleware creates tracing middleware
func NewTracingMiddleware() *TracingMiddleware {
	return &TracingMiddleware{
		tracer: otel.Tracer("api-gateway"),
	}
}

// Middleware returns the HTTP middleware
func (m *TracingMiddleware) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, span := m.tracer.Start(r.Context(), "gateway.request",
			trace.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.path", r.URL.Path),
				attribute.String("http.client_ip", getClientIP(r)),
			),
		)
		defer span.End()

		// Add trace ID to response
		traceID := span.SpanContext().TraceID().String()
		w.Header().Set("X-Trace-ID", traceID)

		// Wrap response to capture status
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next(wrapped, r.WithContext(ctx))

		// Add response attributes
		span.SetAttributes(
			attribute.Int("http.status_code", wrapped.statusCode),
			attribute.Int64("http.response_size", int64(wrapped.bytesWritten)),
		)

		if wrapped.statusCode >= 400 {
			span.RecordError(fmt.Errorf("HTTP %d", wrapped.statusCode))
		}
	}
}

// responseWriter wraps http.ResponseWriter to capture response info
type responseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int
}

func (w *responseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.bytesWritten += n
	return n, err
}

func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("hijacking not supported")
}

func (w *responseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func setRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDContextKey, id)
}

func GetRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDContextKey).(string); ok {
		return id
	}
	return ""
}

const requestIDContextKey contextKeyType = "requestID"
```

### Junior -> FAANG: Middleware Patterns That Show Up in Interviews

Middleware is one of the most common practical coding questions at FAANG. The pattern is: a function that takes an `http.Handler` (or `http.HandlerFunc`) and returns one. You wrap the handler with your logic, call `next`, then optionally do post-processing. The order you stack middleware matters: the first `Use` call is the outermost wrapper.

The auth middleware here has one critical detail worth memorizing: it checks excluded paths before any token validation. Interviewers specifically ask "how do you handle public endpoints that do not require auth?" The answer is an exclusion list checked at the start of the middleware, not a separate handler.

For rate limiting, know that the correct key is authenticated identity (user ID or API key) when the user is known, and client IP as a fallback for unauthenticated endpoints. Using IP alone for authenticated endpoints is wrong because many users can share an IP (corporate NAT, CGNAT). Know that the `X-Forwarded-For` header can be spoofed if your gateway sits behind a proxy, so you need to trust only the rightmost untrusted IP.

The `responseWriter` wrapper that captures status code and bytes written is a pattern every Go web developer needs. Standard `http.ResponseWriter` does not expose the status code after it is written. The wrapper fixes that. Interviewers ask you to instrument a handler and this is the correct approach.

### Senior @ FAANG: Middleware Design at Production Scale

**Auth middleware correctness gaps.** The JWT validation uses HMAC (`*jwt.SigningMethodHMAC`). Production systems use RSA or ECDSA (asymmetric) so the gateway can validate tokens using a public key without holding the signing secret. Hold the signing key only in the auth service. Rotate public keys via JWKS (`/.well-known/jwks.json`) and cache the key set in memory, refreshing on a schedule and on key-not-found to handle key rotation without restarts.

**Rate limiter key extraction.** The `defaultKeyFunc` checks `X-API-Key` then falls back to `X-Forwarded-For`. In production there are at least four distinct key strategies: by API key (authenticated partner), by user ID from JWT claims (authenticated human), by IP (unauthenticated public endpoint), and by tenant ID (B2B SaaS where one tenant can have many API keys). These need different limits. A `KeyExtractor` interface that routes to the appropriate strategy based on what is present in the request is cleaner than a long if-else chain.

**Sliding window correctness.** The Redis sorted set approach has a race: the `ZCard` command runs before `ZAdd`, so count does not include the current request. The code adds 1 to the count when computing `remaining` but does not add 1 to the limit check. Under concurrent requests this is effectively optimistic: you may allow slightly more than `limit` requests in a window because multiple goroutines read count zero and all proceed. For most use cases this is acceptable. For strict enforcement, use a Lua script that atomically reads and increments in a single round trip.

**Logging middleware and streaming responses.** The `responseWriter` wrapper works for ordinary JSON responses. For server-sent events or chunked streaming, `WriteHeader` is called once but `Write` is called many times. The `bytesWritten` counter handles this correctly because it accumulates. But if the upstream uses `http.Flusher` to push chunks, the logging middleware must implement `Flush` to pass through, which the `responseWriter` here does correctly via the `Flush` method.

**Tracing middleware and context propagation.** The tracing middleware creates a new span and stores it in the context. Downstream services receive the trace ID via `W3C traceparent` or `B3` headers. The propagation format matters: choose one standard and enforce it at the gateway rather than allowing services to use whichever format their framework defaults to. Mixing `B3` and `W3C` headers in the same trace breaks most tracing backends. An ADR documenting the chosen propagation format is a governance deliverable for a platform team owning the gateway.

---
