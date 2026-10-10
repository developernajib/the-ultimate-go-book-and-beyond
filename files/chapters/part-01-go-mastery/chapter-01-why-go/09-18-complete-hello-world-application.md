## 1.8 Complete Hello World Application

The following application goes beyond `fmt.Println("Hello")` to demonstrate patterns used in real Go services: structured logging with `slog`, graceful shutdown via OS signal handling, HTTP timeouts, middleware, and JSON response encoding. This is the skeleton you would use as a starting point for a production HTTP service.

```go
// main.go - Production-ready Hello World
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Config holds application configuration
type Config struct {
	Port         string
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
	IdleTimeout  time.Duration
}

// Response represents a JSON response
type Response struct {
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
	Version   string    `json:"version"`
}

// HealthResponse represents health check response
type HealthResponse struct {
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
}

// Overridable at build time: go build -ldflags "-X main.version=$(git rev-parse --short HEAD)"
// (must be var, not const: the linker -X flag can only set variables)
var version = "1.0.0"

func main() {
	// Initialize structured logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load configuration
	config := loadConfig()

	// Create router
	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("GET /", handleRoot)
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /ready", handleReady)

	// Wrap with middleware
	handler := loggingMiddleware(mux)

	// Create server with timeouts
	server := &http.Server{
		Addr:         ":" + config.Port,
		Handler:      handler,
		ReadTimeout:  config.ReadTimeout,
		WriteTimeout: config.WriteTimeout,
		IdleTimeout:  config.IdleTimeout,
	}

	// Start server in goroutine
	go func() {
		slog.Info("Server starting", "port", config.Port, "version", version)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			slog.Error("Server error", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("Server shutting down")

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("Server forced to shutdown", "error", err)
	}

	slog.Info("Server stopped")
}

func loadConfig() Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	return Config{
		Port:         port,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	response := Response{
		Message:   "Hello, Go!",
		Timestamp: time.Now().UTC(),
		Version:   version,
	}

	writeJSON(w, http.StatusOK, response)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	response := HealthResponse{
		Status:    "healthy",
		Timestamp: time.Now().UTC(),
	}

	writeJSON(w, http.StatusOK, response)
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	// In a real app, check database connections, etc.
	response := HealthResponse{
		Status:    "ready",
		Timestamp: time.Now().UTC(),
	}

	writeJSON(w, http.StatusOK, response)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("Failed to encode response", "error", err)
	}
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Wrap response writer to capture status code
		wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(wrapped, r)

		slog.Info("Request completed",
			"method", r.Method,
			"path", r.URL.Path,
			"status", wrapped.status,
			"duration", time.Since(start),
			"remote_addr", r.RemoteAddr,
		)
	})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}
```

Run with:

```bash
go run main.go

# Test endpoints
curl http://localhost:8080/
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

### Walkthrough: What This 180-Line Skeleton Actually Teaches

This is not really a Hello World. It is a compressed tour of the ten idioms every production Go HTTP service uses. If you are new to Go, read each one and understand *why* it is here, not just that it is here. These patterns recur in every production Go codebase you will ever read.

1. **Structured logging with `log/slog`** (lines 46-50). As of Go 1.21 (2023), `slog` is the canonical structured-logger in the standard library. Before `slog`, the ecosystem was split between `zap` (fast, Uber) and `zerolog` (fast, allocation-free). For new code in 2026, use `slog` unless you have a specific performance reason to reach for `zap`. The key-value pattern `slog.Info("msg", "key", value)` is the one idiom to internalize: it produces JSON log lines that every log aggregator (Loki, Splunk, Datadog, CloudWatch) ingests without configuration.

2. **Explicit server timeouts** (lines 68-74). The single most common production bug in Go HTTP services from inexperienced authors is using `http.ListenAndServe(":8080", nil)` without setting `ReadTimeout`, `WriteTimeout`, and `IdleTimeout` on an `http.Server`. A connection that never sends bytes (a slow-loris attack or a buggy client) will occupy a goroutine and a file descriptor until it eventually times out at the OS level (minutes). An explicit `http.Server` with 15-second read/write timeouts prevents this. Every production Go service you ever ship should have these three fields set.

3. **The `go func() { server.ListenAndServe() }()` plus signal-wait pattern** (lines 77-88). Running the server in a goroutine and then blocking the main goroutine on a signal channel is the canonical idiom for graceful shutdown. The signal channel gets notified on `SIGINT` (Ctrl+C) and `SIGTERM` (what Kubernetes sends before killing your pod). When the main goroutine receives the signal, it calls `server.Shutdown(ctx)`, which stops accepting new connections but lets in-flight requests complete. Without this, Kubernetes will `SIGKILL` your pod after the grace period and any in-flight requests are dropped. Every Go service that runs in Kubernetes should do this.

4. **`context.WithTimeout` for bounded shutdown** (line 93). Passing a timeout-bounded context to `server.Shutdown` caps how long graceful shutdown can take. If you give it `context.Background()`, shutdown will wait forever for a stuck handler. Thirty seconds is a reasonable default for HTTP. Match it to your platform's grace period (Kubernetes defaults to 30 seconds).

5. **`http.ServeMux` with method-qualified routes** (lines 60-62). The Go 1.22 (Feb 2024) standard router gained method matching (`"GET /health"`) and path parameters (`"GET /users/{id}"`). For small services, the standard `http.ServeMux` is now enough, and a third-party router (`chi`, `gorilla/mux`) is no longer required. Know this: interviewers in 2025-2026 specifically test whether you know the stdlib caught up.

6. **Middleware as function composition** (lines 65, 155-172). Go's HTTP middleware pattern is "a function that takes an `http.Handler` and returns an `http.Handler`." Composing middleware is just function wrapping. This is idiomatic, no framework required. The wrapped response writer (lines 171-179) lets middleware observe the eventual status code, a small but important pattern for request logging and metrics.

7. **`any` parameter on `writeJSON`** (line 146). The `any` alias was introduced in Go 1.18 as a rename of `interface{}`. Using it in a generic helper function like `writeJSON` is fine. Using it as a field type on a struct is usually a code smell (type info is lost). This is the one place in the file where `any` earns its use.

8. **Config via environment variables** (`loadConfig`, lines 103-115). The Twelve-Factor App pattern: config in the environment, not in files. For more than two or three config values, reach for a library (`kelseyhightower/envconfig`, `caarlos0/env`, or the heavier `viper`), but for a small service, `os.Getenv` plus a default is the idiomatic zero-dependency approach.

9. **JSON struct tags** (lines 31-33, 37-39). The `` `json:"message"` `` tags control how the field is marshaled. This is Go's main mechanism for structured-data interop. See also `xml:`, `yaml:`, `bson:`, `db:` tags for other libraries. Interviewers test whether you know that unexported (lowercase) fields are NEVER marshaled regardless of tag.

10. **Version constant** (line 44). Embedding a version string in your binary is cheap and invaluable. Production fleets with a `/version` or a version field in `/health` responses let you confirm which build is actually running without shelling into the pod. Graduate to build-time injection via `-ldflags "-X main.version=$(git rev-parse --short HEAD)"` once you have CI.

### Extending the Skeleton: Production-Readiness Checklist (Senior Track)

The file above is "production-ready in spirit." To actually ship this to a FAANG-equivalent production environment, the following extensions are expected. Each is a one-evening addition. Skipping them in a real service is a staff-level review flag.

- **Prometheus metrics.** Add a `/metrics` endpoint with `promauto` counters for request count, latency histograms, and error rate, wrapped in the middleware. Without this, you cannot answer "what is your service's P99 latency?" and you will not pass a production-readiness review.
- **OpenTelemetry tracing.** Wrap the middleware to create a span per request, propagate `traceparent` headers to downstream calls. Already the industry default for distributed tracing. Not having it means an incident across three services will take three times longer to debug.
- **Correlation / request ID.** Generate a UUID per incoming request (the standard-library `uuid` package does this with no new dependency since Go 1.27), or accept `X-Request-ID` from the client, attach it to the request `context.Context`, log it on every structured-log line for that request, and include it in the response header. Without this, log correlation across services is impossible.
- **Context propagation into handlers.** The handlers in the skeleton ignore `r.Context()`. In production, every downstream call (database, HTTP, message queue) should receive that context so that cancellation and timeouts propagate end-to-end. Fix this before shipping.
- **Actual readiness logic.** `handleReady` currently returns a static "ready." A real readiness probe checks that the database is reachable, critical dependencies are up, and the service can actually serve traffic. Kubernetes uses readiness to decide whether to route traffic to the pod. Returning a bogus "ready" defeats the probe's purpose.
- **Security headers.** Add `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy` where appropriate. For an API-only service, the subset is small but non-empty.
- **Rate limiting.** At the edge (ideally) or in the service (minimally). `golang.org/x/time/rate` has a token-bucket implementation in the standard-library-adjacent `x/` modules.
- **Panic recovery middleware.** A single panic in any handler kills the goroutine but not the server. Returning a 500 with a proper error is better than dropping the connection. Wrap the mux with a recover middleware.
- **Build-time version injection.** Replace the hardcoded `var version = "1.0.0"` with `-ldflags "-X main.version=$(git rev-parse --short HEAD)"` so the running binary reports its commit SHA.
- **Pprof endpoint, disabled by default.** Import `net/http/pprof` with a `_` import and expose the handlers on a separate admin port, behind an authn check or accessible only from localhost. During incidents this is how you grab a CPU profile from a live service in 30 seconds. Its absence is what turns a 30-minute investigation into a 4-hour one.

### How to Use This Skeleton in an Interview (Junior → FAANG Track)

This one file answers, or at least gives you a natural entry point into, roughly nine of the most common Go interview questions. Memorize the file, type it from scratch once a day for a week before an on-site, and you can answer all of these without hesitation:

- "Write an HTTP server in Go." → You have one.
- "How would you add graceful shutdown?" → You have the signal+`server.Shutdown` pattern.
- "How do you do structured logging?" → `slog` with JSON handler.
- "How do you write HTTP middleware?" → Function wrapping `http.Handler`.
- "What are ReadTimeout, WriteTimeout, IdleTimeout for?" → Slow-client protection, walk the interviewer through slow-loris.
- "What is `context.WithTimeout` for?" → Bounded shutdown and downstream cancellation.
- "How do you handle signals?" → `signal.Notify` on `SIGINT` / `SIGTERM`.
- "What does `any` mean in Go?" → Alias for `interface{}`, introduced in 1.18.
- "How do you produce a JSON response in a handler?" → `json.NewEncoder(w).Encode(data)`.

The strategic move: when an interviewer opens with "build a simple HTTP server in Go," do not build something simpler than this skeleton. Building exactly this skeleton (even a compressed version) signals that you know what production Go looks like. Stripping it down to `http.ListenAndServe(":8080", nil)` signals that you have only ever read Go tutorials.

---
