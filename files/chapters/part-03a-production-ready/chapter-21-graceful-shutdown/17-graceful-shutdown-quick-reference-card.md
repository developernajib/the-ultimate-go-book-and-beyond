## Graceful Shutdown Quick Reference Card

This card consolidates the key patterns, commands, and timeout values needed to implement production-grade graceful shutdown. The Kubernetes shutdown sequence, the component ordering, and the common mistake list are the three sections most frequently needed when diagnosing deploy-time request failures or process-exit hangs.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ GRACEFUL SHUTDOWN QUICK REFERENCE                                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│ SIGNAL HANDLING (modern):                                                       │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ ctx, stop := signal.NotifyContext(context.Background(),                     │ │
│ │     syscall.SIGINT, syscall.SIGTERM)                                        │ │
│ │ defer stop()                                                                │ │
│ │                                                                             │ │
│ │ <-ctx.Done()   // first signal arrives                                      │ │
│ │ stop()         // restore default: 2nd signal now hard-kills                │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ HTTP SERVER SHUTDOWN:                                                           │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ server := &http.Server{Addr: ":8080", Handler: handler}                     │ │
│ │ go server.ListenAndServe()                                                  │ │
│ │                                                                             │ │
│ │ // On signal. Parent MUST be Background: the signal ctx is                  │ │
│ │ // already canceled, and inheriting it aborts the drain instantly.          │ │
│ │ ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)    │ │
│ │ defer cancel()                                                              │ │
│ │ server.Shutdown(ctx)   // waits for in-flight requests                      │ │
│ │                        // does NOT wait for hijacked (WebSocket) conns      │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ KUBERNETES SHUTDOWN SEQUENCE:                                                   │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ 0. Pod marked Terminating -> grace clock STARTS, and endpoint               │ │
│ │    removal + preStop/SIGTERM race each other from here.                     │ │
│ │ 1. preStop hook runs (its time comes OUT of the grace budget)               │ │
│ │ 2. SIGTERM received                                                         │ │
│ │ 3. Fail readiness  <- IMMEDIATE (liveness stays 200)                        │ │
│ │ 4. Sleep ~5s (drain delay)  <- KEEP SERVING NORMALLY                        │ │
│ │ 5. Stop accepting new connections (Shutdown closes listener)                │ │
│ │ 6. Wait for in-flight requests                                              │ │
│ │ 7. Close deps: consumers, workers, flush, DB last                           │ │
│ │ 8. Exit before SIGKILL                                                      │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ GOROUTINE SHUTDOWN PATTERN:                                                     │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ ctx, cancel := context.WithCancel(context.Background())                     │ │
│ │ var wg sync.WaitGroup                                                       │ │
│ │                                                                             │ │
│ │ wg.Go(func() {              // sync.WaitGroup.Go, Go 1.25+                  │ │
│ │     for {                                                                   │ │
│ │         select {                                                            │ │
│ │         case <-ctx.Done():                                                  │ │
│ │             return          // clean exit                                   │ │
│ │         case job := <-jobChan:                                              │ │
│ │             process(job)                                                    │ │
│ │         }                                                                   │ │
│ │     }                                                                       │ │
│ │ })                                                                          │ │
│ │                                                                             │ │
│ │ cancel()   // signal goroutines to stop                                     │ │
│ │ wg.Wait()  // wait for completion                                           │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ HEALTH CHECK ENDPOINTS:                                                         │
│ ├── /healthz (Liveness):  process alive, return 200 ALWAYS,                     │
│ │                        including during drain                                 │
│ ├── /readyz  (Readiness): return 503 the instant shutdown starts                │
│ └── /startup:             initial startup probe (K8s 1.18+)                     │
│                                                                                 │
│ KUBERNETES DEPLOYMENT:                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ terminationGracePeriodSeconds: 40   # preStop + drain + headroom            │ │
│ │ lifecycle:                                                                  │ │
│ │   preStop:                                                                  │ │
│ │     exec:                                                                   │ │
│ │       command: ["/bin/sh", "-c", "sleep 5"]   # LB propagation              │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ TIMEOUT BUDGET (must SUM to less than the grace period):                        │
│ ├── Kubernetes grace default: 30s   (Docker 10s, systemd 90s)                   │
│ ├── preStop sleep:             5s   <- spends the SAME budget                   │
│ ├── HTTP request drain:       20s                                               │
│ ├── DB / flush drain:          5s                                               │
│ └── TOTAL:                    30s = the 30s default EXACTLY,                    │
│                                     so raise grace to 40s                       │
│                                                                                 │
│ SHUTDOWN ORDER (reverse of startup):                                            │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ 1. Health probes (readiness 503, immediate)                                 │ │
│ │ 2. HTTP/gRPC servers (stop listening, drain)                                │ │
│ │ 3. Message consumers (stop polling, commit offsets)                         │ │
│ │ 4. Background workers (cancel, wait)                                        │ │
│ │ 5. Caches/metrics (flush)                                                   │ │
│ │ 6. Database connections (LAST: workers may still commit)                    │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ERRGROUP PATTERN:                                                               │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ g, gctx := errgroup.WithContext(ctx)                                        │ │
│ │                                                                             │ │
│ │ g.Go(func() error {                                                         │ │
│ │     err := server.ListenAndServe()                                          │ │
│ │     if errors.Is(err, http.ErrServerClosed) { return nil }                  │ │
│ │     return err                                                              │ │
│ │ })                                                                          │ │
│ │ g.Go(func() error { return runWorker(gctx) })                               │ │
│ │ g.Go(func() error {                                                         │ │
│ │     <-gctx.Done()                                                           │ │
│ │     // Background, NOT gctx: gctx is already dead here.                     │ │
│ │     sctx, c := context.WithTimeout(context.Background(), 20*time.Second)    │ │
│ │     defer c()                                                               │ │
│ │     return server.Shutdown(sctx)                                            │ │
│ │ })                                                                          │ │
│ │                                                                             │ │
│ │ if err := g.Wait(); err != nil && !errors.Is(err, context.Canceled) {       │ │
│ │     return err   // not log.Fatal: that skips your defers                   │ │
│ │ }                                                                           │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ COMMON MISTAKES:                                                                │
│ ├── X os.Exit()/log.Fatal in main    - defers never run                         │
│ ├── X No drain delay in K8s          - 502s on every deploy                     │
│ ├── X 503ing during the drain delay  - causes the very errors                   │
│ │                                      the delay prevents                       │
│ ├── X Shutdown(ctx) from signal ctx  - drain aborts instantly                   │
│ ├── X Shutdown(context.Background()) - no deadline, hangs                       │
│ ├── X Blocking goroutines            - shutdown hangs forever                   │
│ ├── X Double shutdown                - close of CLOSED channel                  │
│ │                                      panics (db.Close is safe)                │
│ ├── X Failing liveness while draining- kubelet restarts you                     │
│ └── X Closing DB before workers done - errors mid-transaction                   │
│                                                                                 │
│ BEST PRACTICES:                                                                 │
│ ├── + sync.Once for shutdown logic (Do blocks 2nd caller)                       │
│ ├── + Always bound the drain with a deadline                                    │
│ ├── + Log shutdown progress per phase                                           │
│ ├── + Test shutdown under load (send real SIGTERM)                              │
│ ├── + Measure the LB propagation gap, do not guess 5s                           │
│ └── + Make long requests async (202 + status URL)                               │
│                                                                                 │
│ SIGNALS REFERENCE:                                                              │
│ ├── SIGINT:    Ctrl+C (catchable)                                               │
│ ├── SIGTERM:   terminate request (catchable, K8s sends this)                    │
│ ├── SIGKILL:   force kill (NOT catchable, K8s sends at grace end)               │
│ ├── SIGHUP:    hangup (often config reload)                                     │
│ └── SIGUSR1/2: user-defined (custom actions)                                    │
│                                                                                 │
│ DATABASE DRAIN PATTERN:                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ type DBWrapper struct {                                                     │ │
│ │     db     *sql.DB                                                          │ │
│ │     active sync.WaitGroup                                                   │ │
│ │     mu     sync.RWMutex   // makes the gate+Add one step                    │ │
│ │     closed bool                                                             │ │
│ │ }                                                                           │ │
│ │                                                                             │ │
│ │ func (w *DBWrapper) enter() bool {                                          │ │
│ │     w.mu.RLock()                                                            │ │
│ │     defer w.mu.RUnlock()                                                    │ │
│ │     if w.closed { return false }                                            │ │
│ │     w.active.Add(1)   // Add cannot land after Wait sees zero               │ │
│ │     return true                                                             │ │
│ │ }                                                                           │ │
│ │                                                                             │ │
│ │ func (w *DBWrapper) Shutdown(ctx context.Context) error {                   │ │
│ │     w.mu.Lock(); w.closed = true; w.mu.Unlock()                             │ │
│ │     done := make(chan struct{})                                             │ │
│ │     go func() { w.active.Wait(); close(done) }()                            │ │
│ │     select {                                                                │ │
│ │     case <-done:     return w.db.Close()                                    │ │
│ │     case <-ctx.Done(): w.db.Close(); return ctx.Err()                       │ │
│ │     }                                                                       │ │
│ │ }                                                                           │ │
│ │                                                                             │ │
│ │ // db.Close() does NOT wait for in-flight queries. That is why              │ │
│ │ // the WaitGroup exists. (Close IS idempotent and never panics.)            │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Reference in Every Service Template

The shutdown sequence is complex enough to get wrong. Embed this reference in every service template and onboarding doc. Engineers who remember the order ship correct shutdowns. Engineers who guess ship broken ones.
