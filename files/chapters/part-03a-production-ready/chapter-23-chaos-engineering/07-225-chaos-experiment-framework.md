## 23.5 Chaos Experiment Framework

Running chaos experiments manually is error-prone and does not scale. A proper experiment framework provides a structured way to define experiments with setup, injection, monitoring, verification, and cleanup phases. Think of it like Go's `testing.T` but for chaos: you declare what the experiment does, how long it runs, and what success looks like, and the framework handles the lifecycle, logging, and result collection.

The framework is also where the safety machinery lives, and this is the part most implementations get wrong. It is easy to write a runner that injects a fault, blocks for the configured duration, and then checks whether the system is healthy. That runner has no abort condition. If the service falls over two seconds into a thirty second experiment, it keeps the fault injected for the remaining twenty-eight and reports the failure afterwards, at which point you have not run an experiment, you have run an outage with good logging. The runner below treats the steady-state hypothesis as something it polls continuously, and it stops the moment the hypothesis stops holding.

### Experiment Definition

The `Experiment` struct captures the lifecycle as function fields. `SteadyState` is the hypothesis, expressed as a probe that returns an error when the system is not behaving normally. `Setup` prepares preconditions, `Inject` introduces the fault, `Verify` checks recovery after the fault is removed, and `Cleanup` removes it.

Three of those are mandatory and the runner refuses to execute an experiment that omits them. That refusal is a feature. An experiment with no `SteadyState` has no hypothesis and therefore no abort condition. An experiment with no `Cleanup` has no way to undo what it did. An experiment with no `Duration` never ends. In each case the correct behaviour is to decline to inject anything, loudly, rather than to fill in a permissive default and start breaking things.

```go
package chaos

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "sync"
    "time"
)

type Experiment struct {
    Name        string
    Description string
    Hypothesis  string // Plain English: what you expect to remain true.
    Duration    time.Duration

    // SteadyState is the hypothesis as executable code. It is probed once
    // before injection to establish a baseline, then every ProbeInterval
    // while the fault is live. An error means the system is not behaving
    // normally, and it is what aborts the run.
    SteadyState   func(ctx context.Context) error
    ProbeInterval time.Duration
    // AbortAfter is how many consecutive failed probes to tolerate before
    // aborting. Defaults to 1. Raise it only if your probe is genuinely
    // flaky, and fix the probe instead if you can.
    AbortAfter int

    Setup   func(ctx context.Context) error
    Inject  func(ctx context.Context) error
    Verify  func(ctx context.Context) error // Runs after the fault is removed.
    Cleanup func(ctx context.Context) error
}

func (e Experiment) validate() error {
    var errs []error
    if e.Inject == nil {
        errs = append(errs, errors.New("Inject is required"))
    }
    if e.Cleanup == nil {
        errs = append(errs, errors.New(
            "Cleanup is required: an experiment that cannot undo its fault is an outage"))
    }
    if e.SteadyState == nil {
        errs = append(errs, errors.New(
            "SteadyState is required: without it there is no hypothesis and no abort condition"))
    }
    if e.Duration <= 0 {
        errs = append(errs, errors.New(
            "Duration must be positive: an unbounded experiment never ends"))
    }
    return errors.Join(errs...)
}
```

The result records an `Outcome` rather than a bare `Success` boolean, because "did not succeed" covers several very different situations and a game day report needs to tell them apart. An experiment that was skipped because the system was already unhealthy is not evidence of resilience. Neither is one the operator cancelled halfway through. Collapsing those into `Success: false` next to a genuine hypothesis violation throws away the only information that mattered.

```go
type Outcome string

const (
    OutcomeHeld    Outcome = "held"    // Hypothesis survived the fault.
    OutcomeBroke   Outcome = "broke"   // Fault removed, but Verify failed.
    OutcomeAborted Outcome = "aborted" // Steady state lost, or run cancelled.
    OutcomeSkipped Outcome = "skipped" // Never injected.
    OutcomeInvalid Outcome = "invalid" // Missing safety machinery.
)

type ExperimentResult struct {
    Name      string
    Outcome   Outcome
    StartTime time.Time
    EndTime   time.Time
    Error     error
    Probes    int
    Metrics   map[string]float64
}

func (r ExperimentResult) Success() bool { return r.Outcome == OutcomeHeld }

type ChaosRunner struct {
    logger  *slog.Logger
    mu      sync.Mutex
    results []ExperimentResult

    // CleanupWait bounds how long cleanup may take after the run ends.
    CleanupWait time.Duration
}

func NewChaosRunner(logger *slog.Logger) *ChaosRunner {
    return &ChaosRunner{logger: logger, CleanupWait: 30 * time.Second}
}

func (r *ChaosRunner) record(res ExperimentResult) ExperimentResult {
    res.EndTime = time.Now()
    r.mu.Lock()
    r.results = append(r.results, res)
    r.mu.Unlock()
    return res
}

func (r *ChaosRunner) Results() []ExperimentResult {
    r.mu.Lock()
    defer r.mu.Unlock()
    return append([]ExperimentResult(nil), r.results...)
}

var ErrSteadyStateLost = errors.New("chaos: steady state lost")
```

### The Runner

Read the ordering carefully, because every step of it is load-bearing.

The baseline probe comes first. Injecting a fault into a system that is already degraded tells you nothing, since you cannot attribute what follows to your fault, and it makes a bad day worse. If there is no steady state to begin with, the run is skipped and nothing is injected.

Cleanup is registered before injection and runs on a **detached** context. This matters more than it looks. If cleanup used the caller's context, then pressing Ctrl-C, or the parent deadline expiring, would hand the fault-removal path an already-cancelled context, and the one piece of code whose entire job is to take the fault out of production would be unable to make a single API call. The fault would stay live. `context.WithoutCancel` severs the cancellation while keeping the values, and a fresh timeout bounds it.

The monitor loop is the abort condition. It probes the hypothesis on a ticker while the fault is live, and on enough consecutive failures it cleans up and returns immediately rather than serving out the remainder of the duration.

Cleanup runs *before* `Verify`, because `Verify` is asking whether the system recovered, and it cannot answer that question while the fault is still injected.

```go
func (r *ChaosRunner) Run(ctx context.Context, exp Experiment) ExperimentResult {
    res := ExperimentResult{
        Name:      exp.Name,
        StartTime: time.Now(),
        Metrics:   map[string]float64{},
    }

    if err := exp.validate(); err != nil {
        res.Outcome = OutcomeInvalid
        res.Error = err
        return r.record(res)
    }

    probeEvery := exp.ProbeInterval
    if probeEvery <= 0 {
        probeEvery = time.Second
    }
    tolerate := exp.AbortAfter
    if tolerate <= 0 {
        tolerate = 1
    }

    r.logger.Info("chaos experiment starting",
        "name", exp.Name, "hypothesis", exp.Hypothesis, "duration", exp.Duration)

    // Baseline. Never inject chaos into an already-sick system.
    if err := exp.SteadyState(ctx); err != nil {
        res.Outcome = OutcomeSkipped
        res.Error = fmt.Errorf("no baseline steady state, refusing to inject: %w", err)
        r.logger.Warn("chaos experiment skipped", "name", exp.Name, "error", res.Error)
        return r.record(res)
    }

    if exp.Setup != nil {
        if err := exp.Setup(ctx); err != nil {
            res.Outcome = OutcomeSkipped
            res.Error = fmt.Errorf("setup failed: %w", err)
            return r.record(res)
        }
    }

    cleaned := false
    cleanup := func() {
        if cleaned {
            return
        }
        cleaned = true
        // Detached on purpose. Cleanup must run even when ctx is already
        // cancelled, because it is what removes the fault from a live system.
        cctx, ccancel := context.WithTimeout(context.WithoutCancel(ctx), r.CleanupWait)
        defer ccancel()
        if err := exp.Cleanup(cctx); err != nil {
            r.logger.Error("CLEANUP FAILED, fault may still be live",
                "name", exp.Name, "error", err)
        }
    }
    defer cleanup()

    if err := exp.Inject(ctx); err != nil {
        res.Outcome = OutcomeSkipped
        res.Error = fmt.Errorf("injection failed: %w", err)
        return r.record(res)
    }

    expCtx, cancel := context.WithTimeout(ctx, exp.Duration)
    defer cancel()

    ticker := time.NewTicker(probeEvery)
    defer ticker.Stop()
    consecutive := 0
    var lastErr error

monitor:
    for {
        select {
        case <-expCtx.Done():
            break monitor // Ran the full duration without losing steady state.
        case <-ticker.C:
            res.Probes++
            err := exp.SteadyState(expCtx)
            if err == nil {
                consecutive = 0
                continue
            }
            if expCtx.Err() != nil {
                break monitor // Probe failed only because time ran out.
            }
            consecutive++
            lastErr = err
            r.logger.Warn("steady state probe failed",
                "name", exp.Name, "consecutive", consecutive, "error", err)

            if consecutive >= tolerate {
                res.Outcome = OutcomeAborted
                res.Error = fmt.Errorf("%w after %d consecutive failed probes: %w",
                    ErrSteadyStateLost, consecutive, lastErr)
                r.logger.Error("ABORTING chaos experiment", "name", exp.Name, "error", res.Error)
                cleanup()
                return r.record(res)
            }
        }
    }

    // Remove the fault before asking whether the system recovered.
    cleanup()

    // The parent context died rather than the experiment's own timer, so the
    // operator cancelled the run. The fault is gone, but nothing was proven.
    if ctx.Err() != nil {
        res.Outcome = OutcomeAborted
        res.Error = fmt.Errorf("run cancelled: %w", ctx.Err())
        return r.record(res)
    }

    if exp.Verify != nil {
        if err := exp.Verify(ctx); err != nil {
            res.Outcome = OutcomeBroke
            res.Error = fmt.Errorf("verification failed: %w", err)
            return r.record(res)
        }
    }

    res.Outcome = OutcomeHeld
    r.logger.Info("chaos experiment completed", "name", exp.Name, "outcome", res.Outcome)
    return r.record(res)
}
```

### Testing the Safety Machinery

The abort path is the most important code in the framework and the least likely to be exercised by accident, so test it directly. Kill the steady state 200 milliseconds into a ten second experiment and assert that the runner does not sit there for the other 9.8:

```go
func TestAbortsWhenSteadyStateBreaks(t *testing.T) {
    var faultLive, healthy atomic.Bool
    healthy.Store(true)

    r := NewChaosRunner(testLogger())
    start := time.Now()

    res := r.Run(context.Background(), Experiment{
        Name:          "kill-the-service",
        Duration:      10 * time.Second,
        ProbeInterval: 50 * time.Millisecond,
        SteadyState: func(ctx context.Context) error {
            if !healthy.Load() {
                return errors.New("error rate 100%")
            }
            return nil
        },
        Inject: func(ctx context.Context) error {
            faultLive.Store(true)
            time.AfterFunc(200*time.Millisecond, func() { healthy.Store(false) })
            return nil
        },
        Cleanup: func(ctx context.Context) error { faultLive.Store(false); return nil },
    })

    if res.Outcome != OutcomeAborted {
        t.Fatalf("want aborted, got %s", res.Outcome)
    }
    if elapsed := time.Since(start); elapsed > 2*time.Second {
        t.Fatalf("kept the fault live for %v after the service died", elapsed)
    }
    if faultLive.Load() {
        t.Fatal("fault still injected after abort")
    }
    if !errors.Is(res.Error, ErrSteadyStateLost) {
        t.Fatal("abort reason not reported")
    }
}
```

That run aborts in roughly 250 milliseconds against a ten second nominal duration. Three more tests are worth writing and are short: cancel the parent context mid-run and assert the fault is gone and the outcome is not `held`, hand the runner a `SteadyState` that fails immediately and assert `Inject` was never called, and hand it an `Experiment` with no `SteadyState` and no `Cleanup` and assert it refuses to inject at all.

### Example Experiments

```go
func DatabaseFailureExperiment(chaosDB *ChaosDB, health *HealthProbe) Experiment {
    return Experiment{
        Name:        "database-failure",
        Description: "Half of database queries fail for 30 seconds",
        Hypothesis:  "Read paths serve from cache and the API stays under 1% 5xx",
        Duration:    30 * time.Second,
        ProbeInterval: 2 * time.Second,
        SteadyState:   health.Check, // Polled throughout. This is the abort switch.
        Inject: func(ctx context.Context) error {
            chaosDB.Store(DBFaultConfig{
                Enabled:   true,
                ErrorRate: 0.5,
                Latency:   100 * time.Millisecond,
            })
            return nil
        },
        Verify: func(ctx context.Context) error {
            // Runs after Cleanup, so this genuinely asks about recovery.
            return health.Check(ctx)
        },
        Cleanup: func(ctx context.Context) error {
            chaosDB.Disable()
            return nil
        },
    }
}
```

The `HighLatencyExperiment` below is where a subtler failure hides. It is tempting to write a `Verify` that says, in comments, "check that circuit breakers activated" and then `return nil`. That experiment can never fail. It reports `held` whether the breakers tripped, stayed shut, or were never wired up, and it will do so cheerfully for years. A verification that returns `nil` unconditionally is worse than no verification, because it manufactures evidence of resilience you do not have. Either query the metric or delete the phase.

```go
func HighLatencyExperiment(inj *Injector, breakers BreakerMetrics, health *HealthProbe) Experiment {
    return Experiment{
        Name:          "high-latency",
        Description:   "500ms +/- 200ms added to every inbound request for 60 seconds",
        Hypothesis:    "Upstream breakers open and shed load rather than queueing",
        Duration:      60 * time.Second,
        ProbeInterval: 2 * time.Second,
        SteadyState:   health.Check,
        Inject: func(ctx context.Context) error {
            inj.Store(FaultConfig{
                Enabled:       true,
                Latency:       500 * time.Millisecond,
                LatencyJitter: 200 * time.Millisecond,
            })
            return nil
        },
        Verify: func(ctx context.Context) error {
            // Assert the thing the hypothesis actually claims.
            opened, err := breakers.OpenedSince(ctx, time.Now().Add(-60*time.Second))
            if err != nil {
                return fmt.Errorf("cannot read breaker metrics: %w", err)
            }
            if opened == 0 {
                return errors.New(
                    "no circuit breaker opened under 500ms latency: the safeguard is missing")
            }
            return nil
        },
        Cleanup: func(ctx context.Context) error {
            inj.Disable()
            return nil
        },
    }
}
```

### Staff Lens: Framework Safety Controls Are Load-Bearing

Every chaos experiment must have abort conditions that auto-stop it when a metric crosses a threshold, blast radius limits so that only a bounded slice of traffic is affected, and cleanup that runs unconditionally. Without these, chaos becomes a real outage.

The reason to build those into the framework rather than to document them as a policy is that policies are followed by whoever remembers them at 2am and frameworks are followed by everyone. Once `validate` refuses an experiment with no `SteadyState`, nobody on the team can write the dangerous version by accident. That is the difference between a chaos platform and a collection of scripts that happen to break things.

---
