## 16.8 Context Mistakes

### Ignoring Context Cancellation

A function that does not check `ctx.Done()` will continue running after its caller has canceled or timed out, wasting resources and potentially delaying shutdown. Long-running loops must poll `ctx.Done()` via a `select` with `default` to remain responsive to cancellation without blocking on each iteration.

```go
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
```

### Context Value Abuse

Context values are intended for request-scoped metadata, trace IDs, auth tokens, not for passing required function parameters. Hiding mandatory inputs in the context makes function signatures misleading, breaks static analysis, and causes runtime panics on type assertion if a caller omits the value.

```go
// BAD: using context for required parameters
func bad(ctx context.Context) {
    userID := ctx.Value("userID").(int)  // Hidden dependency!
}

// GOOD: explicit parameters
func good(ctx context.Context, userID int) {
    // userID is required and visible
}
```

That example contains a second, independent bug worth separating out: the key is a plain `string`. Context keys are compared by interface equality, so *any* package storing the string `"userID"` collides with this one, silently overwriting or shadowing the value. The collision is invisible at compile time and appears as a wrong value or a panicking type assertion, at runtime, in production.

The idiom is an unexported key type, which makes collisions impossible because no other package can construct the key:

```go
// Unexported type: no other package can name it, so no collision.
type ctxKey struct{}

func WithUserID(ctx context.Context, id int) context.Context {
    return context.WithValue(ctx, ctxKey{}, id)
}

// Typed accessor: the assertion lives in one place, and callers get
// an ok rather than a panic.
func UserIDFrom(ctx context.Context) (int, bool) {
    id, ok := ctx.Value(ctxKey{}).(int)
    return id, ok
}
```

Note the accessor returns `(int, bool)` rather than asserting bare. `ctx.Value(k).(int)` panics when the value is absent, which turns a missing-value bug into a downed process. Even when a value truly is required, discover that with an `ok` check and return an error.

### Storing Context in Struct

Storing a `context.Context` in a struct ties the context's lifetime to the struct's lifetime rather than to the specific operation being performed. The Go documentation explicitly discourages this: contexts should flow through function call chains so each caller can pass the appropriate deadline and cancellation signal for its particular request.

```go
// BAD: context should not be stored
type Handler struct {
    ctx context.Context  // Don't do this!
}

// GOOD: pass context to methods
type Handler struct{}

func (h *Handler) Handle(ctx context.Context) error {
    // Use ctx
    return nil
}
```

### Additional Context Mistakes

1. **Ignoring `ctx.Err()` in loops.** A long loop processing items without checking cancellation is effectively uncancellable. Add a select on `ctx.Done()` periodically.
2. **Passing `context.Background()` in the middle of a call chain.** Breaks cancellation propagation. Always propagate the received context.
3. **Forgetting `defer cancel()`.** Every `WithCancel`/`WithTimeout`/`WithDeadline` must have a matching `defer cancel()` on all paths.
4. **Using a canceled context for cleanup.** When a request is cancelled, its context is already dead, so every cleanup call made with it fails instantly with `context.Canceled`. The connection is not returned, the span is not flushed, the row is not deleted. Cleanup needs a live context.

   Reach for `context.WithoutCancel` (Go 1.21) rather than `context.Background()`. Both detach from the parent's cancellation, but `WithoutCancel` keeps the parent's **values**, so trace IDs, request IDs, and auth metadata survive into the cleanup path. Dropping to `Background()` throws those away, and the cleanup that fails is then the one you cannot find in your traces:

   ```go
   // Cleanup that runs even though ctx was cancelled, while keeping
   // the request's trace ID for observability.
   cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
   defer cancel()
   _ = conn.Close(cleanupCtx)
   ```

   Always give the detached context its own timeout. A context with no cancellation and no deadline is a hang waiting to happen.

5. **`break` inside a `select` inside a `for`.** `break` binds to the nearest enclosing `for`, `switch`, or `select`, and a `select` counts. So `break` in a select case exits the *select*, not the loop, and the loop spins on:

   ```go
   for {
       select {
       case <-ctx.Done():
           break // Breaks the SELECT. The for loop continues forever.
       case v := <-ch:
           process(v)
       }
   }
   ```

   Use `return`, or a labelled break:

   ```go
   loop:
   for {
       select {
       case <-ctx.Done():
           break loop // Now it breaks the for
       case v := <-ch:
           process(v)
       }
   }
   ```

   This compiles cleanly and `go vet` does not flag it, so it survives review easily. It presents as a goroutine that ignores cancellation while burning a core.

### Staff Lens: Context-Usage Review Checklist

For every concurrent PR, check:

1. Every I/O function takes context as first parameter.
2. Every `WithCancel`/`WithTimeout` has matching `defer cancel()`.
3. Context is propagated, not replaced with `context.Background()`.
4. No context stored in structs.
5. Long loops check `ctx.Done()` periodically.
6. Cleanup uses fresh context.

Teams that apply this checklist catch most context bugs before merge.

---
