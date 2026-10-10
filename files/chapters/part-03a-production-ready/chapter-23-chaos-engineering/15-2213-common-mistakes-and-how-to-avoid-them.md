## 23.13 Common Mistakes and How to Avoid Them

Even experienced engineers make costly mistakes when starting a chaos engineering program. The most common errors involve skipping safety controls, running experiments without a clear definition of normal behavior, or accidentally targeting production systems. Each mistake below includes a "wrong" pattern that shows the dangerous approach and a "correct" pattern that demonstrates the safe alternative. Understanding these anti-patterns before you begin will save you from turning a chaos experiment into a real incident.

### Mistake 1: Starting in Production Without Preparation

Running chaos experiments directly in production before establishing monitoring, runbooks, and validated safety mechanisms is the fastest way to convert a controlled experiment into an unplanned outage. The correct approach is a maturity ladder that gates progression from development through staging, canary, and finally full production, with each level requiring explicit prerequisites to be satisfied before advancing. The `ChaosProgression` struct below formalizes this gate-checking logic so that promotion to a higher environment is never a manual judgment call.

```go
// WRONG: Jumping straight to production chaos
func RunChaosExperiment() {
    // No staging testing
    // No safety controls
    // No monitoring
    injectFault(production) // Disaster!
}

// CORRECT: Gradual progression
type ChaosMaturityLevel int

const (
    Level1Dev ChaosMaturityLevel = iota // Development only
    Level2Staging                        // Staging environment
    Level3Canary                         // Small production subset
    Level4Production                     // Full production
)

type ChaosProgression struct {
    currentLevel ChaosMaturityLevel
    requirements map[ChaosMaturityLevel][]Requirement
}

func (p *ChaosProgression) CanAdvance() bool {
    for _, req := range p.requirements[p.currentLevel] {
        if !req.IsMet() {
            return false
        }
    }
    return true
}

// Requirements for production chaos:
// - Comprehensive monitoring
// - Automated rollback
// - Runbook for experiment types
// - On-call engineer available
// - Business approval
```

### Mistake 2: Not Defining Steady State

Without a quantitative definition of "healthy", you cannot tell whether your experiment exposed a weakness or simply produced noise. Steady state is expressed as a set of observable metrics, error rate, p99 latency, throughput, each with a threshold and comparison operator that can be evaluated against real telemetry. The `SteadyState.Verify` method below queries Prometheus before, during, and after fault injection, giving you an objective pass/fail signal rather than relying on subjective observation. The "during" part is not optional: a check that only runs at the two ends is a report, whereas a check that runs throughout is an abort condition.

Two things in the queries below are easy to get wrong and are covered in detail in 23.7. `histogram_quantile` needs its input aggregated with `sum(...) by (le)`, since without the `by (le)` grouping you get one quantile per series rather than one for the service, and whichever series happens to land first is the number you end up alerting on. And the error-rate query needs `or vector(0)`, because a service with no 5xx at all produces an empty vector rather than a zero, and the naive query makes a perfectly healthy service fail its own health check.

```go
// WRONG: Running chaos without steady state definition
func RunExperiment(exp Experiment) {
    // What does "healthy" even mean?
    inject(exp.Fault)
    wait(exp.Duration)
    cleanup(exp.Fault)
    // Did we break anything? Who knows!
}

// CORRECT: Define and verify steady state
type SteadyState struct {
    Metrics []MetricDefinition
}

// Comparison is a closed set, not a free-form string. A typo in a string
// field silently selects the "unknown" branch, and an unknown comparison in
// a safety check must never quietly pass.
type Comparison int

const (
    LessThan Comparison = iota
    GreaterThan
)

type MetricDefinition struct {
    Name      string
    Query     string // Prometheus query
    Threshold float64
    Compare   Comparison
}

// Querier is the seam. Depend on this rather than a concrete Prometheus
// client, and the whole steady-state layer becomes testable with a fake that
// returns NaN, an empty vector, or a 422, which are exactly the cases that
// break real implementations.
type Querier interface {
    Query(ctx context.Context, q string) (float64, error)
}

func DefineSteadyState(window string) SteadyState {
    return SteadyState{
        Metrics: []MetricDefinition{
            {
                Name: "error_rate",
                // `or vector(0)` supplies the zero that "no 5xx series exist"
                // means. Without it, a service with zero errors returns an
                // empty vector and fails its own check.
                Query: fmt.Sprintf(
                    `(sum(rate(http_requests_total{status=~"5.."}[%s])) or vector(0)) `+
                        `/ sum(rate(http_requests_total[%s]))`, window, window),
                Threshold: 0.01, // 1%
                Compare:   LessThan,
            },
            {
                Name: "latency_p99_seconds",
                // sum(...) by (le) is required. Without the grouping you get
                // one quantile per series instead of one for the service.
                Query: fmt.Sprintf(
                    `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[%s])) by (le))`,
                    window),
                Threshold: 0.5, // 500ms
                Compare:   LessThan,
            },
            {
                Name:      "throughput",
                Query:     fmt.Sprintf(`sum(rate(http_requests_total[%s])) or vector(0)`, window),
                Threshold: 1000, // req/s floor
                Compare:   GreaterThan,
            },
        },
    }
}

func (s *SteadyState) Verify(ctx context.Context, q Querier) error {
    for _, m := range s.Metrics {
        value, err := q.Query(ctx, m.Query)
        if err != nil {
            // Fail closed. An abort condition you cannot evaluate is an
            // abort condition you do not have.
            return fmt.Errorf("query failed for %s: %w", m.Name, err)
        }
        if math.IsNaN(value) {
            // NaN loses every comparison, so an unchecked NaN reads as
            // "under threshold" and reports a dead service as healthy.
            return fmt.Errorf("metric %s is NaN: treat as steady state lost", m.Name)
        }

        var ok bool
        switch m.Compare {
        case LessThan:
            ok = value < m.Threshold
        case GreaterThan:
            ok = value > m.Threshold
        default:
            return fmt.Errorf("metric %s has an unknown comparison", m.Name)
        }

        if !ok {
            return fmt.Errorf("metric %s failed: got %g, threshold %g",
                m.Name, value, m.Threshold)
        }
    }
    return nil
}
```

### Mistake 3: No Rollback Mechanism

Every fault injection must be paired with a deterministic removal path that can be triggered automatically when the context is canceled or an abort signal is received. The `SafeFaultInjector` below starts a monitoring goroutine alongside the injected fault so that context cancellation immediately invokes `Rollback`. The `EmergencyStop` aggregator extends this pattern to allow a single call to halt all active injectors.

This is the highest-stakes code in any chaos program, and the obvious implementation of it contains a bug that turns the emergency stop into a way of crashing the process. It is worth walking through before the corrected version, because everything about it reads as careful.

Picture `Rollback` guarded only by an `applied` bool: check `if !s.applied { return nil }`, then `close(s.stopChan)`, then `s.applied = false`. Now consider the moment this code exists to handle. The experiment's deadline expires, so the monitor goroutine calls `Rollback`. At the same instant, the operator watching the graphs slams the emergency stop, so `StopAll` calls `Rollback` too. Both goroutines read `applied` as true before either has written it. Both proceed. Both call `close(s.stopChan)`.

The second close panics. Not an error return, a panic, and it unwinds through `EmergencyStop.StopAll` itself. Run that race five hundred times under `-race` and you get `WARNING: DATA RACE` on `applied` and then:

```
panic: close of closed channel

goroutine 26 [running]:
chaos.(*SafeFaultInjector).Rollback(...)
chaos.(*EmergencyStop).StopAll(0xc000134200)
```

Read that stack again. The big red button killed the process that was holding the fault injected in production, on the one code path that only ever executes when something is already going badly wrong. Any remaining injectors in the loop never get rolled back, because `StopAll` never reaches them. This is the worst class of bug in the chapter: a safety mechanism that fails precisely when it is needed and takes the rest of the safety machinery with it.

The fixes are mundane, which is the point. Guard the state with a mutex, make the close a `sync.Once`, return an error from `Remove` rather than a panic, take a context so rollback can be bounded, and have `StopAll` keep going after a failure and report what it could not undo.

```go
// WRONG: Can't stop the chaos
func InjectFault(fault Fault) {
    fault.Apply()
    // How do we stop this if things go wrong?
}

// CORRECT: rollback that is safe to call twice, from two goroutines, at once
type Fault interface {
    Apply(ctx context.Context) error
    Remove(ctx context.Context) error
}

type SafeFaultInjector struct {
    name  string
    fault Fault

    mu       sync.Mutex
    applied  bool
    stopOnce sync.Once
    stopChan chan struct{}
}

func NewSafeFaultInjector(name string, f Fault) *SafeFaultInjector {
    return &SafeFaultInjector{name: name, fault: f, stopChan: make(chan struct{})}
}

func (s *SafeFaultInjector) Inject(ctx context.Context) error {
    s.mu.Lock()
    if s.applied {
        s.mu.Unlock()
        return fmt.Errorf("chaos: %s already injected", s.name)
    }
    s.applied = true
    s.mu.Unlock()

    if err := s.fault.Apply(ctx); err != nil {
        s.mu.Lock()
        s.applied = false // Injection failed, so nothing is applied.
        s.mu.Unlock()
        return err
    }

    go func() {
        select {
        case <-ctx.Done():
            // Detached. The context that just died cannot be used for the
            // call that removes the fault from production.
            cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
            defer cancel()
            s.Rollback(cctx)
        case <-s.stopChan:
        }
    }()

    return nil
}

// Rollback is idempotent and safe under concurrent callers. The monitor
// goroutine and an operator's emergency stop WILL race here, by design:
// that is the exact situation the button exists for.
func (s *SafeFaultInjector) Rollback(ctx context.Context) error {
    s.mu.Lock()
    if !s.applied {
        s.mu.Unlock()
        return nil
    }
    s.applied = false // Claimed under the lock: only one caller gets here.
    s.mu.Unlock()

    s.stopOnce.Do(func() { close(s.stopChan) })
    return s.fault.Remove(ctx)
}

// Emergency stop button
type EmergencyStop struct {
    mu        sync.Mutex
    injectors []*SafeFaultInjector
}

func (e *EmergencyStop) Register(inj *SafeFaultInjector) {
    e.mu.Lock()
    defer e.mu.Unlock()
    e.injectors = append(e.injectors, inj)
}

// StopAll rolls every injector back and reports which ones it could not.
// It deliberately continues past a failure: one stuck injector must never
// strand the others, and silence here would be a lie about production state.
func (e *EmergencyStop) StopAll(ctx context.Context) error {
    e.mu.Lock()
    injectors := append([]*SafeFaultInjector(nil), e.injectors...)
    e.mu.Unlock()

    var errs []error
    for _, inj := range injectors {
        if err := inj.Rollback(ctx); err != nil {
            errs = append(errs, fmt.Errorf("%s: %w", inj.name, err))
        }
    }
    if len(errs) > 0 {
        return fmt.Errorf("EMERGENCY STOP INCOMPLETE, faults may still be live: %w",
            errors.Join(errs...))
    }
    return nil
}
```

Test it by racing it on purpose. Cancel the context and hit the stop button from two goroutines simultaneously, five hundred times, and assert the fault was removed exactly once each time:

```go
func TestEmergencyStopSurvivesTheRace(t *testing.T) {
    for i := 0; i < 500; i++ {
        ctx, cancel := context.WithCancel(context.Background())
        f := &countingFault{}
        inj := NewSafeFaultInjector("db", f)
        inj.Inject(ctx)

        es := &EmergencyStop{}
        es.Register(inj)

        var wg sync.WaitGroup
        wg.Add(2)
        go func() { defer wg.Done(); cancel() }()                      // Deadline fires
        go func() { defer wg.Done(); es.StopAll(context.Background()) }() // Operator hits stop
        wg.Wait()
        time.Sleep(time.Millisecond)

        if got := f.removes.Load(); got != 1 {
            t.Fatalf("run %d: fault removed %d times, want exactly 1", i, got)
        }
    }
}
```

Under `-race`, that is green against the version above and panics against the version without the mutex.

### Mistake 4: Chaos Without Context

Scheduling experiments at arbitrary times, including peak traffic windows, release freeze periods, or holidays, amplifies blast radius and eliminates the signal you are trying to measure. A `ChaosScheduler` encodes organizational context: blocked periods for known high-risk times, a business calendar for holidays and special events, and an on-call availability check to ensure someone is ready to respond. The `CanRun` method evaluates all constraints and returns a human-readable reason when an experiment should not proceed, making scheduling decisions auditable.

```go
// WRONG: Running chaos during critical business periods
func ScheduleChaos() {
    // Every day at noon? That's when traffic is highest!
    cron.Schedule("0 12 * * *", runChaosExperiment)
}

// CORRECT: Context-aware chaos scheduling
type ChaosScheduler struct {
    blockedPeriods []TimePeriod
    preferredTimes []TimePeriod
    calendar       *BusinessCalendar
}

type TimePeriod struct {
    Start time.Time
    End   time.Time
    Reason string
}

func (s *ChaosScheduler) CanRun(t time.Time) (bool, string) {
    // Check blocked periods. Note the half-open interval: t.After(Start)
    // excludes Start itself, so an experiment landing exactly on the first
    // instant of a freeze window would sail straight through it. Boundary
    // conditions on a safety check should be inclusive at the start.
    for _, period := range s.blockedPeriods {
        if !t.Before(period.Start) && t.Before(period.End) {
            return false, period.Reason
        }
    }

    // Check business calendar
    if s.calendar.IsHoliday(t) {
        return false, "holiday period"
    }

    if s.calendar.IsPeakTraffic(t) {
        return false, "peak traffic period"
    }

    // Check if on-call is available
    if !s.isOnCallAvailable(t) {
        return false, "no on-call coverage"
    }

    return true, ""
}

// NextAllowedTime reports the next permitted window, and whether one exists.
// Returning a bare time.Time{} for "none found" hands the caller the year 1,
// which is a time in the past, and a scheduler that treats "no safe window"
// as "run immediately" is the exact failure this whole section is about.
func (s *ChaosScheduler) NextAllowedTime() (time.Time, bool) {
    now := time.Now()
    for _, period := range s.preferredTimes {
        next := period.Next(now)
        if ok, _ := s.CanRun(next); ok {
            return next, true
        }
    }
    return time.Time{}, false
}
```

### Mistake 5: Testing Only Happy Path Failures

Single-point failures, killing one pod, severing one connection, are the easiest experiments to design but the least representative of how production incidents actually unfold. Real outages typically involve compound failures where one degraded component triggers cascading problems elsewhere, such as a database failover simultaneously causing a cache miss storm that overwhelms the remaining replicas. The `CompoundFailure` type below models these scenarios explicitly, supporting sequential and parallel orderings.

Compound failures deserve the most safety machinery in your entire program and usually receive the least, because they are the exciting ones. Notice that `DatabaseFailover` combined with a 100% `CacheFlush` in parallel is not really an experiment at anyone's scale: it is a guaranteed outage with a hypothesis attached as decoration. If you cannot state what should remain true while both are live, and cannot abort within seconds when it stops being true, you are not ready to run the pair. Run each half alone first, learn the shape of each, and only then combine. The `MaxDuration` and `SteadyState` fields below are mandatory for exactly this reason.

The third ordering in the naive version, "cascading", is worth deleting rather than implementing, and the reason is instructive. Look at what a cascading entry actually contains: a single `LatencyInjection`, followed by comments explaining that it "causes connection pool exhaustion, which causes other services to fail". Those comments are the finding. You do not inject a cascade, you inject one fault and *discover* whether a cascade emerges, and if you could script the cascade in advance you would not need the experiment. Modelling it as an injection order dressed a hypothesis up as a fault.

```go
// WRONG: Only testing simple failures
func BasicChaosTest() {
    // Kill one pod
    killPod(randomPod())
    // That's it? Real failures are more complex
}

// CORRECT: Test compound failures, with the safety they demand
type Order int

const (
    Sequential Order = iota
    Parallel
)

type CompoundFailure struct {
    Name     string
    Failures []Failure
    Order    Order

    // Not optional. A compound failure without a hypothesis you can poll
    // and a hard ceiling on duration is an outage you scheduled.
    Hypothesis  string
    SteadyState func(ctx context.Context) error
    MaxDuration time.Duration
}

func RealWorldChaosScenarios() []CompoundFailure {
    return []CompoundFailure{
        {
            Name: "failover-during-cold-cache",
            // The classic pairing: the failover is survivable, and the cold
            // cache is survivable, and the two together are what took the
            // site down last year.
            Failures: []Failure{
                &DatabaseFailover{},
                &CacheFlush{Percentage: 25}, // Start at 25, not 100.
            },
            Order:       Parallel,
            Hypothesis:  "Reads degrade but stay under 1% 5xx; origin QPS stays under 2x",
            MaxDuration: 90 * time.Second,
        },
        {
            Name: "partition-then-load",
            Failures: []Failure{
                &NetworkPartition{Source: "service-a", Target: "service-b"},
                &LoadIncrease{Multiplier: 3},
            },
            Order:       Sequential,
            Hypothesis:  "service-a sheds b-dependent requests and serves the rest",
            MaxDuration: 2 * time.Minute,
        },
    }
}
```

The single-fault experiment that reveals a cascade is still the most valuable one you can run. Inject 5 seconds of latency into `payment-service`, then go and watch what happens to everything that talks to it. If a connection pool three services away exhausts itself, you have found something no amount of scripting the cascade in advance would have taught you, because you did not know it was there to script.

### Staff Lens: Chaos Mistakes Have Outsize Cost

A chaos experiment that goes wrong becomes a real outage. Blast radius limits and auto-abort are not optional. Test the safety machinery before running production chaos.

---
