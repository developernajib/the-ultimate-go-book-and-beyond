export default `## 14.4 Context Values: Request-Scoped Data

Context values carry request-scoped data across API boundaries. They should be used sparingly and correctly.

### Type-Safe Context Keys

Using an unexported custom integer type as the key type guarantees that no other package can accidentally store a value under the same key, because type identity is part of the equality check. Accessor functions like \`RequestID\` and \`UserID\` centralize the type assertion in one place, so callers never need to know the underlying key constant or perform raw assertions themselves. This pattern also makes it easy to return zero values or \`(value, bool)\` pairs instead of panicking when a value is absent.

\`\`\`go
package requestctx

import "context"

// Use private types for keys to prevent collisions
type contextKey int

const (
    requestIDKey contextKey = iota
    userIDKey
    traceKey
    loggerKey
)

// Request ID
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func RequestID(ctx context.Context) string {
    if id, ok := ctx.Value(requestIDKey).(string); ok {
        return id
    }
    return ""
}

// User ID with type safety
func WithUserID(ctx context.Context, userID int64) context.Context {
    return context.WithValue(ctx, userIDKey, userID)
}

func UserID(ctx context.Context) (int64, bool) {
    userID, ok := ctx.Value(userIDKey).(int64)
    return userID, ok
}

// Trace information
type TraceInfo struct {
    TraceID    string
    SpanID     string
    ParentSpan string
    Sampled    bool
}

func WithTrace(ctx context.Context, trace TraceInfo) context.Context {
    return context.WithValue(ctx, traceKey, trace)
}

func Trace(ctx context.Context) (TraceInfo, bool) {
    trace, ok := ctx.Value(traceKey).(TraceInfo)
    return trace, ok
}
\`\`\`

### Anti-Patterns to Avoid

Context values become a source of hidden coupling and subtle bugs when misused, because they bypass the explicit function signatures that make Go code easy to read and reason about. String keys and exported key types are particularly dangerous in large codebases where multiple packages can independently choose the same key string and silently overwrite each other's data. Storing mutable structs is equally hazardous because concurrent goroutines sharing the same context may update the struct without synchronization, introducing data races that are hard to detect.

\`\`\`go
// BAD: Using string keys (collision risk)
ctx = context.WithValue(ctx, "user", user)

// BAD: Using exported types as keys (external packages can collide)
type Key string
ctx = context.WithValue(ctx, Key("user"), user)

// BAD: Passing function arguments through context
func BadProcess(ctx context.Context) error {
    config := ctx.Value("config").(Config)  // Hidden dependency!
    return doWork(config)
}

// GOOD: Pass explicitly
func GoodProcess(ctx context.Context, config Config) error {
    return doWork(config)
}

// BAD: Using context values to affect program behavior
func BadHandler(ctx context.Context) {
    if ctx.Value("skipValidation").(bool) {  // Business logic in context!
        // Skip validation
    }
}

// GOOD: Use explicit parameters
func GoodHandler(ctx context.Context, opts Options) {
    if opts.SkipValidation {
        // Skip validation
    }
}

// BAD: Storing mutable data
type Counter struct {
    count int
}
func Bad(ctx context.Context) {
    counter := ctx.Value("counter").(*Counter)
    counter.count++  // Race condition!
}

// GOOD: Context values should be immutable
type RequestInfo struct {
    ID        string
    StartTime time.Time
}
\`\`\`

### When to Use Context Values

The guiding rule is that context values should carry observability and identity metadata, not control flow or business logic. A request ID or trace span belongs in the context because it genuinely needs to cross every API boundary without polluting dozens of function signatures, whereas a database connection or feature flag belongs in an explicit parameter because its presence or absence affects program correctness. The middleware example below demonstrates the legitimate use case: enriching the context once at the edge of the system with a request ID, authenticated user, and trace information that downstream handlers may read but should never depend on for their core logic.

\`\`\`go
/*
DO use context values for:
✓ Request IDs / Correlation IDs
✓ Trace IDs / Span IDs
✓ Authentication tokens (after validation)
✓ Locale / Language preference
✓ Logger with request-scoped fields

DON'T use context values for:
✗ Function parameters
✗ Optional configuration
✗ Database connections
✗ Business logic flags
✗ Anything that affects correctness
*/

// Good examples of context values
func middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Request ID - tracing purposes
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = uuid.NewString()
        }
        ctx = WithRequestID(ctx, requestID)

        // Authenticated user - already validated
        if user := authenticate(r); user != nil {
            ctx = WithUser(ctx, user)
        }

        // Trace propagation
        if traceHeader := r.Header.Get("X-Trace-ID"); traceHeader != "" {
            ctx = WithTrace(ctx, parseTraceHeader(traceHeader))
        }

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
\`\`\`

### Value Lookup Performance

Context values use linked list lookup, O(n) in the depth of the context chain:

\`\`\`go
// Each WithValue adds a new node
ctx := context.Background()
ctx = context.WithValue(ctx, key1, val1)  // Depth 1
ctx = context.WithValue(ctx, key2, val2)  // Depth 2
ctx = context.WithValue(ctx, key3, val3)  // Depth 3

// Looking up key1 requires traversing the chain
// For deeply nested contexts, this can impact performance

// Solution: Bundle related values
type RequestContext struct {
    RequestID string
    UserID    int64
    TraceID   string
    StartTime time.Time
}

func WithRequestContext(ctx context.Context, rc RequestContext) context.Context {
    return context.WithValue(ctx, requestContextKey, rc)
}

func GetRequestContext(ctx context.Context) (RequestContext, bool) {
    rc, ok := ctx.Value(requestContextKey).(RequestContext)
    return rc, ok
}
\`\`\`

### What Belongs in Context Values, and What Does Not

The Go docs say context values should be "request-scoped data". This is under-specified. The practical rule:

**Belongs in context:**
- Request ID, trace ID, span context (telemetry).
- User identity after authentication (who).
- Deadline information redundant with context deadline.
- Locale, tenant ID (cross-cutting request properties).

**Does not belong in context:**
- Dependencies (database handle, logger, cache client). Inject via struct fields or constructor parameters.
- Configuration (timeouts, feature flags, connection strings). Also struct fields.
- Domain data (the user's order being processed, the email being sent). Function parameters.
- Mutable state (a counter, a list being appended to). Stored state belongs in a struct, not context.

The litmus test: if the value is passed through three function calls unchanged, it might belong in context. If the value is essential to the function's core logic (the user's order when placing an order), it belongs in function parameters.

### Typed Accessor Pattern

Never expose context keys directly. Wrap them in typed accessor functions:

\`\`\`go
type userIDKey struct{}
func WithUserID(ctx context.Context, id string) context.Context { return context.WithValue(ctx, userIDKey{}, id) }
func UserID(ctx context.Context) (string, bool) { id, ok := ctx.Value(userIDKey{}).(string); return id, ok }
\`\`\`

This gives you type safety, prevents key collisions (struct type is unexported), and makes the API discoverable. Callers use \`UserID(ctx)\` instead of raw context access.

### Staff Lens: Context-Value Governance

A codebase with three context keys is manageable. A codebase with fifty is chaos. Context values proliferate because adding one is cheap and removing one requires tracing callers. The staff-level discipline: a team-owned registry of allowed context keys, reviewed quarterly, unused ones retired. Without this, context values accrete indefinitely and eventually carry so much smuggled state that the function signatures lie.

---
`;
