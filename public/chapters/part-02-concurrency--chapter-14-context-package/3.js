export default `## 14.2 Cancellation: Stopping Work Gracefully

Cancellation is the primary use case for context. It allows parent operations to signal that downstream work should stop.

### Detecting Cancellation

There are three idiomatic ways to check whether a context has been cancelled. The \`select\` with \`ctx.Done()\` and a \`default\` branch is non-blocking and is the most common pattern inside tight loops. For stream processing where the goroutine must also wait on a data channel, omitting the \`default\` branch lets the \`select\` block efficiently on whichever event arrives first.

\`\`\`go
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
\`\`\`

### Propagating Cancellation

Child contexts inherit cancellation from their parent: when a parent context is cancelled or times out, all derived child contexts are cancelled simultaneously regardless of their own deadlines. In the example below, both children are created with much longer timeouts, but because the parent expires after 100 milliseconds all three contexts fire at the same time.

\`\`\`go
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

    // Children also cancelled when parent times out
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
\`\`\`

### Manual Cancellation Patterns

\`context.WithCancel\` gives you an explicit \`cancel\` function that you can call to abort all downstream work on demand. The \`fetchAll\` function below demonstrates a fail-fast pattern: the first goroutine to encounter an error calls \`cancel\`, which propagates through the shared context and causes all other in-flight HTTP requests to abort. Go 1.20's \`WithCancelCause\` extends this by letting you attach a specific error to the cancellation so callers can distinguish the root cause from a generic \`context.Canceled\`.

\`\`\`go
// Cancel on first error
func fetchAll(ctx context.Context, urls []string) ([]Response, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    responses := make([]Response, len(urls))
    errCh := make(chan error, 1)
    var wg sync.WaitGroup

    for i, url := range urls {
        i, url := i, url
        wg.Add(1)
        go func() {
            defer wg.Done()

            resp, err := fetch(ctx, url)
            if err != nil {
                select {
                case errCh <- err:
                    cancel() // Cancel other goroutines
                default:
                }
                return
            }
            responses[i] = resp
        }()
    }

    // Wait for completion in separate goroutine
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    // Wait for completion or error
    select {
    case <-done:
        return responses, nil
    case err := <-errCh:
        return nil, err
    }
}

// Cancel with cause (Go 1.20+)
func fetchWithCause(ctx context.Context, url string) (*Response, error) {
    ctx, cancel := context.WithCancelCause(ctx)
    defer cancel(nil) // Pass nil for normal completion

    resp, err := http.Get(url)
    if err != nil {
        cancel(fmt.Errorf("HTTP request failed: %w", err))
        return nil, context.Cause(ctx)
    }

    return parseResponse(resp)
}
\`\`\`

### Cancellation-Aware Cleanup

A key insight when writing cleanup logic is that the original context is already cancelled, so it must not be reused for cleanup operations. The \`cleanup\` method creates a fresh \`context.Background\`-derived context with its own timeout, ensuring cleanup has a meaningful deadline independent of whatever caused the original cancellation.

\`\`\`go
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
    // Create a new context for cleanup with its own timeout
    // Don't use cancelled context!
    cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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
\`\`\`

### Go 1.20+: context.Cause

\`context.Cause(ctx)\` returns the specific reason a context was cancelled, beyond the generic \`context.Canceled\` or \`context.DeadlineExceeded\`. Paired with \`WithCancelCause\`:

\`\`\`go
ctx, cancel := context.WithCancelCause(parent)
// ...later, cancel with a specific reason:
cancel(errors.New("user disconnected"))

// Downstream:
if ctx.Err() != nil {
    reason := context.Cause(ctx)
    log.Printf("cancelled: %v", reason)
}
\`\`\`

This is a meaningful improvement for diagnostics. Previously, cancellation errors bubbled up as generic \`context.Canceled\`, making the actual cause invisible in logs. With \`Cause\`, the reason is recoverable. Use it in production services where multiple cancellation paths converge.

### Go 1.21+: context.WithoutCancel

\`context.WithoutCancel(ctx)\` returns a new context with the same values as \`ctx\` but detached from its cancellation. Useful for fire-and-forget operations that should outlive the request:

\`\`\`go
func HandleRequest(ctx context.Context, req Request) error {
    result, err := process(ctx, req)
    if err != nil { return err }

    // Audit logging should not be cancelled by client disconnect
    go auditLog(context.WithoutCancel(ctx), req, result)
    return nil
}
\`\`\`

The spawned goroutine keeps the request-scoped values (request ID, user) but is not cancelled when the HTTP handler returns. This is the correct pattern for audit logs, metric flushes, and other best-effort background work.

### Go 1.21+: context.AfterFunc

\`context.AfterFunc(ctx, f)\` registers a function to run when \`ctx\` is cancelled. Cleaner than a manual goroutine with \`<-ctx.Done()\`.

\`\`\`go
stop := context.AfterFunc(ctx, func() { conn.Close() })
defer stop() // prevents f from running if we return normally
\`\`\`

### Staff Lens: Cause-Aware Diagnostics

A service without \`context.Cause\` has blind-spot errors: every cancellation looks the same. A service with it can distinguish client disconnect, admin shutdown, timeout, downstream failure. The diagnostic power is substantial. The staff-level move: propagate specific causes, log them, and emit metrics per cause. This is one of the highest-value migrations a team can make in response to Go 1.20.

---
`;
