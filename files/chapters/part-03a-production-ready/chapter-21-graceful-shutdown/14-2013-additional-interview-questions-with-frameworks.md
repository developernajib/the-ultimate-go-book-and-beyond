## 21.13 Additional Interview Questions with Frameworks

### Question 6: Design a Multi-Component Shutdown Orchestrator

**Problem**: Design a shutdown system that coordinates graceful shutdown across HTTP servers, gRPC servers, message consumers, background workers, and database connections, ensuring proper ordering and timeout handling.

The dependency graph below shows the correct teardown order. Components higher in the graph must stop first so that components lower in the graph (which they depend on) remain available until all upstream work finishes.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                  SHUTDOWN ORCHESTRATOR ARCHITECTURE                               │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  COMPONENT DEPENDENCY GRAPH:                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐      │
│  │                                                                         │      │
│  │                    ┌─────────────┐                                      │      │
│  │                    │   Health    │  ← Shutdown FIRST (immediate)        │      │
│  │                    │   Probes    │                                      │      │
│  │                    └──────┬──────┘                                      │      │
│  │                           │                                             │      │
│  │              ┌────────────┴────────────┐                                │      │
│  │              ▼                         ▼                                │      │
│  │       ┌───────────┐             ┌───────────┐                           │      │
│  │       │   HTTP    │             │   gRPC    │  ← Stop accepting new     │      │
│  │       │  Server   │             │  Server   │    connections            │      │
│  │       └─────┬─────┘             └─────┬─────┘                           │      │
│  │             │                         │                                 │      │
│  │             └────────────┬────────────┘                                 │      │
│  │                          │                                              │      │
│  │              ┌───────────┴───────────┐                                  │      │
│  │              ▼                       ▼                                  │      │
│  │       ┌───────────┐           ┌───────────┐                             │      │
│  │       │  Message  │           │ Background│  ← Stop processing new      │      │
│  │       │ Consumers │           │  Workers  │    work, complete in-flight │      │
│  │       └─────┬─────┘           └─────┬─────┘                             │      │
│  │             │                       │                                   │      │
│  │             └───────────┬───────────┘                                   │      │
│  │                         │                                               │      │
│  │                         ▼                                               │      │
│  │                  ┌───────────┐                                          │      │
│  │                  │  Caches,  │  ← Flush pending writes                  │      │
│  │                  │  Metrics  │                                          │      │
│  │                  └─────┬─────┘                                          │      │
│  │                        │                                                │      │
│  │                        ▼                                                │      │
│  │                  ┌───────────┐                                          │      │
│  │                  │ Database  │  ← Close LAST (wait for txns)            │      │
│  │                  └───────────┘                                          │      │
│  │                                                                         │      │
│  └─────────────────────────────────────────────────────────────────────────┘      │
│                                                                                   │
│  SHUTDOWN TIMELINE:                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐      │
│  │                                                                         │      │
│  │  T+0s     T+0s      T+5s      T+10s     T+20s     T+25s     T+30s       │      │
│  │    │        │         │         │         │         │         │         │      │
│  │    │  ┌─────┴─────┐   │         │         │         │         │         │      │
│  │    │  │Unhealthy  │   │         │         │         │         │         │      │
│  │    │  │+LB Drain  │   │         │         │         │         │         │      │
│  │    │  └───────────┘   │         │         │         │         │         │      │
│  │    │                  │  ┌──────┴──────┐  │         │         │         │      │
│  │    │                  │  │Stop HTTP/   │  │         │         │         │      │
│  │    │                  │  │gRPC listen  │  │         │         │         │      │
│  │    │                  │  └─────────────┘  │         │         │         │      │
│  │    │                  │                   │  ┌──────┴──────┐  │         │      │
│  │    │                  │                   │  │Drain workers│  │         │      │
│  │    │                  │                   │  │+consumers   │  │         │      │
│  │    │                  │                   │  └─────────────┘  │         │      │
│  │    │                  │                   │            ┌──────┴──────┐  │      │
│  │    │                  │                   │            │Flush + Close│  │      │
│  │    │                  │                   │            │DB pools &   │  │      │
│  │    │                  │                   │            │connections  │  │      │
│  │    │                  │                   │            └─────────────┘  │      │
│  │ SIGTERM                                                                 │      │
│  │                                                                         │      │
│  └─────────────────────────────────────────────────────────────────────────┘      │
│                                                                                   │
│  ERROR HANDLING STRATEGY:                                                         │
│  ├── Component fails to stop: Log error, continue to next component               │
│  ├── Timeout exceeded: Force stop, log warning, continue                          │
│  ├── Panic in shutdown: Recover, log, continue                                    │
│  └── Multiple SIGTERM: Ignore subsequent signals                                  │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Implementation:**

The orchestrator groups registered components by numeric priority, then shuts down each priority group concurrently with a per-phase timeout. Components within the same priority level stop in parallel. Groups execute sequentially from lowest priority number (health probes) to highest (final cleanup). A `sync.Once` guard makes the sequence run exactly once no matter how many signals arrive, and because `Once.Do` blocks rather than returning early, a second caller waits for the first to finish instead of racing ahead.

Read the timeout config critically before you copy it. The interview answer that spots the flaw in it is the one that gets the offer, and it is discussed right after the code.

```go
// shutdown/orchestrator.go
package shutdown

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "slices"
    "sync"
    "sync/atomic"
    "syscall"
    "time"
)

// Priority defines shutdown order (lower = earlier)
type Priority int

const (
    PriorityHealth    Priority = 0   // Immediate
    PriorityListeners Priority = 10  // Stop accepting new work
    PriorityWorkers   Priority = 20  // Drain workers
    PriorityFlush     Priority = 30  // Flush caches/metrics
    PriorityDatabase  Priority = 40  // Close connections
    PriorityCleanup   Priority = 50  // Final cleanup
)

// Component interface for anything that needs graceful shutdown
type Component interface {
    Name() string
    Priority() Priority
    Stop(ctx context.Context) error
}

// Orchestrator coordinates shutdown of multiple components
type Orchestrator struct {
    logger         *slog.Logger
    components     []Component
    mu             sync.RWMutex

    shuttingDown   atomic.Bool
    shutdownOnce   sync.Once

    // Configuration
    drainDelay     time.Duration
    totalTimeout   time.Duration
    phaseTimeout   time.Duration

    // Hooks
    preShutdown    []func()
    postShutdown   []func()
}

// OrchestratorConfig configures the orchestrator
type OrchestratorConfig struct {
    DrainDelay   time.Duration // Wait for LB to drain (default: 5s)
    TotalTimeout time.Duration // Overall shutdown timeout (default: 30s)
    PhaseTimeout time.Duration // Per-phase timeout (default: 10s)
}

// DefaultConfig returns default configuration
func DefaultConfig() OrchestratorConfig {
    return OrchestratorConfig{
        DrainDelay:   5 * time.Second,
        TotalTimeout: 30 * time.Second,
        PhaseTimeout: 10 * time.Second,
    }
}

// NewOrchestrator creates a new shutdown orchestrator
func NewOrchestrator(cfg OrchestratorConfig, logger *slog.Logger) *Orchestrator {
    return &Orchestrator{
        logger:       logger,
        components:   make([]Component, 0),
        drainDelay:   cfg.DrainDelay,
        totalTimeout: cfg.TotalTimeout,
        phaseTimeout: cfg.PhaseTimeout,
    }
}

// Register adds a component to be managed
func (o *Orchestrator) Register(c Component) {
    o.mu.Lock()
    defer o.mu.Unlock()
    o.components = append(o.components, c)
}

// OnPreShutdown registers a hook to run before shutdown begins
func (o *Orchestrator) OnPreShutdown(fn func()) {
    o.mu.Lock()
    defer o.mu.Unlock()
    o.preShutdown = append(o.preShutdown, fn)
}

// OnPostShutdown registers a hook to run after shutdown completes
func (o *Orchestrator) OnPostShutdown(fn func()) {
    o.mu.Lock()
    defer o.mu.Unlock()
    o.postShutdown = append(o.postShutdown, fn)
}

// IsShuttingDown returns true if shutdown is in progress
func (o *Orchestrator) IsShuttingDown() bool {
    return o.shuttingDown.Load()
}

// WaitForSignal blocks until a shutdown signal is received
func (o *Orchestrator) WaitForSignal(ctx context.Context) os.Signal {
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    defer signal.Stop(sigChan) // without this the registration leaks

    select {
    case sig := <-sigChan:
        return sig
    case <-ctx.Done():
        return nil
    }
}

// Shutdown performs graceful shutdown of all components
func (o *Orchestrator) Shutdown(ctx context.Context) error {
    var err error

    o.shutdownOnce.Do(func() {
        o.shuttingDown.Store(true)
        err = o.doShutdown(ctx)
    })

    return err
}

func (o *Orchestrator) doShutdown(ctx context.Context) error {
    start := time.Now()
    o.logger.Info("initiating graceful shutdown")

    // Apply total timeout
    ctx, cancel := context.WithTimeout(ctx, o.totalTimeout)
    defer cancel()

    // Run pre-shutdown hooks
    o.runPreShutdownHooks()

    // Wait for LB drain
    o.logger.Info("waiting for load balancer drain", "delay", o.drainDelay)
    select {
    case <-time.After(o.drainDelay):
    case <-ctx.Done():
        o.logger.Warn("drain delay interrupted")
    }

    // Group components by priority
    groups := o.groupByPriority()

    // Shutdown each priority group
    var errs []error
    for _, priority := range sortedPriorities(groups) {
        group := groups[priority]
        if err := o.shutdownGroup(ctx, priority, group); err != nil {
            errs = append(errs, err)
        }
    }

    // Run post-shutdown hooks
    o.runPostShutdownHooks()

    o.logger.Info("shutdown complete",
        "duration", time.Since(start),
        "errors", len(errs))

    if len(errs) > 0 {
        return fmt.Errorf("shutdown errors: %v", errs)
    }
    return nil
}

func (o *Orchestrator) groupByPriority() map[Priority][]Component {
    o.mu.RLock()
    defer o.mu.RUnlock()

    groups := make(map[Priority][]Component)
    for _, c := range o.components {
        p := c.Priority()
        groups[p] = append(groups[p], c)
    }
    return groups
}

func (o *Orchestrator) shutdownGroup(ctx context.Context, priority Priority, components []Component) error {
    o.logger.Info("shutting down component group",
        "priority", priority,
        "count", len(components))

    // Create phase timeout
    phaseCtx, cancel := context.WithTimeout(ctx, o.phaseTimeout)
    defer cancel()

    // Shutdown components concurrently within priority group
    var wg sync.WaitGroup
    errChan := make(chan error, len(components))

    for _, c := range components {
        wg.Add(1)
        // No `(comp Component)` parameter needed: since Go 1.22 each
        // iteration has its own `c`.
        go func() {
            defer wg.Done()
            // Defers run LIFO, so this recover runs before wg.Done above:
            // a panicking component still releases the WaitGroup.
            defer func() {
                if r := recover(); r != nil {
                    o.logger.Error("panic during component shutdown",
                        "component", c.Name(),
                        "panic", r)
                    errChan <- fmt.Errorf("%s: panic: %v", c.Name(), r)
                }
            }()

            start := time.Now()
            if err := c.Stop(phaseCtx); err != nil {
                o.logger.Error("component shutdown failed",
                    "component", c.Name(),
                    "error", err,
                    "duration", time.Since(start))
                errChan <- fmt.Errorf("%s: %w", c.Name(), err)
            } else {
                o.logger.Info("component stopped",
                    "component", c.Name(),
                    "duration", time.Since(start))
            }
        }()
    }

    // Wait for all components in group
    wg.Wait()
    close(errChan)

    // Collect errors
    var errs []error
    for err := range errChan {
        errs = append(errs, err)
    }

    if len(errs) > 0 {
        return fmt.Errorf("group %d errors: %v", priority, errs)
    }
    return nil
}

func (o *Orchestrator) runPreShutdownHooks() {
    o.mu.RLock()
    hooks := o.preShutdown
    o.mu.RUnlock()

    for _, hook := range hooks {
        func() {
            defer func() {
                if r := recover(); r != nil {
                    o.logger.Error("panic in pre-shutdown hook", "panic", r)
                }
            }()
            hook()
        }()
    }
}

func (o *Orchestrator) runPostShutdownHooks() {
    o.mu.RLock()
    hooks := o.postShutdown
    o.mu.RUnlock()

    for _, hook := range hooks {
        func() {
            defer func() {
                if r := recover(); r != nil {
                    o.logger.Error("panic in post-shutdown hook", "panic", r)
                }
            }()
            hook()
        }()
    }
}

func sortedPriorities(groups map[Priority][]Component) []Priority {
    priorities := make([]Priority, 0, len(groups))
    for p := range groups {
        priorities = append(priorities, p)
    }
    slices.Sort(priorities) // Priority is an ordered type: no closure needed
    return priorities
}
```

### The Budget Bug Hiding in the Defaults

The defaults look reasonable in isolation and do not add up:

```
DrainDelay:   5s
TotalTimeout: 30s   <- the cap on everything below
PhaseTimeout: 10s   <- per priority group
```

There are six priority levels. `doShutdown` spends the drain delay from the total budget, then walks the groups sequentially, giving each up to `PhaseTimeout`. Worst case demand is `5s + (6 x 10s) = 65s` against a `30s` cap. Since `phaseCtx` derives from the total `ctx`, the cap wins, and the tail of the sequence is what starves:

```
drain delay                      5s
  phase Health      budget      10s
  phase Listeners   budget      10s
  phase Workers     budget       5s   <- clipped by the total
  phase Flush       budget       0s   <- STARVED
  phase Database    budget       0s   <- STARVED
  phase Cleanup     budget       0s   <- STARVED
```

The components that get zero are, in order, your metrics flush, your database close, and your final cleanup. The orchestrator is precisely inverted: it lavishes time on the cheap phases (failing a health probe takes microseconds) and starves the expensive, correctness-critical ones. Worse, it fails quietly. Every starved `Stop(phaseCtx)` returns `context.DeadlineExceeded`, gets logged as a component error, and the process exits 0 having skipped the database close.

Three ways out, in increasing order of quality:

1. **Make the invariant explicit and validate it at construction.** Reject a config where `DrainDelay + (len(priorityLevels) * PhaseTimeout) > TotalTimeout`. Loud at startup beats silent at 3am.
2. **Give phases individual budgets.** Health does not need 10 seconds. Workers might need 20. A per-priority timeout map fits the real shape of the problem.
3. **Deadline-aware allocation.** Give each phase the smaller of its nominal budget and the remaining time, and log loudly when a phase is clipped, so the starvation shows up as a warning naming the component rather than a generic timeout.

Whichever you pick, the total still has to fit inside `terminationGracePeriodSeconds`, and the `preStop` hook spends from that same budget.

### Two Smaller Fixes

**`WaitForSignal` leaks its registration.** It calls `signal.Notify(sigChan, ...)` and never calls `signal.Stop`. On the `ctx.Done()` path the channel stays registered with the signal package forever, which pins it and keeps delivering to a channel nobody reads. Add `defer signal.Stop(sigChan)`. In a long-lived process that calls this more than once, it is a genuine leak.

**Modernise the loop and the sort.** The `go func(comp Component){...}(c)` parameter dance exists to dodge the pre-1.22 loop variable capture bug, which has not existed since Go 1.22: `for _, c := range components` now gives each iteration its own `c`, so `go func(){ ... c ... }()` is safe. Likewise `sort.Slice` with a comparison closure can just be `slices.Sort(priorities)`, since `Priority` is an ordered type.

### Staff Lens: Advanced Questions Test Systemic Thinking

Advanced shutdown questions separate candidates who understand the mechanics from those who can design the infrastructure. A strong candidate walks through: the problem, the components involved, the sequencing, the failure modes, the testing strategy. Weaker candidates focus only on code snippets without the architectural framework.

---
