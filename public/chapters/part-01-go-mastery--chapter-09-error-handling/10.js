export default `## 9.9 Complete Production Error Handling System

The following example assembles the patterns from the previous sections into a working HTTP service with structured error codes, typed errors, JSON error responses, panic recovery middleware, and tests. Each file is shown in full so you can see how the pieces connect.

### Project Structure

A well-structured Go project separates concerns across predictable directories, making it immediately navigable to any Go developer. The following layout follows the widely adopted convention for Go module organization.

\`\`\`
errorhandling/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── errors/
│   │   ├── codes.go
│   │   ├── errors.go
│   │   └── errors_test.go
│   ├── middleware/
│   │   ├── recovery.go
│   │   └── logging.go
│   └── handler/
│       ├── user.go
│       └── user_test.go
├── Makefile
├── Dockerfile
└── go.mod
\`\`\`

### codes.go, Error Codes

The error codes file defines a typed enumeration of all error codes the service can produce, enabling consistent mapping to HTTP status codes and exhaustive handling by clients.

\`\`\`go
// internal/errors/codes.go
package errors

import "net/http"

// ErrorCode represents a machine-readable error code
type ErrorCode string

const (
    // Client errors
    CodeInvalidArgument   ErrorCode = "INVALID_ARGUMENT"
    CodeNotFound          ErrorCode = "NOT_FOUND"
    CodeAlreadyExists     ErrorCode = "ALREADY_EXISTS"
    CodePermissionDenied  ErrorCode = "PERMISSION_DENIED"
    CodeUnauthenticated   ErrorCode = "UNAUTHENTICATED"
    CodeRateLimited       ErrorCode = "RATE_LIMITED"
    CodeFailedPrecondition ErrorCode = "FAILED_PRECONDITION"

    // Server errors
    CodeInternal          ErrorCode = "INTERNAL"
    CodeUnavailable       ErrorCode = "UNAVAILABLE"
    CodeDeadlineExceeded  ErrorCode = "DEADLINE_EXCEEDED"
    CodeCanceled          ErrorCode = "CANCELED"
)

// HTTPStatus returns the appropriate HTTP status code
func (c ErrorCode) HTTPStatus() int {
    switch c {
    case CodeInvalidArgument:
        return http.StatusBadRequest
    case CodeNotFound:
        return http.StatusNotFound
    case CodeAlreadyExists:
        return http.StatusConflict
    case CodePermissionDenied:
        return http.StatusForbidden
    case CodeUnauthenticated:
        return http.StatusUnauthorized
    case CodeRateLimited:
        return http.StatusTooManyRequests
    case CodeFailedPrecondition:
        return http.StatusPreconditionFailed
    case CodeUnavailable:
        return http.StatusServiceUnavailable
    case CodeDeadlineExceeded:
        return http.StatusGatewayTimeout
    case CodeCanceled:
        return 499 // Client Closed Request
    default:
        return http.StatusInternalServerError
    }
}

// IsRetryable returns whether errors with this code can be retried
func (c ErrorCode) IsRetryable() bool {
    switch c {
    case CodeUnavailable, CodeDeadlineExceeded, CodeRateLimited:
        return true
    default:
        return false
    }
}
\`\`\`

### errors.go, Error Types

The errors file defines the custom error types that carry codes, messages, and contextual metadata. These types implement the \`error\` interface and support \`errors.Is\` and \`errors.As\` inspection.

\`\`\`go
// internal/errors/errors.go
package errors

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "net/http"
    "runtime"
    "time"
)

// AppError represents a structured application error
type AppError struct {
    Code       ErrorCode        \`json:"code"\`
    Message    string           \`json:"message"\`
    Details    []Detail         \`json:"details,omitempty"\`
    RequestID  string           \`json:"request_id,omitempty"\`
    Timestamp  time.Time        \`json:"timestamp"\`
    internal   error            // Never serialized
    stack      []uintptr        // Stack trace
    retryAfter time.Duration    // For rate limiting
}

// Detail provides additional context about an error
type Detail struct {
    Field       string \`json:"field,omitempty"\`
    Reason      string \`json:"reason"\`
    Value       any    \`json:"value,omitempty"\`
}

// New creates a new AppError
func New(code ErrorCode, message string) *AppError {
    return &AppError{
        Code:      code,
        Message:   message,
        Timestamp: time.Now().UTC(),
        stack:     captureStack(),
    }
}

// Wrap wraps an existing error
func Wrap(err error, code ErrorCode, message string) *AppError {
    if err == nil {
        return nil
    }
    return &AppError{
        Code:      code,
        Message:   message,
        Timestamp: time.Now().UTC(),
        internal:  err,
        stack:     captureStack(),
    }
}

// Error implements the error interface
func (e *AppError) Error() string {
    if e.internal != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.internal)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Unwrap returns the wrapped error
func (e *AppError) Unwrap() error {
    return e.internal
}

// Is enables errors.Is to match by code
func (e *AppError) Is(target error) bool {
    if t, ok := target.(*AppError); ok {
        return e.Code == t.Code
    }
    return false
}

// WithDetail adds a detail to the error
func (e *AppError) WithDetail(field, reason string) *AppError {
    e.Details = append(e.Details, Detail{
        Field:  field,
        Reason: reason,
    })
    return e
}

// WithDetailValue adds a detail with value to the error
func (e *AppError) WithDetailValue(field, reason string, value any) *AppError {
    e.Details = append(e.Details, Detail{
        Field:  field,
        Reason: reason,
        Value:  value,
    })
    return e
}

// WithRetryAfter sets the retry-after duration
func (e *AppError) WithRetryAfter(d time.Duration) *AppError {
    e.retryAfter = d
    return e
}

// HTTPStatus returns the appropriate HTTP status code
func (e *AppError) HTTPStatus() int {
    return e.Code.HTTPStatus()
}

// StackTrace returns the formatted stack trace
func (e *AppError) StackTrace() string {
    frames := runtime.CallersFrames(e.stack)
    var result string
    for {
        frame, more := frames.Next()
        result += fmt.Sprintf("%s\\n\\t%s:%d\\n", frame.Function, frame.File, frame.Line)
        if !more {
            break
        }
    }
    return result
}

// captureStack captures the current stack trace
func captureStack() []uintptr {
    pcs := make([]uintptr, 32)
    n := runtime.Callers(3, pcs)
    return pcs[:n]
}

// Common error constructors

// NotFound creates a not found error
func NotFound(resource string, id any) *AppError {
    return New(CodeNotFound, fmt.Sprintf("%s not found", resource)).
        WithDetailValue("resource", resource, id)
}

// InvalidArgument creates an invalid argument error
func InvalidArgument(message string) *AppError {
    return New(CodeInvalidArgument, message)
}

// ValidationFailed creates a validation error with multiple field errors
func ValidationFailed(details ...Detail) *AppError {
    err := New(CodeInvalidArgument, "validation failed")
    err.Details = details
    return err
}

// Unauthenticated creates an authentication error
func Unauthenticated(message string) *AppError {
    return New(CodeUnauthenticated, message)
}

// PermissionDenied creates an authorization error
func PermissionDenied(resource, action string) *AppError {
    return New(CodePermissionDenied, "permission denied").
        WithDetail(resource, fmt.Sprintf("not allowed to %s", action))
}

// Internal creates an internal error (wrapping the cause)
func Internal(cause error) *AppError {
    return Wrap(cause, CodeInternal, "internal error")
}

// RateLimited creates a rate limit error
func RateLimited(retryAfter time.Duration) *AppError {
    return New(CodeRateLimited, "rate limit exceeded").
        WithRetryAfter(retryAfter)
}

// FromContext converts context errors to AppError
func FromContext(err error) *AppError {
    if err == nil {
        return nil
    }

    if errors.Is(err, context.Canceled) {
        return Wrap(err, CodeCanceled, "request canceled")
    }
    if errors.Is(err, context.DeadlineExceeded) {
        return Wrap(err, CodeDeadlineExceeded, "request timeout")
    }

    // Check if already an AppError
    var appErr *AppError
    if errors.As(err, &appErr) {
        return appErr
    }

    // Wrap unknown errors
    return Internal(err)
}

// Response types for JSON serialization

// ErrorResponse is the JSON response format
type ErrorResponse struct {
    Error ErrorBody \`json:"error"\`
}

// ErrorBody contains the error details
type ErrorBody struct {
    Code      string   \`json:"code"\`
    Message   string   \`json:"message"\`
    Details   []Detail \`json:"details,omitempty"\`
    RequestID string   \`json:"request_id,omitempty"\`
}

// WriteError writes an error response to the HTTP response writer
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    appErr := FromContext(err)
    if appErr == nil {
        appErr = Internal(errors.New("unknown error"))
    }

    // Set request ID if available
    if reqID := r.Context().Value("request_id"); reqID != nil {
        appErr.RequestID = reqID.(string)
    }

    // Set retry-after header if applicable
    if appErr.retryAfter > 0 {
        w.Header().Set("Retry-After", fmt.Sprintf("%d", int(appErr.retryAfter.Seconds())))
    }

    // Write response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(appErr.HTTPStatus())

    json.NewEncoder(w).Encode(ErrorResponse{
        Error: ErrorBody{
            Code:      string(appErr.Code),
            Message:   appErr.Message,
            Details:   appErr.Details,
            RequestID: appErr.RequestID,
        },
    })
}
\`\`\`

### errors_test.go, Tests

The error type tests verify correct error construction, chain traversal with \`errors.Is\` and \`errors.As\`, and that error messages format correctly for logging and API responses.

\`\`\`go
// internal/errors/errors_test.go
package errors

import (
    "context"
    "encoding/json"
    "errors"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"
)

func TestAppError_Error(t *testing.T) {
    tests := []struct {
        name    string
        err     *AppError
        want    string
    }{
        {
            name: "simple error",
            err:  New(CodeNotFound, "user not found"),
            want: "[NOT_FOUND] user not found",
        },
        {
            name: "wrapped error",
            err:  Wrap(errors.New("db error"), CodeInternal, "database failure"),
            want: "[INTERNAL] database failure: db error",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := tt.err.Error(); got != tt.want {
                t.Errorf("Error() = %q, want %q", got, tt.want)
            }
        })
    }
}

func TestAppError_Is(t *testing.T) {
    notFound := New(CodeNotFound, "user not found")
    internal := New(CodeInternal, "internal error")

    // Same code should match
    if !errors.Is(notFound, &AppError{Code: CodeNotFound}) {
        t.Error("expected match for same code")
    }

    // Different codes should not match
    if errors.Is(notFound, internal) {
        t.Error("expected no match for different codes")
    }

    // Wrapped errors should still match
    wrapped := Wrap(notFound, CodeInternal, "wrapped")
    if !errors.Is(wrapped, notFound) {
        t.Error("expected wrapped error to match inner error")
    }
}

func TestAppError_Unwrap(t *testing.T) {
    cause := errors.New("original error")
    wrapped := Wrap(cause, CodeInternal, "wrapped")

    unwrapped := errors.Unwrap(wrapped)
    if unwrapped != cause {
        t.Errorf("Unwrap() = %v, want %v", unwrapped, cause)
    }
}

func TestFromContext(t *testing.T) {
    tests := []struct {
        name     string
        err      error
        wantCode ErrorCode
    }{
        {
            name:     "context canceled",
            err:      context.Canceled,
            wantCode: CodeCanceled,
        },
        {
            name:     "deadline exceeded",
            err:      context.DeadlineExceeded,
            wantCode: CodeDeadlineExceeded,
        },
        {
            name:     "unknown error",
            err:      errors.New("unknown"),
            wantCode: CodeInternal,
        },
        {
            name:     "nil error",
            err:      nil,
            wantCode: "",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := FromContext(tt.err)
            if tt.err == nil {
                if got != nil {
                    t.Errorf("FromContext(nil) = %v, want nil", got)
                }
                return
            }
            if got.Code != tt.wantCode {
                t.Errorf("FromContext().Code = %s, want %s", got.Code, tt.wantCode)
            }
        })
    }
}

func TestWriteError(t *testing.T) {
    tests := []struct {
        name           string
        err            error
        wantStatus     int
        wantCode       string
    }{
        {
            name:       "not found",
            err:        NotFound("user", 123),
            wantStatus: http.StatusNotFound,
            wantCode:   "NOT_FOUND",
        },
        {
            name:       "rate limited",
            err:        RateLimited(60 * time.Second),
            wantStatus: http.StatusTooManyRequests,
            wantCode:   "RATE_LIMITED",
        },
        {
            name:       "unknown error",
            err:        errors.New("something went wrong"),
            wantStatus: http.StatusInternalServerError,
            wantCode:   "INTERNAL",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := httptest.NewRequest("GET", "/", nil)
            rec := httptest.NewRecorder()

            WriteError(rec, req, tt.err)

            if rec.Code != tt.wantStatus {
                t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
            }

            var resp ErrorResponse
            if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
                t.Fatalf("failed to decode response: %v", err)
            }

            if resp.Error.Code != tt.wantCode {
                t.Errorf("code = %s, want %s", resp.Error.Code, tt.wantCode)
            }
        })
    }
}

func TestNotFound(t *testing.T) {
    err := NotFound("user", "abc123")

    if err.Code != CodeNotFound {
        t.Errorf("Code = %s, want %s", err.Code, CodeNotFound)
    }

    if len(err.Details) != 1 {
        t.Fatalf("len(Details) = %d, want 1", len(err.Details))
    }

    detail := err.Details[0]
    if detail.Reason != "user" {
        t.Errorf("Detail.Reason = %s, want 'user'", detail.Reason)
    }
    if detail.Value != "abc123" {
        t.Errorf("Detail.Value = %v, want 'abc123'", detail.Value)
    }
}

func TestValidationFailed(t *testing.T) {
    err := ValidationFailed(
        Detail{Field: "email", Reason: "invalid format"},
        Detail{Field: "age", Reason: "must be positive"},
    )

    if err.Code != CodeInvalidArgument {
        t.Errorf("Code = %s, want %s", err.Code, CodeInvalidArgument)
    }

    if len(err.Details) != 2 {
        t.Fatalf("len(Details) = %d, want 2", len(err.Details))
    }
}

func BenchmarkNew(b *testing.B) {
    for b.Loop() {
        _ = New(CodeNotFound, "user not found")
    }
}

func BenchmarkWrap(b *testing.B) {
    cause := errors.New("original")
    b.ResetTimer()
    for b.Loop() {
        _ = Wrap(cause, CodeInternal, "wrapped")
    }
}

func BenchmarkFromContext(b *testing.B) {
    err := context.Canceled
    b.ResetTimer()
    for b.Loop() {
        _ = FromContext(err)
    }
}
\`\`\`

### recovery.go, Panic Recovery Middleware

Middleware wraps HTTP handlers to provide cross-cutting concerns such as logging, authentication, and panic recovery without cluttering individual handler implementations.

\`\`\`go
// internal/middleware/recovery.go
package middleware

import (
    "log/slog"
    "net/http"
    "runtime/debug"

    apperrors "myapp/internal/errors"
)

// Recovery returns middleware that recovers from panics
func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rec := recover(); rec != nil {
                    stack := debug.Stack()

                    // Log the panic
                    logger.Error("panic recovered",
                        "panic", rec,
                        "stack", string(stack),
                        "path", r.URL.Path,
                        "method", r.Method,
                    )

                    // Write error response
                    err := apperrors.Internal(nil).
                        WithDetail("panic", "an unexpected error occurred")
                    apperrors.WriteError(w, r, err)
                }
            }()

            next.ServeHTTP(w, r)
        })
    }
}
\`\`\`

### main.go, Server Entry Point

The application entry point wires together all components, configures the server, and handles graceful shutdown. This file should remain thin, delegating business logic to internal packages.

\`\`\`go
// cmd/server/main.go
package main

import (
    "context"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "myapp/internal/errors"
    "myapp/internal/middleware"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    mux := http.NewServeMux()

    // Example handlers
    mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if id == "" {
            errors.WriteError(w, r, errors.InvalidArgument("id is required"))
            return
        }

        // Simulate user not found
        if id == "999" {
            errors.WriteError(w, r, errors.NotFound("user", id))
            return
        }

        w.Header().Set("Content-Type", "application/json")
        w.Write([]byte(\`{"id":"\` + id + \`","name":"John Doe"}\`))
    })

    mux.HandleFunc("POST /users", func(w http.ResponseWriter, r *http.Request) {
        // Simulate validation error
        err := errors.ValidationFailed(
            errors.Detail{Field: "email", Reason: "invalid format"},
            errors.Detail{Field: "age", Reason: "must be positive", Value: -5},
        )
        errors.WriteError(w, r, err)
    })

    mux.HandleFunc("GET /panic", func(w http.ResponseWriter, r *http.Request) {
        panic("intentional panic for testing")
    })

    // Apply middleware
    handler := middleware.Recovery(logger)(mux)

    server := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()

        server.Shutdown(ctx)
    }()

    logger.Info("starting server", "addr", server.Addr)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        logger.Error("server error", "error", err)
        os.Exit(1)
    }
}
\`\`\`

### Makefile

The Makefile provides a standard set of development commands that wrap common Go toolchain operations, ensuring consistent behavior across developer machines and CI environments.

\`\`\`makefile
.PHONY: build test run lint

build:
	go build -o bin/server ./cmd/server

test:
	go test -v -race -cover ./...

run:
	go run ./cmd/server

lint:
	golangci-lint run

bench:
	go test -bench=. -benchmem ./internal/errors/
\`\`\`

### Dockerfile

The Dockerfile uses a multi-stage build to produce a minimal production image. The first stage compiles the binary with full build tooling. The final stage copies only the compiled binary into a scratch or distroless base.

\`\`\`dockerfile
FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server ./cmd/server

FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata
COPY --from=builder /server /server

EXPOSE 8080

ENTRYPOINT ["/server"]
\`\`\`

### Using This as a Reference Implementation

For a senior engineer, the production error-handling system above is the template for the team's own reference. Copy, adapt to the team's conventions, publish as the canonical pattern. Every new service starts here. The reference evolves with the team, but the shared shape survives turnover.

---
`;
