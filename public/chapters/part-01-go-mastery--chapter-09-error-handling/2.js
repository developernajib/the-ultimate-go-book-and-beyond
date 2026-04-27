export default `## 9.1 The Error Interface

The \`error\` type is Go's most fundamental interface:

\`\`\`go
type error interface {
    Error() string
}
\`\`\`

Any type with an \`Error() string\` method implements \`error\`. This simplicity is intentional, it allows errors to be values that can be inspected, passed around, and stored.

### Why Errors Are Values

In languages like Java, Python, or JavaScript, errors are exceptions that interrupt normal control flow. Go takes a different approach: errors are just values returned from functions. Because errors are ordinary values, they support the same operations as any other type, assignment, comparison, function parameters, and storage in data structures:

\`\`\`go
// Errors can be stored
var lastError error

// Errors can be compared
if err == io.EOF {
    // ...
}

// Errors can be passed to functions
func logError(err error) {
    // ...
}

// Errors can be returned from functions (obviously)
func doSomething() error {
    return nil
}
\`\`\`

### Basic Error Handling

The canonical Go error handling pattern:

\`\`\`go
result, err := someFunction()
if err != nil {
    return err
}
// use result
\`\`\`

This pattern appears thousands of times in Go programs. While some find it verbose, it has significant advantages:

1. **Visibility**: Every potential failure point is visible
2. **Control**: You decide how to handle each error
3. **No hidden costs**: No runtime exception machinery
4. **Debugging**: Error paths are easy to trace

### Creating Errors

Go provides two standard ways to create simple errors: \`errors.New\` for static string errors and \`fmt.Errorf\` for formatted errors with optional wrapping via the \`%w\` verb.

\`\`\`go
import "errors"

// Simple error
err := errors.New("something went wrong")

// Formatted error
err := fmt.Errorf("failed to process %s: invalid format", filename)

// From a constant (for testing and comparison)
const ErrInvalidInput = constError("invalid input")

type constError string

func (e constError) Error() string { return string(e) }
\`\`\`

### Custom Error Types

Custom error types carry additional information:

\`\`\`go
type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func validate(email string) error {
    if !strings.Contains(email, "@") {
        return ValidationError{
            Field:   "email",
            Message: "must contain @",
        }
    }
    return nil
}
\`\`\`

### Error Type Design Considerations

The choice between pointer and value receivers on error types affects how errors behave when compared, copied, and passed through the error chain. Pointer receivers are necessary when the error wraps another error (since \`Unwrap\` returns a reference to the inner error), while value receivers work well for small, self-contained errors.

\`\`\`go
// Pointer receiver - can be nil, mutable
type ConfigError struct {
    Path string
    Err  error
}

func (e *ConfigError) Error() string {
    return fmt.Sprintf("config %s: %v", e.Path, e.Err)
}

// Value receiver - copied, immutable
type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}
\`\`\`

**Use pointer receivers when:**
- Error contains wrapped error (for \`Unwrap\`)
- Error is large (avoid copying)
- Error needs to be mutable

**Use value receivers when:**
- Error is small (2-3 fields)
- Error doesn't wrap other errors
- Immutability is desired

### Error as Observability Surface

For a senior engineer, every error message eventually appears in a log aggregator, a metrics label, or an incident ticket. The discipline:

1. **Error messages are retained.** Treat them as observability data, not user-facing strings.
2. **Error messages must not leak secrets.** Passwords, tokens, PII. The reviewer's job is to catch this.
3. **Error messages should be parseable.** Structured prefixes (\`service: operation: ...\`) make log queries easier.

---
`;
