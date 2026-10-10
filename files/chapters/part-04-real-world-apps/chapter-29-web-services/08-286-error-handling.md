## 29.6 Error Handling

### Custom Error Types

A custom `AppError` type pairs an HTTP status code with a client-safe message and an optional wrapped internal error. Constructor functions like `NewNotFoundError` and `NewBadRequestError` enforce consistent status codes, so handlers never hard-code numeric codes and error categorization stays in one place.

```go
package errors

import (
    "fmt"
    "net/http"
)

type AppError struct {
    Code    int    `json:"-"`
    Message string `json:"message"`
    Err     error  `json:"-"`
}

func (e *AppError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("%s: %v", e.Message, e.Err)
    }
    return e.Message
}

func (e *AppError) Unwrap() error {
    return e.Err
}

func NewNotFoundError(resource string) *AppError {
    return &AppError{
        Code:    http.StatusNotFound,
        Message: fmt.Sprintf("%s not found", resource),
    }
}

func NewBadRequestError(message string) *AppError {
    return &AppError{
        Code:    http.StatusBadRequest,
        Message: message,
    }
}

func NewUnauthorizedError() *AppError {
    return &AppError{
        Code:    http.StatusUnauthorized,
        Message: "Unauthorized",
    }
}

func NewForbiddenError() *AppError {
    return &AppError{
        Code:    http.StatusForbidden,
        Message: "Forbidden",
    }
}

func NewInternalError(err error) *AppError {
    return &AppError{
        Code:    http.StatusInternalServerError,
        Message: "Internal server error",
        Err:     err,
    }
}

func NewConflictError(message string) *AppError {
    return &AppError{
        Code:    http.StatusConflict,
        Message: message,
    }
}
```

### Error Handler

The `ErrorHandler` inspects errors returned from service calls using `errors.As` to distinguish known `AppError` values from unexpected failures. Known errors produce their associated status code and message. Unknown errors are logged with full details but return a generic 500 response to the client, preventing internal information leaks.

```go
package handlers

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"
)

type ErrorHandler struct {
    logger *slog.Logger
}

func (h *ErrorHandler) Handle(w http.ResponseWriter, r *http.Request, err error) {
    var appErr *AppError
    if errors.As(err, &appErr) {
        // Known error
        if appErr.Code >= 500 {
            h.logger.Error("server error",
                "error", appErr.Err,
                "path", r.URL.Path,
            )
        }

        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(appErr.Code)
        json.NewEncoder(w).Encode(map[string]string{
            "error": appErr.Message,
        })
        return
    }

    // Unknown error - log and return generic message
    h.logger.Error("unexpected error",
        "error", err,
        "path", r.URL.Path,
    )

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusInternalServerError)
    json.NewEncoder(w).Encode(map[string]string{
        "error": "Internal server error",
    })
}
```

### Junior to FAANG: Error Discipline From Day One

Three rules to internalize. Never return `err.Error()` to a client for unknown errors (leaks stack paths, credentials, internal URLs). Always log unknown errors with full context server-side. Always return a stable machine-readable code, not just a human message. The snippet above does all three.

Worked example, the handler pattern that keeps error handling clean. Return `(status, err)` or better, return `error` where the error type carries the status, and have one central `writeError` function. Handlers become linear flows with early returns, no repeated JSON-marshaling.

```go
func (h *Handler) HandleCreate(w http.ResponseWriter, r *http.Request) {
    if err := h.create(w, r); err != nil {
        h.errors.Handle(w, r, err)
    }
}
func (h *Handler) create(w http.ResponseWriter, r *http.Request) error {
    var req CreateUserRequest
    if err := decodeJSON(w, r, &req, 1<<20); err != nil {
        return errors.NewBadRequestError("invalid body")
    }
    user, err := h.svc.Create(r.Context(), req)
    if err != nil {
        return err // AppError bubbles up, unknown errors become 500
    }
    return respondJSON(w, http.StatusCreated, user)
}
```

Interview framing. "How do you prevent leaking internal errors." Answer in three parts. Type the error domain (`AppError`), wrap unknown errors with `fmt.Errorf("svc call: %w", err)` and let the handler decide what to show, log the full chain server-side with `slog` including `stack`. Mention that stack traces in responses are both an info leak and a UX disaster, and that you have seen them in production during an intern bug bash.

### Senior at FAANG: RFC 7807 Problem Details as Org Contract

The `{"error": "string"}` envelope shown above is the minimum. At FAANG scale, adopt RFC 7807. Every error response is `application/problem+json` with fixed fields.

```json
{
  "type": "https://corp.dev/problems/user-not-found",
  "title": "User not found",
  "status": 404,
  "detail": "User with id 42 does not exist.",
  "instance": "/api/v1/users/42",
  "code": "user_not_found",
  "trace_id": "0af7651916cd43dd8448eb211c80319c",
  "errors": []
}
```

The `code` field is a stable org-wide identifier mapped to runbooks. The `trace_id` is propagated from OTEL. The `errors` array carries validation details. The `type` URI points to a docs page explaining the error. This shape survives every language and client SDK and makes incident triage linear.

Error-code registry. Own a single `errors.yaml` in a platform repo that lists every code, its HTTP status, its docs URL, its retriability (is it safe to retry), and the owning team. The registry is the source of truth for client SDKs, for support tooling, and for SRE runbooks. A code that is not in the registry fails CI.

Retriability metadata. Clients need to know which errors are safe to retry. 429 and 503 always yes (with backoff). 5xx marked retriable only if the operation is idempotent. 4xx almost never. Encode this in the registry and emit `Retry-After` headers where appropriate.

Circuit breaking on upstream errors. When an upstream service returns 5xx beyond a threshold, trip a circuit breaker (`sony/gobreaker` or `failsafe-go`). Requests during the breaker-open window return a `platform/circuit_open` error with status 503 immediately, preserving upstream capacity for recovery. Publish breaker config as a platform convention (5 percent error rate over 60 seconds trips, 30 second open window, half-open probes).

Error budgets and SLOs. Every service publishes an availability SLO (e.g. 99.9 percent non-5xx over 28 days). The error budget (0.1 percent) is spent on deploys, experiments, and real outages. When the budget is more than 50 percent spent, freeze risky changes. When exhausted, block all non-fix deploys. This is a staff-level policy that the error-handling platform enables by cleanly distinguishing 5xx from 4xx.

Panic-as-error plumbing. Panic recovery middleware emits `code: internal_panic`, records `panic_total`, captures the stack to Sentry with a PII scrubber, and returns RFC 7807 with `status: 500` and `detail: "unexpected error"`. Handlers never see the panic. SRE dashboards alert on any non-zero `panic_total` rate.

Error context propagation. Use `errors.Is` and `errors.As` everywhere, `fmt.Errorf("%w")` to wrap, never `fmt.Errorf("%v")` which breaks the chain. Services should define sentinel errors (`var ErrUserNotFound = errors.New("user not found")`) for cross-package matching. Handlers map sentinels to `AppError` values via a small table.

Client SDK impact. The error envelope determines SDK ergonomics. With RFC 7807, you can generate typed error classes in every language (TypeScript, Swift, Kotlin, Python) from the registry. Clients do `catch (e: UserNotFound)` rather than parsing strings. This single change removes an entire class of support tickets.

Observability of errors. Metrics per code, per status, per service. Alert on new codes appearing (a service started returning `unknown_upstream_error` yesterday, why). Alert on codes crossing thresholds (spike in `payment_declined`). Log every 5xx with full context (request ID, trace ID, user ID if auth'd, input size, downstream error). Sample 4xx at 1 percent to avoid log-storm on bot traffic.

Staff archetype. The Error Taxonomy Owner runs the code registry, reviews every new code, writes the runbooks, and drives the quarterly "top 10 errors" retro. Deeply unglamorous, highly leveraged.

Multi-year roadmap. Year 1, migrate to RFC 7807 and publish the registry. Year 2, generate typed SDKs, integrate with incident tooling. Year 3, per-code SLOs and budgets, retirement of legacy `{"error": ""}` envelope. Year 4, tail-sampled traces correlated with errors for postmortem speed.

---
