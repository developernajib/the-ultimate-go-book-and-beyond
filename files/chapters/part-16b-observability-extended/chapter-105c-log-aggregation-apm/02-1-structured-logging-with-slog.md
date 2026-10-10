## 105C.2 Structured Logging with slog

Go 1.21 introduced `log/slog` as the official structured logging package.

```go
package logging

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"

	"go.opentelemetry.io/otel/trace"
)

// LogConfig configures the logging system
type LogConfig struct {
	Level       slog.Level
	Format      string // "json", "text"
	Output      io.Writer
	ServiceName string
	ServiceVersion string
	Environment string
	AddSource   bool
}

// NewLogger creates a production-ready structured logger
func NewLogger(config LogConfig) *slog.Logger {
	opts := &slog.HandlerOptions{
		Level:     config.Level,
		AddSource: config.AddSource,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Rename time key to match ECS (Elastic Common Schema)
			if a.Key == slog.TimeKey {
				a.Key = "@timestamp"
			}
			// Rename level to log.level for ECS
			if a.Key == slog.LevelKey {
				a.Key = "log.level"
				a.Value = slog.StringValue(
					levelToECS(a.Value.Any().(slog.Level)))
			}
			// Rename msg to message for ECS
			if a.Key == slog.MessageKey {
				a.Key = "message"
			}
			return a
		},
	}

	output := config.Output
	if output == nil {
		output = os.Stdout
	}

	var handler slog.Handler
	if config.Format == "text" {
		handler = slog.NewTextHandler(output, opts)
	} else {
		handler = slog.NewJSONHandler(output, opts)
	}

	// Add service metadata
	logger := slog.New(handler).With(
		slog.String("service.name", config.ServiceName),
		slog.String("service.version", config.ServiceVersion),
		slog.String("environment", config.Environment),
		slog.String("host.name", getHostname()),
	)

	return logger
}

func levelToECS(level slog.Level) string {
	switch level {
	case slog.LevelDebug:
		return "debug"
	case slog.LevelInfo:
		return "info"
	case slog.LevelWarn:
		return "warn"
	case slog.LevelError:
		return "error"
	default:
		return "info"
	}
}

func getHostname() string {
	h, _ := os.Hostname()
	return h
}

// ContextLogger extracts trace information and adds it to log entries
type ContextLogger struct {
	base *slog.Logger
}

// NewContextLogger wraps a slog.Logger with trace context support
func NewContextLogger(base *slog.Logger) *ContextLogger {
	return &ContextLogger{base: base}
}

// WithContext extracts correlation ID and trace from context
func (l *ContextLogger) WithContext(ctx context.Context) *slog.Logger {
	logger := l.base

	// Extract correlation ID
	if corrID := CorrelationIDFromContext(ctx); corrID != "" {
		logger = logger.With(slog.String("correlation_id", corrID))
	}

	// Extract OpenTelemetry trace context
	span := trace.SpanFromContext(ctx)
	if span.IsRecording() {
		spanCtx := span.SpanContext()
		if spanCtx.IsValid() {
			logger = logger.With(
				slog.String("trace.id", spanCtx.TraceID().String()),
				slog.String("span.id", spanCtx.SpanID().String()),
				slog.Bool("trace.sampled", spanCtx.IsSampled()),
			)
		}
	}

	// Extract user ID if present
	if userID := UserIDFromContext(ctx); userID != "" {
		logger = logger.With(slog.String("user.id", userID))
	}

	return logger
}

// Key types for context values
type contextKeyType string

const (
	correlationIDKey contextKeyType = "correlation_id"
	userIDKey        contextKeyType = "user_id"
	requestIDKey     contextKeyType = "request_id"
)

// WithCorrelationID adds a correlation ID to the context
func WithCorrelationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, correlationIDKey, id)
}

// CorrelationIDFromContext extracts the correlation ID from context
func CorrelationIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(correlationIDKey).(string)
	return id
}

// WithUserID adds a user ID to the context
func WithUserID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, userIDKey, id)
}

// UserIDFromContext extracts the user ID from context
func UserIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(userIDKey).(string)
	return id
}

// LoggingMiddleware adds structured logging to HTTP handlers
func LoggingMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Generate or extract correlation ID
			corrID := r.Header.Get("X-Correlation-ID")
			if corrID == "" {
				corrID = generateID()
			}

			// Add to response headers for client debugging
			w.Header().Set("X-Correlation-ID", corrID)

			// Enrich context
			ctx := WithCorrelationID(r.Context(), corrID)
			r = r.WithContext(ctx)

			// Wrap response writer to capture status
			wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			// Request log
			reqLogger := logger.With(
				slog.String("correlation_id", corrID),
				slog.String("http.method", r.Method),
				slog.String("http.url", r.URL.Path),
				slog.String("http.query", r.URL.RawQuery),
				slog.String("http.remote_addr", r.RemoteAddr),
				slog.String("http.user_agent", r.UserAgent()),
			)

			reqLogger.Info("request started")

			// Execute handler
			next.ServeHTTP(wrapped, r)

			// Response log
			duration := time.Since(start)
			level := slog.LevelInfo
			if wrapped.statusCode >= 500 {
				level = slog.LevelError
			} else if wrapped.statusCode >= 400 {
				level = slog.LevelWarn
			}

			reqLogger.Log(r.Context(), level, "request completed",
				slog.Int("http.status_code", wrapped.statusCode),
				slog.Duration("http.duration", duration),
				slog.Int64("http.response_size", wrapped.bytesWritten),
			)
		})
	}
}

type responseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int64
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.bytesWritten += int64(n)
	return n, err
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// SampledLogger wraps a logger with sampling to reduce log volume
type SampledLogger struct {
	base       *slog.Logger
	mu         sync.Mutex
	counters   map[string]int
	sampleRate int // 1 in N messages
}

// NewSampledLogger creates a sampled logger
func NewSampledLogger(base *slog.Logger, sampleRate int) *SampledLogger {
	return &SampledLogger{
		base:       base,
		counters:   make(map[string]int),
		sampleRate: sampleRate,
	}
}

// InfoSampled logs at info level with sampling by message key
func (l *SampledLogger) InfoSampled(ctx context.Context, key, msg string, args ...any) {
	l.mu.Lock()
	l.counters[key]++
	count := l.counters[key]
	l.mu.Unlock()

	if count%l.sampleRate == 0 {
		l.base.InfoContext(ctx, msg, append(args,
			slog.Int("sample_count", count),
			slog.Int("sample_rate", l.sampleRate),
		)...)
	}
}

// ErrorLogger wraps error logging with stack traces and error details
type ErrorLogger struct {
	logger *slog.Logger
}

// NewErrorLogger creates an error logger
func NewErrorLogger(logger *slog.Logger) *ErrorLogger {
	return &ErrorLogger{logger: logger}
}

// LogError logs an error with full context
func (l *ErrorLogger) LogError(ctx context.Context, err error, msg string, args ...any) {
	if err == nil {
		return
	}

	// Capture stack trace
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	stack := string(buf[:n])

	attrs := []any{
		slog.String("error.type", fmt.Sprintf("%T", err)),
		slog.String("error.message", err.Error()),
		slog.String("error.stack_trace", stack),
	}

	// Check if error implements additional interfaces
	if unwrapped := errors.Unwrap(err); unwrapped != nil {
		attrs = append(attrs, slog.String("error.cause", unwrapped.Error()))
	}

	attrs = append(attrs, args...)
	l.logger.ErrorContext(ctx, msg, attrs...)
}

// AuditLogger provides immutable audit trail logging
type AuditLogger struct {
	logger    *slog.Logger
	service   string
}

// AuditEvent represents an auditable action
type AuditEvent struct {
	Action     string
	UserID     string
	ResourceID string
	Resource   string
	Result     string // "success", "failure"
	Reason     string
	IP         string
	Details    map[string]any
}

// Log records an audit event
func (a *AuditLogger) Log(ctx context.Context, event AuditEvent) {
	attrs := []any{
		slog.String("event.action", event.Action),
		slog.String("event.outcome", event.Result),
		slog.String("user.id", event.UserID),
		slog.String("resource.id", event.ResourceID),
		slog.String("resource.type", event.Resource),
		slog.String("source.ip", event.IP),
		slog.String("service.name", a.service),
		slog.Bool("event.audit", true),
		slog.Time("event.created", time.Now()),
	}

	if event.Reason != "" {
		attrs = append(attrs, slog.String("event.reason", event.Reason))
	}

	if len(event.Details) > 0 {
		detailsJSON, _ := json.Marshal(event.Details)
		attrs = append(attrs, slog.String("event.details", string(detailsJSON)))
	}

	a.logger.InfoContext(ctx, "audit_event", attrs...)
}
```

### Junior → FAANG: Why `slog` Over `fmt.Println` and `log.Printf`

The shift from `fmt.Println` to `log/slog` is not cosmetic: structured logs are machine-readable, which means they can be parsed, indexed, and queried by log aggregation systems without brittle regex-based parsing. An unstructured log line like `"user 12345 logged in at 2024-01-15"` requires a regex to extract the user ID. A structured log `{"event":"login","user_id":"12345","timestamp":"2024-01-15"}` can be queried directly with `user_id = "12345"` in Elasticsearch or Loki.

First-job habit: never use string interpolation to embed dynamic values in log messages. Put dynamic values in structured fields. `slog.Info("request completed", "duration_ms", 150, "user_id", userID)` is always better than `log.Printf("request completed in %dms for user %s", 150, userID)`.

### Senior @ FAANG: slog Architecture, Custom Handlers, and Security

**Custom slog handler as a shared library.** At scale, a custom `slog.Handler` that automatically injects `trace_id`, `span_id`, `service.name`, and `deployment.environment` from the context eliminates the burden from every call site. The handler is implemented once in the platform's shared logging library and used by all services. This ensures log fields are always present and always named consistently, which is a prerequisite for cross-service log correlation.

**PII scrubbing at the handler level.** A custom handler can inspect attribute keys and values before writing them to the output. Attributes whose keys match a blocklist (email, password, ssn, credit_card) are either redacted (replaced with `[REDACTED]`) or hashed before emission. This scrubbing happens at the handler level, not the call site, so individual developers cannot accidentally bypass it. The blocklist is maintained as a configuration file reviewed by the security team.

**Log sampling for cost control.** At FAANG-scale request volumes, a service handling 100,000 RPS that emits one log line per request produces 100,000 log lines per second. At 200 bytes per line, that is 20 MB/s, or 1.7 TB/day per service. A custom slog handler that samples debug and info logs (keeping 1% of successful requests, 100% of errors and warnings) reduces this by two orders of magnitude without losing diagnostic signal.

---
