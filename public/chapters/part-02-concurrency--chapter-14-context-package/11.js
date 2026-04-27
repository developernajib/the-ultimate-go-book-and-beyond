export default `## 14.10 Common Mistakes and Anti-Patterns

### 1. Not Calling Cancel

Every \`context.WithCancel\`, \`WithTimeout\`, and \`WithDeadline\` call allocates internal state in the parent context's cancellation tree. Discarding the cancel function leaks this allocation for the lifetime of the parent context. \`defer cancel()\` must be called unconditionally, even when the context will time out naturally, to release resources promptly.

\`\`\`go
// WRONG
func bad(ctx context.Context) error {
    ctx, _ = context.WithTimeout(ctx, time.Second)  // Cancel discarded!
    return doWork(ctx)
}

// CORRECT
func good(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, time.Second)
    defer cancel()
    return doWork(ctx)
}
\`\`\`

### 2. Storing Context in Struct

Embedding a \`context.Context\` in a struct ties a single, fixed context to every method call on that struct, preventing callers from controlling cancellation or deadlines on a per-request basis. Contexts are inherently request-scoped and should be passed as the first parameter to each method that needs them, not stored as long-lived struct fields.

\`\`\`go
// WRONG
type Handler struct {
    ctx context.Context  // Don't do this!
    db  *sql.DB
}

// CORRECT
type Handler struct {
    db *sql.DB
}

func (h *Handler) Handle(ctx context.Context, req Request) error {
    return h.db.QueryContext(ctx, ...)
}
\`\`\`

### 3. Using Context Values for Dependencies

Context values are designed for request-scoped metadata, trace IDs, authentication tokens, and similar cross-cutting data, not for passing core dependencies like database handles or loggers. Hiding dependencies in context values makes function signatures misleading, breaks type safety (requiring unchecked type assertions), and makes the code harder to test and reason about.

\`\`\`go
// WRONG
func bad(ctx context.Context) error {
    db := ctx.Value("database").(*sql.DB)  // Hidden dependency!
    return db.Query(...)
}

// CORRECT
func good(ctx context.Context, db *sql.DB) error {
    return db.QueryContext(ctx, ...)
}
\`\`\`

### 4. Ignoring Context Cancellation

Long-running loops or compute-intensive functions that never check \`ctx.Done()\` will continue executing even after the caller has given up, wasting CPU and holding resources. A \`select\` with a \`default\` branch on \`ctx.Done()\` adds minimal overhead while ensuring the goroutine can exit promptly when the context is cancelled.

\`\`\`go
// WRONG
func bad(ctx context.Context) error {
    for i := 0; i < 1000000; i++ {
        // Never checks context!
        doExpensiveWork(i)
    }
    return nil
}

// CORRECT
func good(ctx context.Context) error {
    for i := 0; i < 1000000; i++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            doExpensiveWork(i)
        }
    }
    return nil
}
\`\`\`

### 5. Using Cancelled Context for Cleanup

When a request is cancelled, the associated context is already in the \`Done\` state. Passing it to cleanup operations like database closes or log flushes will cause those operations to fail immediately. Cleanup paths that must complete regardless of the original request's fate should use a fresh \`context.Background()\` with an appropriate timeout.

\`\`\`go
// WRONG
func bad(ctx context.Context) {
    // ctx might be cancelled
    db.Close(ctx)  // May fail if context cancelled!
}

// CORRECT
func good(ctx context.Context) {
    // Use fresh context for cleanup
    cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    db.Close(cleanupCtx)
}
\`\`\`

### 6. Passing nil Context

The context package panics when a nil context is passed to any function that calls methods on it, including \`ctx.Done()\` and \`ctx.Value()\`. Code that does not yet know which context to use should pass \`context.TODO()\` rather than \`nil\`, which is semantically equivalent to \`context.Background()\` but signals to readers and static analysis tools that a real context should be threaded through later.

\`\`\`go
// WRONG
func bad() {
    doWork(nil)  // Will panic!
}

// CORRECT
func good() {
    doWork(context.Background())  // or context.TODO()
}
\`\`\`

### Additional Mistakes to Flag

1. **Context stored in a struct.** \`type Service struct { ctx context.Context }\` is almost always wrong. Context's lifetime is a single operation, not an object's lifetime. Pass context to methods that need it.
2. **Ignoring context.Err() in long loops.** A loop that processes 10 million items without checking cancellation is effectively uncancellable.
3. **Passing context.Background() deep in the call stack.** This breaks cancellation. The request context should propagate from the entry point.
4. **Using ctx.Value for mandatory data.** If the function cannot work without it, it is not a request-scoped hint. Make it a function parameter.
5. **Not returning ctx.Err() when select chooses ctx.Done().** Callers need to know why the function returned. Return \`ctx.Err()\`, which is \`context.Canceled\` or \`context.DeadlineExceeded\`.

### Staff Lens: Context Anti-Pattern Catalog

Like synchronization, context anti-patterns recur. Documenting them as a team catalog with before/after examples lets reviewers catch them consistently. The catalog plus \`go vet\` plus \`staticcheck\` rules (like \`SA1029\`, \`SA5012\`) catches most context bugs at review or CI time. Teams that build this discipline have dramatically fewer context-related incidents.

---
`;
