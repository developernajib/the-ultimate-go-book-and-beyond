export default `## 9.6 Panic and Recover

### When to Panic

\`panic\` terminates the current goroutine's execution and begins unwinding the stack, running deferred functions along the way. Reserve it for conditions that represent bugs in the program, impossible states, violated invariants, or configuration errors at startup, not for runtime failures a caller could handle.

\`\`\`go
// Good: configuration error at startup
func MustCompile(pattern string) *Regexp {
    r, err := Compile(pattern)
    if err != nil {
        panic(fmt.Sprintf("regexp: Compile(%q): %v", pattern, err))
    }
    return r
}

// Good: impossible state (indicates bug)
func process(status Status) {
    switch status {
    case Active:
        // ...
    case Inactive:
        // ...
    default:
        panic(fmt.Sprintf("unknown status: %v", status))
    }
}

// Good: violated invariant
func (s *Stack) Pop() int {
    if len(s.items) == 0 {
        panic("pop from empty stack")
    }
    // ...
}
\`\`\`

**Don't panic for:**
- Missing files
- Network errors
- Invalid user input
- Database connection failures
- Any error a caller might want to handle

### The Must Pattern

The \`Must\` pattern wraps a function that returns \`(T, error)\` and panics if the error is non-nil. It is appropriate for package-level variable initialization where failure means the program cannot run at all, compiled regular expressions, resolved file paths, or environment configuration that must be present.

\`\`\`go
var (
    emailRegex = regexp.MustCompile(\`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\$\`)
    homeDir    = must(os.UserHomeDir())
    configPath = must(filepath.Abs("config.yaml"))
)

func must[T any](v T, err error) T {
    if err != nil {
        panic(err)
    }
    return v
}
\`\`\`

### Recover

\`recover\` is a built-in function that regains control of a panicking goroutine. It only works inside a deferred function. Called anywhere else, it returns \`nil\`. The recovered value is whatever was passed to \`panic\`, which can be an \`error\`, a \`string\`, or any other type. A common pattern wraps arbitrary functions and converts panics into returned errors.

\`\`\`go
func safeExecute(fn func()) (err error) {
    defer func() {
        if r := recover(); r != nil {
            switch v := r.(type) {
            case error:
                err = fmt.Errorf("panic: %w", v)
            default:
                err = fmt.Errorf("panic: %v", v)
            }
        }
    }()

    fn()
    return nil
}
\`\`\`

### HTTP Handler Protection

A panic in an HTTP handler crashes the entire server process unless something catches it. Recovery middleware wraps \`next.ServeHTTP\` in a deferred \`recover\`, logs the panic with a stack trace, and returns a 500 response instead of killing the process. The standard library's \`net/http\` server recovers panics per-request by default, but only logs them, custom middleware gives you control over the response format and error reporting.

\`\`\`go
func recoveryMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                // Log with stack trace
                stack := debug.Stack()
                log.Printf("PANIC: %v\\n%s", err, stack)

                // Send error response
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusInternalServerError)
                json.NewEncoder(w).Encode(map[string]string{
                    "error": "Internal server error",
                })

                // Report to error tracking service
                reportPanic(r.Context(), err, stack)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
\`\`\`

### Goroutine Protection

Goroutines that panic cannot be recovered by the spawning goroutine. Each goroutine must install its own deferred recover. The following helper pattern avoids repeating the recovery boilerplate.

\`\`\`go
func safeGo(fn func()) {
    go func() {
        defer func() {
            if r := recover(); r != nil {
                stack := debug.Stack()
                log.Printf("goroutine panic: %v\\n%s", r, stack)
                // Report to metrics/alerting
                panicCounter.Inc()
            }
        }()
        fn()
    }()
}

// Usage
safeGo(func() {
    processItem(item)
})

// With error channel
func safeGoWithError(fn func() error) <-chan error {
    errCh := make(chan error, 1)
    go func() {
        defer func() {
            if r := recover(); r != nil {
                errCh <- fmt.Errorf("panic: %v", r)
            }
        }()
        errCh <- fn()
    }()
    return errCh
}
\`\`\`

### Panic Discipline

Three rules:

1. **Panic at the programmer-error boundary only.** Invariant violations, impossible states, startup failures with \`Must...\` helpers.
2. **Recover at the outermost HTTP handler or goroutine boundary.** Not in the middle of business logic.
3. **Log the panic with full stack before converting to error.** The stack is the only artifact that lets you debug. Do not discard it.

---
`;
