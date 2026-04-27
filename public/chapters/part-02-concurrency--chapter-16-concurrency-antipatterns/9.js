export default `## 16.8 Context Mistakes

### Ignoring Context Cancellation

A function that does not check \`ctx.Done()\` will continue running after its caller has cancelled or timed out, wasting resources and potentially delaying shutdown. Long-running loops must poll \`ctx.Done()\` via a \`select\` with \`default\` to remain responsive to cancellation without blocking on each iteration.

\`\`\`go
// BAD: ignores context
func bad(ctx context.Context) {
    for {
        doWork()  // Never checks ctx
    }
}

// GOOD: respects context
func good(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            doWork()
        }
    }
}
\`\`\`

### Context Value Abuse

Context values are intended for request-scoped metadata, trace IDs, auth tokens, not for passing required function parameters. Hiding mandatory inputs in the context makes function signatures misleading, breaks static analysis, and causes runtime panics on type assertion if a caller omits the value.

\`\`\`go
// BAD: using context for required parameters
func bad(ctx context.Context) {
    userID := ctx.Value("userID").(int)  // Hidden dependency!
}

// GOOD: explicit parameters
func good(ctx context.Context, userID int) {
    // userID is required and visible
}
\`\`\`

### Storing Context in Struct

Storing a \`context.Context\` in a struct ties the context's lifetime to the struct's lifetime rather than to the specific operation being performed. The Go documentation explicitly discourages this: contexts should flow through function call chains so each caller can pass the appropriate deadline and cancellation signal for its particular request.

\`\`\`go
// BAD: context should not be stored
type Handler struct {
    ctx context.Context  // Don't do this!
}

// GOOD: pass context to methods
type Handler struct{}

func (h *Handler) Handle(ctx context.Context) error {
    // Use ctx
}
\`\`\`

### Additional Context Mistakes

1. **Ignoring \`ctx.Err()\` in loops.** A long loop processing items without checking cancellation is effectively uncancellable. Add a select on \`ctx.Done()\` periodically.
2. **Passing \`context.Background()\` in the middle of a call chain.** Breaks cancellation propagation. Always propagate the received context.
3. **Forgetting \`defer cancel()\`.** Every \`WithCancel\`/\`WithTimeout\`/\`WithDeadline\` must have a matching \`defer cancel()\` on all paths.
4. **Using cancelled context for cleanup.** Cleanup code needs its own context, usually \`context.WithTimeout(context.Background(), ...)\`, not the already-cancelled parent.

### Staff Lens: Context-Usage Review Checklist

For every concurrent PR, check:

1. Every I/O function takes context as first parameter.
2. Every \`WithCancel\`/\`WithTimeout\` has matching \`defer cancel()\`.
3. Context is propagated, not replaced with \`context.Background()\`.
4. No context stored in structs.
5. Long loops check \`ctx.Done()\` periodically.
6. Cleanup uses fresh context.

Teams that apply this checklist catch most context bugs before merge.

---
`;
