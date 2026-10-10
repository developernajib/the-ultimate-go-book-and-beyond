## 23.11 Complete Production Chaos Engineering Platform

This section assembles the individual techniques from earlier in the chapter into a production-grade chaos engineering platform with experiment management, safety controls, and observability.

### Project Structure

```
chaosplatform/
├── cmd/
│   └── chaosctl/
│       └── main.go
├── pkg/
│   ├── experiment/
│   │   ├── experiment.go
│   │   ├── runner.go
│   │   └── registry.go
│   ├── fault/
│   │   ├── http.go
│   │   ├── grpc.go
│   │   ├── network.go
│   │   ├── resource.go
│   │   └── database.go
│   ├── safety/
│   │   ├── controller.go
│   │   ├── rollback.go
│   │   └── blast_radius.go
│   ├── metrics/
│   │   └── collector.go
│   └── scheduler/
│       └── scheduler.go
├── api/
│   └── chaos.proto
├── configs/
│   └── experiments/
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

### pkg/experiment/experiment.go

The `Experiment` struct is the central configuration object for the platform, encoding every safety boundary inline: blast radius percentage, maximum target count, maximum duration, and cooldown period are all first-class fields rather than runtime checks, so experiments are self-describing and can be validated before they run. The builder methods (`WithDuration`, `WithFault`, `WithBlastRadius`, `WithTargets`) use the fluent pattern to allow declarative experiment construction in a single expression, improving readability in the CLI and test code. The `SteadyStateConfig` separates health checks into before, during, and after phases so the runner can confirm the system is healthy before injecting any fault and again after recovery, following the scientific method that underpins effective chaos engineering.

```go
package experiment

import (
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

// State represents experiment state
type State string

const (
    StatePending   State = "pending"
    StateRunning   State = "running"
    StatePaused    State = "paused"
    StateCompleted State = "completed"
    StateFailed    State = "failed"
    StateAborted   State = "aborted"
)

// Experiment defines a chaos experiment
type Experiment struct {
    ID          string            `json:"id"`
    Name        string            `json:"name"`
    Description string            `json:"description"`
    State       State             `json:"state"`

    // Timing
    Duration    time.Duration     `json:"duration"`
    StartTime   *time.Time        `json:"start_time,omitempty"`
    EndTime     *time.Time        `json:"end_time,omitempty"`

    // Fault configuration
    FaultType   string            `json:"fault_type"`
    FaultConfig json.RawMessage   `json:"fault_config"`

    // Safety controls
    BlastRadius BlastRadiusConfig `json:"blast_radius"`
    Rollback    RollbackConfig    `json:"rollback"`

    // Targeting
    Selectors   TargetSelectors   `json:"selectors"`

    // Steady state
    SteadyState SteadyStateConfig `json:"steady_state"`

    // Results
    Results     *ExperimentResult `json:"results,omitempty"`

    // Metadata
    Labels      map[string]string `json:"labels"`
    Annotations map[string]string `json:"annotations"`
    CreatedAt   time.Time         `json:"created_at"`
    CreatedBy   string            `json:"created_by"`
}

// BlastRadiusConfig controls experiment scope
type BlastRadiusConfig struct {
    Percentage      float64       `json:"percentage"`        // % of targets affected
    MaxTargets      int           `json:"max_targets"`       // Max number of targets
    MaxDuration     time.Duration `json:"max_duration"`      // Max experiment duration
    CooldownPeriod  time.Duration `json:"cooldown_period"`   // Time between experiments
}

// RollbackConfig defines automatic rollback conditions
type RollbackConfig struct {
    Enabled          bool          `json:"enabled"`
    ErrorThreshold   float64       `json:"error_threshold"`    // Abort if error rate exceeds
    LatencyThreshold time.Duration `json:"latency_threshold"`  // Abort if p99 exceeds
    CheckInterval    time.Duration `json:"check_interval"`     // How often to check
}

// TargetSelectors defines what to target
type TargetSelectors struct {
    Namespace       string            `json:"namespace,omitempty"`
    Labels          map[string]string `json:"labels,omitempty"`
    Services        []string          `json:"services,omitempty"`
    Pods            []string          `json:"pods,omitempty"`
    Endpoints       []string          `json:"endpoints,omitempty"`
}

// SteadyStateConfig defines health verification
type SteadyStateConfig struct {
    ProbeTimeout   time.Duration     `json:"probe_timeout"`
    BeforeChecks   []HealthCheck     `json:"before_checks"`
    DuringChecks   []HealthCheck     `json:"during_checks"`
    AfterChecks    []HealthCheck     `json:"after_checks"`
}

// HealthCheck defines a health verification
type HealthCheck struct {
    Name        string          `json:"name"`
    Type        string          `json:"type"` // http, prometheus, custom
    Config      json.RawMessage `json:"config"`
    Threshold   float64         `json:"threshold"`
    Comparison  string          `json:"comparison"` // lt, gt, eq, ne
}

// ExperimentResult holds experiment outcomes
type ExperimentResult struct {
    Success           bool              `json:"success"`
    SteadyStateBefore map[string]bool   `json:"steady_state_before"`
    SteadyStateAfter  map[string]bool   `json:"steady_state_after"`
    Metrics           map[string]float64 `json:"metrics"`
    Errors            []string          `json:"errors"`
    Timeline          []TimelineEvent   `json:"timeline"`
}

type TimelineEvent struct {
    Timestamp   time.Time `json:"timestamp"`
    Event       string    `json:"event"`
    Description string    `json:"description"`
}

// NewExperiment creates a new experiment
func NewExperiment(name, description string) *Experiment {
    return &Experiment{
        ID:          uuid.New().String(),
        Name:        name,
        Description: description,
        State:       StatePending,
        BlastRadius: BlastRadiusConfig{
            Percentage:     10,
            MaxTargets:     5, // Never leave a safety cap at its zero value.
            MaxDuration:    30 * time.Minute,
            CooldownPeriod: 5 * time.Minute,
        },
        Rollback: RollbackConfig{
            Enabled:          true,
            ErrorThreshold:   0.1,
            LatencyThreshold: 2 * time.Second, // Zero here means "abort on any
            // latency at all", which aborts every experiment on its first probe.
            CheckInterval: 10 * time.Second,
        },
        Labels:      make(map[string]string),
        Annotations: make(map[string]string),
        CreatedAt:   time.Now(),
    }
}

// WithDuration sets experiment duration
func (e *Experiment) WithDuration(d time.Duration) *Experiment {
    e.Duration = d
    return e
}

// WithFault configures the fault type
func (e *Experiment) WithFault(faultType string, config any) *Experiment {
    e.FaultType = faultType
    configBytes, _ := json.Marshal(config)
    e.FaultConfig = configBytes
    return e
}

// WithBlastRadius configures safety limits
func (e *Experiment) WithBlastRadius(percentage float64, maxTargets int) *Experiment {
    e.BlastRadius.Percentage = percentage
    e.BlastRadius.MaxTargets = maxTargets
    return e
}

// WithTargets sets targeting configuration
func (e *Experiment) WithTargets(selectors TargetSelectors) *Experiment {
    e.Selectors = selectors
    return e
}
```

### pkg/experiment/runner.go

The `Runner` enforces single-experiment serialization through a mutex-guarded `activeExperiment` pointer, preventing concurrent chaos from compounding faults and making results uninterpretable. Fault cleanup is registered as a `defer` immediately after successful injection so it runs on every exit path, normal completion, rollback, manual abort, or panic. The rollback monitor runs as a separate goroutine that periodically queries live error rate and p99 latency. When either threshold is breached it cancels the experiment context, triggering the main select to exit early and the deferred cleanup to execute before post-experiment steady-state verification.

Four details decide whether that description is true of the running code, and each is easy to get wrong in a way no compiler will catch.

**Cleanup must not use the caller's context.** `defer injector.Cleanup(ctx)` looks correct and is the most dangerous line in the platform. The context it captures is the one the operator cancels with Ctrl-C. So the moment a human decides to stop the experiment, the function whose entire job is to remove the fault from production is handed a dead context and cannot make a single API call. The cleanup "runs", the log line appears, and the fault stays live. Cleanup runs on `context.WithoutCancel` plus its own timeout, always.

**`rollbackTriggered` needs to be atomic.** It is written by the monitor goroutine and read by the main goroutine. There is a happens-before edge when the monitor's `cancel()` is what wakes the main select, which is why this usually looks fine. But the experiment's own timeout can fire at the same moment the monitor decides to roll back, and then the write and the read are genuinely concurrent. `go test -race` catches it on the interleaving you will eventually get in production. Use `atomic.Bool`.

**The injector map needs the lock.** `r.faultInjectors[exp.FaultType]` in `Run` reads a map that `RegisterFaultInjector` writes under `r.mu`. Reading it unlocked is a data race against any concurrent registration, and a concurrent map read/write is one of the few things Go turns into a hard runtime crash rather than a silent corruption.

**Reserve the safety slot, and release it.** The gate is `safety.Acquire`, not a bare check, and the release must be deferred the instant the slot is held, or the cooldown and concurrency accounting drift permanently out of true after the first early return.

```go
package experiment

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "math"
    "net/http"
    "sync"
    "sync/atomic"
    "time"

    "chaosplatform/pkg/fault"
    "chaosplatform/pkg/metrics"
    "chaosplatform/pkg/safety"
)

// sleepCtx waits for d and reports whether it slept the full duration.
func sleepCtx(ctx context.Context, d time.Duration) bool {
    t := time.NewTimer(d)
    defer t.Stop()
    select {
    case <-t.C:
        return true
    case <-ctx.Done():
        return false
    }
}

// Runner executes chaos experiments
type Runner struct {
    logger           *slog.Logger
    faultInjectors   map[string]fault.Injector
    safetyController *safety.Controller
    metricsCollector *metrics.Collector

    mu               sync.RWMutex
    activeExperiment *Experiment
    stopChan         chan struct{}
}

// NewRunner creates a new experiment runner
func NewRunner(
    logger *slog.Logger,
    safetyController *safety.Controller,
    metricsCollector *metrics.Collector,
) *Runner {
    return &Runner{
        logger:           logger,
        faultInjectors:   make(map[string]fault.Injector),
        safetyController: safetyController,
        metricsCollector: metricsCollector,
    }
}

// RegisterFaultInjector adds a fault injector
func (r *Runner) RegisterFaultInjector(faultType string, injector fault.Injector) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.faultInjectors[faultType] = injector
}

// Run executes an experiment.
func (r *Runner) Run(ctx context.Context, exp *Experiment) (*ExperimentResult, error) {
    r.mu.Lock()
    if r.activeExperiment != nil {
        r.mu.Unlock()
        return nil, fmt.Errorf("another experiment is running: %s", r.activeExperiment.ID)
    }
    r.activeExperiment = exp
    stopChan := make(chan struct{}) // Capture locally: workers must not read the field.
    r.stopChan = stopChan
    r.mu.Unlock()

    defer func() {
        r.mu.Lock()
        r.activeExperiment = nil
        r.mu.Unlock()
    }()

    result := &ExperimentResult{
        Timeline: make([]TimelineEvent, 0),
        Metrics:  make(map[string]float64),
    }

    // Phase 1: steady state BEFORE. Never inject into an already-sick system.
    if err := r.verifySteadyState(ctx, exp, result, phaseBefore); err != nil {
        result.Errors = append(result.Errors, fmt.Sprintf("pre-flight failed: %v", err))
        exp.State = StateFailed
        return result, err
    }

    // Phase 2: admission. Checks and reserves atomically.
    release, err := r.safetyController.Acquire(exp)
    if err != nil {
        result.Errors = append(result.Errors, err.Error())
        exp.State = StateAborted
        return result, err
    }
    defer release() // Frees the slot and starts the cooldown clock.

    // Phase 3: look up the injector under the lock that guards the map.
    r.mu.RLock()
    injector, ok := r.faultInjectors[exp.FaultType]
    r.mu.RUnlock()
    if !ok {
        return result, fmt.Errorf("unknown fault type: %s", exp.FaultType)
    }

    // Phase 4: inject.
    if err := injector.Inject(ctx, exp.FaultConfig); err != nil {
        result.Errors = append(result.Errors, fmt.Sprintf("injection failed: %v", err))
        exp.State = StateFailed
        return result, err
    }

    // Cleanup on a DETACHED context. If this used ctx, an operator pressing
    // Ctrl-C would cancel the only code path that removes the fault from
    // production, and the fault would outlive the process.
    defer func() {
        cctx, ccancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
        defer ccancel()
        if err := injector.Cleanup(cctx); err != nil {
            r.logger.Error("CLEANUP FAILED, fault may still be live",
                "experiment", exp.ID, "error", err)
            result.Errors = append(result.Errors, fmt.Sprintf("cleanup failed: %v", err))
        }
        r.addTimelineEvent(result, "fault_cleaned", "Fault injection cleaned up")
    }()

    // Phase 5: run with monitoring.
    experimentCtx, cancel := context.WithTimeout(ctx, exp.Duration)
    defer cancel()

    var rollbackTriggered atomic.Bool // Written by the monitor, read here.
    if exp.Rollback.Enabled {
        go func() {
            ticker := time.NewTicker(exp.Rollback.CheckInterval)
            defer ticker.Stop()
            for {
                select {
                case <-experimentCtx.Done():
                    return
                case <-stopChan:
                    return
                case <-ticker.C:
                    if r.shouldRollback(experimentCtx, exp) {
                        r.logger.Warn("rollback threshold exceeded, aborting",
                            "experiment", exp.ID)
                        rollbackTriggered.Store(true)
                        cancel()
                        return
                    }
                }
            }
        }()
    }

    select {
    case <-experimentCtx.Done():
        if rollbackTriggered.Load() {
            r.addTimelineEvent(result, "rollback_triggered", "Automatic rollback")
        }
    case <-stopChan:
        exp.State = StateAborted
        return result, nil
    }

    // Phase 6: verify recovery, respecting cancellation while we wait for it.
    if !sleepCtx(ctx, 10*time.Second) {
        return result, ctx.Err()
    }

    if err := r.verifySteadyState(ctx, exp, result, phaseAfter); err != nil {
        result.Errors = append(result.Errors,
            fmt.Sprintf("post-experiment verification failed: %v", err))
        exp.State = StateFailed
    } else {
        result.Success = !rollbackTriggered.Load()
        exp.State = StateCompleted
    }

    // Collect returns an error rather than an empty map on failure, so that
    // shouldRollback can fail closed. Final metrics are best-effort: losing
    // them must not change the experiment's verdict.
    if m, err := r.metricsCollector.Collect(ctx); err != nil {
        r.logger.Warn("could not collect final metrics", "error", err)
    } else {
        result.Metrics = m
    }
    return result, nil
}

// phase is a closed enum, not a free-form string. A typo'd string selects no
// checks and returns nil, which reports a system nobody looked at as healthy.
type phase int

const (
    phaseBefore phase = iota
    phaseDuring
    phaseAfter
)

func (r *Runner) verifySteadyState(
    ctx context.Context,
    exp *Experiment,
    result *ExperimentResult,
    p phase,
) error {
    var checks []HealthCheck
    switch p {
    case phaseBefore:
        checks = exp.SteadyState.BeforeChecks
        result.SteadyStateBefore = make(map[string]bool)
    case phaseDuring:
        checks = exp.SteadyState.DuringChecks
    case phaseAfter:
        checks = exp.SteadyState.AfterChecks
        result.SteadyStateAfter = make(map[string]bool)
    default:
        return fmt.Errorf("unknown steady state phase %d", p)
    }

    // A phase with no checks configured is not a pass. It means nobody
    // defined a hypothesis, and there is nothing to conclude from silence.
    if len(checks) == 0 {
        return fmt.Errorf("no steady state checks configured for phase %d", p)
    }

    timeout := exp.SteadyState.ProbeTimeout
    if timeout <= 0 {
        timeout = 10 * time.Second
    }

    for _, check := range checks {
        cctx, cancel := context.WithTimeout(ctx, timeout)
        passed, err := r.runHealthCheck(cctx, check)
        cancel()

        switch p {
        case phaseBefore:
            result.SteadyStateBefore[check.Name] = passed
        case phaseAfter:
            result.SteadyStateAfter[check.Name] = passed
        }

        if err != nil {
            return fmt.Errorf("health check %s errored: %w", check.Name, err)
        }
        if !passed {
            return fmt.Errorf("health check %s did not pass", check.Name)
        }
    }

    return nil
}

func (r *Runner) runHealthCheck(ctx context.Context, check HealthCheck) (bool, error) {
    // Implementation depends on check type
    switch check.Type {
    case "http":
        return r.runHTTPHealthCheck(ctx, check)
    case "prometheus":
        return r.runPrometheusHealthCheck(ctx, check)
    default:
        return false, fmt.Errorf("unknown health check type: %s", check.Type)
    }
}

func (r *Runner) runHTTPHealthCheck(ctx context.Context, check HealthCheck) (bool, error) {
    var config struct {
        URL            string `json:"url"`
        ExpectedStatus int    `json:"expected_status"`
    }
    if err := json.Unmarshal(check.Config, &config); err != nil {
        return false, err
    }

    req, err := http.NewRequestWithContext(ctx, "GET", config.URL, nil)
    if err != nil {
        return false, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return false, err
    }
    defer resp.Body.Close()

    return resp.StatusCode == config.ExpectedStatus, nil
}

func (r *Runner) runPrometheusHealthCheck(ctx context.Context, check HealthCheck) (bool, error) {
    // Never stub a safety check with `return true, nil`. A placeholder that
    // reports healthy silently approves every experiment configured to use
    // it, and it will do so for as long as it takes someone to notice.
    // Fail closed until the real implementation lands.
    return false, errors.New("prometheus health check not implemented")
}

// shouldRollback reports whether live metrics have breached the abort
// thresholds. It fails CLOSED: if the metrics cannot be read at all, the
// experiment aborts, because an abort condition you cannot evaluate is an
// abort condition you do not have.
func (r *Runner) shouldRollback(ctx context.Context, exp *Experiment) bool {
    metrics, err := r.metricsCollector.Collect(ctx)
    if err != nil {
        r.logger.Warn("cannot evaluate rollback thresholds, aborting", "error", err)
        return true
    }

    errorRate, ok := metrics["error_rate"]
    if !ok {
        r.logger.Warn("error_rate metric absent, aborting")
        return true
    }
    if math.IsNaN(errorRate) {
        // NaN loses every comparison, so an unchecked NaN reads as "under
        // threshold" and disarms the rollback. See 23.7.
        r.logger.Warn("error_rate is NaN, aborting")
        return true
    }
    if errorRate > exp.Rollback.ErrorThreshold {
        r.logger.Warn("error rate threshold exceeded",
            "current", errorRate, "threshold", exp.Rollback.ErrorThreshold)
        return true
    }

    // p99 is carried in SECONDS, matching Prometheus histogram convention.
    // The unit here is worth being pedantic about: writing
    // `time.Duration(p99) * time.Millisecond` against a seconds-valued float
    // truncates 0.25 to the integer 0, yielding a threshold of 0ms that no
    // latency can ever exceed. The rollback then never fires, and the bug is
    // invisible because the code reads as if it handles latency.
    if p99, ok := metrics["latency_p99_seconds"]; ok && !math.IsNaN(p99) {
        got := time.Duration(p99 * float64(time.Second))
        if got > exp.Rollback.LatencyThreshold {
            r.logger.Warn("latency threshold exceeded",
                "current", got, "threshold", exp.Rollback.LatencyThreshold)
            return true
        }
    }

    return false
}

func (r *Runner) addTimelineEvent(result *ExperimentResult, event, description string) {
    result.Timeline = append(result.Timeline, TimelineEvent{
        Timestamp:   time.Now(),
        Event:       event,
        Description: description,
    })
}

// Abort stops the currently running experiment. It is idempotent: an
// operator who hits Ctrl-C twice, or a signal handler that races the
// experiment's own completion, must not panic the process on a double close.
// A kill switch that can crash the thing holding the fault is not a kill
// switch.
func (r *Runner) Abort() error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if r.activeExperiment == nil {
        return fmt.Errorf("no active experiment")
    }

    select {
    case <-r.stopChan:
        return nil // Already aborting.
    default:
        close(r.stopChan)
    }
    return nil
}

// GetActiveExperiment returns the currently running experiment
func (r *Runner) GetActiveExperiment() *Experiment {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.activeExperiment
}

```

### pkg/safety/controller.go

The `Controller` acts as a pre-flight gate that must approve every experiment before any fault is injected, enforcing five independent safety invariants: emergency stop flag, global enable switch, concurrent experiment cap, cooldown period since the last run, and blocked calendar hours such as business hours or deployment windows.

That is the design. The implementation people reach for first enforces three of the five, and the two it drops are the two that limit how much chaos can be running at once. It is worth dwelling on why, because the failure is invisible by inspection and the code reads perfectly.

The gate is a `CanExecute` method that *checks* state and returns a bool. It never *changes* state. The counters it consults, `activeCount` and `lastExperiment`, are maintained by separate `StartExperiment` and `EndExperiment` methods, and if the runner never calls those, then `activeCount` is permanently 0 and `lastExperiment` is permanently the zero time. Now read the two checks against those values. `activeCount >= maxConcurrent` is `0 >= 1`, which is false forever, so the concurrency cap can never block anything. And `time.Since(c.lastExperiment) < c.globalCooldown` compares `time.Since(January 1, year 1)`, which is about 2562047 hours, against five minutes. Also false forever. Both branches are unreachable code that logs reassuring warnings it will never emit.

Run 200 experiments back to back through that gate and all 200 are approved despite a five minute cooldown. Fire 50 concurrently and all 50 are approved despite `maxConcurrent: 1`. The platform reports itself safe while running unlimited simultaneous chaos.

Wiring up the calls is necessary but not sufficient, because check-then-act across two critical sections is a TOCTOU race. Fifty goroutines can each take the read lock, each observe `activeCount == 0`, each release, and each then increment. The cap is still breached, just less often, which is worse: a bug that only shows up under load is a bug that ships. Admission control must check and reserve **in one write-locked critical section**. Make the gate an `Acquire` that returns a release function, so the reservation and its accounting cannot be separated by a caller who forgets.

```go
package safety

import (
    "errors"
    "fmt"
    "log/slog"
    "sync"
    "time"

    "chaosplatform/pkg/experiment"
)

// Controller manages safety controls for chaos experiments.
type Controller struct {
    logger *slog.Logger
    mu     sync.RWMutex

    // Global safety settings
    enabled        bool
    maxConcurrent  int
    globalCooldown time.Duration

    // State
    activeCount    int
    lastExperiment time.Time
    blockedHours   map[int]bool // Hours when chaos is blocked, in loc.
    loc            *time.Location

    // Emergency stop
    emergencyStop bool
}

func NewController(logger *slog.Logger) *Controller {
    return &Controller{
        logger:         logger,
        enabled:        true,
        maxConcurrent:  1,
        globalCooldown: 5 * time.Minute,
        blockedHours:   make(map[int]bool),
        loc:            time.UTC, // Never the host's local zone. See below.
    }
}

// SetBlockedHours sets hours during which chaos is not allowed, interpreted
// in loc. Pass the zone your on-call rotation actually lives in.
func (c *Controller) SetBlockedHours(loc *time.Location, hours ...int) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.loc = loc
    c.blockedHours = make(map[int]bool)
    for _, h := range hours {
        c.blockedHours[h] = true
    }
}

// EmergencyStop halts all chaos experiments
func (c *Controller) EmergencyStop() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.emergencyStop = true
    c.logger.Warn("EMERGENCY STOP activated - all chaos experiments halted")
}

// Resume allows chaos experiments to continue
func (c *Controller) Resume() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.emergencyStop = false
    c.logger.Info("Chaos experiments resumed")
}

// MaxBlastRadiusPercent is the hard ceiling any single experiment may
// request. See the note below on why this is 25 and not 50.
const MaxBlastRadiusPercent = 25.0

var ErrDenied = errors.New("safety: experiment denied")

// Acquire is the admission gate. It checks every invariant and reserves a
// slot in ONE write-locked critical section, then returns the release func.
//
// It deliberately does not offer a bare "CanExecute" that only checks. A
// check whose result the caller acts on later is a TOCTOU race: fifty
// goroutines can each see activeCount == 0 and each proceed. Reserving
// under the same lock that did the checking is the only version that holds.
func (c *Controller) Acquire(exp *experiment.Experiment) (release func(), err error) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if c.emergencyStop {
        return nil, fmt.Errorf("%w: emergency stop active", ErrDenied)
    }
    if !c.enabled {
        return nil, fmt.Errorf("%w: chaos globally disabled", ErrDenied)
    }
    if c.activeCount >= c.maxConcurrent {
        return nil, fmt.Errorf("%w: %d experiments already running (max %d)",
            ErrDenied, c.activeCount, c.maxConcurrent)
    }
    if since := time.Since(c.lastExperiment); !c.lastExperiment.IsZero() && since < c.globalCooldown {
        return nil, fmt.Errorf("%w: cooldown, %v remaining",
            ErrDenied, (c.globalCooldown - since).Round(time.Second))
    }
    // Fixed zone, not the host's. A container set to UTC silently turns a
    // "no chaos during business hours" rule into no rule at all.
    if hour := time.Now().In(c.loc).Hour(); c.blockedHours[hour] {
        return nil, fmt.Errorf("%w: hour %02d in %v is blocked", ErrDenied, hour, c.loc)
    }
    if exp.BlastRadius.Percentage > MaxBlastRadiusPercent {
        return nil, fmt.Errorf("%w: blast radius %.1f%% exceeds the %.0f%% ceiling",
            ErrDenied, exp.BlastRadius.Percentage, MaxBlastRadiusPercent)
    }
    if exp.BlastRadius.MaxTargets <= 0 {
        // The zero value must not mean "unlimited" on a safety field.
        return nil, fmt.Errorf("%w: MaxTargets must be set", ErrDenied)
    }
    if exp.BlastRadius.MaxDuration <= 0 {
        return nil, fmt.Errorf("%w: MaxDuration must be set", ErrDenied)
    }
    if exp.Duration > exp.BlastRadius.MaxDuration {
        return nil, fmt.Errorf("%w: duration %v exceeds limit %v",
            ErrDenied, exp.Duration, exp.BlastRadius.MaxDuration)
    }

    // Reserve, under the same lock that just did the checking.
    c.activeCount++
    c.logger.Info("experiment admitted", "experiment", exp.ID, "active", c.activeCount)

    var once sync.Once
    return func() {
        once.Do(func() {
            c.mu.Lock()
            defer c.mu.Unlock()
            c.activeCount--
            c.lastExperiment = time.Now() // Cooldown starts when chaos ends.
            c.logger.Info("experiment released", "experiment", exp.ID, "active", c.activeCount)
        })
    }, nil
}

// Status returns the current safety status
type SafetyStatus struct {
    Enabled       bool      `json:"enabled"`
    EmergencyStop bool      `json:"emergency_stop"`
    ActiveCount   int       `json:"active_count"`
    MaxConcurrent int       `json:"max_concurrent"`
    LastExperiment time.Time `json:"last_experiment"`
    CooldownRemaining time.Duration `json:"cooldown_remaining"`
}

func (c *Controller) Status() SafetyStatus {
    c.mu.RLock()
    defer c.mu.RUnlock()

    var cooldownRemaining time.Duration
    if !c.lastExperiment.IsZero() {
        cooldownRemaining = max(c.globalCooldown-time.Since(c.lastExperiment), 0)
    }

    return SafetyStatus{
        Enabled:           c.enabled,
        EmergencyStop:     c.emergencyStop,
        ActiveCount:       c.activeCount,
        MaxConcurrent:     c.maxConcurrent,
        LastExperiment:    c.lastExperiment,
        CooldownRemaining: cooldownRemaining,
    }
}
```

An `EmergencyStop` method provides an instant kill switch that requires no redeployment and can be triggered by an operator or an automated alerting system when anomalous behavior is detected outside a planned experiment. Note what it does and does not do: it prevents the *next* `Acquire` from succeeding. It does not reach into experiments already running. Those need the runner's own abort path, and a platform that advertises an emergency stop while only gating admission will disappoint the first person who reaches for it during an incident. Wire `EmergencyStop` to both.

### A Note on the Blast Radius Ceiling

The ceiling above is 25%, and the version of this code you will most often see uses 50% with a comment explaining that at worst half the fleet is affected and the other half keeps serving traffic.

That reasoning does not survive contact with a real fleet. If you take out half your instances, the surviving half does not continue serving traffic as before, it inherits *all* of the traffic. Capacity that was comfortable at 50% utilisation is now at 100%, queues build, latency climbs, health checks start timing out, and the orchestrator begins killing the survivors for failing their probes. This fails to bound the blast radius at 50%: instead, it creates a load test that starts by deleting half the fleet's capacity, and the most likely outcome is a full outage caused by the tool whose job was to prevent one.

The number that matters is not the fraction you break, it is the fraction the remainder can absorb. If your fleet runs at 40% utilisation, killing 25% pushes the survivors to roughly 53%, which is a real experiment with a real margin. Killing 50% pushes them past 80% and into the region where the answer is always "everything falls over", which teaches you nothing you did not already know. Compute the ceiling from your actual headroom, start far below it, and treat any number above 25% as requiring a specific argument rather than a default.

This is the general shape of the discipline. Every safety limit in a chaos platform should be justified by an argument about what the system can absorb, not by a round number that sounds cautious.

### Testing the Gate

A safety control nobody tested is a safety control nobody has. These two tests are the ones that would have caught the dead cooldown and the unenforced cap, and they are short enough that there is no excuse:

```go
func TestConcurrencyCapHolds(t *testing.T) {
    c := NewController(testLogger())

    var wg sync.WaitGroup
    var mu sync.Mutex
    admitted := 0
    start := make(chan struct{})

    for i := 0; i < 50; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            <-start // Release all 50 at once, to force the interleaving.
            if _, err := c.Acquire(newTestExperiment()); err == nil {
                mu.Lock()
                admitted++
                mu.Unlock()
            }
        }()
    }
    close(start)
    wg.Wait()

    if admitted != 1 {
        t.Fatalf("maxConcurrent is 1 but %d experiments were admitted", admitted)
    }
}

func TestCooldownFires(t *testing.T) {
    c := NewController(testLogger())

    release, err := c.Acquire(newTestExperiment())
    if err != nil {
        t.Fatalf("first experiment must be admitted: %v", err)
    }
    release() // Experiment ends, cooldown clock starts.

    if _, err := c.Acquire(newTestExperiment()); err == nil {
        t.Fatal("second experiment admitted with no cooldown wait")
    }
}
```

Against the check-only controller, the first test admits all 50 and the second admits the second experiment instantly. Against the version above, exactly 1 of 50 is admitted and the cooldown reports `5m0s remaining`. Add a third test asserting that the *first* ever experiment is not blocked, since a naive cooldown that forgets to special-case the zero `lastExperiment` fails in the other direction and blocks the platform's first run for 2562047 hours.

### cmd/chaosctl/main.go

The `chaosctl` entry point demonstrates a complete end-to-end experiment: it wires all platform components, registers the four built-in fault injector types (HTTP latency, HTTP errors, network partition, and pod kill), and constructs a 2-minute latency injection experiment targeting the `api-server` pods in the `production` namespace with a 10% blast radius. A signal handler goroutine intercepts `SIGINT` and `SIGTERM` and calls `runner.Abort()`, giving operators a way to stop an in-progress experiment from the terminal. The final exit code is set to 1 when the experiment result reports failure, making `chaosctl` compatible with CI pipelines that use exit codes to gate deployments on resilience test results.

The signal handler is the second place the context-cancellation trap bites, and it is worth seeing the two halves together. The obvious handler calls `runner.Abort()` and then `cancel()`. `Abort` is the graceful path: it closes `stopChan`, the runner's select returns, and the deferred cleanup removes the fault. But `cancel()` fires immediately afterwards and kills the context, so unless cleanup is detached (which the corrected `Run` above makes sure of), the cleanup that Ctrl-C just triggered runs against a dead context and cannot remove anything.

Even with cleanup detached, do not cancel out from under a graceful abort that is already in flight. Abort first, give it a bounded window to unwind, and reserve `cancel()` for the second signal, when the operator is telling you they have stopped caring about the fault and want the process gone. Print what that means, because leaving a fault injected is exactly the situation the operator needs to know about:

```go
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        <-sigChan
        logger.Info("signal received, aborting experiment gracefully")
        // Abort unwinds the runner and lets the deferred cleanup remove the
        // fault. Do NOT cancel(): that would race the cleanup we just asked for.
        runner.Abort()

        <-sigChan
        logger.Error("second signal, forcing exit: THE INJECTED FAULT MAY STILL BE LIVE")
        cancel()
    }()
```

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    "chaosplatform/pkg/experiment"
    "chaosplatform/pkg/fault"
    "chaosplatform/pkg/metrics"
    "chaosplatform/pkg/safety"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Initialize components
    safetyController := safety.NewController(logger)
    metricsCollector := metrics.NewCollector("http://prometheus:9090")

    runner := experiment.NewRunner(logger, safetyController, metricsCollector)

    // Register fault injectors
    runner.RegisterFaultInjector("http-latency", fault.NewHTTPLatencyInjector())
    runner.RegisterFaultInjector("http-error", fault.NewHTTPErrorInjector())
    runner.RegisterFaultInjector("network-partition", fault.NewNetworkPartitionInjector())
    runner.RegisterFaultInjector("pod-kill", fault.NewPodKillInjector())

    // Create experiment
    exp := experiment.NewExperiment(
        "api-latency-test",
        "Test API behavior under high latency conditions",
    ).WithDuration(2 * time.Minute).
        WithFault("http-latency", map[string]any{
            "latency_ms": 500,
            "jitter_ms":  100,
        }).
        WithBlastRadius(10, 5).
        WithTargets(experiment.TargetSelectors{
            Namespace: "production",
            Labels: map[string]string{
                "app": "api-server",
            },
        })

    // Add steady state checks
    exp.SteadyState = experiment.SteadyStateConfig{
        ProbeTimeout: 30 * time.Second,
        BeforeChecks: []experiment.HealthCheck{
            {
                Name: "api-health",
                Type: "http",
                Config: json.RawMessage(`{"url": "http://api:8080/health", "expected_status": 200}`),
            },
        },
        AfterChecks: []experiment.HealthCheck{
            {
                Name: "api-health",
                Type: "http",
                Config: json.RawMessage(`{"url": "http://api:8080/health", "expected_status": 200}`),
            },
        },
    }

    // Handle signals. See the note above: Abort is the graceful path and
    // cancel() is the escape hatch, never both at once.
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        <-sigChan
        logger.Info("received shutdown signal, aborting experiment gracefully")
        runner.Abort()

        <-sigChan
        logger.Error("second signal, forcing exit: THE INJECTED FAULT MAY STILL BE LIVE")
        cancel()
    }()

    // Run experiment
    logger.Info("starting chaos experiment", "name", exp.Name)
    result, err := runner.Run(ctx, exp)
    if err != nil {
        logger.Error("experiment failed", "error", err)
        os.Exit(1)
    }

    // Output results
    resultJSON, _ := json.MarshalIndent(result, "", "  ")
    fmt.Println(string(resultJSON))

    if !result.Success {
        os.Exit(1)
    }
}
```

### Dockerfile

The two-stage build compiles a statically linked `chaosctl` binary with all debug symbols stripped, then copies it into a minimal Alpine runtime image that adds only `ca-certificates` and `tzdata`. Operators who need to inject network faults via `tc` or `iptables` must grant the container additional Linux capabilities at runtime.

Alpine's default user is **root**. An image with no `USER` directive runs as root, and a chaos controller is a poor candidate for extra privilege given that its whole job is to break things and it is a natural target for anyone who gets a foothold in the cluster. Add an explicit unprivileged user and a `USER` line. If a specific fault genuinely needs `NET_ADMIN` to drive `tc`, grant that one capability at runtime rather than running the whole process as root for the convenience of one injector.

`tzdata` is load-bearing here rather than decorative: the safety controller's blocked-hours check resolves a `*time.Location`, and without the zone database `time.LoadLocation` fails and the rule that keeps chaos out of business hours cannot be evaluated.

```dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /chaosctl ./cmd/chaosctl

FROM alpine:3.22

# tzdata is required: the safety controller's blocked-hours rule resolves a
# time.Location, and LoadLocation fails without the zone database.
RUN apk --no-cache add ca-certificates tzdata \
    && adduser -D -u 10001 chaos

WORKDIR /app
COPY --from=builder /chaosctl .

# Alpine defaults to root. Say otherwise, explicitly.
USER 10001:10001

ENTRYPOINT ["./chaosctl"]
```

### docker-compose.yml

The Compose file assembles the chaos controller alongside Prometheus and Grafana on a shared `chaos-net` bridge network, making the Prometheus URL accessible to the metrics collector by hostname without any IP configuration. The Docker socket is mounted into the chaos controller container so it can interact with the Docker daemon directly to kill containers or modify network namespaces when running experiments against local services. A simple Nginx container acts as a target API for demonstration, providing a real HTTP endpoint that the steady-state health checks can probe before and after each experiment.

Understand what that socket mount costs before you copy this file anywhere but your laptop. Access to `/var/run/docker.sock` is equivalent to root on the host, unconditionally: anything that can talk to the daemon can start a privileged container that bind-mounts `/` and walk straight out of the sandbox. The `USER 10001` line in the Dockerfile buys you nothing against it. That trade is defensible in a throwaway local demo, which is all this file is for, and it is not defensible in a shared or production environment. There, drive the container runtime through the orchestrator's API with a service account scoped to the specific verbs the experiments need, and let RBAC bound what the chaos controller can reach. This is also the reason `docker compose` demos and Kubernetes chaos operators are configured so differently: the operator model exists precisely so nobody has to hand the blast-radius tooling root on the node.

The `version` key is obsolete under Compose V2 and emits a warning on every invocation, so it is omitted below.

```yaml
services:
  chaos-controller:
    build: .
    volumes:
      # WARNING: this is root on the host. Local demo only. See the note above.
      - /var/run/docker.sock:/var/run/docker.sock
      - ./configs:/app/configs
    environment:
      - PROMETHEUS_URL=http://prometheus:9090
      - LOG_LEVEL=info
    depends_on:
      - prometheus
    networks:
      - chaos-net

  prometheus:
    image: prom/prometheus:v3.14.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    networks:
      - chaos-net

  grafana:
    image: grafana/grafana:13.2.1
    ports:
      - "3000:3000"
    environment:
      # Local demo only. Read it from the environment or a secret store
      # anywhere else, and never commit a real one to the compose file.
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD}
    depends_on:
      - prometheus
    networks:
      - chaos-net

  # Test target service
  target-api:
    image: nginx:1.29-alpine
    ports:
      - "8080:80"
    networks:
      - chaos-net

networks:
  chaos-net:
    driver: bridge
```

### Staff Lens: Buy vs Build

Full chaos platform (like Gremlin, Chaos Mesh) vs hand-rolled. For most orgs, adopt the platform, do not build one. Building a chaos platform is multi-quarter work, while adopting Chaos Mesh takes days. Reserve build for teams with specific requirements that platforms cannot meet.

---
