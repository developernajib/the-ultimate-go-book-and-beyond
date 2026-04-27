export default `## 9.5 Error Types

When a sentinel error is not enough, when the caller needs to know *which* query failed, how long it took, or what field was invalid, a custom error type carries that structured data alongside the error message. The caller extracts it with \`errors.As\` and uses the fields for logging, retries, or user-facing responses.

\`\`\`go
type QueryError struct {
    Query   string
    Err     error
    Latency time.Duration
}

func (e *QueryError) Error() string {
    return fmt.Sprintf("query %q failed after %v: %v", e.Query, e.Latency, e.Err)
}

func (e *QueryError) Unwrap() error {
    return e.Err
}

func executeQuery(query string) error {
    start := time.Now()
    err := db.Exec(query)
    if err != nil {
        return &QueryError{
            Query:   query,
            Err:     err,
            Latency: time.Since(start),
        }
    }
    return nil
}

// Usage with errors.As
var qerr *QueryError
if errors.As(err, &qerr) {
    log.Printf("Query failed: %s (took %v)", qerr.Query, qerr.Latency)
    if errors.Is(qerr, sql.ErrConnDone) {
        // Reconnect and retry
    }
}
\`\`\`

### Rich Error Types for APIs

Public APIs benefit from structured error types that carry HTTP status codes, error codes, and contextual metadata. This allows API handlers to produce consistent, machine-readable error responses.

\`\`\`go
type APIError struct {
    Code       string            \`json:"code"\`
    Message    string            \`json:"message"\`
    Details    map[string]any    \`json:"details,omitempty"\`
    HTTPStatus int               \`json:"-"\`
    Err        error             \`json:"-"\`
    RequestID  string            \`json:"request_id,omitempty"\`
    Timestamp  time.Time         \`json:"timestamp"\`
}

func (e *APIError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
    }
    return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *APIError) Unwrap() error {
    return e.Err
}

// Implement Is for code-based matching
func (e *APIError) Is(target error) bool {
    if t, ok := target.(*APIError); ok {
        return e.Code == t.Code
    }
    return false
}

// Constructors for common errors
func NewNotFoundError(resource string, id any) *APIError {
    return &APIError{
        Code:       "NOT_FOUND",
        Message:    fmt.Sprintf("%s not found", resource),
        Details:    map[string]any{"resource": resource, "id": id},
        HTTPStatus: http.StatusNotFound,
        Timestamp:  time.Now(),
    }
}

func NewValidationError(field, message string) *APIError {
    return &APIError{
        Code:       "VALIDATION_ERROR",
        Message:    "Request validation failed",
        Details:    map[string]any{"field": field, "message": message},
        HTTPStatus: http.StatusBadRequest,
        Timestamp:  time.Now(),
    }
}

func NewInternalError(err error) *APIError {
    return &APIError{
        Code:       "INTERNAL_ERROR",
        Message:    "An internal error occurred",
        HTTPStatus: http.StatusInternalServerError,
        Err:        err,
        Timestamp:  time.Now(),
    }
}
\`\`\`

### Error Types vs Sentinel Errors

| Sentinel Errors | Error Types |
|-----------------|-------------|
| Simple conditions | Rich context |
| Package-level variables | Exported struct types |
| Compare with \`errors.Is\` | Extract with \`errors.As\` |
| No additional data | Carry extra information |
| \`var ErrNotFound = errors.New(...)\` | \`type NotFoundError struct{...}\` |
| Cheap to create | May allocate memory |

### Typed Error Design

A typed error is a public API. Design the fields carefully:

1. **Include enough data for the caller to act on.** A \`ValidationError\` with \`Field\` and \`Reason\` is useful. One with just \`Reason\` is less useful.
2. **Do not include sensitive data.** Stacktraces, secrets, PII. These end up in log aggregators.
3. **Implement \`Error() string\` to produce a useful human message.** This is what \`log.Println(err)\` will print.

---
`;
