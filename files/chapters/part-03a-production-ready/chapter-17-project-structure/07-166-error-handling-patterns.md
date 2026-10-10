## 17.6 Error Handling Patterns

### Domain Errors

Defining sentinel errors and typed error structs inside each domain package gives the rest of the codebase a stable, importable vocabulary for what can go wrong. Sentinel values enable `errors.Is` comparisons across package boundaries, while a struct like `ValidationError` carries the specific field name that failed, information a raw string error would lose.

```go
// internal/user/errors.go
package user

import (
    "errors"
    "fmt"
)

var (
    ErrNotFound     = errors.New("user not found")
    ErrEmailExists  = errors.New("email already exists")
    ErrInvalidInput = errors.New("invalid input")
)

type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// Unwrap ties the typed error to the sentinel, so callers who only care
// about the category can ask errors.Is(err, ErrInvalidInput), while callers
// who need the field can still recover it with errors.As.
func (e ValidationError) Unwrap() error { return ErrInvalidInput }
```

### Error Response Mapping

The API layer must translate domain errors into appropriate HTTP status codes and structured JSON bodies without leaking internal details to clients. A central `handleError` function using `errors.Is` keeps this mapping in one place, so adding a new domain error only requires a single new `case` rather than scattered status-code logic across every handler.

```go
// internal/api/errors.go
package api

import (
    "encoding/json"
    "errors"
    "log"
    "net/http"

    "myproject/internal/user"
)

type ErrorResponse struct {
    Code    string            `json:"code"`
    Message string            `json:"message"`
    Details map[string]string `json:"details,omitempty"`
}

func handleError(w http.ResponseWriter, err error) {
    var (
        status int
        resp   ErrorResponse
    )

    // Order matters. ValidationError unwraps to ErrInvalidInput, so the
    // errors.As case must come before the errors.Is case that would
    // otherwise swallow it and discard the field name.
    var ve user.ValidationError

    switch {
    case errors.Is(err, user.ErrNotFound):
        status = http.StatusNotFound
        resp = ErrorResponse{Code: "NOT_FOUND", Message: "User not found"}

    case errors.Is(err, user.ErrEmailExists):
        status = http.StatusConflict
        resp = ErrorResponse{Code: "EMAIL_EXISTS", Message: "Email already registered"}

    case errors.As(err, &ve):
        status = http.StatusBadRequest
        resp = ErrorResponse{
            Code:    "INVALID_INPUT",
            Message: "Validation failed",
            Details: map[string]string{ve.Field: ve.Message},
        }

    case errors.Is(err, user.ErrInvalidInput):
        status = http.StatusBadRequest
        resp = ErrorResponse{Code: "INVALID_INPUT", Message: "Invalid input"}

    default:
        status = http.StatusInternalServerError
        resp = ErrorResponse{Code: "INTERNAL_ERROR", Message: "Internal server error"}
        log.Printf("unhandled error: %v", err)
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(resp)
}
```

Two things here are easy to get wrong.

**Case order is load-bearing.** Because `ValidationError` unwraps to `ErrInvalidInput`, the `errors.Is(err, user.ErrInvalidInput)` case matches a `ValidationError` too. Put it first and the `errors.As` case becomes dead code, the `Details` field is never populated, and clients lose the field name with no test failing. Match from most specific to most general.

**Do not echo `err.Error()` into the response, not even on a 400.** It is tempting, since a validation message looks safe. But errors arrive wrapped: by the time a handler sees one, it may read `create user: check email: dial tcp 10.0.2.14:5432: connection refused: invalid input`. The whole chain is in that string, including internal hostnames and ports. Build the client-facing message from structured fields you control, which is exactly what `ValidationError.Field` and `.Message` are for, and let the full chain go to the log instead.

### Staff Lens: Error Categories Match HTTP Semantics

Domain errors fall into a small set of categories. Map them to HTTP status codes consistently:

- `ErrNotFound` → 404
- `ErrUnauthorized` → 401
- `ErrForbidden` → 403
- `ErrInvalidInput` / `ErrValidation` → 400
- `ErrConflict` → 409
- `ErrRateLimited` → 429
- Everything else → 500

Document the mapping. Apply it in every handler via a shared error-response helper. Services that do this consistently are easier to consume (clients can rely on semantic status codes) and easier to operate (500s mean something is broken, 4xxs mean the caller sent bad data).

### Never Leak Internal Details in 5xx Responses

A 500 response should say "internal error" and nothing more. Database error messages, stack traces, and internal identifiers belong in logs, not in the response. Leaking them is a security issue (information disclosure) and an operational issue (clients tie their logic to your internals). Log the details with a correlation ID and return the ID so operators can trace it.

---
