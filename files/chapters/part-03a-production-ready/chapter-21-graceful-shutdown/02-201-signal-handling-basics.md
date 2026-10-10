## 21.1 Signal Handling Basics

### Common Signals

| Signal | Description | Default Action |
|--------|-------------|----------------|
| SIGINT | Interrupt (Ctrl+C) | Terminate |
| SIGTERM | Termination request | Terminate |
| SIGKILL | Force kill | Terminate (cannot catch) |
| SIGHUP | Hangup | Terminate |
| SIGUSR1/2 | User-defined | None |

### Basic Signal Handling

The key mechanism here is a buffered channel of size 1 passed to `signal.Notify`. The buffer is critical: if the goroutine consuming the channel is not ready when the OS delivers the signal, a zero-capacity channel would silently drop it. `signal.Notify` registers the channel to receive the specified signals, so any unregistered signal continues to use the default OS behavior (e.g., `SIGKILL` cannot be caught at all). The receiving goroutine blocks until a signal arrives, then runs cleanup before exiting, converting an asynchronous OS event into a sequential, controllable shutdown path.

```go
import (
    "log"
    "os"
    "os/signal"
    "syscall"
)

func main() {
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        sig := <-sigChan
        log.Printf("Received signal: %v", sig)
        // Cleanup...
        os.Exit(0)
    }()

    // Run your application
    runServer()
}
```

### Modern Pattern: signal.NotifyContext (Go 1.16+)

For new code, prefer `signal.NotifyContext`. It folds signal handling into the context tree so every goroutine that already accepts a `context.Context` (HTTP handlers, DB queries, background workers) gets canceled the moment SIGTERM arrives. No dedicated signal goroutine, no manual channel plumbing.

```go
import (
    "context"
    "log"
    "os/signal"
    "syscall"
)

func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer stop() // restores default signal handling

    if err := runServer(ctx); err != nil {
        log.Fatal(err)
    }
}
```

`stop()` unregisters the signal handler and restores the OS default.

Be precise about what `defer stop()` does and does not buy you. The deferred call does not run until `main` returns, which is *after* the graceful path has already finished. While `runServer` is still draining, the handler is still registered, so a second SIGTERM is caught and discarded (the context is already canceled, and nothing else is listening). A hung shutdown stays hung until Kubernetes' `SIGKILL` arrives.

If you want the "second signal means hard kill" escape hatch, call `stop()` explicitly the moment the context is canceled, before the slow drain begins:

```go
func runServer(ctx context.Context, stop context.CancelFunc) error {
    srv := &http.Server{Addr: ":8080", Handler: mux}

    errCh := make(chan error, 1)
    go func() { errCh <- srv.ListenAndServe() }()

    select {
    case err := <-errCh:
        return err
    case <-ctx.Done():
    }

    // Restore default handling now, not at the end of main. From here on a
    // second SIGTERM terminates the process immediately, even if the drain hangs.
    stop()

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
    defer cancel()
    return srv.Shutdown(shutdownCtx)
}
```

The `defer stop()` in `main` is still worth keeping as a backstop for the paths that never reach the explicit call. It just is not what gives you the impatient-operator hard kill.

### Staff Lens: signal.NotifyContext Is the Default

Every modern Go service should use `signal.NotifyContext` at the top of `main`. The older `signal.Notify` with a channel is still correct but requires more boilerplate. New code should use the context version.

---
