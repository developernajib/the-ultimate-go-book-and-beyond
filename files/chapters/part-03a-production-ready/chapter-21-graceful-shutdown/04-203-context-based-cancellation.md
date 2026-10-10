## 21.3 Context-Based Cancellation

### Application-Wide Context

A single root context, canceled when an OS signal arrives, provides a clean shutdown mechanism that propagates automatically through every component of the application. The goroutine below listens for `SIGINT` and `SIGTERM` and calls `cancel()` on receipt, which causes the context's `Done` channel to close and unblocks any code waiting on it. Using `errgroup.WithContext` ties the HTTP server and background workers together so that a failure in any single component also cancels the others, preventing the process from hanging indefinitely.

```go
func main() {
    // signal.NotifyContext does the job of the goroutine below in one line.
    // The explicit form is shown here to make the wiring visible.
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel() // releases the context if run() returns on its own

    // Signal handler
    go func() {
        quit := make(chan os.Signal, 1)
        signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
        <-quit
        log.Println("Shutdown signal received")
        cancel()
    }()

    // Run application components
    if err := run(ctx); err != nil && !errors.Is(err, context.Canceled) {
        log.Fatalf("Application error: %v", err)
    }
}

func run(ctx context.Context) error {
    g, ctx := errgroup.WithContext(ctx)

    // HTTP server
    g.Go(func() error {
        return runHTTPServer(ctx)
    })

    // Background workers
    g.Go(func() error {
        return runWorker(ctx)
    })

    return g.Wait()
}
```

### Worker Shutdown

A well-behaved background worker must check for context cancellation on every iteration rather than only at startup, since shutdown can arrive at any point during a long-running job loop. The `select` statement in `runWorker` gives the cancellation signal priority over new work, ensuring the worker exits promptly without picking up additional jobs after shutdown has been requested. The `processNextJob` function also selects on `ctx.Done()` alongside the job queue and a timeout, so no single blocking receive can stall the shutdown sequence.

```go
func runWorker(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            log.Println("Worker shutting down")
            return ctx.Err()
        default:
            if err := processNextJob(ctx); err != nil {
                log.Printf("Job error: %v", err)
            }
        }
    }
}

func processNextJob(ctx context.Context) error {
    // Respect context in long operations
    select {
    case <-ctx.Done():
        return ctx.Err()
    case job := <-jobQueue:
        return processJob(ctx, job)
    case <-time.After(5 * time.Second):
        return nil // No job, check context again
    }
}
```

One caveat worth stating precisely, because it trips people up. Inside `processNextJob`, `ctx.Done()` and `jobQueue` are two cases of the same `select`. When both are ready, Go picks one **at random**. So a worker can still pull one more job off the queue on the same tick that cancellation arrives. The outer loop in `runWorker` is what bounds this: it re-checks `ctx.Done()` before the next call, so the worst case is a single extra job, not an unbounded stream. That is usually fine, since `processJob` receives the canceled context and should bail out early. If you need a hard stop with no extra job at all, check cancellation again after the receive:

```go
case job := <-jobQueue:
    if ctx.Err() != nil {
        requeue(job) // do not start work we cannot finish
        return ctx.Err()
    }
    return processJob(ctx, job)
```

### Staff Lens: Shutdown-Awareness Is a Design Property

Every goroutine in the service must respect the shutdown context. Goroutines that do not are leaks at best, stuck processes at worst. Review every `go` statement in the codebase: does the spawned goroutine take a context? Does it check `ctx.Done()`?

The pattern of "every goroutine accepts context as first parameter and respects it" is the simplest way to ensure the entire service shuts down cleanly.

---
