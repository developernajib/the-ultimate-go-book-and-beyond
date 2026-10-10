## Context Pitfalls: Production Horror Stories

Context is deceptively simple, and misuse causes real production issues. Each pattern below is a recurring failure shape rather than a specific company's incident, and each one is demonstrated rather than asserted.

### The Context Value Key Collision

When two packages use the same string as a context key, the second `WithValue` silently overwrites the first. Picture an `auth` package and a `billing` package that both chose `"user"`. Whichever runs last wins, and downstream code that asks for an `*auth.User` gets handed a `*billing.BillingUser`.

The failure mode is a type-assertion panic in code that never changed, in a package that has no relationship to the one that broke it, triggered by a middleware ordering nobody thought was significant. The `auth` package's tests pass. The `billing` package's tests pass. They only collide when both are on the same request.

```go
// WRONG: String keys can collide
package auth
func WithUser(ctx context.Context, user *User) context.Context {
    return context.WithValue(ctx, "user", user)  // Bad key!
}

package billing
func WithUser(ctx context.Context, user *BillingUser) context.Context {
    return context.WithValue(ctx, "user", user)  // Same key!
}

// If both are used:
ctx = auth.WithUser(ctx, authUser)
ctx = billing.WithUser(ctx, billingUser)
// auth.GetUser(ctx) returns billingUser! Wrong type, likely panic.

// CORRECT: Unexported type keys prevent collisions
package auth

type contextKey int
const userKey contextKey = iota

func WithUser(ctx context.Context, user *User) context.Context {
    return context.WithValue(ctx, userKey, user)
}

func GetUser(ctx context.Context) (*User, bool) {
    user, ok := ctx.Value(userKey).(*User)
    return user, ok
}

// Now each package has isolated key space
// Collision is impossible
```

The guarantee is worth stating precisely, because it is stronger than "pick unique names". Context compares keys with `==` on an `any`, and interface equality compares **dynamic type first, then value**. Two packages that each declare their own unexported `type contextKey int` and each use `0` do **not** collide, because `auth.contextKey(0) != billing.contextKey(0)`: the types differ. Verified with two real packages using identical underlying values:

```
pkga.Get: alice-from-pkga
pkgb.Get: bob-from-pkgb
-> both int 0, no collision: dynamic types differ

string key "user": bob  <- alice was shadowed
```

Unexported type, isolated key space, collisions impossible by construction. Not by convention, by the type system. That is why staticcheck's **SA1029** flags basic-type keys.

### The Memory Leak from Uncanceled Contexts

Every `context.WithTimeout` arms an internal runtime timer (via `time.AfterFunc`) and links the new context into its parent's cancellation tree, both of which stay alive until the deadline fires or the cancel function is called. Discarding the cancel function means that timer and the retained context node linger for the full timeout duration regardless of when the operation finishes. Under high request rates, this accumulates to hundreds of thousands of pending timers and un-reclaimed context nodes, consuming memory and timer-heap overhead for no purpose. (These are leaked timers and heap objects, not leaked goroutines, `WithTimeout` does not spawn a goroutine per timer.)

```go
// MEMORY LEAK: Context never canceled
func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx, _ := context.WithTimeout(r.Context(), 30*time.Second)  // Ignored cancel!

    result := expensiveOperation(ctx)
    json.NewEncoder(w).Encode(result)
}

// Problem: The timeout's runtime timer stays armed until it fires
// If request completes in 1ms, the timer lingers for 29.999 seconds
// At 10K req/sec, that's 300K pending timers and retained context nodes!

// CORRECT: Always call cancel
func handleRequestGood(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
    defer cancel()  // CRITICAL: Clean up immediately when done

    result := expensiveOperation(ctx)
    json.NewEncoder(w).Encode(result)
}

// Even if operation completes before timeout, cancel() releases resources

// ALSO CORRECT: Cancel in both success and error paths
func handleRequestVerbose(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)

    result, err := expensiveOperation(ctx)
    cancel()  // Cancel as soon as operation completes

    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(result)
}
```

### The Detached Context Antipattern

Creating a fresh `context.Background()` inside a handler severs the link to the request lifecycle. If the client disconnects, the server has no way to signal the downstream operation to stop, it runs for the full timeout duration, holding database connections and consuming resources for a response nobody will read.

```go
// WRONG: Creates orphan context
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Lost connection to request lifecycle!
    ctx := context.Background()
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    result := queryDatabase(ctx)  // Continues even if client disconnects!
    json.NewEncoder(w).Encode(result)
}

// Client disconnects after 100ms, but database query runs for 30 seconds
// Wasted resources, potential data inconsistency

// CORRECT: Derive from request context
func handleRequestGood(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
    defer cancel()

    result := queryDatabase(ctx)  // Canceled if client disconnects
    json.NewEncoder(w).Encode(result)
}

// WRONG, even though the detachment is intentional:
// r.Body is closed by the server when the handler returns.
func handleRequestWithBackgroundBroken(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("accepted"))

    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
        defer cancel()
        processAsync(ctx, r.Body) // reads a closed body, loses the payload
    }()
}

// CORRECT: read the body BEFORE returning, detach with WithoutCancel.
const maxBodyBytes = 4 << 20 // 4 MiB cap for async payloads

func handleRequestWithBackground(w http.ResponseWriter, r *http.Request) {
    // Consume the body while the handler still owns it.
    body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
    if err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    // WithoutCancel keeps trace/request IDs, drops the cancellation.
    // Derive before `go` so it cannot race the handler returning.
    ctx, cancel := context.WithTimeout(
        context.WithoutCancel(r.Context()), 5*time.Minute)

    go func() {
        defer cancel()
        defer func() {
            if rec := recover(); rec != nil {
                log.Printf("async work panicked: %v", rec)
            }
        }()
        processAsync(ctx, bytes.NewReader(body))
    }()

    w.WriteHeader(http.StatusAccepted)
    w.Write([]byte("accepted"))
}
```

The broken version fails in the quietest way available. `r.Body` is closed by the server the instant `ServeHTTP` returns, and the documentation is explicit: "The Server will close the request body." The goroutine then reads nothing:

```
async body read after handler returned -> read "", err=http: invalid Read on closed Body
```

The client already received `accepted`. The payload is gone. There is no error path, no failed request, and no log unless someone thought to add one. This is the same lifetime mistake as passing `r.Context()` to a background goroutine, applied to the body instead of the context: **nothing owned by the request survives the handler's return.** Not the context, not the body, not the `ResponseWriter`. Copy out what you need before returning.

### The Context Value Abuse

Treating the context as a general-purpose dependency container makes function signatures deceptive, `func process(ctx context.Context)` looks like it needs no dependencies, but internally it performs unchecked type assertions to extract a database handle, cache client, logger, and mutable counter. This hides the true dependency graph, prevents the compiler from catching missing arguments, and introduces data races when mutable state is shared across goroutines through the context.

```go
// WRONG: Context as a grab bag
func handler(ctx context.Context) {
    // Storing mutable state
    ctx = context.WithValue(ctx, "counter", new(int))

    // Storing dependencies
    ctx = context.WithValue(ctx, "db", db)
    ctx = context.WithValue(ctx, "cache", cache)
    ctx = context.WithValue(ctx, "logger", logger)

    // Now function signatures hide dependencies
    process(ctx)  // What does this need? Who knows!
}

func process(ctx context.Context) {
    // Type unsafe, panic-prone retrieval
    db := ctx.Value("db").(*sql.DB)        // Panics if missing
    cache := ctx.Value("cache").(*Cache)   // Panics if missing
    counter := ctx.Value("counter").(*int) // Mutable shared state!
    *counter++                              // Data race!
}

// CORRECT: Explicit dependencies, context for request-scoped data only
type Handler struct {
    db     *sql.DB
    cache  *Cache
    logger *Logger
}

func (h *Handler) Handle(ctx context.Context) {
    // Context only for request-scoped data
    requestID := GetRequestID(ctx)
    traceID := GetTraceID(ctx)

    h.logger.Info("handling request",
        "request_id", requestID,
        "trace_id", traceID)

    // Dependencies are explicit
    result := h.db.QueryContext(ctx, "SELECT ...")
}

// Context values are appropriate for:
// 1. Request ID / Trace ID
// 2. Authentication/Authorization info (read-only)
// 3. Deadline/timeout propagation
// 4. Cancellation signal

// Context values are NOT for:
// 1. Dependencies (use struct fields)
// 2. Mutable state (use proper synchronization)
// 3. Optional parameters (use functional options)
// 4. Return values (use return statement)
```

### The Timeout Inheritance Trap

A common misconception is that setting a longer timeout on a child context extends the available time. It does not. The child's effective deadline is always the minimum of its own deadline and the parent's. If the parent has 10 seconds remaining, creating a child with a 30-second timeout still gives the child only 10 seconds. The fix is to check the remaining budget before starting expensive operations and allocate time proportionally.

```go
// GOTCHA: Child can't have longer timeout than parent
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Request has 10 second timeout
    ctx := r.Context()

    // Try to set 30 second timeout for database
    dbCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    // Effective timeout is still 10 seconds (parent's deadline)!
    result := queryDatabase(dbCtx)
}

// CORRECT: Be aware of inherited deadlines
func handleRequestAware(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Check remaining time
    deadline, ok := ctx.Deadline()
    if ok {
        remaining := time.Until(deadline)
        log.Printf("Request has %v remaining", remaining)

        if remaining < 5*time.Second {
            http.Error(w, "insufficient time for operation", 408)
            return
        }
    }

    // Use a portion of remaining time
    dbCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    result := queryDatabase(dbCtx)
}

// PATTERN: Timeout budgeting
type TimeoutBudget struct {
    total     time.Duration
    remaining time.Duration
    start     time.Time
}

func NewTimeoutBudget(total time.Duration) *TimeoutBudget {
    return &TimeoutBudget{
        total:     total,
        remaining: total,
        start:     time.Now(),
    }
}

func (b *TimeoutBudget) Allocate(portion float64) time.Duration {
    elapsed := time.Since(b.start)
    b.remaining = b.total - elapsed
    return time.Duration(float64(b.remaining) * portion)
}

func handleWithBudget(ctx context.Context) {
    budget := NewTimeoutBudget(10 * time.Second)

    // Allocate 30% for auth
    authCtx, cancel := context.WithTimeout(ctx, budget.Allocate(0.3))
    validateAuth(authCtx)
    cancel()

    // Allocate 50% for main operation
    mainCtx, cancel := context.WithTimeout(ctx, budget.Allocate(0.5))
    doMainWork(mainCtx)
    cancel()

    // Remaining 20% for cleanup
    cleanupCtx, cancel := context.WithTimeout(ctx, budget.Allocate(0.2))
    cleanup(cleanupCtx)
    cancel()
}
```

### Quick Reference: Context Best Practices

| Scenario | Do | Don't |
|----------|-----|-------|
| Key type | Unexported custom type | String or built-in type |
| Cancel function | Always defer cancel() | Ignore the cancel return |
| Parent context | Derive from request context | Create orphan Background |
| Context values | Request-scoped immutable data | Dependencies, mutable state |
| Timeout extension | Budget remaining time | Expect child to extend parent |
| Nil context | Use TODO() or Background() | Pass nil |
| Fire-and-forget work | `context.WithoutCancel` + own timeout | Pass `r.Context()`, which dies with the request |
| Request body in a goroutine | Read it before the handler returns | Read `r.Body` after `ServeHTTP` returns |
| Cleanup after cancellation | `WithoutCancel(ctx)` + timeout | Reuse the canceled ctx |
| Loop cancellation | `return ctx.Err()` or `break label` | Bare `break` inside a `select` |

### Staff Lens: Context Horror Stories as Teaching Material

Each context-related incident in your org's history is a free teaching resource. Write them up. "Service X returned 500s for 30 minutes because a canceled context was reused in cleanup" is a story every engineer remembers. "Always use a fresh context for cleanup" is a rule no one remembers. The stories lodge in memory. The rules do not. Staff engineers who invest in writing these up compound the team's context discipline over years.

### Principal Lens: Context Incidents Signal Framework Gaps

Most context-related incidents trace back to missing shared infrastructure: no standard middleware, no deadline-propagation library, no enforced convention. A single incident is a bug. Five context incidents in a year is a framework gap. Principal engineers who see the pattern invest in the framework (shared middleware, linter rules, templates) rather than patching the individual bugs. The framework prevents the next ten incidents before they happen.

---
