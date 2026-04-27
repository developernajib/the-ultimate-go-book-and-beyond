export default `## 11.7 Error Handling in Concurrent Code

Handling errors in concurrent code requires careful design.

### Error Channel Pattern

The cleanest approach to collecting errors from concurrent goroutines is to pair each result with its error in a dedicated struct and funnel everything through a single buffered channel. Buffering the channel to the number of goroutines prevents any worker from blocking on send, while a separate goroutine calls \`wg.Wait()\` then closes the channel so the collector loop can range over it cleanly. This design lets you accumulate all errors rather than short-circuiting on the first one, which is useful when you want a full picture of what failed.

\`\`\`go
type Result struct {
    Value int
    Err   error
}

func processAll(items []int) ([]int, error) {
    results := make(chan Result, len(items))

    var wg sync.WaitGroup
    for _, item := range items {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            value, err := process(i)
            results <- Result{Value: value, Err: err}
        }(item)
    }

    // Close channel when all goroutines complete
    go func() {
        wg.Wait()
        close(results)
    }()

    // Collect results
    var values []int
    var errs []error
    for r := range results {
        if r.Err != nil {
            errs = append(errs, r.Err)
        } else {
            values = append(values, r.Value)
        }
    }

    if len(errs) > 0 {
        return values, fmt.Errorf("encountered %d errors: %v", len(errs), errs)
    }
    return values, nil
}
\`\`\`

### First Error Cancellation with errgroup

When you want to cancel all in-flight work as soon as one goroutine fails, the \`golang.org/x/sync/errgroup\` package handles the boilerplate. \`errgroup.WithContext\` returns a derived context that is cancelled automatically when any goroutine returns a non-nil error, and \`g.Wait()\` blocks until all goroutines finish and returns the first error encountered. This eliminates manual \`WaitGroup\` management and context wiring.

\`\`\`go
import "golang.org/x/sync/errgroup"

func fetchAll(ctx context.Context, urls []string) ([]Response, error) {
    g, ctx := errgroup.WithContext(ctx)
    responses := make([]Response, len(urls))

    for i, url := range urls {
        i, url := i, url  // Capture for goroutine
        g.Go(func() error {
            resp, err := fetchWithContext(ctx, url)
            if err != nil {
                return err  // First error cancels context
            }
            responses[i] = resp
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err  // Return first error
    }
    return responses, nil
}
\`\`\`

### errgroup with Limit

\`errgroup.SetLimit\` caps the number of goroutines that can be active at any one time, making it straightforward to avoid overwhelming downstream services or exhausting file descriptors. The call to \`g.Go\` blocks when the limit is reached and resumes as running goroutines finish, giving you a built-in semaphore without any manual \`sync.Mutex\` or counting channel. Combining this with context propagation means that if any one fetch fails, all pending goroutines will see the cancelled context and exit early.

\`\`\`go
func fetchAllLimited(ctx context.Context, urls []string) ([]Response, error) {
    g, ctx := errgroup.WithContext(ctx)
    g.SetLimit(10)  // Max 10 concurrent fetches

    responses := make([]Response, len(urls))

    for i, url := range urls {
        i, url := i, url
        g.Go(func() error {
            resp, err := fetchWithContext(ctx, url)
            if err != nil {
                return err
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
\`\`\`

### Panic Recovery in Goroutines

A panic in one goroutine crashes the entire process, it does not propagate to the goroutine that spawned it. If you call third-party code or any function that might panic, wrap it with a \`defer recover()\` inside the goroutine. The \`safeGo\` helper below captures panics, logs the stack trace via \`debug.Stack()\`, and lets the rest of the program continue normally.

\`\`\`go
func safeGo(fn func()) {
    go func() {
        defer func() {
            if r := recover(); r != nil {
                log.Printf("recovered from panic: %v\\nstack: %s", r, debug.Stack())
            }
        }()
        fn()
    }()
}

// Usage
safeGo(func() {
    // If this panics, it's recovered
    riskyOperation()
})
\`\`\`

### Error Aggregation Pattern

When you need to collect every error from a concurrent fan-out rather than stopping at the first failure, implementing a thread-safe \`MultiError\` type gives you a reusable aggregator. The mutex protects the internal slice so multiple goroutines can call \`Add\` concurrently without data races, and the \`Err\` method returns \`nil\` when no errors occurred, integrating cleanly with callers that simply check \`if err != nil\`. This pattern is especially useful in batch processing pipelines where partial success is acceptable and callers need a complete report of all failures.

\`\`\`go
type MultiError struct {
    errors []error
    mu     sync.Mutex
}

func (m *MultiError) Add(err error) {
    if err == nil {
        return
    }
    m.mu.Lock()
    m.errors = append(m.errors, err)
    m.mu.Unlock()
}

func (m *MultiError) Error() string {
    m.mu.Lock()
    defer m.mu.Unlock()

    if len(m.errors) == 0 {
        return ""
    }

    var msgs []string
    for _, err := range m.errors {
        msgs = append(msgs, err.Error())
    }
    return strings.Join(msgs, "; ")
}

func (m *MultiError) Err() error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if len(m.errors) == 0 {
        return nil
    }
    return m
}

// Usage
func processAll(items []Item) error {
    var me MultiError
    var wg sync.WaitGroup

    for _, item := range items {
        wg.Add(1)
        go func(i Item) {
            defer wg.Done()
            if err := process(i); err != nil {
                me.Add(err)
            }
        }(item)
    }

    wg.Wait()
    return me.Err()
}
\`\`\`

### Go 1.20+: errors.Join

The hand-rolled \`MultiError\` above predates Go 1.20's \`errors.Join\`. In modern Go, use the stdlib:

\`\`\`go
var errs []error
for err := range errCh {
    if err != nil { errs = append(errs, err) }
}
return errors.Join(errs...)
\`\`\`

\`errors.Join\` returns a single \`error\` value that wraps all inputs. Callers can use \`errors.Is\` and \`errors.As\` to inspect any wrapped error. No custom type needed. The \`MultiError\` pattern above is teaching material. New code should use \`errors.Join\`.

### The Three Error-Handling Shapes

For concurrent Go, the error-handling shape is one of three:

1. **Fail fast, cancel the rest.** \`errgroup.WithContext\`. First error wins, context cancels, other goroutines exit early. Default for request-handling code where partial success is not useful.
2. **Collect all errors, continue.** WaitGroup plus error channel plus \`errors.Join\`. Useful for batch operations where you want a full report of what failed.
3. **Fire and forget.** Goroutines log their own errors and never propagate. Acceptable only for genuinely best-effort background work (metric emission, cache warming) where the caller does not care about the outcome.

The review question: which shape is this code using, and is it the right one for the semantics? A batch job that should collect all errors but uses \`errgroup\` will hide failures. A request handler that should fail fast but uses accumulation will return success with hidden errors. Wrong shape is silent failure.

### Panic Recovery at Goroutine Boundaries

The panic-recovery pattern shown above is not optional in a production service. Every goroutine that runs user code, third-party libraries, or anything that can fail in unpredictable ways needs a recover boundary at its top level. Without it, a single panic crashes the whole service. With it, the panic is logged, metrics are emitted, and the service continues. The shape of the recovery:

\`\`\`go
func safeGo(ctx context.Context, name string, fn func(context.Context) error) {
    go func() {
        defer func() {
            if r := recover(); r != nil {
                // Log with goroutine name, stack, context
                slog.ErrorContext(ctx, "goroutine panic",
                    "name", name, "panic", r, "stack", string(debug.Stack()))
                metrics.PanicCounter.Inc(name)
            }
        }()
        if err := fn(ctx); err != nil {
            slog.ErrorContext(ctx, "goroutine error", "name", name, "error", err)
        }
    }()
}
\`\`\`

Use this for every long-running goroutine. The name gives you dashboardable metrics. The stack gives you diagnosis. The context carries the trace correlation ID if you have one wired up.

### Staff Lens: Error Handling as an Invariant

The team that ships concurrent Go with inconsistent error handling ships concurrent Go with inconsistent observability. Every goroutine leak, every silent failure, every "why did this service suddenly degrade", traces back to missing error handling discipline. The staff-level investment: codify the three shapes in a team doc, provide a shared \`safeGo\` helper that enforces the recover boundary, wire the goroutine-panic metric into the dashboards, and review every concurrent PR against this checklist. Done consistently, this catches 90% of the preventable concurrency incidents before they reach production.

### Principal Lens: Errors That Cross Goroutines Are Also Errors That Cross Services

The error-handling patterns in a single process generalise to distributed systems. \`errgroup\` is in-process fan-out with cancellation on first error. A distributed equivalent is a parallel RPC fan-out with a context that cancels on first error. The patterns are parallel. The principal-level design question is: where do the errors get handled, and where do they cross boundaries? An error that a goroutine swallows silently is as bad as an error that a downstream RPC swallows silently. Design the error propagation path before writing the concurrent code. If the design does not have an error path for every concurrent operation, the design is incomplete. This is one of the most common staff-and-above design review findings and one of the highest-leverage places to intervene.

---
`;
