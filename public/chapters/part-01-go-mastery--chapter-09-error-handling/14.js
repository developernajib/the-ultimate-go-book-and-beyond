export default `## 9.13 Interview Questions

Error-handling questions are nearly universal in FAANG Go interviews. Interviewers use them to check whether you can defend Go's design without either reciting dogma or complaining about the boilerplate, and whether you have production instincts for wrapping, sentinel errors, and typed error handling.

> **What FAANG actually tests here**: whether you can read error flow from code, pick between \`errors.Is\`, \`errors.As\`, and \`errors.Join\` appropriately, and recognize the common production bugs (typed-nil returns, ignored close errors, swallowed context in wrapping).

### Question 1: Why doesn't Go have exceptions?

**What FAANG expects**: an honest tradeoff answer that names the cost (boilerplate, visual noise) alongside the payoff (visible failure paths, no hidden control flow, auditability). Candidates who dismiss the cost or the payoff usually score below senior bar.

**Answer:**
Go's designers chose explicit error returns over exceptions for several reasons:

1. **Visibility**: Every potential failure point is visible in the code. You can't accidentally ignore errors without explicitly using \`_\`.

2. **Control flow clarity**: Exceptions create invisible control flow paths. With errors as values, the flow is always explicit.

3. **Performance**: Exception handling requires runtime support for stack unwinding, which adds overhead even when no error occurs.

4. **Simplicity**: The error interface (\`Error() string\`) is trivial to implement, making it easy to create custom error types.

5. **Forcing handling**: While you can ignore errors, the explicit return value makes it obvious when you do.

\`\`\`go
// Compare to Java where errors are invisible:
// user = getUser(123);  // Might throw, might not - who knows?

// In Go, errors are always visible:
user, err := getUser(123)  // Obviously can fail
if err != nil {
    // Must handle
}
\`\`\`

**Follow-ups**:
- The Go team has rejected several error-handling syntax proposals. Name one and explain the objection.
- When is \`panic\` the right tool instead of returning an error?

### Question 2: When should you use errors.Is vs errors.As?

**What FAANG expects**: correct semantics for each (value comparison vs type extraction), awareness that both walk the wrapped chain via \`Unwrap\`, and knowledge that \`errors.Join\` combines multiple errors into a single error whose \`Is\`/\`As\` work against any of its components.

**Answer:**

**errors.Is** - Check if an error matches a specific value (sentinel error):
\`\`\`go
if errors.Is(err, os.ErrNotExist) {
    // File doesn't exist
}

if errors.Is(err, context.Canceled) {
    // Request was canceled
}
\`\`\`

**errors.As** - Extract a specific error type to access its fields:
\`\`\`go
var pathErr *os.PathError
if errors.As(err, &pathErr) {
    fmt.Printf("Operation: %s, Path: %s\\n", pathErr.Op, pathErr.Path)
}

var netErr net.Error
if errors.As(err, &netErr) {
    if netErr.Timeout() {
        // Handle timeout
    }
}
\`\`\`

Key difference: \`Is\` checks equality, \`As\` extracts type. Both work through wrapped error chains. \`errors.Join\` (Go 1.20+) combines multiple errors, and \`errors.Is\`/\`errors.As\` transparently walk all joined errors looking for a match. This is what \`errgroup\` and parallel workers return when several goroutines fail.

**Follow-ups**:
- How would you implement a custom \`Is\` method on an error type so that all errors of a given resource type match a single sentinel?
- What is \`errors.Unwrap\`, and when would you call it directly instead of using \`Is\`/\`As\`?

### Question 3: How would you design an error handling system for a microservices architecture?

**What FAANG expects**: gRPC status codes or equivalent canonical taxonomy, trace context propagation, retryable classification, and awareness that the server-side error message should not leak internal details to the client.

**Answer:**

1. **Standardized error codes**: Use consistent codes across services (like gRPC status codes)

2. **Error propagation**: Include request IDs and trace IDs in errors

3. **Error classification**: Categorize errors as retryable vs non-retryable

4. **Structured logging**: Log errors with consistent fields

5. **Error aggregation**: Collect errors for monitoring (e.g., error budgets)

\`\`\`go
type ServiceError struct {
    Code       ErrorCode
    Message    string
    Service    string    // Which service originated the error
    RequestID  string    // For distributed tracing
    TraceID    string
    Retryable  bool
    Details    map[string]any
}

func (e *ServiceError) Error() string {
    return fmt.Sprintf("[%s] %s: %s", e.Service, e.Code, e.Message)
}

// Propagate errors between services
func PropagateError(err error, service string) *ServiceError {
    var svcErr *ServiceError
    if errors.As(err, &svcErr) {
        // Preserve original error, add current service
        return &ServiceError{
            Code:      svcErr.Code,
            Message:   fmt.Sprintf("%s -> %s", svcErr.Message, service),
            Service:   svcErr.Service,
            RequestID: svcErr.RequestID,
            Retryable: svcErr.Retryable,
        }
    }
    // Wrap unknown error
    return &ServiceError{
        Code:    CodeInternal,
        Message: err.Error(),
        Service: service,
    }
}
\`\`\`

**Follow-ups**:
- How do you avoid leaking stack traces or SQL fragments to external clients while preserving them for operators?
- When is it appropriate to translate between service-level error codes and HTTP status codes, and who owns that translation?

### Question 4: What's wrong with this error handling code?

**What FAANG expects**: three distinct bugs (ignored close error, missing error context, no path in wrapping), plus the named-return pattern that lets the deferred close observe and update the return value.

The following code contains a subtle but consequential error handling mistake. Reading it carefully before reviewing the answer develops the code review intuition needed to catch similar issues in production.

\`\`\`go
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    data, err := io.ReadAll(f)
    if err != nil {
        return err
    }

    return process(data)
}
\`\`\`

**Answer:**

Several issues:

1. **No context**: Errors are returned without wrapping, making debugging difficult

2. **Close error ignored**: \`defer f.Close()\` ignores the close error

3. **No file path in error**: If it fails, you don't know which file

**Fixed version:**
\`\`\`go
func processFile(path string) (err error) {
    f, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open %s: %w", path, err)
    }
    defer func() {
        if closeErr := f.Close(); closeErr != nil && err == nil {
            err = fmt.Errorf("close %s: %w", path, closeErr)
        }
    }()

    data, err := io.ReadAll(f)
    if err != nil {
        return fmt.Errorf("read %s: %w", path, err)
    }

    if err := process(data); err != nil {
        return fmt.Errorf("process %s: %w", path, err)
    }

    return nil
}
\`\`\`

**Follow-ups**:
- What is the difference between \`%w\` and \`%v\` when formatting errors with \`fmt.Errorf\`?
- When is it acceptable to ignore a \`Close\` error, for example on a read-only file?

### Question 5: How does errors.Is work with custom error types?

**What FAANG expects**: correct semantics of the optional \`Is(target error) bool\` method, the \`Unwrap\` convention, and awareness that \`Is\` is for value-equivalence checks while \`As\` is for typed extraction.

**Answer:**

By default, \`errors.Is\` compares errors by equality. Custom errors can override this by implementing the \`Is\` method:

\`\`\`go
type NotFoundError struct {
    Resource string
    ID       string
}

func (e NotFoundError) Error() string {
    return fmt.Sprintf("%s %s not found", e.Resource, e.ID)
}

// Custom Is implementation - match by resource type only
func (e NotFoundError) Is(target error) bool {
    if t, ok := target.(NotFoundError); ok {
        // Match if same resource type, regardless of ID
        return e.Resource == t.Resource
    }
    return false
}

// Usage
err := NotFoundError{Resource: "user", ID: "123"}
target := NotFoundError{Resource: "user", ID: "456"}

errors.Is(err, target)  // true - same resource type

// Also works through wrapping
wrapped := fmt.Errorf("service: %w", err)
errors.Is(wrapped, target)  // true
\`\`\`

**Follow-ups**:
- When would an error type implement both \`Is\` and \`Unwrap\`? What order does \`errors.Is\` call them in?
- How does \`errors.Join\`'s multi-error value interact with a custom \`Is\` method?

### Q (Senior track): Design the error contract for a public REST API.

**What FAANG expects**: a structured answer covering error code enum, user-safe messages, request ID correlation, HTTP status mapping, and stability across versions.

**Answer**: Three layers. First, the wire format: \`{"error": {"code": "USER_NOT_FOUND", "message": "...", "request_id": "..."}}\`. Second, the Go side: a typed error with \`Code string\`, \`Message string\`, \`Cause error\`, \`Retryable bool\`, \`HTTPStatus int\`. Third, the discipline: every handler translates internal errors to this shape at the boundary, never leaks internal details, never includes sensitive data.

The stability rule: once \`USER_NOT_FOUND\` is in the public contract, removing it is a breaking change. Adding new codes is not breaking. Document the enum, version it, maintain backwards compatibility.

### Q (Senior track): How do you balance error context with log noise?

**What FAANG expects**: the insight that wrapping at every layer produces unreadable logs, and the structured-logging fix.

**Answer**: Wrap with context at meaningful boundaries (package, subsystem, transaction), not at every function call. Log once at the top of the stack (the HTTP handler, the worker's main loop) with the full error chain and structured fields. Avoid \`log.Printf("error: %v", err)\` scattered through the layers, as that produces duplicate messages and makes correlation hard. Use \`log/slog\` with structured fields for everything.

---
`;
