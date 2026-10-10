## 40.3 Error Response Structure

### Standardized Error Format

The `APIError` envelope carries a machine-readable `code` alongside the human-readable `message`, so clients can branch on the code without parsing strings. The `details` array holds per-field violations with a `location` tag (body, query, header, path), and the `trace_id` field threads observability context through to logs without requiring a separate correlation header.

**RFC 9457 compatibility (Problem Details for HTTP APIs).** RFC 9457 (2023) supersedes RFC 7807 and defines a standard problem body with `type`, `title`, `status`, `detail`, and `instance` plus arbitrary extension members, served with `Content-Type: application/problem+json`. The envelope below is a superset: mapping `code` to `type` (as a URI), `message` to `title`, keeping `status`, adding a `detail` field for long-form explanation, and using `path` as `instance` gives you a spec-compliant response without rewriting consumers. New APIs should emit `application/problem+json` on errors. `details` becomes an extension member and survives the mapping unchanged.

```go
// ... imports omitted for brevity (encoding/json, net/http, time)

// APIError is the standard error response
type APIError struct {
    Status    int           `json:"status"`
    Code      string        `json:"code"`
    Message   string        `json:"message"`
    Details   []ErrorDetail `json:"details,omitempty"`
    RequestID string        `json:"request_id,omitempty"`
    Timestamp string        `json:"timestamp"`
    Path      string        `json:"path,omitempty"`
    TraceID   string        `json:"trace_id,omitempty"`
}

// ErrorDetail provides specific error information
type ErrorDetail struct {
    Field    string      `json:"field,omitempty"`
    Code     string      `json:"code"`
    Message  string      `json:"message"`
    Value    any `json:"value,omitempty"`
    Location string      `json:"location,omitempty"` // body, query, header, path
}

// ErrorResponse writes an error response
func ErrorResponse(w http.ResponseWriter, r *http.Request, status int, code, message string) {
    apiErr := APIError{
        Status:    status,
        Code:      code,
        Message:   message,
        Timestamp: time.Now().UTC().Format(time.RFC3339),
        Path:      r.URL.Path,
        RequestID: GetRequestID(r.Context()),
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(apiErr)
}

// ValidationErrorResponse writes a validation error response
func ValidationErrorResponse(w http.ResponseWriter, r *http.Request, details []ErrorDetail) {
    apiErr := APIError{
        Status:    http.StatusUnprocessableEntity,
        Code:      "VALIDATION_ERROR",
        Message:   "One or more fields failed validation",
        Details:   details,
        Timestamp: time.Now().UTC().Format(time.RFC3339),
        Path:      r.URL.Path,
        RequestID: GetRequestID(r.Context()),
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusUnprocessableEntity)
    json.NewEncoder(w).Encode(apiErr)
}

// Common error responses
func BadRequest(w http.ResponseWriter, r *http.Request, message string) {
    ErrorResponse(w, r, http.StatusBadRequest, "BAD_REQUEST", message)
}

func Unauthorized(w http.ResponseWriter, r *http.Request, message string) {
    if message == "" {
        message = "Authentication required"
    }
    ErrorResponse(w, r, http.StatusUnauthorized, "UNAUTHORIZED", message)
}

func Forbidden(w http.ResponseWriter, r *http.Request, message string) {
    if message == "" {
        message = "Access denied"
    }
    ErrorResponse(w, r, http.StatusForbidden, "FORBIDDEN", message)
}

func NotFound(w http.ResponseWriter, r *http.Request, resource string) {
    message := "Resource not found"
    if resource != "" {
        message = resource + " not found"
    }
    ErrorResponse(w, r, http.StatusNotFound, "NOT_FOUND", message)
}

func Conflict(w http.ResponseWriter, r *http.Request, message string) {
    ErrorResponse(w, r, http.StatusConflict, "CONFLICT", message)
}

func InternalError(w http.ResponseWriter, r *http.Request) {
    ErrorResponse(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected error occurred")
}

func ServiceUnavailable(w http.ResponseWriter, r *http.Request, message string) {
    ErrorResponse(w, r, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", message)
}
```

### Domain Errors

`DomainError` wraps a sentinel error via `Unwrap` so callers can use `errors.Is` to match error categories without inspecting the concrete type. Constructor functions like `NewNotFoundError` encode resource and ID into the message at the point of creation, keeping handler code free of string formatting logic.

```go
// ... imports omitted for brevity (errors, fmt)

// Domain error types
var (
    ErrNotFound     = errors.New("not found")
    ErrConflict     = errors.New("conflict")
    ErrUnauthorized = errors.New("unauthorized")
    ErrForbidden    = errors.New("forbidden")
    ErrValidation   = errors.New("validation error")
)

// DomainError wraps errors with additional context
type DomainError struct {
    Err      error
    Code     string
    Message  string
    Resource string
    Field    string
}

func (e *DomainError) Error() string {
    if e.Message != "" {
        return e.Message
    }
    return e.Err.Error()
}

func (e *DomainError) Unwrap() error {
    return e.Err
}

// Error constructors
func NewNotFoundError(resource, id string) *DomainError {
    return &DomainError{
        Err:      ErrNotFound,
        Code:     "NOT_FOUND",
        Message:  fmt.Sprintf("%s with ID %s not found", resource, id),
        Resource: resource,
    }
}

func NewConflictError(resource, field, value string) *DomainError {
    return &DomainError{
        Err:      ErrConflict,
        Code:     "ALREADY_EXISTS",
        Message:  fmt.Sprintf("%s with %s '%s' already exists", resource, field, value),
        Resource: resource,
        Field:    field,
    }
}

func NewValidationError(field, message string) *DomainError {
    return &DomainError{
        Err:     ErrValidation,
        Code:    "VALIDATION_ERROR",
        Message: message,
        Field:   field,
    }
}

func NewUnauthorizedError(message string) *DomainError {
    return &DomainError{
        Err:     ErrUnauthorized,
        Code:    "UNAUTHORIZED",
        Message: message,
    }
}

func NewForbiddenError(message string) *DomainError {
    return &DomainError{
        Err:     ErrForbidden,
        Code:    "FORBIDDEN",
        Message: message,
    }
}
```

### Error Mapping

`MapErrorToResponse` first tries `errors.As` for structured `DomainError` values, then falls back to `errors.Is` for plain sentinel errors, covering both the rich and minimal error paths in a single translation layer. This keeps HTTP status code selection out of service code and centralizes the mapping in one place that is easy to audit and extend.

```go
// ... imports omitted for brevity (errors, log/slog, net/http)

// MapErrorToResponse converts domain errors to HTTP responses
func MapErrorToResponse(w http.ResponseWriter, r *http.Request, err error) {
    var domainErr *DomainError
    if errors.As(err, &domainErr) {
        mapDomainError(w, r, domainErr)
        return
    }

    // Check for standard errors
    switch {
    case errors.Is(err, ErrNotFound):
        NotFound(w, r, "")
    case errors.Is(err, ErrConflict):
        Conflict(w, r, err.Error())
    case errors.Is(err, ErrUnauthorized):
        Unauthorized(w, r, err.Error())
    case errors.Is(err, ErrForbidden):
        Forbidden(w, r, err.Error())
    case errors.Is(err, ErrValidation):
        // 422, matching mapDomainError below. A validation failure must not
        // return 400 down one path and 422 down another.
        ErrorResponse(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
    default:
        // Log unexpected error
        slog.Error("unexpected error", "error", err, "request_id", GetRequestID(r.Context()))
        InternalError(w, r)
    }
}

func mapDomainError(w http.ResponseWriter, r *http.Request, err *DomainError) {
    switch {
    case errors.Is(err.Err, ErrNotFound):
        NotFound(w, r, err.Resource)
    case errors.Is(err.Err, ErrConflict):
        Conflict(w, r, err.Message)
    case errors.Is(err.Err, ErrUnauthorized):
        Unauthorized(w, r, err.Message)
    case errors.Is(err.Err, ErrForbidden):
        Forbidden(w, r, err.Message)
    case errors.Is(err.Err, ErrValidation):
        if err.Field != "" {
            ValidationErrorResponse(w, r, []ErrorDetail{{
                Field:   err.Field,
                Code:    err.Code,
                Message: err.Message,
            }})
        } else {
            ErrorResponse(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Message)
        }
    default:
        InternalError(w, r)
    }
}
```

### Junior → FAANG: echoing values, leaking secrets, and other beginner traps

The `ErrorDetail.Value` field echoes the invalid value back to the client. That sounds helpful and is the single most common source of accidental credential leaks in validation code. If a user submits `{"password": "hunter2"}` and your validator rejects it as too short, echoing `"hunter2"` into the response logs it through every proxy, CDN, and APM agent in the request path. The rule: never echo values for fields that are or could be sensitive (passwords, tokens, card numbers, SSNs, anything tagged as PII). A safe default is to echo only for fields explicitly allow-listed as non-sensitive, and to truncate or redact everything else. The senior reviewer will catch this in every junior PR.

The worked example for this section: your error response includes `trace_id`. A junior asks "where does the trace ID come from." The answer is the OpenTelemetry context. The full trace is: `httptrace` or a middleware extracts `traceparent` from the incoming request, `otel` propagates it through `context.Context`, your logger writes it into every log line, and your error handler copies it into the response body. The trace ID is what turns a user screenshot ("I got error FOOBAR at 10:42") into a clickable link that a support engineer can paste into Grafana or Honeycomb to see exactly what happened. Get this pipeline right on day one because retrofitting it is painful.

Interview entry-point for this topic: "design an error envelope for a new public API." Walk through `type`, `title`, `status`, `detail`, `instance` from RFC 9457, add `errors` for field-level details, add a `trace_id` extension, and defend each field. Say the phrase "Problem Details for HTTP APIs" and the interviewer will know you have read the RFC. Say the phrase "stable machine-readable code" and they will know you have debugged production.

### Senior @ FAANG: RFC 9457, error catalogs, and governance at scale

RFC 9457 is non-negotiable for a new public API in 2026. The structure above is a superset, but many staff engineers skip the mapping and emit problem+json directly. Go has no single blessed library here. `github.com/moogar0880/problems` covers both RFC 7807 and RFC 9457 and defines the `application/problem+json` and `application/problem+xml` media types as constants, but the type is small enough that most teams hand-roll it rather than take the dependency. The `type` field is a URI. Do not use `about:blank`. Register each problem class at a stable URL under your documentation, for example `https://errors.example.com/validation-failed`. That URL must resolve to a page that documents the problem, lists the extension members, and gives remediation steps. Over time the catalog of URIs becomes your error contract with clients, and the URIs become part of your SDK generation pipeline.

Error catalog governance is a staff-level artifact. Maintain the catalog as a versioned file (YAML, CUE, or TOML) in a shared repository. Each entry has a URI, a short code (`VALIDATION_FAILED`), an HTTP status, a default title, translation keys, a deprecation flag, and a "since version" marker. Generate Go constants, TypeScript enums, and OpenAPI components from this file so every consumer sees the same truth. Treat catalog changes as API changes: additions are minor version bumps, changes to existing codes are major version bumps, and deletions require a deprecation period. Stripe's error documentation is the industry exemplar of this practice, and GitHub's X-GitHub-Request-Id header plus machine-readable error codes is another. Both were built to the same pattern, both took years to stabilize, and both teams would tell you to start on day one rather than refactor later.

The `MapErrorToResponse` function above is where most production Go services quietly go wrong. The switch-on-sentinel-error pattern is idiomatic but it has two failure modes at scale. First, it couples the edge to domain error types. When a new domain package adds `ErrRateLimited`, the mapper must learn about it, which means the mapper becomes a bottleneck that every team must touch. Second, it does not compose. If a domain error wraps a repository error wraps a database error, `errors.Is` walks the chain and matches the first sentinel, but the resulting HTTP status is chosen from that one match, losing the nuance of the full chain. The staff-level fix is to make domain errors implement a small interface: `type HTTPCoder interface { HTTPStatus() int; ErrorCode() string }`. The mapper does `errors.As` for that interface and asks the error to describe itself. Adding a new error type becomes a local change with no edge-layer edit. This is the open-closed principle applied to error mapping, and it is the single most valuable refactor available in most mature Go services.

The trace-id correlation deserves explicit discussion. Under OpenTelemetry, the correct pattern is to extract the span from context with `trace.SpanFromContext(ctx)`, read `span.SpanContext().TraceID()`, and write that hex string into the response. Do not generate a fresh UUID as your `request_id` unless there is no active span, and never conflate request IDs with trace IDs. Set both in the response so that clients can correlate with either your logs (request ID) or your traces (trace ID) without ambiguity. If you want the trace ID in a header as well as the body, note that `traceresponse` is not part of W3C Trace Context. It is a separate and still unfinished W3C work item (Trace Response Headers), so treat it as optional and do not build anything load-bearing on it.

i18n integration with error responses is where most teams take a shortcut that hurts later. Do not localize the `title` or `detail` at the point the error is constructed. Construct with code and parameters, let the HTTP response serializer resolve to `Accept-Language` at the last moment, and serve a `Content-Language` header in the response. This gives you per-request locale selection, lets admins override via a query parameter for debugging, and lets you A/B test message wording without touching validators. The serializer owns the `golang.org/x/text/message.Printer` and the catalog file, and the catalog file is version-controlled alongside the error catalog described above.

One last staff-level note on observability: 4xx responses are part of your error budget or they are not, and that decision shapes on-call culture. Most SRE teams exclude 4xx from SLO calculations because they reflect client behavior, but 422 spikes often indicate a client-side regression or a contract drift that should wake somebody up. The fix is to track 4xx rate as a separate SLI with its own threshold, and to alert on sudden deltas rather than absolute levels. Pair that with structured logs that index `error.code` so you can answer "which validation rule is firing most today" in a dashboard rather than grepping logs. This is what separates a team that ships error handling from a team that ships error handling and knows when it breaks.

---
