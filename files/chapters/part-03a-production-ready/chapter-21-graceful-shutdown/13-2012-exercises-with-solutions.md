## 21.12 Exercises with Solutions

### Exercise 1: Implement Worker Pool Shutdown

**Problem:** Create a worker pool that shuts down gracefully, completing all in-progress jobs.

**Solution:**

The pool uses context cancellation to signal workers to stop accepting new jobs. When `Shutdown` is called, it cancels the context, then waits for all worker goroutines to exit via a `WaitGroup`. Each worker drains any remaining buffered jobs before returning, so no submitted work is silently dropped.

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

type WorkerPool struct {
    jobs      chan func()
    wg        sync.WaitGroup
    ctx       context.Context
    cancel    context.CancelFunc
    workers   int
}

func NewWorkerPool(workers, queueSize int) *WorkerPool {
    ctx, cancel := context.WithCancel(context.Background())
    return &WorkerPool{
        jobs:    make(chan func(), queueSize),
        ctx:     ctx,
        cancel:  cancel,
        workers: workers,
    }
}

func (p *WorkerPool) Start() {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }
}

func (p *WorkerPool) worker(id int) {
    defer p.wg.Done()

    for {
        select {
        case <-p.ctx.Done():
            // Drain remaining jobs before exiting
            for {
                select {
                case job := <-p.jobs:
                    job()
                default:
                    return
                }
            }
        case job := <-p.jobs:
            job()
        }
    }
}

func (p *WorkerPool) Submit(job func()) error {
    select {
    case p.jobs <- job:
        return nil
    case <-p.ctx.Done():
        return fmt.Errorf("pool is shutting down")
    }
}

func (p *WorkerPool) Shutdown(timeout time.Duration) error {
    p.cancel()

    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return fmt.Errorf("shutdown timeout")
    }
}

// Usage
func main() {
    pool := NewWorkerPool(4, 100)
    pool.Start()

    // Submit jobs. No `i := i` needed: loop variables have been per-iteration
    // since Go 1.22.
    for i := 0; i < 10; i++ {
        pool.Submit(func() {
            fmt.Printf("Job %d starting\n", i)
            time.Sleep(time.Second)
            fmt.Printf("Job %d done\n", i)
        })
    }

    // Shutdown gracefully
    if err := pool.Shutdown(30 * time.Second); err != nil {
        fmt.Printf("Shutdown error: %v\n", err)
    }

    fmt.Println("Pool shutdown complete")
}
```

### Exercise 2: Implement Kubernetes-Ready Service

**Problem:** Create a service that handles Kubernetes pod lifecycle correctly.

**Solution:**

This service exposes `/healthz` (liveness) and `/readyz` (readiness) endpoints backed by `atomic.Bool` flags. On `SIGTERM`, it fails readiness so kube-proxy stops routing traffic, sleeps for the configured drain delay, then calls `server.Shutdown` with a bounded timeout. Note that `healthy` is deliberately never set to false: liveness must keep passing throughout a normal drain, or the kubelet restarts the container mid-request.

Watch the shutdown context's **parent** closely. It is the single easiest thing to get wrong in this exercise, and the failure is silent.

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "net/http"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "time"
)

// drainDelay (5s) + drainTimeout (20s) = 25s, leaving real headroom inside
// the 30s default terminationGracePeriodSeconds. A 25s drain would leave
// exactly zero and get SIGKILLed at the finish line.
const drainTimeout = 20 * time.Second

type K8sService struct {
    server       *http.Server
    ready        atomic.Bool
    healthy      atomic.Bool
    shuttingDown atomic.Bool

    drainDelay time.Duration
}

func NewK8sService(addr string, handler http.Handler, drainDelay time.Duration) *K8sService {
    s := &K8sService{
        drainDelay: drainDelay,
    }
    s.healthy.Store(true)
    s.ready.Store(false)

    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", s.livenessHandler)
    mux.HandleFunc("/readyz", s.readinessHandler)
    mux.Handle("/", handler)

    s.server = &http.Server{
        Addr:    addr,
        Handler: mux,
    }

    return s
}

func (s *K8sService) livenessHandler(w http.ResponseWriter, r *http.Request) {
    if s.healthy.Load() {
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]string{"status": "unhealthy"})
    }
}

func (s *K8sService) readinessHandler(w http.ResponseWriter, r *http.Request) {
    if s.ready.Load() && !s.shuttingDown.Load() {
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]string{"status": "not ready"})
    }
}

func (s *K8sService) Run(ctx context.Context) error {
    // Start server
    errChan := make(chan error, 1)
    go func() {
        if err := s.server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
            errChan <- err
        }
    }()

    // Mark ready after startup
    s.ready.Store(true)

    // Wait for signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    select {
    case err := <-errChan:
        return err
    case <-sigChan:
        return s.gracefulShutdown()
    case <-ctx.Done():
        return s.gracefulShutdown()
    }
}

// gracefulShutdown takes no context on purpose. Every caller reaches it
// because its context is already dead, so there is no live context here to
// inherit. See "The dead-on-arrival context" below.
func (s *K8sService) gracefulShutdown() error {
    s.shuttingDown.Store(true)

    // Phase 1: fail readiness (liveness stays green)
    s.ready.Store(false)

    // Phase 2: wait for the LB to notice, still serving normally
    time.Sleep(s.drainDelay)

    // Phase 3: drain, on a fresh deadline rooted at Background.
    shutdownCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)
    defer cancel()

    return s.server.Shutdown(shutdownCtx)
}

func main() {
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        time.Sleep(500 * time.Millisecond) // Simulate work
        w.Write([]byte("Hello, World!"))
    })

    svc := NewK8sService(":8080", handler, 5*time.Second)

    if err := svc.Run(context.Background()); err != nil {
        os.Exit(1)
    }
}
```

**The dead-on-arrival context.** The natural way to write `gracefulShutdown` is to pass it the context `Run` already has:

```go
// WRONG
shutdownCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
defer cancel()
return s.server.Shutdown(shutdownCtx)
```

That reads as "give the drain 25 seconds". It does not do that. `WithTimeout` returns a context canceled when *either* the timeout fires **or the parent is canceled**. On the `case <-ctx.Done()` branch the parent is already canceled, so `shutdownCtx` is born canceled and the 25 seconds never start. `Shutdown` returns instantly with `context canceled`, in **427µs** when measured, abandoning every in-flight request. The process then exits and the client sees a reset.

It is a nasty bug because it is invisible in the common case. Send `SIGTERM` and the `case <-sigChan` branch runs, where `ctx` is still `Background` and alive, so the drain works perfectly in your manual test. Only the cancellation path is broken, which is the path your parent context takes when *another* component fails first, or when an errgroup tears the tree down. So it fails exactly when the system is already unhappy.

The rule: a shutdown deadline must be rooted at `context.Background()`. Cancellation flows *into* the shutdown path as the trigger, never *through* it as the budget. Once you are draining, the signal context has done its job, and inheriting it converts your deadline into an instant abort.

### Exercise 3: Implement Database Connection Draining

**Problem:** Create a database pool wrapper that drains connections during shutdown.

**Solution:**

The `DrainableDB` wrapper increments a `WaitGroup` before every query and transaction, and decrements it when the operation completes. On shutdown, it marks itself closed (rejecting new queries), waits for active operations to finish, and only then calls `db.Close()`. The `DrainableTx` type ensures the `WaitGroup` counter is decremented exactly once regardless of whether the transaction is committed or rolled back.

The `RWMutex` is what makes the flag check and the `Add` a single indivisible step. Without it, "check closed, then `Add(1)`" can be split by a concurrent `Shutdown`, letting an `Add` land after `Wait` has already observed zero and returned. That is the `WaitGroup` reuse case the standard library documents as a misuse, and here it would mean closing the pool underneath a query that just started.

```go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
    "sync/atomic"
    "time"
)

var ErrDraining = fmt.Errorf("database is closing")

type DrainableDB struct {
    db            *sql.DB
    activeQueries sync.WaitGroup

    mu     sync.RWMutex // guards the closed/Add pairing, not just closed
    closed bool
}

func NewDrainableDB(db *sql.DB) *DrainableDB {
    return &DrainableDB{db: db}
}

// enter reserves a slot in the drain accounting. It returns false if the pool
// is closing. The RLock makes "not closed" and "counted" atomic together:
// Shutdown cannot take the write lock in between.
func (d *DrainableDB) enter() bool {
    d.mu.RLock()
    defer d.mu.RUnlock()
    if d.closed {
        return false
    }
    d.activeQueries.Add(1)
    return true
}

func (d *DrainableDB) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    if !d.enter() {
        return nil, ErrDraining
    }
    defer d.activeQueries.Done()

    return d.db.QueryContext(ctx, query, args...)
}

func (d *DrainableDB) Exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
    if !d.enter() {
        return nil, ErrDraining
    }
    defer d.activeQueries.Done()

    return d.db.ExecContext(ctx, query, args...)
}

func (d *DrainableDB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*DrainableTx, error) {
    // Note: no defer Done() here. The transaction stays counted until the
    // caller commits or rolls back, which is the whole point.
    if !d.enter() {
        return nil, ErrDraining
    }

    tx, err := d.db.BeginTx(ctx, opts)
    if err != nil {
        d.activeQueries.Done()
        return nil, err
    }

    return &DrainableTx{
        Tx:   tx,
        pool: d,
    }, nil
}

func (d *DrainableDB) Shutdown(ctx context.Context) error {
    d.mu.Lock()
    d.closed = true
    d.mu.Unlock()
    // From here, every enter() returns false, so the counter can only fall.

    // Wait for active queries
    done := make(chan struct{})
    go func() {
        d.activeQueries.Wait()
        close(done)
    }()

    select {
    case <-done:
        return d.db.Close()
    case <-ctx.Done():
        // Force close
        d.db.Close()
        return fmt.Errorf("shutdown timeout: %w", ctx.Err())
    }
}

type DrainableTx struct {
    *sql.Tx
    pool   *DrainableDB
    closed atomic.Bool
}

// CompareAndSwap, not a plain bool. The idiomatic `defer tx.Rollback()`
// alongside an explicit `tx.Commit()` means both methods run, routinely from
// the same goroutine but not always. CAS guarantees exactly one Done() no
// matter how they interleave. A double Done() panics the WaitGroup.
func (t *DrainableTx) Commit() error {
    if !t.closed.CompareAndSwap(false, true) {
        return nil
    }
    defer t.pool.activeQueries.Done()
    return t.Tx.Commit()
}

func (t *DrainableTx) Rollback() error {
    if !t.closed.CompareAndSwap(false, true) {
        return nil // already committed: the no-op that makes defer safe
    }
    defer t.pool.activeQueries.Done()
    return t.Tx.Rollback()
}

// Usage
func main() {
    rawDB, _ := sql.Open("postgres", "...")
    db := NewDrainableDB(rawDB)

    // Start queries
    for i := 0; i < 5; i++ {
        go func(id int) {
            time.Sleep(time.Duration(id) * time.Second)
            rows, err := db.Query(context.Background(), "SELECT 1")
            if err != nil {
                fmt.Printf("Query %d failed: %v\n", id, err)
                return
            }
            rows.Close()
            fmt.Printf("Query %d completed\n", id)
        }(i)
    }

    // Shutdown after brief delay
    time.Sleep(2 * time.Second)

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    if err := db.Shutdown(ctx); err != nil {
        fmt.Printf("Shutdown error: %v\n", err)
    } else {
        fmt.Println("Shutdown complete")
    }
}
```

### Senior at FAANG Track

4. **Shutdown audit.** For every service your team owns, verify graceful shutdown works correctly under load. Document gaps. Close them.

5. **Chaos-test shutdown.** Build a staging test that sends SIGTERM to a running service under realistic load. Assert zero dropped requests. Run in CI regularly.

6. **Grace period tuning.** For each service, measure actual drain time under p99 load. Set `terminationGracePeriodSeconds` appropriately.

### Staff / Principal Track

7. **Service template shutdown.** Ensure the org's service template has graceful shutdown built in correctly. New services get it for free.

8. **Shared service manager library.** Ship a shared library that handles shutdown correctly. Drive adoption across services.

9. **Production readiness gate.** Add graceful-shutdown verification to the production readiness checklist. Block launches that fail.

10. **Shutdown incident postmortem.** Document past shutdown-related incidents (dropped requests during deploys, stuck processes, data loss). Extract systemic fixes.

---
