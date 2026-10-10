## 22.7 Health Checks

### Comprehensive Health Check

A health checker runs each registered check concurrently in its own goroutine, collecting results under a mutex before returning the aggregate status. Running checks in parallel means the endpoint costs the time of the **slowest** check rather than the sum of all of them. It does not, by itself, bound anything: `wg.Wait()` waits for every check, so the response is only as predictable as the worst check. The per-check timeout below is what actually bounds it.

```go
type HealthStatus struct {
    Status    string                 `json:"status"`
    Checks    map[string]CheckResult `json:"checks"`
    Timestamp time.Time              `json:"timestamp"`
}

type CheckResult struct {
    Status     string `json:"status"`
    DurationMS int64  `json:"duration_ms"` // an int64 count, not a Duration
    Error      string `json:"error,omitempty"`
}

type HealthChecker struct {
    checks       map[string]func(context.Context) error
    checkTimeout time.Duration // per-check bound, e.g. 2s
}

func (hc *HealthChecker) Check(ctx context.Context) HealthStatus {
    status := HealthStatus{
        Status:    "healthy",
        Checks:    make(map[string]CheckResult),
        Timestamp: time.Now(),
    }

    var wg sync.WaitGroup
    var mu sync.Mutex

    for name, check := range hc.checks {
        wg.Add(1)
        // No loop-variable copies needed: per-iteration since Go 1.22.
        go func() {
            defer wg.Done()

            // Bound EVERY check independently. One wedged dependency must
            // not decide how long the health endpoint takes.
            checkCtx, cancel := context.WithTimeout(ctx, hc.checkTimeout)
            defer cancel()

            start := time.Now()
            err := runCheck(checkCtx, check) // recovers panics, honours ctx
            duration := time.Since(start)

            result := CheckResult{
                Status:     "healthy",
                DurationMS: duration.Milliseconds(),
            }

            if err != nil {
                result.Status = "unhealthy"
                result.Error = err.Error()
            }

            mu.Lock()
            status.Checks[name] = result
            if result.Status == "unhealthy" {
                status.Status = "unhealthy"
            }
            mu.Unlock()
        }()
    }

    wg.Wait()
    return status
}

// runCheck guarantees a result within ctx even if the check ignores it, and
// converts a panicking check into an unhealthy result rather than a crash.
func runCheck(ctx context.Context, check func(context.Context) error) error {
    done := make(chan error, 1) // buffered: the goroutine must never block
    go func() {
        defer func() {
            if r := recover(); r != nil {
                done <- fmt.Errorf("check panicked: %v", r)
            }
        }()
        done <- check(ctx)
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err() // report the timeout; the check may still be running
    }
}
```

### A Health Check Is a Dependency You Just Added

Two failure modes make health endpoints a surprisingly common cause of the outages they exist to detect.

**An unbounded check wedges the endpoint.** Give the checker a fast cache probe and one database probe that hangs, then call it with a context that has no deadline (exactly what a plain handler passes):

```
health endpoint took 3.002s (fast check: 0ms)
```

The response is gated entirely by the slowest check, and nothing caps it. Now wire that endpoint to a `livenessProbe` with a 1-second `timeoutSeconds` and a `failureThreshold` of 3, and the kubelet kills a perfectly healthy process because a *dependency* is slow. Restarting the pod does not fix the database. It drops the in-flight requests the pod was still serving fine, and the replacement pod probes the same slow database and dies too. This creates a failure loop that converts a dependency brownout into a full outage, rolling across the fleet.

This is why the split matters mechanically, not just conceptually:

- **Liveness** must check *only* the process itself, and ideally nothing at all beyond "the HTTP server can answer". No database, no cache, no downstream. The only correct response to a liveness failure is a restart, and a restart cannot fix anything external.
- **Readiness** may check dependencies, because its consequence is removal from the load balancer, which is a reasonable response to "I cannot serve right now".

Even readiness deserves care: if every replica readiness-checks the same database and the database blips, every replica leaves the load balancer simultaneously and the service goes to zero capacity over a fault that might have affected 10% of queries.

**The endpoint is unauthenticated and does real work.** `/healthz` returning per-dependency latencies and error strings is an information leak, and if each request opens a database connection, it is also a free amplification vector: cheap for an attacker to call, expensive for you to serve. Cache the result for a second or two and serve every probe from that cache. Probes run every few seconds per replica, so the cache costs nothing and puts a hard ceiling on the load your health endpoint can generate.

### Staff Lens: Separate Liveness and Readiness

Liveness: is the process alive? Minimal checks, no external dependencies. Failure means restart.

Readiness: can the process serve traffic? Can include dependency checks. Failure means remove from load balancer, not restart.

Conflating them is a common mistake that causes Kubernetes to restart pods when their dependencies fail, helping nothing.

---
