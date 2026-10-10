## 21.4 Draining Connections

### Connection Draining Pattern

The draining pattern uses a `sync.WaitGroup` to track every in-flight request and a flag to signal that the server is shutting down. The ordering is the whole trick: a request must check the shutdown flag and increment the counter **atomically with respect to the flag being set**, so that the `WaitGroup` can never go up again once `Shutdown` has started waiting. That is what guarantees `activeConns.Wait()` unblocks only after every request already in progress has completed, rather than abandoning them mid-flight.

An `RWMutex` buys exactly that ordering, and it is cheap: readers do not contend with each other, so the request path stays parallel.

```go
type Server struct {
    handler     http.Handler
    activeConns sync.WaitGroup

    mu       sync.RWMutex
    shutdown bool
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // The check and the Add happen under the same RLock, so they cannot be
    // split by a concurrent Shutdown taking the write lock.
    s.mu.RLock()
    if s.shutdown {
        s.mu.RUnlock()
        http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
        return
    }
    s.activeConns.Add(1)
    s.mu.RUnlock()
    defer s.activeConns.Done()

    // Handle request
    s.handler.ServeHTTP(w, r)
}

func (s *Server) Shutdown(timeout time.Duration) error {
    s.mu.Lock()
    s.shutdown = true // stop accepting new work
    s.mu.Unlock()
    // Past this point every ServeHTTP either already did its Add (and is
    // counted) or will see shutdown == true and bail. No Add can follow.

    done := make(chan struct{})
    go func() {
        s.activeConns.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return errors.New("shutdown timeout")
    }
}
```

**Why not the obvious version?** The tempting shape is a `chan struct{}` closed by `Shutdown`, with `ServeHTTP` calling `Add(1)` first and then `select`-ing on it. That version has two problems. It counts requests it is about to reject, and more importantly it lets `Add(1)` run concurrently with `Wait()` after the counter has already hit zero, which is precisely the reuse case `sync.WaitGroup` documents as a misuse. The flag-under-lock version has no such window: the `Add` is ordered before the flag write or the request is rejected.

### Staff Lens: Prefer http.Server.Shutdown

The pattern above manually tracks active connections. In most cases, `http.Server.Shutdown` already does this correctly. Hand-rolling connection draining is error-prone. Use the stdlib unless you have a specific reason not to.

---
