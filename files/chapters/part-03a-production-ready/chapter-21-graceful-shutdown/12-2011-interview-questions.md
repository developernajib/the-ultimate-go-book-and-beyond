## 21.11 Interview Questions

### Question 1: How does http.Server.Shutdown work?

**What FAANG expects:** The four concrete steps, awareness that Shutdown does *not* interrupt in-flight handlers (so a handler that ignores the request context can outlast the deadline), and the gotcha that long-lived connections behave in two *opposite* ways depending on whether the handler hijacked the connection. Streaming and SSE handlers hold the drain open until the deadline. Hijacked connections (which is what WebSockets are) are not tracked at all, so Shutdown ignores them completely and returns while they are still live.

**Answer:**

`http.Server.Shutdown` performs these steps:

1. Closes all listeners (stops accepting new connections)
2. Closes all idle connections immediately
3. Waits for active connections to become idle
4. Returns when all connections are closed OR context is canceled

```go
// Important: Shutdown doesn't interrupt active requests
// It waits for them to complete

server := &http.Server{Addr: ":8080"}

// Start in background
go server.ListenAndServe()

// Later, shutdown with timeout
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

err := server.Shutdown(ctx)
// err is nil if all connections closed
// err is context.DeadlineExceeded if timeout hit
```

**Follow-ups:**
- *What happens to websocket or SSE connections during Shutdown?* This is the question that separates people who have read the docs from people who have shipped it, because the two cases are opposites. **SSE and streaming** handlers are still inside `ServeHTTP`, so the connection is active rather than idle and `Shutdown` blocks on it until the deadline. **WebSockets** call `Hijack`, which removes the connection from the server's tracking entirely: `Shutdown` neither closes them nor waits for them, and returns `nil` immediately even with live sessions in flight (measurably so, in microseconds). So SSE stalls your shutdown, and WebSockets get silently severed when the process exits a moment later. The fix differs too. For SSE, thread a shutdown-aware context into the handler so it wraps up. For WebSockets, `RegisterOnShutdown(fn)` gives you a callback to send close frames, but note that `Shutdown` does not wait for those callbacks either, so you must block on your own connection-tracking `WaitGroup` after `Shutdown` returns.
- *Shutdown vs Close, when do you use each?* `Close` is the panic button: it breaks connections immediately, no drain. Use it only as a final fallback when `Shutdown(ctx)` has already returned `context.DeadlineExceeded`.
- *How do handlers know a shutdown is in progress?* Pass `server.BaseContext` so every request derives from a shutdown-aware context, and in each handler check `r.Context().Done()` or its equivalent to bail out of long operations instead of holding the drain open.

### Question 2: Why is a drain delay important in Kubernetes?

**What FAANG expects:** Name the race condition by its parts (SIGTERM delivery is synchronous, EndpointSlice propagation to kube-proxy and external load balancers is not), quantify the typical window (500ms to several seconds depending on the ingress controller), and give the two-tool fix: fail readiness first, then `preStop` sleep of a few seconds before exec'ing the signal, with `terminationGracePeriodSeconds` sized to cover preStop + drain + in-flight work.

**Answer:**

When Kubernetes sends SIGTERM, it also updates the Endpoints object. However, these are asynchronous:
- SIGTERM is immediate
- Endpoints update takes time to propagate to load balancers

Without a drain delay:
```
T+0s: SIGTERM received, server starts shutdown
T+0s: Endpoints updated (propagation starts)
T+0-5s: LB still sending traffic to shutting-down pod
T+5s: LB finally stops sending traffic
Result: Requests fail during 0-5s window
```

With drain delay:
```
T+0s: SIGTERM received
T+0s: Mark unhealthy (fail readiness probe)
T+0-5s: LB stops sending traffic (sees unhealthy)
T+5s: Start actual shutdown
Result: No dropped requests
```

**Follow-ups:**
- *What does `preStop: sleep 5` actually buy you and what is wrong with it?* It delays SIGTERM so endpoint changes propagate, but it is opaque: the sleep has no knowledge of whether the load balancer actually deregistered. A better preStop calls a deregister endpoint or polls until the pod is out of rotation. Some operators use both (sleep as belt, deregister call as suspenders).
- *What should `terminationGracePeriodSeconds` be set to?* The sum of preStop + longest-in-flight-request + DB flush + a buffer. Default is 30s. For services with 60s+ user uploads, raise it, otherwise Kubernetes will SIGKILL mid-request.
- *What is the PID 1 gotcha?* If the container entrypoint is a shell script that exec's your binary without `exec`, the shell is PID 1 and swallows signals. Either run the Go binary directly as entrypoint or use `exec "$@"` in the shell wrapper, otherwise your graceful handler never runs.

### Question 3: How do you ensure database transactions complete during shutdown?

**What FAANG expects:** A layered answer: (1) cancel new work at the HTTP/queue boundary so no new transactions begin, (2) let in-flight transactions finish using a WaitGroup or tracked-tx pattern, (3) close the pool last. Bonus for mentioning idempotency: if you cannot guarantee completion, the system must tolerate the work being retried on a different pod.

**Answer:**

```go
// 1. Track active transactions
type TransactionTracker struct {
    active sync.WaitGroup
}

func (t *TransactionTracker) Begin(ctx context.Context, db *sql.DB) (*TrackedTx, error) {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }

    t.active.Add(1)
    return &TrackedTx{
        Tx:      tx,
        tracker: t,
    }, nil
}

type TrackedTx struct {
    *sql.Tx
    tracker *TransactionTracker
    done    bool
}

func (t *TrackedTx) Commit() error {
    if !t.done {
        t.done = true
        defer t.tracker.active.Done()
    }
    return t.Tx.Commit()
}

func (t *TrackedTx) Rollback() error {
    if !t.done {
        t.done = true
        defer t.tracker.active.Done()
    }
    return t.Tx.Rollback()
}

// 2. Wait during shutdown
func (t *TransactionTracker) WaitForCompletion(ctx context.Context) error {
    done := make(chan struct{})
    go func() {
        t.active.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

**Follow-ups:**
- *What if a transaction is genuinely uninterruptible (e.g. a long migration)?* Do not hold shutdown open for it. Commit idempotently in the background, let the pod exit, and design the replacement pod to recover from the last committed state. Holding SIGTERM open for multi-minute work gets you SIGKILLed and leaves the transaction half-applied anyway.
- *Close order: server, workers, DB pool, why?* Reverse of startup. If you close the DB pool before workers finish, workers see cryptic "connection closed" errors mid-transaction. The server has to close first so no new work arrives, then workers drain, then the pool.
- *How does this interact with message queues (Kafka, SQS)?* Stop the consumer loop (pause fetches) but keep the connection open long enough to commit the last offsets/ack messages. Committing offsets *before* processing completes is the classic "lost message" bug.

### Question 4: What's the difference between SIGINT and SIGTERM?

**What FAANG expects:** Both are catchable, both default to terminate, and in production Go code they are handled identically (graceful shutdown). Strong answers also distinguish SIGKILL (uncatchable, so design for it as the "grace period expired" failure mode) and note the modern Go pattern: `signal.NotifyContext` (Go 1.16+) instead of manual channel plumbing.

**Answer:**

| Aspect | SIGINT | SIGTERM |
|--------|--------|---------|
| Source | User (Ctrl+C) | System/orchestrator |
| Meaning | "Stop what you're doing" | "Please terminate" |
| Catchable | Yes | Yes |
| Default | Terminate | Terminate |
| Kubernetes | Not used | Sent before SIGKILL |

Both should trigger graceful shutdown. The main difference is context:
- SIGINT: Developer debugging, want quick response
- SIGTERM: Production deployment, want complete cleanup

```go
signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
// Handle both the same way
```

Modern Go (1.16+) folds this into the context tree:

```go
ctx, stop := signal.NotifyContext(context.Background(),
    syscall.SIGINT, syscall.SIGTERM)
defer stop()

<-ctx.Done() // first signal
stop()       // restore default NOW, so a second signal hard-kills a stuck drain
gracefulShutdown()
```

The explicit `stop()` is the load-bearing line. `defer stop()` alone does not run until `main` returns, which is after the drain has already finished, so during a hung shutdown the handler is still installed and a second SIGTERM is caught and discarded. The process just sits there until SIGKILL.

**Follow-ups:**
- *What is SIGHUP used for in Go services?* Traditionally "reload config without restart". Modern Kubernetes-native services ignore it, they prefer rolling deploys to config reloads. Still common for sidecars (envoy, fluent-bit).
- *Why is SIGKILL worth discussing even though you cannot catch it?* Because your graceful path is the only thing standing between SIGTERM and the eventual SIGKILL. Designing the grace period, the work you try to finish, and the persistence/idempotency guarantees for work you cannot finish is the real question hiding inside "how do you shut down cleanly".
- *What is the "second ctrl-C hard kills" pattern?* `signal.NotifyContext` cancels on the first signal, and `stop()` unregisters the handler so a second signal hits the default OS action (terminate). The catch, and the thing interviewers probe for: this only works if you call `stop()` **explicitly, as soon as the context is canceled**. Relying on `defer stop()` gives you nothing, because it does not run until `main` returns, by which point the drain you wanted to escape has already completed. Written correctly, operators can always force-exit a wedged shutdown.

### Question 5: How do you test graceful shutdown?

**What FAANG expects:** Three levels of test, unit (server starts, shutdown returns nil, in-flight request completes), integration (k8s terminationGracePeriod actually honors your drain, no 5xx on rolling deploy), and chaos (random SIGKILL, network partition during drain). Bonus for naming `testing/synctest` (Go 1.25 stable) as the way to write deterministic timeout tests without wall-clock sleeps.

**Answer:**

```go
func TestGracefulShutdown(t *testing.T) {
    // Start server
    srv := &http.Server{Addr: ":0", Handler: slowHandler()}

    ln, _ := net.Listen("tcp", ":0")
    go srv.Serve(ln)

    // Start slow request
    reqDone := make(chan error, 1)
    go func() {
        resp, err := http.Get("http://" + ln.Addr().String())
        if err != nil {
            reqDone <- err
            return
        }
        defer resp.Body.Close()
        io.ReadAll(resp.Body)
        reqDone <- nil
    }()

    // Wait for request to start
    time.Sleep(100 * time.Millisecond)

    // Trigger shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    shutdownDone := make(chan error, 1)
    go func() {
        shutdownDone <- srv.Shutdown(ctx)
    }()

    // Verify request completes
    if err := <-reqDone; err != nil {
        t.Errorf("request failed: %v", err)
    }

    // Verify shutdown completes
    if err := <-shutdownDone; err != nil {
        t.Errorf("shutdown failed: %v", err)
    }
}

func slowHandler() http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        time.Sleep(2 * time.Second)
        w.Write([]byte("OK"))
    })
}
```

**Follow-ups:**
- *How do you test that no requests are dropped during a rolling deploy?* Run a load generator at steady RPS against a service in a real cluster, trigger a rollout, and assert zero 5xx and zero connection resets across the deploy window. The bug this catches is always drain misconfiguration (preStop too short, readiness not failing before SIGTERM).
- *What does `testing/synctest` add here?* It provides a virtual clock, so you can assert "shutdown returns within 30s of SIGTERM" deterministically without actually sleeping 30 seconds in CI. Use `synctest.Test(t, ...)` (the preferred API since Go 1.25 stable).
- *How do you verify the PID 1 signal-forwarding bug does not regress?* Add a container test that runs your actual image, sends SIGTERM to the container, and asserts the graceful-shutdown log line is emitted. Catches the "shell wrapper ate the signal" class of bugs.

### Q (Staff track): Design a service-manager library for your org's Go services.

**Answer**: Components the library must handle.

1. Signal handling via `signal.NotifyContext`.
2. Component registration with start/stop lifecycle methods.
3. Shutdown sequencing: stop accepting new work, wait for in-flight work with bounded deadline, close resources in reverse order of dependency.
4. Flush for telemetry (metrics, traces, logs).
5. Health check that flips to unhealthy on shutdown start.
6. Optional preStop hook integration.

Ship it. Drive adoption. Every new service uses it. Graceful shutdown becomes correct by default.

---
