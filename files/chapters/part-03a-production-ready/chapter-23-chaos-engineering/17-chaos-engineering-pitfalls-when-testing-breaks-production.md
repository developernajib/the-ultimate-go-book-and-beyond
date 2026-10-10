## Chaos Engineering Pitfalls: When Testing Breaks Production

This section covers the most dangerous chaos engineering mistakes that turn testing into actual incidents. Each pitfall is drawn from real-world failures where well-intentioned chaos experiments caused production outages, data corruption, or extended downtime. For each pitfall, you will see the dangerous pattern followed by the safe alternative with detailed Go code showing the correct approach.

### The Blast Radius Explosion

**The Incident**: Chaos experiment meant for 1 pod affected entire cluster. DNS chaos injection misconfigured - all pods lost name resolution.

```go
// WRONG: Chaos with no blast radius control

func injectNetworkChaos() {
    // 🚨 No target selection - affects EVERYTHING
    iptables("-A", "OUTPUT", "-p", "tcp", "--dport", "5432", "-j", "DROP")
    // All database connections in the cluster are now broken
}
```

```go
// CORRECT: Controlled blast radius

type ChaosExperiment struct {
    Target      TargetSelector
    MaxAffected int           // Never affect more than N instances
    DryRun      bool          // Preview without executing
    Rollback    func() error  // Automatic rollback capability
}

type TargetSelector struct {
    Namespace  string            // Only this namespace
    Labels     map[string]string // Only matching pods
    Percentage float64           // Only X% of matching pods

    // AllowProduction, not ExcludeProduction. The zero value of a bool is
    // false, so a field named ExcludeProduction defaults to "do not exclude
    // production", and ChaosExperiment{} happily targets prod. Name safety
    // flags so that the zero value is the safe one, always.
    AllowProduction bool
}

func (e *ChaosExperiment) Execute(ctx context.Context) error {
    if e.MaxAffected <= 0 {
        return errors.New("MaxAffected must be set")
    }
    if e.Rollback == nil {
        // Calling a nil func value panics. Refuse before injecting, not
        // afterwards from inside a goroutine holding a live fault.
        return errors.New("Rollback is required")
    }

    targets, err := e.Target.Resolve(ctx)
    if err != nil {
        return err
    }
    if len(targets) == 0 {
        // An empty selector matching nothing and an empty selector matching
        // EVERYTHING both deserve a hard stop. See the note below.
        return errors.New("selector matched no targets")
    }
    if len(targets) > e.MaxAffected {
        return fmt.Errorf("blast radius too large: %d > %d", len(targets), e.MaxAffected)
    }

    if !e.Target.AllowProduction {
        for _, t := range targets {
            if t.IsProduction() {
                return fmt.Errorf("refusing to affect production target: %s", t.Name)
            }
        }
    }

    if e.DryRun {
        log.Printf("DRY RUN: would affect %d targets: %v", len(targets), targets)
        return nil
    }

    if err := e.inject(ctx, targets); err != nil {
        return err
    }

    // Roll back when the experiment ends, however it ends. Waiting only on
    // ctx.Done() in a goroutine leaks that goroutine for the lifetime of the
    // context and never rolls back on normal completion.
    defer func() {
        if err := e.Rollback(); err != nil {
            log.Printf("ROLLBACK FAILED, fault may still be live: %v", err)
        }
    }()

    return e.monitor(ctx, targets)
}
```

The empty-selector case deserves more than a line. A `TargetSelector` with no labels set does not match nothing, it matches *everything*, and label selectors are the single most common source of blast-radius accidents precisely because the failure is silent and inverted: you make a typo, or leave a field empty, and instead of an error you get the whole cluster. That is how a DNS chaos experiment aimed at one pod takes out `coredns` and with it every name lookup in the cluster.

Two habits prevent it. Resolve the selector and print what it matched before you inject anything, which is what `DryRun` is for and why it should be the default for a new experiment rather than an option. And make `MaxAffected` a hard ceiling that is checked against the *resolved* list, so an over-broad selector fails the experiment instead of expanding it. The check above does exactly that: a selector that accidentally matches 400 pods against a `MaxAffected` of 1 returns an error rather than a catastrophe.

### The Missing Steady State

**The Problem**: Running chaos experiments without knowing what "normal" looks like. Can't tell if chaos caused degradation or things were already broken.

```go
// WRONG: Inject chaos, hope for the best

func runExperiment() {
    injectLatency()
    time.Sleep(5 * time.Minute)
    stopLatency()
    fmt.Println("Experiment complete")  // But was anything actually broken?
}
```

```go
// CORRECT: Steady state hypothesis with verification

type SteadyStateHypothesis struct {
    Name        string
    Metrics     []MetricCheck
    Timeout     time.Duration
}

type MetricCheck struct {
    Query     string     // Prometheus query
    Condition Condition  // gt, lt, eq
    Threshold float64
}

func (h *SteadyStateHypothesis) Verify(ctx context.Context) (bool, error) {
    for _, m := range h.Metrics {
        value, err := prometheus.Query(ctx, m.Query)
        if err != nil {
            return false, err
        }

        if !m.Condition.Check(value, m.Threshold) {
            return false, nil
        }
    }
    return true, nil
}

func runExperiment(ctx context.Context) error {
    hypothesis := SteadyStateHypothesis{
        Name: "API is responsive",
        Metrics: []MetricCheck{
            {
                // sum(...) by (le) is required. Without the grouping this
                // returns one quantile per series, not one for the service.
                Query:     `histogram_quantile(0.99, sum(rate(http_duration_seconds_bucket[1m])) by (le))`,
                Condition: LessThan,
                Threshold: 0.5, // p99 < 500ms
            },
            {
                // A RATIO, not a count. "Fewer than 10 errors/sec" means
                // something different at 50 req/s than at 50,000, and
                // `or vector(0)` supplies the zero that "no 5xx series
                // exist" means, so a healthy service does not fail its own
                // check by returning an empty vector.
                Query: `(sum(rate(http_requests_total{status=~"5.."}[1m])) or vector(0)) ` +
                    `/ sum(rate(http_requests_total[1m]))`,
                Condition: LessThan,
                Threshold: 0.01, // Under 1% errors
            },
        },
    }

    // Step 1: Verify steady state BEFORE experiment
    healthy, err := hypothesis.Verify(ctx)
    if err != nil {
        return fmt.Errorf("failed to verify baseline: %w", err)
    }
    if !healthy {
        return errors.New("system not in steady state before experiment, aborting")
    }
    log.Println("Baseline verified, starting experiment...")

    // Step 2: Inject chaos, with rollback guaranteed on every exit path
    rollback := injectLatency(100 * time.Millisecond)
    defer rollback()

    // Step 3: Continuously verify, and ABORT when the hypothesis breaks
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil // Experiment ran its full duration. Hypothesis held.
        case <-ticker.C:
            healthy, err := hypothesis.Verify(ctx)
            if err != nil {
                // Fail closed. If you cannot evaluate the hypothesis, you no
                // longer have an abort condition, and continuing to inject
                // while blind is how an experiment becomes an incident.
                return fmt.Errorf("cannot verify steady state, aborting: %w", err)
            }
            if !healthy {
                // Return, and the deferred rollback fires immediately.
                log.Println("FINDING: steady state violated, aborting experiment")
                return ErrSteadyStateLost
            }
        }
    }
}
```

That last branch is the entire point of this section, and it is the one most often written wrong. The tempting version logs the violation and carries on:

```go
if !healthy {
    log.Println("FINDING: Steady state violated during chaos!")
    // This is actually success - we found a weakness   <-- NO
}
```

The comment is seductive because half of it is true. Finding a weakness *is* success. But the code does not stop, so the fault stays injected against a system that is already failing its own health check, for the entire remaining duration. You learned the weakness exists in the first ten seconds and then spent the next five minutes exploiting it against your own users. Everything after the first failed probe is not experiment, it is damage, and it teaches you nothing you did not know at second ten.

Record the finding and abort. Those are not in tension. The finding is the return value.

### The Production Surprise

**The Disaster**: Chaos experiment ran in production during peak hours because environment variable wasn't set.

```go
// WRONG: Trusting environment detection

func shouldRunChaos() bool {
    // 🚨 What if ENV isn't set? Defaults to empty string.
    return os.Getenv("ENV") != "production"
}

func main() {
    if shouldRunChaos() {
        startChaosAgent()  // Oops, this ran in production
    }
}
```

```go
// CORRECT: Explicit opt-in with multiple safeguards

func shouldRunChaos() (bool, error) {
    // Safeguard 1: Explicit opt-in required
    if os.Getenv("CHAOS_ENABLED") != "true" {
        return false, nil
    }

    // Safeguard 2: Verify NOT in production (multiple checks)
    env := os.Getenv("ENV")
    if env == "" {
        return false, fmt.Errorf("ENV not set - refusing to run chaos")
    }
    if env == "production" || env == "prod" {
        return false, fmt.Errorf("refusing to run chaos in production")
    }

    // Safeguard 3: Check for production indicators
    if os.Getenv("PRODUCTION_DATABASE") != "" {
        return false, fmt.Errorf("production database detected - refusing chaos")
    }

    // Safeguard 4: Time-based protection.
    // Resolve an explicit zone. time.Now().Hour() uses the host's local time,
    // and containers overwhelmingly run as UTC, so a rule written to mean
    // "not during the London working day" silently becomes a rule about
    // whatever TZ the pod happened to inherit. That is not a safeguard, it is
    // a coin flip you will not notice until it lands wrong.
    loc, err := time.LoadLocation(os.Getenv("CHAOS_TIMEZONE"))
    if err != nil {
        return false, fmt.Errorf("CHAOS_TIMEZONE invalid or unset: %w", err)
    }
    if hour := time.Now().In(loc).Hour(); hour >= 8 && hour < 19 {
        if os.Getenv("CHAOS_ALLOW_BUSINESS_HOURS") != "true" {
            return false, fmt.Errorf("chaos disabled during business hours in %v", loc)
        }
    }

    // Safeguard 5: Require approval token (rotates daily).
    // Compare in constant time. This gate decides whether faults may be
    // injected, which makes the token an authorization secret, and a
    // byte-by-byte == on a secret is a timing oracle.
    token := os.Getenv("CHAOS_APPROVAL_TOKEN")
    expected, err := dailyToken(time.Now().In(loc))
    if err != nil {
        return false, fmt.Errorf("cannot derive approval token: %w", err)
    }
    if subtle.ConstantTimeCompare([]byte(token), []byte(expected)) != 1 {
        return false, errors.New("invalid or expired chaos approval token")
    }

    log.Printf("Chaos enabled in environment: %s", env)
    return true, nil
}
```

Two notes on this pattern. The layering is the point: five independent gates, each of which alone is enough to stop the experiment, so no single misconfiguration is sufficient to start one. Safeguard 2 is the one that matters most and is the one people delete, because "refuse when `ENV` is unset" feels like it will be annoying. It is annoying. It is also the only gate that catches the specific incident this section opens with, where an unset variable meant a check for `!= "production"` returned true and chaos started in production.

And be clear about what this particular controller is: it is a hard "never in production" agent, which is the right shape for a team at maturity level 1 or 2 and is explicitly *not* the Principles-of-Chaos ideal of running in production. That is fine. Earn production chaos by building the abort machinery first, then relax safeguards 2 and 3 deliberately and one at a time, rather than by discovering that they never worked.

### The Unrecoverable State

**The Problem**: Chaos experiment corrupted data or state that couldn't be automatically rolled back.

```go
// WRONG: Chaos that mutates persistent state

func injectDatabaseChaos() {
    // 🚨 This permanently corrupts data!
    db.Exec("UPDATE users SET balance = balance * 0.5 WHERE random() < 0.1")
}
```

```go
// CORRECT: Non-destructive chaos techniques

// 1. Network-level chaos (no data modification)
func injectReadOnlyChaos() func() {
    proxy := startTCProxy(":5432", "real-db:5432")

    // Inject latency, not data corruption
    proxy.AddLatency(100 * time.Millisecond)
    // Or drop connections
    proxy.SetDropRate(0.1)  // 10% of connections fail

    return proxy.Stop
}

// 2. Application-level fault injection (reversible)
type FaultInjector struct {
    mu     sync.RWMutex
    faults map[string]Fault
}

// FaultType is a closed set. A free-form string lets a typo select the
// default branch, and a default branch that returns nil is a fault that
// silently never fires.
type FaultType int

const (
    FaultLatency FaultType = iota
    FaultError
    FaultTimeout
)

type Fault struct {
    Type        FaultType
    Probability float64
    Duration    time.Duration
    Enabled     bool
}

// MaybeInject takes a context so injected delay stays cancellable. Without
// one, a "timeout" fault parks a goroutine for a fixed 30 seconds even after
// the caller has hung up, and under load that is a goroutine leak that looks
// like a memory leak.
func (f *FaultInjector) MaybeInject(ctx context.Context, operation string) error {
    f.mu.RLock()
    fault, exists := f.faults[operation]
    f.mu.RUnlock()

    if !exists || !fault.Enabled {
        return nil
    }
    if rand.Float64() > fault.Probability {
        return nil
    }

    switch fault.Type {
    case FaultLatency:
        if !sleepCtx(ctx, fault.Duration) {
            return ctx.Err()
        }
        return nil
    case FaultError:
        return fmt.Errorf("injected error for %s", operation)
    case FaultTimeout:
        // Wait out the caller's own deadline rather than a magic 30s.
        <-ctx.Done()
        return ctx.Err()
    default:
        // An unrecognised fault type is a config bug. Returning nil here
        // silently disables the injection and the experiment reports a
        // clean run it never performed.
        return fmt.Errorf("unknown fault type %q for %s", fault.Type, operation)
    }
}

// 3. Shadow/dark launch testing
func processOrder(ctx context.Context, order Order) error {
    // Real processing
    result, err := realOrderProcessor.Process(ctx, order)

    // Shadow: test the new code path without affecting production.
    if chaosEnabled() {
        // WithoutCancel is load-bearing. ctx is the request context, and the
        // server cancels it the instant this handler returns, which is
        // immediately. Hand the goroutine ctx directly and the shadow call
        // is cancelled before it does any work: measure it and you will see
        // 0 of 100 shadow requests complete, while the error metric fills
        // with context.Canceled that tells you nothing about the new code.
        sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
        go func() {
            defer cancel()
            // A shadow path must never be able to take down the real one.
            defer func() {
                if r := recover(); r != nil {
                    metrics.RecordShadowPanic(r)
                }
            }()
            if _, shadowErr := experimentalProcessor.Process(sctx, order); shadowErr != nil {
                metrics.RecordShadowError(shadowErr)
            }
        }()
    }

    return err
}
```

The shadow launch bug is worth measuring rather than taking on faith. Fire 100 requests through the version that passes `ctx` straight into the goroutine, cancelling each request context as the handler returns exactly as a real server does, and **0 of 100** shadow calls complete: all 100 are cancelled. Swap in `context.WithoutCancel` and all 100 complete. The broken version is not subtly degraded, it is entirely inert, and because it faithfully records a `context.Canceled` for each one it produces a shadow error dashboard that looks like data.

Note also `result` is assigned and unused in both versions, which the compiler will reject. Shadow comparison is the reason the variable exists: capture the real result and diff it against the shadow one, otherwise you are only checking that the new path does not error, not that it agrees.

### Quick Reference: Chaos Anti-Patterns

| Anti-Pattern | Impact | Fix |
|--------------|--------|-----|
| No blast radius | Affects entire cluster | Explicit targeting, max affected |
| No steady state | Can't measure impact | Define metrics before experiment |
| Implicit environment | Runs in production | Explicit opt-in with safeguards |
| Destructive mutations | Data corruption | Network-level or app-level faults |
| No automatic rollback | Manual recovery needed | Context cancellation + rollback |
| No documentation | Repeated mistakes | Record all experiments and findings |

### Staff Lens: Chaos Tool Safety Audit

Before running production chaos: audit the tool's safety mechanisms. Can it auto-abort? Can it be killed remotely? Does it have kill switches? If any answer is uncertain, do not run in production yet.

---
