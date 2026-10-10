## Graceful Shutdown Pitfalls: When Shutdowns Aren't So Graceful

This section covers the most dangerous shutdown mistakes that cause data loss, broken connections, and user-facing errors during deployments.

### The Kubernetes Drain Race Condition

**The Incident**: Deployments cause 5xx errors for 10 seconds. The pod is killed before the load balancer stops routing traffic.

```go
// WRONG: Immediate shutdown on signal

func main() {
    server := &http.Server{Addr: ":8080", Handler: router}

    go server.ListenAndServe()

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM)
    <-sigChan

    // Problem: Kubernetes sends SIGTERM, but load balancer still sends traffic
    // During the ~5 second window, requests hit a dying pod
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    server.Shutdown(ctx)
}
```

The fix adds three steps between receiving `SIGTERM` and calling `Shutdown`: mark the readiness probe as failing, sleep long enough for the load balancer to drain, then shut down the listener. This eliminates the window where new requests arrive at a server that has already begun tearing down.

```go
// CORRECT: Pre-stop delay for Kubernetes

func main() {
    var shuttingDown atomic.Bool
    server := &http.Server{Addr: ":8080", Handler: router}

    // Health endpoint checks shutdown state
    http.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
        if shuttingDown.Load() {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    })

    go server.ListenAndServe()

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM)
    <-sigChan

    // Step 1: Mark as unhealthy IMMEDIATELY
    shuttingDown.Store(true)
    log.Println("Marked as unhealthy, waiting for load balancer...")

    // Step 2: Wait for Kubernetes to remove us from endpoints. We keep
    // serving normally here: traffic is still arriving, and 503ing it now
    // would cause the very errors this sleep exists to prevent.
    // Size this from measurement, not folklore. 5s is a starting guess.
    time.Sleep(5 * time.Second)

    // Step 3: Now shutdown, existing requests will complete.
    // Budget check: 5s sleep + 20s drain = 25s, which must fit inside
    // terminationGracePeriodSeconds (30s default) with room for cleanup.
    // Using 25s here instead of 20s would leave exactly zero headroom.
    log.Println("Draining existing connections...")
    ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }
}
```

### The Hung Goroutine Problem

**The Scenario**: Shutdown hangs forever because a goroutine is blocked on a channel or network call.

```go
// WRONG: Background worker without shutdown support

func main() {
    // Start background worker
    go func() {
        for {
            job := <-jobQueue  // Blocks forever if queue is empty
            processJob(job)
        }
    }()

    // On shutdown, this goroutine never exits
    // The process hangs or is killed forcefully
}
```

The corrected version wraps the worker in a `WaitGroup`, selects on `ctx.Done()` alongside the job channel, and applies a per-job timeout. The shutdown path cancels the context, then waits for the `WaitGroup` with its own deadline so a stuck job cannot block the process indefinitely.

```go
// CORRECT: Background worker with graceful shutdown

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    var wg sync.WaitGroup

    // Start background worker
    wg.Add(1)
    go func() {
        defer wg.Done()
        for {
            select {
            case <-ctx.Done():
                log.Println("Worker shutting down")
                return
            case job := <-jobQueue:
                // Process with timeout
                jobCtx, jobCancel := context.WithTimeout(ctx, 30*time.Second)
                processJob(jobCtx, job)
                jobCancel()
            }
        }
    }()

    // Signal handler
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down...")

    // Cancel context to stop workers
    cancel()

    // Wait for workers with timeout
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Println("Clean shutdown complete")
    case <-time.After(30 * time.Second):
        log.Println("Shutdown timed out, forcing exit")
    }
}
```

### The Database Connection Leak

**The Problem**: Active database connections are killed mid-transaction, causing data corruption or locks.

```go
// WRONG: Force close database on shutdown

func main() {
    db, _ := sql.Open("postgres", connStr)
    defer db.Close()  // Close() doesn't wait for active transactions!

    // ... application runs ...

    // On SIGTERM, db.Close() is called
    // Active transactions are killed mid-way
    // Potential partial writes, deadlocks, or corruption
}
```

The fix wraps the `*sql.DB` in a manager that tracks active queries with a `WaitGroup`. On shutdown, it waits for all in-flight queries to finish before calling `db.Close()`, and uses `sync.Once` on `trackedRows.Close` to prevent double-decrement if a caller closes rows more than once.

```go
// CORRECT: Drain database connections gracefully

type DatabaseManager struct {
    db     *sql.DB
    active sync.WaitGroup
}

func (m *DatabaseManager) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    m.active.Add(1)
    rows, err := m.db.QueryContext(ctx, query, args...)
    // Note: caller is responsible for calling rows.Close() which decrements
    return &trackedRows{Rows: rows, wg: &m.active}, err
}

type trackedRows struct {
    *sql.Rows
    wg *sync.WaitGroup
    once sync.Once
}

func (r *trackedRows) Close() error {
    var err error
    r.once.Do(func() {
        err = r.Rows.Close()
        r.wg.Done()
    })
    return err
}

func (m *DatabaseManager) Shutdown(ctx context.Context) error {
    // Wait for active queries to complete
    done := make(chan struct{})
    go func() {
        m.active.Wait()
        close(done)
    }()

    select {
    case <-done:
        return m.db.Close()
    case <-ctx.Done():
        // Force close after timeout
        m.db.Close()
        return ctx.Err()
    }
}
```

### The Lost In-Flight Request

**The Incident**: Long-running API requests (file uploads, report generation) fail because the server shuts down mid-processing.

```go
// WRONG: Shutdown kills long-running requests

func handleLongRequest(w http.ResponseWriter, r *http.Request) {
    // 2-minute report generation
    report := generateReport()  // If shutdown during this, request fails
    json.NewEncoder(w).Encode(report)
}

// Server.Shutdown(ctx) with 30s timeout kills this request
```

Be clear about what the real fix is, because request-tracking middleware is *not* it. `http.Server.Shutdown` already waits for in-flight handlers. If a 2-minute report dies during a 30-second drain, no amount of extra `WaitGroup` bookkeeping saves it. The request was killed by the **budget**, and only two things change the outcome:

1. **Raise the budget** so the drain and `terminationGracePeriodSeconds` actually cover the work. A 2-minute request needs a grace period north of 2 minutes, on every pod, for every deploy.
2. **Stop having 2-minute requests.** Make the endpoint enqueue a job and return `202` with a status URL. Now the drain only has to outlive the enqueue, and the report survives the pod dying because it was never tied to a connection.

Option 2 is nearly always the right answer. Option 1 makes every deployment as slow as your slowest request and still loses the work when a node is preempted.

Where tracking middleware *does* earn its place is observability and correct sequencing: knowing how many requests are in flight, and gating the readiness probe on it. Written correctly it looks like this. Note the `RWMutex`, which is what stops an `Add` from landing after `Wait` has already returned:

```go
// Request tracking, for readiness gating and visibility.

type RequestTracker struct {
    active sync.WaitGroup
    count  atomic.Int64

    mu        sync.RWMutex
    accepting bool
}

func NewRequestTracker() *RequestTracker {
    return &RequestTracker{accepting: true}
}

func (t *RequestTracker) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // The check and the Add must be one step, or Shutdown can slip
        // between them and Wait will miss this request.
        t.mu.RLock()
        if !t.accepting {
            t.mu.RUnlock()
            http.Error(w, "Service shutting down", http.StatusServiceUnavailable)
            return
        }
        t.active.Add(1)
        t.count.Add(1)
        t.mu.RUnlock()

        defer func() {
            t.count.Add(-1)
            t.active.Done()
        }()

        next.ServeHTTP(w, r)
    })
}

func (t *RequestTracker) ActiveCount() int64 { return t.count.Load() }

func (t *RequestTracker) Shutdown(timeout time.Duration) {
    t.mu.Lock()
    t.accepting = false
    t.mu.Unlock()

    done := make(chan struct{})
    go func() {
        t.active.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Println("All requests completed")
    case <-time.After(timeout):
        log.Printf("Warning: %d requests still in-flight after timeout", t.ActiveCount())
    }
}
```

The original of this snippet called `t.activeCount()`, a method that did not exist anywhere, so it did not compile. That is worth noticing: the `WaitGroup` alone cannot tell you its own counter, which is exactly why the separate `atomic.Int64` is here. If you want to log how many requests are stuck, you have to count them yourself.

### The Signal Storm

**The Problem**: Multiple SIGTERM signals run the shutdown sequence more than once concurrently.

Be precise about what actually breaks, because the usual telling of this pitfall is wrong. `(*sql.DB).Close` is **idempotent**: calling it three times in a row returns `nil, nil, nil` and panics nothing. Nor is a data race in Go "undefined behavior" in the C sense. The Go memory model defines racy programs, and the race detector will name them.

What genuinely breaks under a repeated shutdown is narrower and worth knowing:

- `close(ch)` on an already-closed channel panics. This is the real one.
- `WaitGroup.Done` past zero panics with a negative counter.
- Your own cleanup running twice: double-decremented metrics, a second flush racing the first, a temp file removed while its replacement is being renamed into place.
- Two shutdown sequences interleaving, so phase 3 of one runs against phase 5 of the other.

So the fix below is right, and the reason is "make the sequence run exactly once", not "prevent a `db.Close` panic that would never have happened".

```go
// WRONG: Not handling multiple signals

var db *sql.DB

func shutdown() {
    close(doneCh) // second signal panics: close of closed channel
    db.Close()    // (this line is actually fine: Close is idempotent)
}

func main() {
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM)

    go func() {
        for range sigChan {
            shutdown()  // Called on every signal!
        }
    }()
}
```

Using `sync.Once` ensures the shutdown function executes exactly once regardless of how many signals arrive. Subsequent signals are logged but ignored, preventing double-close panics on channels, database handles, and file descriptors.

```go
// CORRECT: Handle signals exactly once

func main() {
    var shutdownOnce sync.Once

    shutdown := func() {
        shutdownOnce.Do(func() {
            log.Println("Starting shutdown...")
            // Shutdown logic here, guaranteed to run only once
            close(doneCh) // safe now: exactly one caller reaches this
            db.Close()
            log.Println("Shutdown complete")
        })
    }

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)

    finished := make(chan struct{})
    go func() {
        defer close(finished)

        sig := <-sigChan
        log.Printf("Received signal: %v", sig)
        shutdown()
    }()

    // main MUST block here. Returning from main kills the process and every
    // goroutine in it, so a main that only spawns the handler and falls off
    // the end exits before any signal can arrive.
    <-finished
}
```

`sync.Once` also gives you a property a plain boolean does not: it *blocks*. If two signals arrive close enough together that two goroutines call `shutdown` at once, the second `Do` does not return early, it waits until the first has finished. So callers can rely on "when `shutdown()` returns, shutdown is complete", rather than "someone else started it and may still be halfway through phase 2".

### Quick Reference: Shutdown Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| No pre-stop delay | 5xx during deploy in K8s | Wait 5s before drain |
| Blocked goroutines | Shutdown hangs forever | Context cancellation + timeout |
| Force-closed DB | Data corruption, locks | Wait for active transactions |
| Killed long requests | User-visible failures | Make them async (202 + status URL), or raise the grace period |
| Double shutdown | Close-of-closed-channel panic, cleanup run twice | sync.Once for shutdown logic |
| No shutdown timeout | Process never exits | Always set max timeout |

### Staff Lens: Verify Shutdown Actually Works

The easiest way to have broken shutdown is to never test it. Make it a routine test: start the service, send load, send SIGTERM, verify clean exit. Services that pass this test are trustworthy in production. Services that do not will fail in ways that are painful to diagnose during incidents.

---
