## 14.2 Cancellation: Stopping Work Gracefully

Cancellation is the primary use case for context. It allows parent operations to signal that downstream work should stop.

### Detecting Cancellation

There are three idiomatic ways to check whether a context has been canceled. The `select` with `ctx.Done()` and a `default` branch is non-blocking and is the most common pattern inside tight loops. For stream processing where the goroutine must also wait on a data channel, omitting the `default` branch lets the `select` block efficiently on whichever event arrives first.

```go
func processItems(ctx context.Context, items []Item) error {
    for _, item := range items {
        // Method 1: Check Done() channel with select
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            // Continue processing
        }

        if err := processItem(ctx, item); err != nil {
            return err
        }
    }
    return nil
}

// Method 2: Check Err() directly (non-blocking)
func processItems2(ctx context.Context, items []Item) error {
    for _, item := range items {
        if ctx.Err() != nil {
            return ctx.Err()
        }
        if err := processItem(ctx, item); err != nil {
            return err
        }
    }
    return nil
}

// Method 3: In channel operations
func processStream(ctx context.Context, items <-chan Item) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case item, ok := <-items:
            if !ok {
                return nil // Channel closed
            }
            if err := process(item); err != nil {
                return err
            }
        }
    }
}
```

### Propagating Cancellation

Child contexts inherit cancellation from their parent: when a parent context is canceled or times out, all derived child contexts are canceled simultaneously regardless of their own deadlines. In the example below, both children are created with much longer timeouts, but because the parent expires after 100 milliseconds all three contexts fire at the same time.

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Parent cancellation propagates to all children
func demonstratePropagation() {
    // Create parent with 100ms timeout
    parent, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    // Create children with longer timeouts
    child1, cancel1 := context.WithTimeout(parent, 5*time.Second)
    defer cancel1()

    child2, cancel2 := context.WithTimeout(parent, 10*time.Second)
    defer cancel2()

    var wg sync.WaitGroup
    wg.Add(3)

    // Parent times out after 100ms
    go func() {
        defer wg.Done()
        <-parent.Done()
        fmt.Println("Parent done:", parent.Err())
    }()

    // Children also canceled when parent times out
    go func() {
        defer wg.Done()
        <-child1.Done()
        fmt.Println("Child1 done:", child1.Err())
    }()

    go func() {
        defer wg.Done()
        <-child2.Done()
        fmt.Println("Child2 done:", child2.Err())
    }()

    wg.Wait()
    // Output: All three print after ~100ms with DeadlineExceeded
}
```

### Manual Cancellation Patterns

`context.WithCancel` gives you an explicit `cancel` function that you can call to abort all downstream work on demand. The fail-fast pattern is: the first goroutine to encounter an error calls `cancel`, which propagates through the shared context and aborts every other in-flight request.

Here is the version people write, and it has a bug that hides until production:

```go
// BROKEN: races done against errCh
func fetchAll(ctx context.Context, urls []string) ([]Response, error) {
    // ... goroutines fetch, and on error do: errCh <- err - cancel() ...

    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return responses, nil // <-- reachable even when errCh has an error!
    case err := <-errCh:
        return nil, err
    }
}
```

The failing goroutine sends to `errCh` and *then* calls `wg.Done()`, so by the time `done` closes, `errCh` already holds an error. Both cases are ready. **`select` chooses uniformly at random among ready cases**, so this returns `(responses, nil)` and silently discards the error roughly half the time. Measured over 2000 runs where the fetches complete before the parent reaches the `select`: **1024 errors silently swallowed, 51%**.

It hides in testing because when the work is slow, the parent is already parked in `select` when `errCh` receives its value, so `errCh` wins by arriving first. Make the fetches fast, or let the scheduler delay the parent under load, and both cases become ready together and the coin flip starts.

The fix is to stop racing them. Wait for all goroutines, then check for an error deterministically:

```go
// Correct: wait for completion, THEN check for an error.
func fetchAll(ctx context.Context, urls []string) ([]Response, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    responses := make([]Response, len(urls))
    errCh := make(chan error, 1)
    var wg sync.WaitGroup

    for i, url := range urls {
        wg.Add(1)
        go func() {
            defer wg.Done()

            resp, err := fetch(ctx, url)
            if err != nil {
                select {
                case errCh <- err: // keep only the first error
                    cancel()       // stop the other goroutines
                default:
                }
                return
            }
            responses[i] = resp // distinct index per goroutine: no race
        }()
    }

    wg.Wait() // every goroutine has finished writing to responses

    select {
    case err := <-errCh:
        return nil, err
    default:
        return responses, nil
    }
}
```

Waiting for `wg.Wait()` costs nothing in the error case, because `cancel()` already told the other goroutines to abandon their work. It also removes a second, quieter hazard: the broken version returns `responses` while goroutines may still be writing into it.

Note the `i, url := i, url` line is gone. Since Go 1.22 loop variables are per-iteration, so the closure already captures its own copy. In Go 1.21 and earlier that line was load-bearing and its absence was a classic bug.

**In real code, use `errgroup`.** Everything above is what `golang.org/x/sync/errgroup` already does correctly:

```go
func fetchAll(ctx context.Context, urls []string) ([]Response, error) {
    g, ctx := errgroup.WithContext(ctx) // ctx is canceled on first error
    responses := make([]Response, len(urls))

    for i, url := range urls {
        g.Go(func() error {
            resp, err := fetch(ctx, url)
            if err != nil {
                return err // errgroup records it and cancels ctx
            }
            responses[i] = resp
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return responses, nil
}
```

Same semantics, no `errCh`, no `sync.WaitGroup`, no `select` to get wrong, and the cancel-on-first-error is built in. The hand-rolled version is worth understanding precisely so you can recognize what `errgroup` is saving you from.

```go
// Cancel with cause (Go 1.20+)
func fetchWithCause(ctx context.Context, url string) (*Response, error) {
    ctx, cancel := context.WithCancelCause(ctx)
    defer cancel(nil) // nil cause on normal completion

    // Use NewRequestWithContext: http.Get ignores ctx entirely, so the
    // request would not be cancellable and the deadline would not apply.
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        cancel(fmt.Errorf("HTTP request failed: %w", err))
        return nil, context.Cause(ctx)
    }
    defer resp.Body.Close()

    return parseResponse(resp)
}
```

The `http.NewRequestWithContext` detail is not incidental. `http.Get(url)` takes no context, so a function that carefully derives a cancellable context and then calls `http.Get` has built the cancellation machinery and wired it to nothing. The request runs to completion regardless of deadline or cancellation. This is one of the most common ways context propagation silently breaks.

### Cancellation-Aware Cleanup

A key insight when writing cleanup logic is that the original context is already canceled, so it cannot be reused for cleanup operations. Any call you make with it returns `context.Canceled` immediately, which means your cleanup silently does nothing. Cleanup needs a fresh context with its own deadline.

The obvious move is `context.WithTimeout(context.Background(), ...)`, and it works, but it throws away every request-scoped value: trace IDs, request IDs, user identity. Your cleanup then runs untraceable, which is unfortunate given cleanup paths are exactly what you want traced when they go wrong.

Since Go 1.21, `context.WithoutCancel(ctx)` is the better tool. It keeps the values and drops only the cancellation, which is precisely the requirement.

```go
type Worker struct {
    tasks chan Task
    done  chan struct{}
}

func (w *Worker) Run(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            // Graceful cleanup
            return w.cleanup(ctx)
        case task := <-w.tasks:
            if err := w.process(ctx, task); err != nil {
                // Log but continue
                log.Printf("Task failed: %v", err)
            }
        }
    }
}

func (w *Worker) cleanup(ctx context.Context) error {
    // ctx is already canceled here: every call made with it would fail
    // instantly. WithoutCancel (Go 1.21) strips the cancellation while
    // KEEPING the values, so cleanup stays traceable. Using
    // context.Background() here would work too, but would silently drop
    // the trace and request IDs.
    cleanupCtx, cancel := context.WithTimeout(
        context.WithoutCancel(ctx), 30*time.Second)
    defer cancel()

    // Drain remaining tasks
    for {
        select {
        case <-cleanupCtx.Done():
            return cleanupCtx.Err()
        case task, ok := <-w.tasks:
            if !ok {
                close(w.done)
                return nil
            }
            w.process(cleanupCtx, task)
        }
    }
}
```

### Go 1.20+: context.Cause

`context.Cause(ctx)` returns the specific reason a context was canceled, beyond the generic `context.Canceled` or `context.DeadlineExceeded`. Paired with `WithCancelCause`:

```go
ctx, cancel := context.WithCancelCause(parent)
// ...later, cancel with a specific reason:
cancel(errors.New("user disconnected"))

// Downstream:
if ctx.Err() != nil {
    reason := context.Cause(ctx)
    log.Printf("canceled: %v", reason)
}
```

This is a meaningful improvement for diagnostics. Previously, cancellation errors bubbled up as generic `context.Canceled`, making the actual cause invisible in logs. With `Cause`, the reason is recoverable. Use it in production services where multiple cancellation paths converge.

### Go 1.21+: context.WithoutCancel

`context.WithoutCancel(ctx)` returns a new context with the same values as `ctx` but detached from its cancellation. Useful for fire-and-forget operations that should outlive the request:

```go
func HandleRequest(ctx context.Context, req Request) error {
    result, err := process(ctx, req)
    if err != nil { return err }

    // Audit logging should not be canceled by client disconnect
    go auditLog(context.WithoutCancel(ctx), req, result)
    return nil
}
```

The spawned goroutine keeps the request-scoped values (request ID, user) but is not canceled when the HTTP handler returns. This is the correct pattern for audit logs, metric flushes, and other best-effort background work.

### Go 1.21+: context.AfterFunc

`context.AfterFunc(ctx, f)` registers a function to run when `ctx` is canceled. Cleaner than a manual goroutine with `<-ctx.Done()`.

```go
stop := context.AfterFunc(ctx, func() { conn.Close() })
defer stop() // prevents f from running if we return normally
```

### Staff Lens: Cause-Aware Diagnostics

A service without `context.Cause` has blind-spot errors: every cancellation looks the same. A service with it can distinguish client disconnect, admin shutdown, timeout, downstream failure. The diagnostic power is substantial. The staff-level move: propagate specific causes, log them, and emit metrics per cause. This is one of the highest-value migrations a team can make in response to Go 1.20.

---
