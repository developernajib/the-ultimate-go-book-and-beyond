export default `## 9.2 Error Wrapping

Go 1.13 introduced error wrapping for adding context while preserving the original error.

### Wrapping with %w

The \`%w\` verb in \`fmt.Errorf\` wraps an error, preserving the original in the chain. Callers can then use \`errors.Is\` and \`errors.As\` to inspect the chain without direct type assertions.

\`\`\`go
func readConfig(path string) (Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return Config{}, fmt.Errorf("reading config %s: %w", path, err)
    }

    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        return Config{}, fmt.Errorf("parsing config: %w", err)
    }

    return cfg, nil
}

// Error message: "reading config /etc/app.json: open /etc/app.json: no such file or directory"
\`\`\`

### The Unwrap Method

Custom error types that wrap an inner error should implement an \`Unwrap() error\` method. This method returns the next error in the chain, allowing \`errors.Is\` and \`errors.As\` to traverse through layers of wrapping to find a specific sentinel or type.

\`\`\`go
type QueryError struct {
    Query string
    Err   error
}

func (e *QueryError) Error() string {
    return fmt.Sprintf("query %q: %v", e.Query, e.Err)
}

func (e *QueryError) Unwrap() error {
    return e.Err
}
\`\`\`

### errors.Unwrap

\`errors.Unwrap\` returns the next error in the chain, enabling manual traversal of wrapped errors. \`errors.Is\` and \`errors.As\` use this internally to walk the complete error chain.

\`\`\`go
err := fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", io.EOF))

// Unwrap one level
inner := errors.Unwrap(err)
fmt.Println(inner)  // "inner: EOF"

// Unwrap again
innermost := errors.Unwrap(inner)
fmt.Println(innermost)  // "EOF"
\`\`\`

### errors.Is

\`errors.Is\` checks whether any error in the chain matches a target value. It walks the chain by calling \`Unwrap\` repeatedly, comparing each error to the target. This replaces direct \`==\` comparisons, which break as soon as an error is wrapped.

\`\`\`go
if errors.Is(err, os.ErrNotExist) {
    // File doesn't exist - handle gracefully
    return useDefault()
}

if errors.Is(err, io.EOF) {
    // End of input - not an error
    break
}

if errors.Is(err, context.Canceled) {
    // Request was canceled - stop processing
    return nil
}
\`\`\`

### errors.As

\`errors.As\` finds the first error in the chain that can be assigned to a target pointer. Unlike \`errors.Is\` which checks value equality, \`errors.As\` checks type compatibility and populates the target variable with the matched error, giving you access to its fields and methods.

\`\`\`go
var pathErr *os.PathError
if errors.As(err, &pathErr) {
    fmt.Printf("Failed operation: %s\\n", pathErr.Op)
    fmt.Printf("Failed path: %s\\n", pathErr.Path)
}

var validErr ValidationError
if errors.As(err, &validErr) {
    fmt.Printf("Invalid field: %s\\n", validErr.Field)
}

var netErr net.Error
if errors.As(err, &netErr) {
    if netErr.Timeout() {
        // Handle timeout specifically
    }
}
\`\`\`

### Implementing Is and As

Custom error types can override the default matching logic by implementing an \`Is(target error) bool\` method. This allows partial matching, for example, treating two \`NotFoundError\` values as equal if they refer to the same resource type, regardless of the specific ID.

\`\`\`go
type NotFoundError struct {
    Resource string
    ID       string
}

func (e NotFoundError) Error() string {
    return fmt.Sprintf("%s %q not found", e.Resource, e.ID)
}

// Implement Is for custom matching
func (e NotFoundError) Is(target error) bool {
    if t, ok := target.(NotFoundError); ok {
        // Match if same resource type (ID can differ)
        return e.Resource == t.Resource
    }
    return false
}

// Usage
err := NotFoundError{Resource: "user", ID: "123"}
target := NotFoundError{Resource: "user", ID: "456"}
errors.Is(err, target)  // true (same resource type)

// Also matches wrapped errors
wrapped := fmt.Errorf("service: %w", err)
errors.Is(wrapped, target)  // true
\`\`\`

### Multi-Error Wrapping (Go 1.20+)

Go 1.20 added support for errors that wrap multiple errors simultaneously. An error type can implement \`Unwrap() []error\` (returning a slice instead of a single error), and \`errors.Is\` and \`errors.As\` will search all branches of the resulting error tree.

\`\`\`go
type MultiError struct {
    Errors []error
}

func (m MultiError) Error() string {
    var b strings.Builder
    for i, err := range m.Errors {
        if i > 0 {
            b.WriteString("; ")
        }
        b.WriteString(err.Error())
    }
    return b.String()
}

// Implement Unwrap to return slice of errors
func (m MultiError) Unwrap() []error {
    return m.Errors
}

// errors.Is checks all wrapped errors
err := MultiError{Errors: []error{io.EOF, os.ErrNotExist}}
errors.Is(err, io.EOF)        // true
errors.Is(err, os.ErrNotExist) // true
\`\`\`

### Wrap Discipline

Three rules for a senior engineer reviewing error-wrap PRs:

1. **Wrap once per meaningful boundary.** Ten layers of \`fmt.Errorf("wrap: %w", err)\` is noise. Wrap when crossing a package, subsystem, or request boundary.
2. **Wrap with context, not noise.** \`fmt.Errorf("authenticating user %s: %w", username, err)\` adds value. \`fmt.Errorf("error: %w", err)\` adds nothing.
3. **Prefer \`%w\` over \`%v\` for inspectable errors.** If a caller might reasonably use \`errors.Is\`, preserve the chain.

---
`;
