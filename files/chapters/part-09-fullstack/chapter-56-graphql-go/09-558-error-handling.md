## 56.8 Error Handling

GraphQL error handling differs from REST in that partial success is a first-class concept: a response can contain both `data` and `errors` fields simultaneously, allowing resolvers that partially succeed to return what they can alongside structured error details. Go's typed errors map cleanly to GraphQL error extensions, where an `extensions` object carries machine-readable error codes alongside the human-readable message. The patterns below show how to classify domain errors, attach extension metadata, and prevent internal implementation details from leaking to clients.

```go
// graph/errors.go
package graph

import (
    "context"
    "errors"
    "fmt"
    "log/slog"

    "github.com/99designs/gqlgen/graphql"
    "github.com/vektah/gqlparser/v2/gqlerror"
)

// Custom error types
var (
    ErrNotFound      = errors.New("not found")
    ErrUnauthorized  = errors.New("unauthorized")
    ErrForbidden     = errors.New("forbidden")
    ErrValidation    = errors.New("validation error")
    ErrConflict      = errors.New("conflict")
    ErrInternal      = errors.New("internal error")
)

// ErrorCode represents GraphQL error codes
type ErrorCode string

const (
    CodeNotFound      ErrorCode = "NOT_FOUND"
    CodeUnauthorized  ErrorCode = "UNAUTHORIZED"
    CodeForbidden     ErrorCode = "FORBIDDEN"
    CodeValidation    ErrorCode = "VALIDATION_ERROR"
    CodeConflict      ErrorCode = "CONFLICT"
    CodeInternal      ErrorCode = "INTERNAL_ERROR"
    CodeRateLimited   ErrorCode = "RATE_LIMITED"
)

// NewError creates a GraphQL error with code
func NewError(ctx context.Context, code ErrorCode, message string) *gqlerror.Error {
    return &gqlerror.Error{
        Message: message,
        Path:    graphql.GetPath(ctx),
        Extensions: map[string]any{
            "code": code,
        },
    }
}

// NewNotFoundError creates a not found error
func NewNotFoundError(ctx context.Context, resource string, id string) *gqlerror.Error {
    return NewError(ctx, CodeNotFound, fmt.Sprintf("%s with ID %s not found", resource, id))
}

// NewValidationError creates a validation error with field details
func NewValidationError(ctx context.Context, field string, message string) *gqlerror.Error {
    return &gqlerror.Error{
        Message: message,
        Path:    graphql.GetPath(ctx),
        Extensions: map[string]any{
            "code":  CodeValidation,
            "field": field,
        },
    }
}

// ErrorPresenter customizes error presentation
func ErrorPresenter(ctx context.Context, err error) *gqlerror.Error {
    // Unwrap the error to get the underlying cause
    var gqlErr *gqlerror.Error
    if errors.As(err, &gqlErr) {
        return gqlErr
    }

    // Map known errors to appropriate responses
    switch {
    case errors.Is(err, ErrNotFound):
        return NewError(ctx, CodeNotFound, err.Error())
    case errors.Is(err, ErrUnauthorized):
        return NewError(ctx, CodeUnauthorized, "Authentication required")
    case errors.Is(err, ErrForbidden):
        return NewError(ctx, CodeForbidden, "Access denied")
    case errors.Is(err, ErrValidation):
        return NewError(ctx, CodeValidation, err.Error())
    case errors.Is(err, ErrConflict):
        return NewError(ctx, CodeConflict, err.Error())
    default:
        // Log internal errors, return generic message
        slog.Error("internal error", "error", err, "path", graphql.GetPath(ctx))
        return NewError(ctx, CodeInternal, "An internal error occurred")
    }
}

// RecoverFunc handles panics in resolvers
func RecoverFunc(ctx context.Context, p any) error {
    slog.Error("panic in resolver",
        "panic", p,
        "path", graphql.GetPath(ctx),
    )
    return NewError(ctx, CodeInternal, "An internal error occurred")
}
```

### Junior -> FAANG: Error Handling Habits That Prevent Production Incidents

The most important habit: never return a raw Go error from a resolver. Raw errors are serialized directly into the `message` field of the GraphQL error object and sent to the client. Database driver errors expose table names. Internal package errors expose file paths. ORM errors expose SQL queries. Any of these can aid an attacker in understanding your data model.

The second habit: use the `errors` package sentinel pattern for domain errors. Define `var ErrNotFound = errors.New("not found")` in your service layer, wrap it with `fmt.Errorf("user %s: %w", id, ErrNotFound)` at the call site, and unwrap it with `errors.Is(err, ErrNotFound)` in the error presenter. This lets you handle all "not found" errors uniformly regardless of which service produced them, while preserving the full error chain in your logs.

The third habit: understand partial success. A GraphQL response can contain both `data` and `errors`. If a user query returns 20 items but one of them fails to load (permissions denied on a field, downstream service timeout for one record), the correct behavior is to return the 19 successful items in `data.items` and add one entry to the `errors` array for the failed item, with a path indicating which item failed (`["items", 3, "sensitiveField"]`). This is fundamentally different from REST, where you choose between 200 (all success) and 4xx/5xx (failure).

### Senior @ FAANG: Error Architecture Across a Federated Graph

At platform level, error handling is a cross-cutting concern that must be standardized across all subgraphs. Without standardization, different subgraphs return different error codes for the same class of failure, clients cannot handle errors programmatically, and on-call engineers cannot parse error patterns from logs.

**The error taxonomy ADR.** Define a canonical error code vocabulary and publish it in the platform SDK: `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. Every subgraph imports the platform SDK's error types and uses these codes. Clients can switch on `error.extensions.code` without knowing which subgraph produced the error.

**Error tracing across subgraph boundaries.** In a federated graph, a single client operation may trigger resolver calls in three subgraphs. If the order subgraph returns an error, the gateway must propagate it to the client in a way that preserves the field path (so the client knows which field failed), adds the subgraph name (so on-call engineers know where to look), and strips the subgraph-internal error message (replacing it with the safe error code and message from the platform taxonomy). The gateway error presenter is responsible for this translation.

**The null-bubble behavior and schema design.** When a non-null field resolver returns an error, GraphQL null-bubbles up through the response tree until it reaches a nullable ancestor or the root. A deeply nested non-null field that fails can null out an entire section of the response. This is a schema design concern as much as an error handling concern: mark fields non-null only when you are certain the resolver will always produce a value for a valid parent object. Fields backed by downstream services, computed fields, or fields that may fail for business reasons (like `averageRating` when there are no reviews) should be nullable so their individual failures do not cascade.

**Error monitoring and alerting.** At FAANG, error handling feeds an alerting pipeline. The error presenter logs every error as a structured event with operation name, field path, error code, and request ID. A log aggregation system (Datadog, Splunk, ELK) aggregates these events, and dashboards show error rate by code, by operation, and by field. Alerts fire when `NOT_FOUND` rates spike (possible data integrity issue), when `INTERNAL_ERROR` rates increase (possible regression), or when `RATE_LIMITED` events exceed baseline (possible abuse). The structured error code vocabulary makes these dashboards possible. Free-text error messages do not.

**The `RecoverFunc` and production panics.** Panics in resolvers are recoverable at the gqlgen level (the `RecoverFunc` is called). But a panic usually indicates a programming error: a nil pointer dereference, an out-of-bounds access, a failed type assertion. At FAANG, panics are treated as severity-2 incidents regardless of whether the end-user saw an error. The `RecoverFunc` must log the panic with the full stack trace (using `debug.Stack()`) and a correlation ID, and emit a metric that triggers a PagerDuty alert. Do not let panics go silently into the error log.

---
