## 14.10 Common Mistakes and Anti-Patterns

### 1. Not Calling Cancel

Every `context.WithCancel`, `WithTimeout`, and `WithDeadline` call allocates internal state in the parent context's cancellation tree. Discarding the cancel function leaks this allocation for the lifetime of the parent context. `defer cancel()` must be called unconditionally, even when the context will time out naturally, to release resources promptly.

```go
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
```

### 2. Storing Context in Struct

Embedding a `context.Context` in a struct ties a single, fixed context to every method call on that struct, preventing callers from controlling cancellation or deadlines on a per-request basis. Contexts are inherently request-scoped and should be passed as the first parameter to each method that needs them, not stored as long-lived struct fields.

```go
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
```

### 3. Using Context Values for Dependencies

Context values are designed for request-scoped metadata, trace IDs, authentication tokens, and similar cross-cutting data, not for passing core dependencies like database handles or loggers. Hiding dependencies in context values makes function signatures misleading, breaks type safety (requiring unchecked type assertions), and makes the code harder to test and reason about.

```go
// WRONG
func bad(ctx context.Context) error {
    db := ctx.Value("database").(*sql.DB)  // Hidden dependency!
    return db.Query(...)
}

// CORRECT
func good(ctx context.Context, db *sql.DB) error {
    return db.QueryContext(ctx, ...)
}
```

### 4. Ignoring Context Cancellation

Long-running loops or compute-intensive functions that never check `ctx.Done()` will continue executing even after the caller has given up, wasting CPU and holding resources. A `select` with a `default` branch on `ctx.Done()` adds minimal overhead while ensuring the goroutine can exit promptly when the context is canceled.

```go
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
```

### 5. Using Canceled Context for Cleanup

When a request is canceled, the associated context is already `Done`. Passing it to cleanup operations makes them fail instantly, so your cleanup silently does nothing. Cleanup that must run regardless of the request's fate needs a context detached from that cancellation, with its own timeout.

```go
// WRONG
func bad(ctx context.Context) {
    // ctx is likely already canceled: this fails instantly and
    // the cleanup never happens.
    db.Close(ctx)
}

// OK, but loses every request-scoped value (trace ID, request ID)
func acceptable(ctx context.Context) {
    cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    db.Close(cleanupCtx)
}

// CORRECT (Go 1.21+): keeps the values, drops only the cancellation
func good(ctx context.Context) {
    cleanupCtx, cancel := context.WithTimeout(
        context.WithoutCancel(ctx), 30*time.Second)
    defer cancel()
    db.Close(cleanupCtx)
}
```

`context.Background()` works, and before Go 1.21 it was the only option. `context.WithoutCancel` is strictly better: identical cancellation behavior, but the cleanup stays traceable. Cleanup paths are exactly the ones you want traced, since they run when something has already gone wrong.

### 6. Handing a Request Context to Fire-and-Forget Work

This is the most consequential context bug in Go services, and it looks completely reasonable:

```go
// WRONG: the goroutine is killed when the handler returns
func Handle(ctx context.Context, order Order) error {
    if err := save(ctx, order); err != nil {
        return err
    }
    go sendConfirmationEmail(ctx, order) // ctx dies with the request
    return nil
}
```

`r.Context()` is canceled the moment the handler returns. The goroutine then races the response, and the response usually wins. Demonstrated by launching the same work three ways from a real handler:

```
passing r.Context():  KILLED by context canceled (trace=trace-42)
WithoutCancel:        SENT (trace=trace-42)
context.Background(): SENT (trace=<nil>)
```

The email is silently never sent. Nothing errors, nothing is logged, and the only evidence is a cancellation nobody was watching for. It works in development because the handler is slow and the email is fast, and it fails in production because the handler is fast.

```go
// CORRECT
func Handle(ctx context.Context, order Order) error {
    if err := save(ctx, order); err != nil {
        return err
    }

    // Derive BEFORE `go`, so it cannot race the handler returning.
    emailCtx, cancel := context.WithTimeout(
        context.WithoutCancel(ctx), 30*time.Second)
    go func() {
        defer cancel()
        // A panic in this goroutine would kill the whole process.
        defer func() {
            if r := recover(); r != nil {
                log.Printf("email panicked: %v", r)
            }
        }()
        sendConfirmationEmail(emailCtx, order)
    }()
    return nil
}
```

Note the timeout. `context.WithoutCancel` alone gives a context that is never canceled by anything, so a hung SMTP server would pin that goroutine for the life of the process. Detaching from the parent's cancellation means you must supply your own bound.

### 7. Passing nil Context

The context package panics when a nil context is passed to any function that calls methods on it, including `ctx.Done()` and `ctx.Value()`. Code that does not yet know which context to use should pass `context.TODO()` rather than `nil`, which is semantically equivalent to `context.Background()` but signals to readers and static analysis tools that a real context should be threaded through later.

```go
// WRONG
func bad() {
    doWork(nil)  // Will panic!
}

// CORRECT
func good() {
    doWork(context.Background())  // or context.TODO()
}
```

### 8. A Bare `break` Inside a `select`

This one is pure Go syntax rather than context semantics, but it defeats cancellation so reliably it belongs here.

```go
// WRONG: this loop ignores cancellation entirely
func consume(ctx context.Context, items <-chan Item) {
    for {
        select {
        case <-ctx.Done():
            break // breaks the SELECT, not the for loop!
        case item := <-items:
            process(item)
        }
    }
}
```

`break` binds to the innermost `for`, `switch`, or **`select`**. Inside a `select`, a bare `break` exits the `select`, which the loop was about to do anyway. The cancellation case is handled by doing nothing, and control returns to the top of the `for`. If `items` never delivers again, the loop spins on a permanently-ready `ctx.Done()` forever, burning a core.

The code reads as if it stops on cancellation. It compiles. `go vet` does not flag it. Demonstrated with a canceled context and a channel that never sends:

```
bare break: HUNG FOREVER (spinning on a canceled ctx)
break loop: returned correctly, n = 0
```

Use a label, or just `return`:

```go
// CORRECT: label the loop
func consume(ctx context.Context, items <-chan Item) {
loop:
    for {
        select {
        case <-ctx.Done():
            break loop
        case item := <-items:
            process(item)
        }
    }
}

// CORRECT and usually better: return the reason
func consume(ctx context.Context, items <-chan Item) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case item := <-items:
            process(item)
        }
    }
}
```

Prefer the `return ctx.Err()` form where you can. It is impossible to get wrong, and it propagates *why* the loop stopped instead of discarding it.

### 9. Storing Mutable Values in Context (Hidden Data Races)

`context.WithValue` is designed exclusively for immutable, request-scoped metadata. Passing pointers to mutable data structures (such as metric counters, slices, or session maps) creates severe data race risks when handlers spawn concurrent child goroutines:

```go
// ANTI-PATTERN: Data race when multiple goroutines modify context-stored pointer
type RequestMetrics struct {
    DBQueries int
    CacheHits int
}

func TrackQueries(ctx context.Context) {
    m := ctx.Value(metricsKey).(*RequestMetrics)
    m.DBQueries++ // DATA RACE: concurrent unsynchronized writes!
}
```

**Fix**: If shared telemetry mutation across concurrent tasks is necessary, make thread-safety explicit by encapsulating synchronization within the struct using `sync.Mutex` or `sync/atomic`:

```go
// CORRECT: Thread-safe metrics container
type SafeMetrics struct {
    DBQueries atomic.Int64
    CacheHits atomic.Int64
}

func TrackQueries(ctx context.Context) {
    if m, ok := ctx.Value(metricsKey).(*SafeMetrics); ok {
        m.DBQueries.Add(1) // Atomic and race-free
    }
}
```

### 10. Cascading Timeout Starvation (Single Timeout Chaining)

Applying a single aggregate timeout across a sequential series of heterogeneous operations causes cascading deadline starvation:

```go
// ANTI-PATTERN: Shared 5s timeout across multiple sequential dependencies
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    user, err := h.cache.Get(ctx, userID) // If cache degrades and takes 4.9s...
    if err != nil {
        user, err = h.db.GetUser(ctx, userID) // ...DB is left with only 100ms!
    }
    // ...
}
```

When the cache experiences latency spikes, the database operation fails with `context.DeadlineExceeded` even though the database itself is completely healthy.

**Fix**: Derive independent, bounded deadlines directly from the request root context for each individual hop:

```go
// CORRECT: Independent operational deadlines rooted in r.Context()
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    // Fast cache budget: 50ms
    cacheCtx, cacheCancel := context.WithTimeout(r.Context(), 50*time.Millisecond)
    user, err := h.cache.Get(cacheCtx, userID)
    cacheCancel()

    if err != nil {
        // Separate database fallback budget: 2s
        dbCtx, dbCancel := context.WithTimeout(r.Context(), 2*time.Second)
        defer dbCancel()
        user, err = h.db.GetUser(dbCtx, userID)
    }
    // ...
}
```

### 11. Deferring `cancel()` Inside Loops (Timer and Child Node Leaks)

Writing `defer cancel()` inside a loop does not clean up resources at the end of the iteration; it accumulates deferred function calls until the enclosing function returns:

```go
// ANTI-PATTERN: Accumulates thousands of live timers and child context nodes
func processBatch(ctx context.Context, items []Item) error {
    for _, item := range items {
        itemCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
        defer cancel() // LEAK: Only runs when processBatch exits!
        if err := process(itemCtx, item); err != nil {
            return err
        }
    }
    return nil
}
```

**Fix**: Invoke `cancel()` explicitly at the bottom of the loop body or encapsulate the loop body in a discrete function:

```go
// CORRECT: Explicit per-iteration cancellation
func processBatch(ctx context.Context, items []Item) error {
    for _, item := range items {
        itemCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
        err := process(itemCtx, item)
        cancel() // Releases context timer and node immediately
        if err != nil {
            return err
        }
    }
    return nil
}
```

> [!NOTE]
> For a field retrospective on common production context regressions and silent background goroutine terminations, see Renaldi Purwanto's breakdown in [*5 Context Mistakes That Are Quietly Breaking Your Go Backend*](https://medium.com/@renaldipurwanto/5-context-mistakes-that-are-quietly-breaking-your-go-backend).

### Additional Mistakes to Flag

1. **Context stored in a struct.** `type Service struct { ctx context.Context }` is almost always wrong. Context's lifetime is a single operation, not an object's lifetime. Pass context to methods that need it.
2. **Ignoring context.Err() in long loops.** A loop that processes 10 million items without checking cancellation is effectively uncancellable.
3. **Passing context.Background() deep in the call stack.** This breaks cancellation. The request context should propagate from the entry point.
4. **Using ctx.Value for mandatory data.** If the function cannot work without it, it is not a request-scoped hint. Make it a function parameter.
5. **Not returning ctx.Err() when select chooses ctx.Done().** Callers need to know why the function returned. Return `ctx.Err()`, which is `context.Canceled` or `context.DeadlineExceeded`.

### Staff Lens: Context Anti-Pattern Catalog

Like synchronization, context anti-patterns recur. Documenting them as a team catalog with before/after examples lets reviewers catch them consistently.

Know precisely which of these the tools catch, so you spend review attention on the rest:

**Caught by `go vet` (`lostcancel`):** discarding the cancel function, and failing to call it on every path. Vet even names the offending `return` statement. Mistake 1 should never survive CI.

**Caught by `staticcheck`:** `SA1029` for a basic-type context key, `SA1012` for a nil context.

**Caught by nothing:** everything else in this section. Context stored in a struct, `context.Background()` passed deep in a call stack, a request context handed to a fire-and-forget goroutine, a bare `break` in a `select`, dependencies smuggled through `ctx.Value`, a loop that never checks cancellation. No linter flags any of them, and none of them fail a test, because they are all invisible until production timing exposes them.

That asymmetry is the argument for the catalog. The bugs the tools catch do not need a catalog. The catalog exists for the ones where a human reading the diff is the only defense.

---
