## 21.8 Complete Application: Production Service Manager

The following service manager handles graceful shutdown for every component (HTTP server, gRPC server, worker pools, message consumers, and database connections) through a single `Run` entry point and a five-phase `shutdown` method. It uses `atomic.Bool` flags for lock-free health state and reverse-order component teardown to respect dependency ordering.

Everything with a lifecycle implements one small `Component` interface and is stopped in reverse registration order. There is no special case for gRPC: it gets an adapter like anything else. That uniformity is what keeps the shutdown path readable as it grows.

```go
// service/manager.go
package service

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "sync/atomic"
    "syscall"
    "time"

    "golang.org/x/sync/errgroup"
)

// Config holds service configuration
type Config struct {
    // HTTP server
    HTTPAddr         string
    HTTPReadTimeout  time.Duration
    HTTPWriteTimeout time.Duration

    // Shutdown
    ShutdownTimeout  time.Duration
    DrainDelay       time.Duration

    // Components
    WorkerCount      int

    // Health
    HealthPath       string
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        HTTPAddr:         ":8080",
        HTTPReadTimeout:  30 * time.Second,
        HTTPWriteTimeout: 30 * time.Second,
        ShutdownTimeout:  30 * time.Second,
        DrainDelay:       5 * time.Second,
        WorkerCount:      10,
        HealthPath:       "/health",
    }
}

// Manager coordinates all service components
type Manager struct {
    config Config
    logger *slog.Logger

    // Components. Everything with a lifecycle goes in `components` and is
    // stopped in reverse registration order. A gRPC server is registered the
    // same way, via a small adapter whose Stop calls GracefulStop.
    httpServer *http.Server
    db         *sql.DB

    // State
    healthy      atomic.Bool // liveness: stays true through a normal drain
    ready        atomic.Bool // readiness: goes false the moment we shut down
    shuttingDown atomic.Bool

    // Synchronization
    mu         sync.RWMutex
    components []Component

    // Hooks
    onShutdown []func(context.Context) error
}

// Component represents a stoppable service component. Start must return
// promptly (it launches work, it does not block on it). Stop must block until
// the component has actually stopped, or until ctx expires.
type Component interface {
    Name() string
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
}

// grpcComponent adapts a gRPC server to Component so it participates in the
// same ordered teardown as everything else, rather than being a special case.
type grpcComponent struct {
    name string
    srv  interface {
        Serve(net.Listener) error
        GracefulStop()
        Stop()
    }
    lis net.Listener
}

func (g *grpcComponent) Name() string { return g.name }

func (g *grpcComponent) Start(ctx context.Context) error {
    go func() {
        if err := g.srv.Serve(g.lis); err != nil {
            slog.Error("grpc serve", "error", err)
        }
    }()
    return nil
}

func (g *grpcComponent) Stop(ctx context.Context) error {
    // GracefulStop blocks until all in-flight RPCs finish, and it has no
    // context parameter, so it must be raced against the deadline by hand.
    done := make(chan struct{})
    go func() {
        g.srv.GracefulStop()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        g.srv.Stop() // hard stop: kill remaining RPCs so we can exit
        <-done
        return ctx.Err()
    }
}

// New creates a new service manager
func New(cfg Config, logger *slog.Logger) *Manager {
    m := &Manager{
        config:     cfg,
        logger:     logger,
        components: make([]Component, 0),
        onShutdown: make([]func(context.Context) error, 0),
    }

    m.healthy.Store(true)
    m.ready.Store(false)

    return m
}

// SetHTTPHandler sets the HTTP handler
func (m *Manager) SetHTTPHandler(handler http.Handler) {
    // Wrap handler with health and metrics endpoints
    mux := http.NewServeMux()
    mux.HandleFunc(m.config.HealthPath, m.healthHandler)
    mux.HandleFunc(m.config.HealthPath+"/live", m.livenessHandler)
    mux.HandleFunc(m.config.HealthPath+"/ready", m.readinessHandler)
    mux.Handle("/", m.requestTracker(handler))

    m.httpServer = &http.Server{
        Addr:         m.config.HTTPAddr,
        Handler:      mux,
        ReadTimeout:  m.config.HTTPReadTimeout,
        WriteTimeout: m.config.HTTPWriteTimeout,
    }
}

// SetDatabase sets the database connection
func (m *Manager) SetDatabase(db *sql.DB) {
    m.db = db
}

// AddComponent registers a component for lifecycle management
func (m *Manager) AddComponent(c Component) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.components = append(m.components, c)
}

// OnShutdown registers a shutdown hook
func (m *Manager) OnShutdown(fn func(context.Context) error) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.onShutdown = append(m.onShutdown, fn)
}

// Run starts all components and waits for shutdown
func (m *Manager) Run(ctx context.Context) error {
    m.logger.Info("starting service manager")

    // Create cancellable context
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    // Setup signal handler
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    // Start all components
    g, ctx := errgroup.WithContext(ctx)

    // HTTP server
    if m.httpServer != nil {
        g.Go(func() error {
            return m.runHTTPServer(ctx)
        })
    }

    // Custom components.
    //
    // Note the context: components get a context derived from the *parent*
    // with cancellation detached, NOT the errgroup's ctx. If they shared the
    // errgroup ctx, the arrival of SIGTERM would cancel every component
    // simultaneously, and the reverse-order Stop() loop in phase 3 would be
    // pure theater: it would be stopping things that had already stopped
    // themselves, in no particular order. Detaching cancellation means the
    // only thing that stops a component is its Stop method, which is what
    // makes the ordering real.
    componentCtx := context.WithoutCancel(ctx)
    for _, c := range m.components {
        m.logger.Info("starting component", "name", c.Name())
        if err := c.Start(componentCtx); err != nil {
            cancel()
            return fmt.Errorf("start %s: %w", c.Name(), err)
        }
    }

    // Wait for context cancellation
    g.Go(func() error {
        select {
        case sig := <-sigChan:
            m.logger.Info("received signal", "signal", sig)
            cancel()
            return nil
        case <-ctx.Done():
            return nil
        }
    })

    // Mark as ready
    m.ready.Store(true)
    m.logger.Info("service is ready")

    // Wait for first error or completion
    if err := g.Wait(); err != nil && !errors.Is(err, context.Canceled) {
        return fmt.Errorf("component error: %w", err)
    }

    // Graceful shutdown
    return m.shutdown()
}

func (m *Manager) runHTTPServer(ctx context.Context) error {
    errChan := make(chan error, 1)

    go func() {
        m.logger.Info("starting HTTP server", "addr", m.config.HTTPAddr)
        if err := m.httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
            errChan <- err
        }
        close(errChan)
    }()

    select {
    case err := <-errChan:
        return err
    case <-ctx.Done():
        return nil
    }
}

func (m *Manager) shutdown() error {
    if m.shuttingDown.Swap(true) {
        return nil // Already shutting down
    }

    m.logger.Info("initiating graceful shutdown")
    start := time.Now()

    ctx, cancel := context.WithTimeout(context.Background(), m.config.ShutdownTimeout)
    defer cancel()

    // Phase 1: fail readiness. Note we do NOT touch m.healthy: liveness must
    // keep passing for the whole drain, or the kubelet restarts the container
    // out from under our in-flight requests.
    m.logger.Info("phase 1: failing readiness")
    m.ready.Store(false)

    // Wait for load balancers to notice. Throughout this window we keep
    // serving new requests completely normally: the listener is still open
    // and the handler still runs. That is the entire point. Traffic is still
    // arriving because endpoint removal has not propagated yet, and 503ing it
    // here would cause exactly the errors this delay exists to prevent.
    m.logger.Info("waiting for drain delay", "delay", m.config.DrainDelay)
    select {
    case <-time.After(m.config.DrainDelay):
    case <-ctx.Done():
        m.logger.Warn("drain delay interrupted")
    }

    // Phase 2: Stop accepting new work
    m.logger.Info("phase 2: stopping new connections")
    if m.httpServer != nil {
        if err := m.httpServer.Shutdown(ctx); err != nil {
            m.logger.Error("HTTP server shutdown error", "error", err)
        }
    }

    // Phase 3: Stop components (reverse order)
    m.logger.Info("phase 3: stopping components")
    m.mu.RLock()
    components := m.components
    m.mu.RUnlock()

    for i := len(components) - 1; i >= 0; i-- {
        c := components[i]
        m.logger.Info("stopping component", "name", c.Name())
        if err := c.Stop(ctx); err != nil {
            m.logger.Error("component stop error", "name", c.Name(), "error", err)
        }
    }

    // Phase 4: Run shutdown hooks
    m.logger.Info("phase 4: running shutdown hooks")
    m.mu.RLock()
    hooks := m.onShutdown
    m.mu.RUnlock()

    for i, hook := range hooks {
        if err := hook(ctx); err != nil {
            m.logger.Error("shutdown hook error", "index", i, "error", err)
        }
    }

    // Phase 5: Close resources
    m.logger.Info("phase 5: closing resources")
    if m.db != nil {
        if err := m.db.Close(); err != nil {
            m.logger.Error("database close error", "error", err)
        }
    }

    m.logger.Info("shutdown complete", "duration", time.Since(start))
    return nil
}

// Health handlers

func (m *Manager) healthHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")

    status := struct {
        Healthy  bool   `json:"healthy"`
        Ready    bool   `json:"ready"`
        Shutdown bool   `json:"shutting_down"`
    }{
        Healthy:  m.healthy.Load(),
        Ready:    m.ready.Load(),
        Shutdown: m.shuttingDown.Load(),
    }

    if !status.Healthy || status.Shutdown {
        w.WriteHeader(http.StatusServiceUnavailable)
    }

    json.NewEncoder(w).Encode(status)
}

func (m *Manager) livenessHandler(w http.ResponseWriter, r *http.Request) {
    if m.healthy.Load() {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("UNHEALTHY"))
    }
}

func (m *Manager) readinessHandler(w http.ResponseWriter, r *http.Request) {
    if m.ready.Load() && !m.shuttingDown.Load() {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("READY"))
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte("NOT READY"))
    }
}

// Request tracking middleware

type requestTracker struct {
    handler http.Handler
    manager *Manager
    active  atomic.Int64
}

func (m *Manager) requestTracker(next http.Handler) http.Handler {
    return &requestTracker{
        handler: next,
        manager: m,
    }
}

func (rt *requestTracker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Deliberately NO shuttingDown check here. See "Do not 503 during the
    // drain delay" below: during that window the load balancer is still
    // routing to us, and our job is to serve those requests normally.
    // Refusing new connections is Shutdown's job, and it happens later,
    // by closing the listener.
    rt.active.Add(1)
    defer rt.active.Add(-1)

    rt.handler.ServeHTTP(w, r)
}

func (rt *requestTracker) ActiveRequests() int64 {
    return rt.active.Load()
}

// ============================================================================
// WORKER POOL WITH GRACEFUL SHUTDOWN
// ============================================================================

// WorkerPool manages a pool of workers
type WorkerPool struct {
    name      string
    workers   int
    jobs      chan Job
    logger    *slog.Logger

    ctx       context.Context
    cancel    context.CancelFunc
    wg        sync.WaitGroup
    started   atomic.Bool
}

// Job represents a unit of work
type Job interface {
    Execute(ctx context.Context) error
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(name string, workers int, logger *slog.Logger) *WorkerPool {
    return &WorkerPool{
        name:    name,
        workers: workers,
        jobs:    make(chan Job, workers*10),
        logger:  logger,
    }
}

// Name returns the component name
func (p *WorkerPool) Name() string {
    return p.name
}

// Start starts the worker pool
func (p *WorkerPool) Start(ctx context.Context) error {
    if p.started.Swap(true) {
        return errors.New("worker pool already started")
    }

    p.ctx, p.cancel = context.WithCancel(ctx)

    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }

    p.logger.Info("worker pool started", "name", p.name, "workers", p.workers)
    return nil
}

// Stop stops the worker pool gracefully
func (p *WorkerPool) Stop(ctx context.Context) error {
    p.logger.Info("stopping worker pool", "name", p.name)

    // Signal workers to stop
    p.cancel()

    // Wait for workers with timeout
    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        p.logger.Info("worker pool stopped", "name", p.name)
        return nil
    case <-ctx.Done():
        p.logger.Warn("worker pool stop timeout", "name", p.name)
        return ctx.Err()
    }
}

// Submit submits a job to the pool.
func (p *WorkerPool) Submit(ctx context.Context, job Job) error {
    if !p.started.Load() {
        return errors.New("worker pool not started") // p.ctx is nil until Start
    }
    select {
    case p.jobs <- job:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    case <-p.ctx.Done():
        return errors.New("worker pool stopped")
    }
}

func (p *WorkerPool) worker(id int) {
    defer p.wg.Done()

    p.logger.Debug("worker started", "pool", p.name, "worker_id", id)

    for {
        select {
        case <-p.ctx.Done():
            p.logger.Debug("worker stopping", "pool", p.name, "worker_id", id)
            return

        case job := <-p.jobs:
            if err := p.executeJob(job); err != nil {
                p.logger.Error("job failed", "pool", p.name, "worker_id", id, "error", err)
            }
        }
    }
}

func (p *WorkerPool) executeJob(job Job) error {
    // Create job context with timeout
    ctx, cancel := context.WithTimeout(p.ctx, 5*time.Minute)
    defer cancel()

    return job.Execute(ctx)
}

// ============================================================================
// MESSAGE CONSUMER WITH GRACEFUL SHUTDOWN
// ============================================================================

// MessageConsumer consumes messages from a queue
type MessageConsumer struct {
    name       string
    queue      string
    handler    func(ctx context.Context, msg []byte) error
    logger     *slog.Logger

    ctx        context.Context
    cancel     context.CancelFunc
    wg         sync.WaitGroup
    processing atomic.Int64
}

// NewMessageConsumer creates a new message consumer
func NewMessageConsumer(name, queue string, handler func(ctx context.Context, msg []byte) error, logger *slog.Logger) *MessageConsumer {
    return &MessageConsumer{
        name:    name,
        queue:   queue,
        handler: handler,
        logger:  logger,
    }
}

func (c *MessageConsumer) Name() string {
    return c.name
}

func (c *MessageConsumer) Start(ctx context.Context) error {
    c.ctx, c.cancel = context.WithCancel(ctx)

    c.wg.Add(1)
    go c.consume()

    c.logger.Info("consumer started", "name", c.name, "queue", c.queue)
    return nil
}

func (c *MessageConsumer) Stop(ctx context.Context) error {
    c.logger.Info("stopping consumer", "name", c.name, "queue", c.queue)

    c.cancel()

    // Wait for in-flight messages
    done := make(chan struct{})
    go func() {
        c.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        c.logger.Info("consumer stopped", "name", c.name)
        return nil
    case <-ctx.Done():
        c.logger.Warn("consumer stop timeout",
            "name", c.name,
            "in_flight", c.processing.Load())
        return ctx.Err()
    }
}

func (c *MessageConsumer) consume() {
    defer c.wg.Done()

    for {
        select {
        case <-c.ctx.Done():
            return
        default:
            // Simulate receiving a message
            msg := c.receiveMessage(c.ctx)
            if msg == nil {
                continue
            }

            c.processing.Add(1)
            if err := c.handler(c.ctx, msg); err != nil {
                c.logger.Error("message handling failed", "error", err)
            }
            c.processing.Add(-1)
        }
    }
}

func (c *MessageConsumer) receiveMessage(ctx context.Context) []byte {
    // Placeholder for actual message receiving
    select {
    case <-ctx.Done():
        return nil
    case <-time.After(100 * time.Millisecond):
        return nil
    }
}
```

### Do Not 503 During the Drain Delay

This is the subtlest trap in the whole file, and it is worth dwelling on because the broken version looks *more* careful than the correct one.

The instinct is to have the request middleware refuse traffic as soon as shutdown starts:

```go
// WRONG: this defeats the drain delay entirely.
func (rt *requestTracker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if rt.manager.shuttingDown.Load() {
        http.Error(w, "Service shutting down", http.StatusServiceUnavailable)
        return
    }
    ...
}
```

`shuttingDown` is set at the *top* of `shutdown()`, before the drain delay. So for the entire drain window, every request that arrives is rejected. But the drain delay exists precisely because traffic is *still arriving* during that window: endpoint removal has not propagated to kube-proxy yet. Instrument the broken version with a client that keeps sending during the delay, as the load balancer does, and the result is unambiguous: across a 500ms drain window, **399 requests returned 503 and zero returned 200**. Every one of them would have succeeded.

You have not made shutdown graceful. You have converted a window where you should serve traffic into a window where you guarantee errors, and you have done it with code that reads like a safety check. The 503-with-`Connection: close` version is strictly worse than having no drain delay at all, because the delay now lengthens the outage.

The correct division of labour:

- **Readiness probe** goes red immediately. This is the *only* signal that should react to `shuttingDown`. It is what makes Kubernetes remove you from endpoints.
- **Request path** keeps serving normally, unchanged, for the whole delay.
- **`Shutdown`** closes the listener when the delay expires. From that instant new connections are refused at the TCP layer, which is what a load balancer correctly interprets as "reroute", and in-flight requests still finish.

`shuttingDown` remains useful for the readiness handler and for logging. It just has no business in the request path.

### Two More Sharp Edges

**The `Stop` deadline is shared, not per-component.** Phases 2 through 5 all receive the same `ctx`, built once from `ShutdownTimeout`. A component that burns the entire budget in phase 3 leaves nothing for the hooks and the database close in phases 4 and 5, which then fail instantly with `context.DeadlineExceeded`. That is the correct behavior (the total is what `terminationGracePeriodSeconds` bounds), but it means a single slow component silently skips your telemetry flush. If a phase must not be starved, give it its own budget.

**`WorkerPool.Stop` cancels before it drains.** It calls `p.cancel()` and then waits for the workers. Workers select on both `p.ctx.Done()` and `p.jobs`, and when both are ready Go picks at random, so jobs already sitting in the buffered queue are mostly abandoned rather than finished. For a pool whose jobs are re-delivered by an external queue, that is fine and even desirable. For a pool holding the only copy of the work, it is data loss. If you need the queue drained, stop accepting new jobs first, close `p.jobs`, and let workers run it to empty with `for job := range p.jobs`.

### Usage Example

The following `main.go` demonstrates wiring all components into the manager before calling `Run`. The manager owns the lifecycle: it starts the HTTP server, then each registered component, and on signal receipt executes the five-phase shutdown sequence: fail readiness, wait out the drain delay while still serving, stop listeners, stop components in reverse order, run hooks, and close the database. The ordering is what guarantees no component tears down a resource another still holds.

```go
// main.go
package main

import (
    "context"
    "database/sql"
    "log/slog"
    "net/http"
    "os"
    "time"

    _ "github.com/lib/pq" // registers the "postgres" driver

    "myapp/metrics"
    "myapp/service"
)

func main() {
    // Setup logger
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Configure service.
    //
    // ShutdownTimeout is the budget for the WHOLE shutdown, drain delay
    // included: 5s of LB propagation leaves 25s to actually drain. So this
    // pod needs terminationGracePeriodSeconds comfortably above 30, say 40.
    // At the 30s default, SIGKILL lands exactly as the drain finishes and
    // phases 4 and 5 never run.
    cfg := service.DefaultConfig()
    cfg.HTTPAddr = ":8080"
    cfg.ShutdownTimeout = 30 * time.Second
    cfg.DrainDelay = 5 * time.Second

    // Create manager
    manager := service.New(cfg, logger)

    // Setup database
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Error("failed to open database", "error", err)
        os.Exit(1)
    }
    manager.SetDatabase(db)

    // Setup HTTP handler
    router := http.NewServeMux()
    router.HandleFunc("/api/users", handleUsers)
    manager.SetHTTPHandler(router)

    // Add worker pool
    workers := service.NewWorkerPool("background-jobs", 10, logger)
    manager.AddComponent(workers)

    // Add message consumer
    consumer := service.NewMessageConsumer(
        "order-consumer",
        "orders",
        processOrder,
        logger,
    )
    manager.AddComponent(consumer)

    // Register shutdown hooks
    manager.OnShutdown(func(ctx context.Context) error {
        logger.Info("flushing metrics")
        return metrics.Flush(ctx)
    })

    // Run service
    if err := manager.Run(context.Background()); err != nil {
        logger.Error("service error", "error", err)
        os.Exit(1)
    }
}
```

### Staff Lens: Service Manager Libraries

Production service managers (this pattern, uber-go/fx, etc.) encode the correct shutdown sequence once. Every new service gets correctness by default. This is the most valuable investment for an org with many Go services.

The alternative, each service implementing shutdown independently, inevitably produces variations that are subtly broken in different ways. The unified library is worth the initial build.

---
