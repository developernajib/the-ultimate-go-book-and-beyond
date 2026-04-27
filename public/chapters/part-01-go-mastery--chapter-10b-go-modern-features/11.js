export default `## 10B.9 errors.AsType[T] (Go 1.26)

### Generic Error Type Assertion

Go 1.26 adds \`errors.AsType[T]\`, a generic companion to \`errors.As\` that returns the extracted error value directly instead of requiring a pre-declared pointer variable. The result is shorter, more readable code, especially when you only need the typed error inside a single \`if\` block.

\`\`\`go
// Before (Go 1.25 and earlier):
var pathErr *fs.PathError
if errors.As(err, &pathErr) {
    fmt.Println("path:", pathErr.Path)
}

// After (Go 1.26+):
if pathErr, ok := errors.AsType[*fs.PathError](err); ok {
    fmt.Println("path:", pathErr.Path)
}
// No need to declare a variable before the if statement
// More idiomatic for inline use

// Before:
var httpErr *HTTPError
if errors.As(err, &httpErr) {
    return httpErr.StatusCode
}
return 500

// After:
if httpErr, ok := errors.AsType[*HTTPError](err); ok {
    return httpErr.StatusCode
}
return 500
\`\`\`

### Practical Usage

The following example shows \`errors.AsType[T]\` replacing the common \`errors.As\` pattern, making the type-assertion intent explicit and reducing boilerplate.

\`\`\`go
// HTTP error handling with errors.AsType
type HTTPError struct {
    StatusCode int
    Message    string
}
func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Message)
}

// Database error handling
type ConstraintError struct {
    Constraint string
    Table      string
}
func (e *ConstraintError) Error() string {
    return fmt.Sprintf("constraint violation on %s.%s", e.Table, e.Constraint)
}

// Error handler using errors.AsType
func handleServiceError(err error) (statusCode int, message string) {
    switch {
    case errors.Is(err, context.DeadlineExceeded):
        return 504, "request timeout"
    case errors.Is(err, context.Canceled):
        return 499, "client disconnected"
    }

    // Type-safe error extraction - Go 1.26
    if httpErr, ok := errors.AsType[*HTTPError](err); ok {
        return httpErr.StatusCode, httpErr.Message
    }
    if constraintErr, ok := errors.AsType[*ConstraintError](err); ok {
        if constraintErr.Constraint == "unique_email" {
            return 409, "email already exists"
        }
        return 422, "data constraint violation"
    }

    return 500, "internal server error"
}
\`\`\`

---
`;
