## 21.9 Company Case Studies

### Google: Zero-Downtime Deployments

Google deploys software thousands of times per day across millions of containers. Their internal tooling enforces three patterns that prevent dropped requests during rollouts: layered health checks that separate liveness from readiness, connection draining with a hard deadline, and staged shutdown that executes cleanup functions in a defined order with per-stage timeouts.

```go
// 1. Layered Health Checks
type HealthManager struct {
    liveness  atomic.Bool  // Process running
    readiness atomic.Bool  // Can serve traffic
    startup   atomic.Bool  // Initial startup complete
}

func (h *HealthManager) LivenessCheck() bool {
    return h.liveness.Load()
}

func (h *HealthManager) ReadinessCheck() bool {
    return h.readiness.Load() && h.startup.Load()
}

// 2. Connection Draining with Deadlines
type ConnectionDrainer struct {
    activeConnections sync.WaitGroup
    maxDrainTime      time.Duration
}

func (d *ConnectionDrainer) Drain(ctx context.Context) error {
    // Create deadline from context or max drain time
    deadline := time.Now().Add(d.maxDrainTime)
    if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
        deadline = ctxDeadline
    }

    done := make(chan struct{})
    go func() {
        d.activeConnections.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(time.Until(deadline)):
        return errors.New("drain timeout")
    }
}

// 3. Staged Shutdown
type StagedShutdown struct {
    stages []ShutdownStage
    logger *slog.Logger
}

type ShutdownStage struct {
    Name    string
    Timeout time.Duration
    Action  func(context.Context) error
}

func (s *StagedShutdown) Execute(ctx context.Context) error {
    for _, stage := range s.stages {
        stageCtx, cancel := context.WithTimeout(ctx, stage.Timeout)

        s.logger.Info("executing shutdown stage", "stage", stage.Name)
        start := time.Now()

        if err := stage.Action(stageCtx); err != nil {
            s.logger.Error("stage failed", "stage", stage.Name, "error", err)
            // Continue to next stage
        }

        s.logger.Info("stage complete", "stage", stage.Name, "duration", time.Since(start))
        cancel()
    }
    return nil
}

// Usage
shutdown := &StagedShutdown{
    stages: []ShutdownStage{
        {Name: "mark_unhealthy", Timeout: time.Second, Action: markUnhealthy},
        {Name: "drain_delay", Timeout: 5 * time.Second, Action: drainDelay},
        {Name: "stop_http", Timeout: 10 * time.Second, Action: stopHTTP},
        {Name: "drain_workers", Timeout: 10 * time.Second, Action: drainWorkers},
        {Name: "close_db", Timeout: 5 * time.Second, Action: closeDB},
    },
}
```

### Uber: Graceful Degradation

Ride-hailing platforms carry huge numbers of concurrent trips, so a server shutdown cannot simply drop connections. A rider mid-trip would lose real-time GPS updates and ETA calculations. The approach uses two patterns: ride-aware shutdown that hands active rides to peer instances before the process exits, and persistent connection management that sends WebSocket close frames with a `GoingAway` status code so clients reconnect to a healthy instance automatically.

```go
// 1. Ride-Aware Shutdown
type RideAwareShutdown struct {
    activeRides sync.Map // rideID -> *Ride
    handoff     chan *Ride
}

func (s *RideAwareShutdown) Shutdown(ctx context.Context) error {
    // Don't accept new rides
    s.stopAcceptingRides()

    // Hand off active rides to other instances
    var wg sync.WaitGroup
    s.activeRides.Range(func(key, value any) bool {
        ride := value.(*Ride)
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := s.handoffRide(ctx, ride); err != nil {
                log.Printf("Failed to handoff ride %s: %v", ride.ID, err)
            }
        }()
        return true
    })

    // Wait for handoffs with timeout
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return fmt.Errorf("ride handoff timeout, %d rides orphaned", s.countRides())
    }
}

// 2. Persistent Connection Handling
type PersistentConnectionManager struct {
    connections sync.Map
    closing     atomic.Bool
}

func (m *PersistentConnectionManager) Close(ctx context.Context) error {
    m.closing.Store(true)

    // Send close frame to all websocket connections
    m.connections.Range(func(key, value any) bool {
        conn := value.(*websocket.Conn)
        conn.WriteControl(
            websocket.CloseMessage,
            websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
            time.Now().Add(time.Second),
        )
        return true
    })

    // Wait for connections to close
    start := time.Now()
    for m.connectionCount() > 0 {
        if time.Since(start) > 10*time.Second {
            break
        }
        time.Sleep(100 * time.Millisecond)
    }

    // Force close remaining
    m.connections.Range(func(key, value any) bool {
        conn := value.(*websocket.Conn)
        conn.Close()
        return true
    })

    return nil
}
```

### Netflix: Chaos-Resilient Shutdown

Netflix runs chaos experiments that intentionally terminate instances during peak load to verify that shutdown paths work under real conditions, not just in integration tests. Their shutdown code disables non-essential features (recommendations, analytics, preview generation) first to free resources for core playback, then uses hedged requests to retry any in-flight call that fails because the target instance is draining.

```go
// 1. Shutdown Chaos Testing
type ShutdownChaosTest struct {
    service    *Service
    scenarios  []ChaosScenario
}

type ChaosScenario struct {
    Name        string
    Setup       func() error
    Verify      func() error
    Cleanup     func() error
}

func (t *ShutdownChaosTest) Run() []TestResult {
    results := make([]TestResult, 0)

    for _, scenario := range t.scenarios {
        result := t.runScenario(scenario)
        results = append(results, result)
    }

    return results
}

// Scenarios:
// - Shutdown during high load
// - Shutdown with stuck requests
// - Shutdown with database failure
// - Shutdown with network partition
// - SIGKILL before SIGTERM completion

// 2. Graceful Degradation During Shutdown
type DegradationManager struct {
    shuttingDown atomic.Bool
    features     map[string]*atomic.Bool
}

func (m *DegradationManager) DisableFeaturesDuringShutdown() {
    // Disable non-essential features first
    m.features["recommendations"].Store(false)
    m.features["analytics"].Store(false)
    m.features["previews"].Store(false)

    // Keep core playback running
    // m.features["playback"] stays enabled
}

func (m *DegradationManager) FeatureEnabled(name string) bool {
    if feature, ok := m.features[name]; ok {
        return feature.Load()
    }
    return false
}

// 3. Request Hedging During Shutdown
type HedgedRequester struct {
    instances []string
    current   int
}

func (r *HedgedRequester) Request(ctx context.Context, req *Request) (*Response, error) {
    // During shutdown, immediately retry to other instances
    for i := 0; i < len(r.instances); i++ {
        instance := r.instances[(r.current+i)%len(r.instances)]

        resp, err := r.makeRequest(ctx, instance, req)
        if err == nil {
            return resp, nil
        }

        // If instance is shutting down, try next immediately
        if isShuttingDown(err) {
            continue
        }

        return nil, err
    }

    return nil, errors.New("all instances unavailable")
}
```

### Stripe: Zero-Transaction-Loss Shutdown

Payment systems cannot lose a transaction during a deployment. The pattern below combines three mechanisms: an in-process gate that stops new transactions from starting on the draining instance, an idempotency store that flushes in-memory records to durable storage before exit, and a checkpoint file that records pending payment state so a restarted process resumes where the previous one left off.

```go
// 1. Transaction-Safe Shutdown
type TransactionSafeShutdown struct {
    db          *sql.DB
    inflightTxs sync.Map    // txID -> *Transaction
    accepting   atomic.Bool // gate: false once shutdown begins
}

func (s *TransactionSafeShutdown) BeginShutdown(ctx context.Context) error {
    // Stop new transactions from starting HERE, in this process. Every code
    // path that opens a payment transaction checks this gate first.
    s.accepting.Store(false)

    // Wait for in-flight transactions to complete
    return s.waitForInflight(ctx)
}

// BeginTx is the only way payment code opens a transaction, so the gate
// cannot be bypassed.
func (s *TransactionSafeShutdown) BeginTx(ctx context.Context) (*sql.Tx, error) {
    if !s.accepting.Load() {
        return nil, ErrDraining // caller retries against a healthy instance
    }
    return s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
}

func (s *TransactionSafeShutdown) waitForInflight(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            count := 0
            s.inflightTxs.Range(func(key, value any) bool {
                count++
                return true
            })

            if count == 0 {
                return nil
            }
        }
    }
}

// 2. Idempotency Key Persistence
type IdempotencyStore struct {
    store map[string]*IdempotencyRecord
    mu    sync.RWMutex
}

func (s *IdempotencyStore) FlushBeforeShutdown(ctx context.Context) error {
    s.mu.RLock()
    defer s.mu.RUnlock()

    // Persist all in-memory idempotency records
    for key, record := range s.store {
        if err := s.persistRecord(ctx, key, record); err != nil {
            return fmt.Errorf("failed to persist %s: %w", key, err)
        }
    }

    return nil
}

// 3. Payment Checkpointing
type PaymentProcessor struct {
    checkpointFile string
    pending        map[string]*Payment
    mu             sync.RWMutex
}

func (p *PaymentProcessor) Checkpoint() error {
    p.mu.RLock()
    defer p.mu.RUnlock()

    data, err := json.Marshal(p.pending)
    if err != nil {
        return err
    }

    // Write atomically
    tmpFile := p.checkpointFile + ".tmp"
    if err := os.WriteFile(tmpFile, data, 0600); err != nil {
        return err
    }

    return os.Rename(tmpFile, p.checkpointFile)
}

func (p *PaymentProcessor) RecoverFromCheckpoint() error {
    data, err := os.ReadFile(p.checkpointFile)
    if os.IsNotExist(err) {
        return nil
    }
    if err != nil {
        return err
    }

    return json.Unmarshal(data, &p.pending)
}
```

**Why not a PostgreSQL advisory lock?** A tempting version of this acquires `pg_advisory_xact_lock(shutdownLockID)` in a long-lived transaction and calls it "preventing new transactions". It is worth understanding why that is wrong, because it looks sophisticated.

An advisory lock lives in the **database**, which every instance shares. It is not scoped to the draining process. So if the other instances also take that lock before starting work, a single pod's shutdown blocks the entire fleet, turning a routine rolling restart into a global stall. And if they do not take it, the lock prevents nothing at all, because advisory locks are purely advisory: they constrain only the code that asks for them. Both outcomes are bad, and which one you get depends on code that is not in this file.

"Do not start new local work" is a **local** predicate. It belongs in a local variable. The `atomic.Bool` gate is not a simplification of the database lock, it is the correct tool, and the database lock is a distributed answer to a non-distributed question.

Holding that transaction open through the drain compounds it. A `SERIALIZABLE` transaction pinned open for the length of shutdown holds a pooled connection, blocks vacuum from cleaning rows newer than its snapshot, and in the code above is never committed or rolled back on the success path at all. It leaks until the process exits.

**On the checkpoint's durability.** `Checkpoint` writes a temp file and renames it, and `os.Rename` within a filesystem is atomic with respect to *readers*: nobody ever sees a half-written checkpoint. That is enough for the graceful-restart case this section is about. It is **not** crash-safe. Neither the file's contents nor the directory entry are guaranteed to be on disk after a power loss, so the rename can survive while the data it points at does not. For a payments checkpoint that must survive a hard kill, `Sync` the file before the rename and `Sync` the directory after it:

```go
import "path/filepath"

f, err := os.OpenFile(tmpFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
if err != nil {
    return err
}
if _, err := f.Write(data); err != nil {
    f.Close()
    return err
}
if err := f.Sync(); err != nil { // contents durable before the rename
    f.Close()
    return err
}
if err := f.Close(); err != nil {
    return err
}
if err := os.Rename(tmpFile, p.checkpointFile); err != nil {
    return err
}
dir, err := os.Open(filepath.Dir(p.checkpointFile))
if err != nil {
    return err
}
defer dir.Close()
return dir.Sync() // the rename itself durable
```

That is three extra syscalls on a path that runs once per shutdown. Cheap insurance for a file whose entire purpose is surviving the process that wrote it.

### Staff Lens: Shutdown Correctness Is a Production Readiness Gate

Each case study shows a team that treats graceful shutdown as a production requirement, not an optional feature. Make it a checklist item before any new service handles production traffic: can we restart it mid-request without data loss? Can we scale it down without 5xx errors? If not, it is not production-ready.

---
