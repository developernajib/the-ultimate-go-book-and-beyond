## 21.2 Graceful HTTP Server Shutdown

### Using http.Server.Shutdown

`http.Server.Shutdown` solves the problem of dropping in-flight requests during a deployment or restart. It works by immediately closing the listener so no new TCP connections are accepted, then waiting for all active connections to reach an idle state before closing them. The shutdown context provides a hard deadline: if any request takes longer than the timeout (here 30 seconds), `Shutdown` returns a `context.DeadlineExceeded` error and the server stops regardless, preventing a stuck request from blocking the process indefinitely. The server is launched in a separate goroutine because `ListenAndServe` blocks, and the `http.ErrServerClosed` check distinguishes a clean shutdown from an unexpected listen error.

```go
func main() {
    server := &http.Server{
        Addr:    ":8080",
        Handler: router,
    }

    // Start server in goroutine
    go func() {
        log.Println("Starting server on :8080")
        if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
            log.Fatalf("Server error: %v", err)
        }
    }()

    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("Shutting down server...")

    // Create shutdown context with timeout
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Shutdown gracefully
    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Server shutdown error: %v", err)
    }

    log.Println("Server stopped")
}
```

### What Shutdown Does

1. Closes the listeners, so no new connections are accepted
2. Closes idle connections immediately
3. Waits for active requests to finish, then closes those connections as they go idle
4. Returns when all tracked connections are closed, or when the context deadline fires

### Shutdown Versus Close, and the Hijacked-Connection Gap

`Close` is the blunt instrument. It closes all listeners and *all* connections immediately, including ones in the middle of serving a request. Use it only as a last resort after `Shutdown` has already missed its deadline.

`Shutdown` is the graceful one, but it has an exception that catches people out: **it does not track hijacked connections**. Once a handler calls `Hijack` (which is what every WebSocket library and every raw-TCP upgrade does under the hood), the connection leaves the server's bookkeeping entirely. `Shutdown` will neither interrupt those connections nor wait for them. It returns as though they do not exist, and the process then exits out from under live WebSocket sessions.

The same applies to `http.Server.RegisterOnShutdown`, which exists precisely to give you a hook for this case. If you serve WebSockets, you own that drain yourself:

```go
// Track live WebSocket sessions so shutdown can close them deliberately.
srv.RegisterOnShutdown(func() {
    hub.CloseAll() // send close frames, let peers reconnect elsewhere
})

if err := srv.Shutdown(shutdownCtx); err != nil {
    log.Printf("http shutdown: %v", err)
}
hub.Wait(shutdownCtx) // Shutdown did NOT wait for hijacked conns, so we do
```

`RegisterOnShutdown` callbacks are invoked at the *start* of `Shutdown`, concurrently, and `Shutdown` does not wait for them to return either. They are a notification, not a barrier. The `hub.Wait` call is what actually blocks.

### Shutdown Does Not Kill In-Flight Requests

`Shutdown` waits for handlers to return. A handler that ignores its context and does a 5-minute database query will block shutdown for 5 minutes (or until the deadline). Handlers must respect context cancellation for shutdown to work on time.

This is the most common shutdown bug: handlers that take too long because they ignore context. Audit and fix.

### Staff Lens: Shutdown Timeout Must Match Reality

Set the shutdown timeout to slightly less than Kubernetes's `terminationGracePeriodSeconds`. If Kubernetes gives you 30 seconds and you set Shutdown timeout to 35, the kubelet kills you first. Set it to 25 to leave buffer for final cleanup.

---
