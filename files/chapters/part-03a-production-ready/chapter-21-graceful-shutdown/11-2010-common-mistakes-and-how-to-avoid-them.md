## 21.10 Common Mistakes and How to Avoid Them

### Mistake 1: Not Handling Shutdown Signals

Without signal handling, `SIGINT` or `SIGTERM` terminates the process immediately, dropping all in-flight requests with no opportunity to send responses or flush buffers. Calling `signal.Notify` with a buffered channel and `server.Shutdown` gives the server a deadline to complete active connections cleanly before the process exits.

```go
// BAD: No signal handling
func main() {
    http.ListenAndServe(":8080", handler)
    // Ctrl+C kills immediately, requests dropped
}

// GOOD: Handle signals properly
func main() {
    server := &http.Server{Addr: ":8080", Handler: handler}

    go server.ListenAndServe()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    server.Shutdown(ctx)
}
```

### Mistake 2: Using os.Exit During Shutdown

`os.Exit` terminates the process immediately, bypassing all deferred function calls, finalizers, and cleanup registered via `defer`. Structuring the application so that `main` calls a `run()` function and uses `os.Exit` only on the returned error ensures that deferred cleanups, closing databases, flushing buffers, terminating background goroutines, all execute before the process exits.

```go
// BAD: os.Exit prevents cleanup
func handleShutdown() {
    log.Println("Shutting down")
    os.Exit(0) // Deferred functions don't run!
}

// GOOD: Let main() return naturally
func main() {
    if err := run(); err != nil {
        log.Printf("Error: %v", err)
        os.Exit(1)
    }
    // Deferred cleanup runs here
}

func run() error {
    defer cleanup() // This will run

    // ... application code ...

    return nil
}
```

### Mistake 3: Not Waiting for Goroutines

When `main` returns, the Go runtime terminates all goroutines immediately, regardless of what work they are doing. A `sync.WaitGroup` solves this by tracking how many goroutines are still active and blocking the shutdown path until all of them call `Done`. Incrementing the counter with `wg.Add(1)` before spawning the goroutine, not inside it, prevents a race where the scheduler delays the goroutine long enough for `wg.Wait` to return zero prematurely.

```go
// BAD: Orphaned goroutines
func processJob(job Job) {
    go func() {
        // This goroutine might not finish before main exits!
        heavyProcessing(job)
    }()
}

// GOOD: Track goroutines
var wg sync.WaitGroup

func processJob(job Job) {
    wg.Add(1)
    go func() {
        defer wg.Done()
        heavyProcessing(job)
    }()
}

func shutdown() {
    // Wait for all jobs
    wg.Wait()
}
```

Since Go 1.25, `WaitGroup.Go` bundles the `Add(1)`, the `go`, and the `defer Done()` into one call, which removes the chance of getting the pairing wrong:

```go
func processJob(job Job) {
    wg.Go(func() {
        heavyProcessing(job)
    })
}
```

Note what this does not fix. Both forms still let `Add` run concurrently with `Wait` once the counter has hit zero, which is the documented misuse. The shutdown path has to stop new work from being submitted before it waits, and no `WaitGroup` API can do that part for you.

### Mistake 4: Closing Channels Incorrectly

Closing a channel that still has active senders causes a panic at runtime, because a send on a closed channel is an unrecoverable error. The idiomatic pattern is to use context cancellation to signal producers to stop sending, and only close the channel after confirming that all senders have exited, typically by waiting on a `WaitGroup` that tracks each producer goroutine.

```go
// BAD: Closing channel that senders still use
func shutdown() {
    close(jobChan) // Panic if someone sends!
}

// GOOD: Use context for cancellation. The sender closes, and only after
// every producer has returned.
func producer(ctx context.Context, jobs chan<- Job) {
    defer wg.Done()
    for {
        // Check cancellation BEFORE creating the job. See below: putting
        // createJob() inside the select silently discards one job.
        if ctx.Err() != nil {
            return
        }
        job := createJob()
        select {
        case <-ctx.Done():
            requeue(job) // we made it, we are responsible for it
            return
        case jobs <- job:
        }
    }
}

func shutdown() {
    cancel()      // producers stop
    wg.Wait()     // every producer has returned, so no sender remains
    close(jobChan) // now this cannot panic
}
```

**The trap inside that `select`.** The obvious version puts the constructor straight into the send case:

```go
select {
case <-ctx.Done():
    return
case jobs <- createJob(): // evaluated on EVERY pass, even when ctx is done
}
```

Entering a `select` evaluates the operands of every case up front, including the value being sent. So `createJob()` runs before the runtime decides which case can proceed. If cancellation wins the race, the job that was just created is thrown away, never sent, and never returned to whatever it came from. Instrumenting a producer with a side-effecting `createJob` shows it plainly: after consuming 5 jobs and cancelling, `createJob()` had been called **6 times while only 5 were delivered**. One job, created and silently lost, on every producer, on every shutdown.

If `createJob` is a pure allocation, this costs you nothing and you can ignore it. If it pops from an in-memory backlog, increments a sequence, or reserves an ID, it is data loss at exactly the moment you were trying to be careful. Create first, then decide where the job goes, and make the cancellation path responsible for putting it back.

### Mistake 5: Not Considering Kubernetes Endpoint Updates

Kubernetes removes a pod from the endpoints list asynchronously, and that removal races the `SIGTERM` rather than preceding it. There is typically a 1 to 10 second window during which load balancers keep routing traffic to the terminating pod. Failing readiness and then sleeping lets the endpoint update propagate before the server begins refusing connections, which removes the wave of 502 errors that otherwise shows up on every rolling restart.

```go
// BAD: Shutdown immediately on SIGTERM
func main() {
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()
    server.Shutdown(ctx) // LB still sending traffic!
}

// GOOD: Wait for LB to update
func main() {
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM)
    <-quit

    // Fail readiness. Liveness must stay green: we are draining, not wedged.
    ready.Store(false)

    // Wait for the LB to remove us from rotation. We keep serving normally
    // throughout this window, because traffic is still arriving.
    time.Sleep(5 * time.Second)

    // Now stop accepting. The whole budget (5s sleep + 25s drain) has to fit
    // inside terminationGracePeriodSeconds, so that must be above 30.
    ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()
    server.Shutdown(ctx)
}
```

### Mistake 6: Cascading Context Timeout Starvation

A widespread defect in graceful shutdown implementations is passing a single shared `context.WithTimeout` across sequential shutdown phases, as analyzed by [Yaninyz witty (February 2026), "Graceful Shutdown in Go: Why Most Implementations Are Wrong"](https://medium.com/@yaninyzwitty/graceful-shutdown-in-go-why-most-implementations-are-wrong-f5979c3230b5).

```go
// WRONG: Single timeout shared across sequential steps
ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()

if err := server.Shutdown(ctx); err != nil { // consumes 9.8 seconds
    log.Printf("server shutdown: %v", err)
}

// Workers and DB have only 200ms remaining before deadline cancellation!
if err := workerPool.Drain(ctx); err != nil { 
    log.Printf("worker drain: %v", err) // context deadline exceeded
}
db.Close() // closed abruptly while workers were still executing queries
```

When HTTP traffic takes the majority of the 10-second budget to drain long-polling or file-upload connections, downstream workers and message consumers experience immediate deadline cancellation. Furthermore, closing database connection pools before workers finish executing causes sudden `sql: database is closed` errors during rolling deployments.

#### The Deterministic Multi-Stage Shutdown Pipeline

A resilient shutdown sequence requires reverse-dependency ordering with isolated phase budgets:

```
Stage 1: Deregister Ingress (Fail readiness probe, sleep 5s for LB endpoint propagation)
   │
   ▼
Stage 2: Stop Ingress (http.Server.Shutdown with dedicated 10s budget)
   │
   ▼
Stage 3: Drain Background Workers (Stop queue consumers, drain active jobs with 15s budget)
   │
   ▼
Stage 4: Flush Buffers (Flush write-ahead logs, metrics, trace exporters)
   │
   ▼
Stage 5: Teardown Infrastructure (Close DB pools, Redis clients, message broker connections)
```

Implementation of a phase-budgeted shutdown runner:

```go
package shutdown

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

type Phase struct {
	Name    string
	Timeout time.Duration
	Action  func(ctx context.Context) error
}

type Runner struct {
	logger *slog.Logger
	phases []Phase
}

func NewRunner(logger *slog.Logger) *Runner {
	return &Runner{logger: logger}
}

func (r *Runner) Register(name string, timeout time.Duration, action func(ctx context.Context) error) {
	r.phases = append(r.phases, Phase{Name: name, Timeout: timeout, Action: action})
}

// Execute executes each shutdown phase sequentially with an isolated timeout budget.
func (r *Runner) Execute(parentCtx context.Context) error {
	var errs []error

	for _, phase := range r.phases {
		r.logger.Info("starting shutdown phase", "phase", phase.Name, "timeout", phase.Timeout)

		phaseCtx, cancel := context.WithTimeout(parentCtx, phase.Timeout)
		done := make(chan error, 1)

		go func() {
			done <- phase.Action(phaseCtx)
		}()

		select {
		case err := <-done:
			cancel()
			if err != nil {
				r.logger.Error("shutdown phase failed", "phase", phase.Name, "error", err)
				errs = append(errs, fmt.Errorf("phase %s: %w", phase.Name, err))
			} else {
				r.logger.Info("shutdown phase completed", "phase", phase.Name)
			}
		case <-phaseCtx.Done():
			cancel()
			r.logger.Error("shutdown phase timed out", "phase", phase.Name)
			errs = append(errs, fmt.Errorf("phase %s: deadline exceeded", phase.Name))
		}
	}

	return errors.Join(errs...)
}
```

### Additional Mistakes

1. **Shutdown timeout longer than grace period.** Kubernetes sends SIGKILL before your Shutdown completes.
2. **Ignoring context in handlers.** Handlers block shutdown past the deadline.
3. **Closing resources before workers finish.** Workers fail mid-task with "database closed" errors.
4. **Not flushing telemetry.** Logs, metrics, and traces from the last few seconds are lost.
5. **Not testing shutdown.** Shutdown code runs in production and nowhere else. Test it in staging with real signals.

### Staff Lens: Chaos Test Shutdown

Simulate shutdown periodically in staging. Send SIGTERM to a running service under load. Verify no requests dropped, no errors logged during drain, no data lost. Services that pass this test have real graceful shutdown. Services that fail have shutdown bugs waiting for production.

---
