## 21.7 Complete Example

This example assembles signal handling, HTTP server shutdown, database cleanup, and a background worker into a single cohesive shutdown sequence. The organising rule is that **exactly one place owns stopping each resource**. `Run` owns the server's listener and drain, because `Run` is what started it. `Shutdown` owns the dependencies that outlive the drain, in this case the database pool. Splitting it any other way produces the double-shutdown bug described after the code.

```go
package main

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "golang.org/x/sync/errgroup"
)

const drainTimeout = 30 * time.Second

type Application struct {
    server  *http.Server
    db      *sql.DB
    workers *WorkerPool
}

func main() {
    if err := realMain(); err != nil {
        log.Printf("fatal: %v", err)
        os.Exit(1)
    }
}

func realMain() error {
    app, err := NewApplication()
    if err != nil {
        return err
    }
    // Closing the DB is deferred so it runs after Run has fully returned,
    // meaning after the drain and after every worker has stopped querying.
    defer app.Shutdown()

    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    err = app.Run(ctx, stop)
    if err != nil && !errors.Is(err, context.Canceled) {
        return err
    }
    log.Println("Application stopped")
    return nil
}

func (app *Application) Run(ctx context.Context, stop context.CancelFunc) error {
    g, gctx := errgroup.WithContext(ctx)

    // HTTP server.
    g.Go(func() error {
        log.Println("Starting HTTP server")
        err := app.server.ListenAndServe()
        if errors.Is(err, http.ErrServerClosed) {
            return nil // expected: Shutdown was called
        }
        return err
    })

    // Workers. They observe gctx and must return when it is canceled.
    g.Go(func() error {
        return app.workers.Run(gctx)
    })

    // Shutdown supervisor: the single owner of stopping the server.
    g.Go(func() error {
        <-gctx.Done()
        log.Println("Shutdown signal received, draining")

        // A second signal from here on hard-kills, in case the drain wedges.
        stop()

        // Bounded. gctx is already canceled, so the parent must be
        // Background, but Background alone would mean "wait forever".
        sctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
        defer cancel()

        if err := app.server.Shutdown(sctx); err != nil {
            return fmt.Errorf("http drain: %w", err) // deadline hit, requests cut off
        }
        log.Println("HTTP drain complete")
        return nil
    })

    return g.Wait()
}

// Shutdown closes dependencies. It runs only after Run has returned, so
// nothing is using the pool by this point.
func (app *Application) Shutdown() {
    if err := app.db.Close(); err != nil {
        log.Printf("Database close error: %v", err)
    }
}
```

### Three Bugs This Structure Avoids

**Shutting the server down twice.** The tempting shape has `Run` call `server.Shutdown` when the context is canceled *and* a separate `app.Shutdown(shutdownCtx)` in `main` call it again with a nice bounded 30-second timeout. The second call is a no-op: `Shutdown` returns `nil` immediately once the server is already closed, in tens of microseconds. So the carefully constructed timeout in `main` governs nothing, and the drain that actually happened was the *other* one. If that first call used `context.Background()` with no deadline, you have an unbounded drain and a timeout that only looks like it works. One owner, one call.

**`context.Background()` with no deadline.** Deriving the drain context from the canceled signal context is wrong: `Shutdown` would return instantly and drop every in-flight request. `context.Background()` is the correct parent. But `Shutdown(context.Background())` on its own waits forever, so a single wedged handler holds the process until `SIGKILL` and the cleanup after it never runs. `WithTimeout(context.Background(), drainTimeout)` is the pairing you want.

**The `WaitGroup` that counts nothing.** The original had an `app.wg sync.WaitGroup` field, a goroutine calling `app.wg.Wait()`, and a reassuring "All work completed" log. Nothing ever called `app.wg.Add`. A `WaitGroup` at zero returns from `Wait` immediately, so that block printed its success message without waiting for anything at all. It is worse than no code, because it reads as proof that in-flight work was drained. Here the errgroup does the waiting, and it waits on something real: `workers.Run(gctx)` cannot return until the worker pool has actually stopped. If you find yourself adding a `WaitGroup` to a struct, grep for its `Add` before you trust its `Wait`.

### Staff Lens: Production Service Template

The shutdown example above should be part of every service's template. When a new service is scaffolded, graceful shutdown is already wired correctly. This prevents teams from having to reinvent it (and get it wrong) for every service.

---
