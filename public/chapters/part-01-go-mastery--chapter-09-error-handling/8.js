export default `## 9.7 Error Handling at Scale

### Structured Errors for Production

Production services need error codes that map to HTTP status codes, gRPC status codes, or message queue dead-letter classifications. A typed \`ErrorCode\` with a \`HTTPStatus()\` method centralizes this mapping so every handler produces consistent responses without per-endpoint switch statements.

\`\`\`go
// codes.go - Error code definitions
type ErrorCode string

const (
    CodeUnknown          ErrorCode = "UNKNOWN"
    CodeInvalidArgument  ErrorCode = "INVALID_ARGUMENT"
    CodeNotFound         ErrorCode = "NOT_FOUND"
    CodeAlreadyExists    ErrorCode = "ALREADY_EXISTS"
    CodePermissionDenied ErrorCode = "PERMISSION_DENIED"
    CodeUnauthenticated  ErrorCode = "UNAUTHENTICATED"
    CodeResourceExhausted ErrorCode = "RESOURCE_EXHAUSTED"
    CodeFailedPrecondition ErrorCode = "FAILED_PRECONDITION"
    CodeAborted          ErrorCode = "ABORTED"
    CodeOutOfRange       ErrorCode = "OUT_OF_RANGE"
    CodeUnimplemented    ErrorCode = "UNIMPLEMENTED"
    CodeInternal         ErrorCode = "INTERNAL"
    CodeUnavailable      ErrorCode = "UNAVAILABLE"
    CodeDeadlineExceeded ErrorCode = "DEADLINE_EXCEEDED"
    CodeCanceled         ErrorCode = "CANCELED"
)

func (c ErrorCode) HTTPStatus() int {
    switch c {
    case CodeInvalidArgument, CodeOutOfRange:
        return http.StatusBadRequest
    case CodeNotFound:
        return http.StatusNotFound
    case CodeAlreadyExists, CodeAborted:
        return http.StatusConflict
    case CodePermissionDenied:
        return http.StatusForbidden
    case CodeUnauthenticated:
        return http.StatusUnauthorized
    case CodeResourceExhausted:
        return http.StatusTooManyRequests
    case CodeFailedPrecondition:
        return http.StatusPreconditionFailed
    case CodeUnimplemented:
        return http.StatusNotImplemented
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
\`\`\`

### Domain-Specific Error Types

Domain-specific error types carry the vocabulary of the business domain rather than generic HTTP or infrastructure concepts. This isolates the domain layer from transport-layer concerns.

\`\`\`go
// errors.go - Application error type
type AppError struct {
    Code       ErrorCode         \`json:"code"\`
    Message    string            \`json:"message"\`
    Details    []ErrorDetail     \`json:"details,omitempty"\`
    Internal   error             \`json:"-"\` // Never expose to client
    Stack      string            \`json:"-"\` // For debugging
    RequestID  string            \`json:"request_id,omitempty"\`
    Timestamp  time.Time         \`json:"timestamp"\`
}

type ErrorDetail struct {
    Field       string \`json:"field,omitempty"\`
    Description string \`json:"description"\`
    Value       any    \`json:"value,omitempty"\`
}

func (e *AppError) Error() string {
    if e.Internal != nil {
        return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Internal)
    }
    return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error {
    return e.Internal
}

func (e *AppError) Is(target error) bool {
    if t, ok := target.(*AppError); ok {
        return e.Code == t.Code
    }
    return false
}

func (e *AppError) WithDetail(field, description string) *AppError {
    e.Details = append(e.Details, ErrorDetail{
        Field:       field,
        Description: description,
    })
    return e
}

func (e *AppError) WithStack() *AppError {
    e.Stack = string(debug.Stack())
    return e
}
\`\`\`

### Error Response Mapping

A centralized error response mapper translates domain errors to HTTP responses, ensuring consistent status codes and response shapes across all endpoints without scattering mapping logic through handlers.

\`\`\`go
// response.go - HTTP error response handler
type ErrorResponse struct {
    Error ErrorBody \`json:"error"\`
}

type ErrorBody struct {
    Code      string        \`json:"code"\`
    Message   string        \`json:"message"\`
    Details   []ErrorDetail \`json:"details,omitempty"\`
    RequestID string        \`json:"request_id,omitempty"\`
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
    var appErr *AppError
    if !errors.As(err, &appErr) {
        // Convert unknown errors to internal error
        appErr = &AppError{
            Code:      CodeInternal,
            Message:   "An unexpected error occurred",
            Internal:  err,
            Timestamp: time.Now(),
        }
    }

    // Set request ID from context
    if reqID := r.Context().Value(RequestIDKey); reqID != nil {
        appErr.RequestID = reqID.(string)
    }

    // Log the error
    logError(r.Context(), appErr)

    // Write response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(appErr.Code.HTTPStatus())
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

### Error Logging with Context

Structured error logging with request-scoped context fields (request ID, user ID, trace ID) makes individual errors traceable back to the originating request.

\`\`\`go
// logging.go - Structured error logging
func logError(ctx context.Context, err *AppError) {
    fields := map[string]any{
        "error_code":    err.Code,
        "error_message": err.Message,
        "timestamp":     err.Timestamp,
    }

    // Add request context
    if reqID := ctx.Value(RequestIDKey); reqID != nil {
        fields["request_id"] = reqID
    }
    if userID := ctx.Value(UserIDKey); userID != nil {
        fields["user_id"] = userID
    }

    // Add internal error details (not exposed to client)
    if err.Internal != nil {
        fields["internal_error"] = err.Internal.Error()
        fields["error_type"] = fmt.Sprintf("%T", err.Internal)

        // Build error chain
        var chain []string
        for e := err.Internal; e != nil; e = errors.Unwrap(e) {
            chain = append(chain, fmt.Sprintf("%T: %s", e, e.Error()))
        }
        fields["error_chain"] = chain
    }

    // Add stack trace for internal errors
    if err.Code == CodeInternal && err.Stack != "" {
        fields["stack_trace"] = err.Stack
    }

    // Log based on severity
    if err.Code == CodeInternal {
        slog.Error("Internal error", slog.Any("fields", fields))
    } else {
        slog.Warn("Application error", slog.Any("fields", fields))
    }
}
\`\`\`

### Org-Wide Error Envelope

For a senior engineer owning cross-service contracts, the error envelope is a shared schema: error code enum, user-safe message, request ID, diagnostic detail. Define once, use everywhere. The team that does this has consistent incident diagnosis. The team that does not spends time translating between service-specific error shapes.

---
`;
