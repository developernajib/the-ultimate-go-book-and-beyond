## 9. Production Checklist

### 9.1 Pre-Migration Checklist

- [ ] **Performance Baseline**
 - [ ] Current latency (p50, p95, p99)
 - [ ] Current throughput (RPS)
 - [ ] Current error rate
 - [ ] Memory/CPU usage

- [ ] **Feature Parity**
 - [ ] All endpoints implemented
 - [ ] Business logic verified
 - [ ] Edge cases handled
 - [ ] Error handling complete

- [ ] **Testing**
 - [ ] Unit tests (>80% coverage)
 - [ ] Integration tests
 - [ ] Load tests
 - [ ] Chaos tests

- [ ] **Observability**
 - [ ] Structured logging
 - [ ] Metrics (Prometheus)
 - [ ] Distributed tracing
 - [ ] Alerting rules

- [ ] **Deployment**
 - [ ] Docker/Kubernetes manifests
 - [ ] Health checks
 - [ ] Graceful shutdown
 - [ ] Database migrations

### 9.2 Go-Specific Checklist

Beyond generic deployment readiness, Go services require attention to a handful of runtime behaviors that differ from most other runtimes, goroutine leaks, signal handling, and connection draining chief among them. The pattern below demonstrates the idiomatic graceful shutdown sequence: the HTTP server is started in a goroutine, a buffered signal channel catches `SIGINT`/`SIGTERM`, and a 30-second context deadline gives in-flight requests time to complete before the process exits.

```go
// Graceful shutdown
func main() {
    srv := &http.Server{Addr: ":8080", Handler: handler}

    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("listen: %s\n", err)
        }
    }()

    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := srv.Shutdown(ctx); err != nil {
        log.Fatal("Server forced to shutdown:", err)
    }

    log.Println("Server exiting")
}
```

### 9.3 Rollback Plan

A feature flag checked at request time is the fastest rollback mechanism available, it requires no redeployment and takes effect within the flag store's propagation latency (typically under one second with an in-memory cache). The snippet below shows the minimal structure: a `FeatureFlags` struct loaded from a remote config or environment variable, and a single conditional in the handler that routes traffic to either the new or old implementation without any infrastructure change.

```go
// Feature flag for instant rollback
type FeatureFlags struct {
    UseNewService bool `json:"use_new_service"`
}

func (s *Service) HandleRequest(w http.ResponseWriter, r *http.Request) {
    flags := s.getFeatureFlags()

    if flags.UseNewService {
        s.newHandler(w, r)
    } else {
        s.oldHandler(w, r)
    }
}
```

---
