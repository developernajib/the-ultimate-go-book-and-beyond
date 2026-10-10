## 22B.10 Measuring Fault Tolerance

### Availability Nines Reference

SLO percentages translate directly into allowable downtime budgets. The table below makes this concrete: a 99.9% SLO permits roughly 44 minutes of downtime per month, while five nines compresses that budget to 26 seconds, a threshold that requires automated failover with no human-in-the-loop recovery paths.

```
SLO Target | Downtime/Year  | Downtime/Month | Downtime/Day
-----------|----------------|----------------|---------------
99%        | 3.65 days      | 7.3 hours      | 14.4 minutes
99.9%      | 8.7 hours      | 43.8 minutes   | 1.44 minutes
99.95%     | 4.4 hours      | 21.9 minutes   | 43.2 seconds
99.99%     | 52.6 minutes   | 4.4 minutes    | 8.64 seconds
99.999%    | 5.26 minutes   | 26 seconds     | 0.86 seconds
```

### Error Budget Calculator in Go

An error budget converts an SLO target into a concrete allowable failure duration for a given time window. Tracking remaining budget as a percentage lets on-call engineers make data-driven decisions about whether to block further deployments or allow continued experimentation when the budget approaches exhaustion.

```go
type ErrorBudget struct {
    SLOPercent     float64
    WindowDuration time.Duration
}

func (eb ErrorBudget) TotalBudget() time.Duration {
    errorRate := 1.0 - (eb.SLOPercent / 100.0)
    return time.Duration(float64(eb.WindowDuration) * errorRate)
}

func (eb ErrorBudget) RemainingPercent(consumed time.Duration) float64 {
    remaining := float64(eb.TotalBudget()-consumed) / float64(eb.TotalBudget()) * 100
    if remaining < 0 {
        return 0
    }
    return remaining
}

// Example: 99.9% SLO over a literal 30-day window.
// TotalBudget() = 43m12s, which is 30 x 24 x 60 x 0.001 minutes.
// After 20min consumed: RemainingPercent() = 53.7%
//
// That is 43m12s, not the 43.8 minutes the table above gives for a month.
// The table uses the average calendar month of 30.44 days. Both are right,
// they answer different questions. State which convention you are using,
// because error budget arguments turn on exactly this kind of detail.
```

### Multi-Window Burn Rate Alert (Google SRE)

A multi-window burn rate alert fires only when the error rate is elevated over both a long window (establishing that the burn is real rather than a blip) and a short window (confirming it is still happening right now, so the alert clears promptly once the incident ends instead of smouldering for an hour). The factor of 14.4 is the Google SRE recipe for a 99.9% SLO: it is the burn rate that would consume 2% of a 30-day budget in a single hour, which is fast enough to be worth waking someone.

Every `sum()` below is load-bearing. Without them this alert is worse than no alert at all:

```yaml
groups:
  - name: fault_tolerance
    rules:
      - alert: HighErrorBudgetBurnRate
        # The sum() calls are not decoration. Written the obvious way,
        #   rate(http_requests_total{status=~"5.."}[1h]) / rate(http_requests_total[1h])
        # Prometheus matches the two sides one-to-one on their labels, so the
        # {status="500"} series is divided BY ITSELF and the result is 1.0 for
        # every 5xx series present. 1.0 > 0.0144 always holds, so the alert
        # fires whenever a single 5xx exists anywhere, at any rate, forever.
        # The fired alert even carries a status="500" label, which is the
        # giveaway that the match happened per-status.
        # Collapsing both sides with sum() gives one label-free value on each
        # side, which is the ratio actually wanted.
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1h]))
            /
            sum(rate(http_requests_total[1h]))
          ) > (14.4 * 0.001)
          and
          (
            sum(rate(http_requests_total{status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total[5m]))
          ) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Burning error budget 14.4x faster than sustainable, incident imminent"
```

Test alert rules the way you test code. `promtool test rules` runs a rule file against synthetic series and asserts which alerts fire, and it catches exactly this class of bug: point it at a healthy service holding steady at its SLO and assert that nothing fires. A rule that pages on a single stray 5xx and a rule that can never fire at all look equally plausible on the page, and only an executed test tells them apart.

### Fault Injection Middleware

Testing fault tolerance in production requires deliberately introducing failures. A `FaultInjector` middleware injects configurable latency and random errors at a specified rate, letting teams verify that circuit breakers, fallbacks, and degradation tiers activate correctly under controlled conditions without waiting for a real outage.

```go
type FaultInjector struct {
    Enabled   bool
    ErrorRate float64       // 0.0 to 1.0
    Latency   time.Duration // extra latency to inject
}

func (fi *FaultInjector) MaybeInject(ctx context.Context) error {
    if !fi.Enabled {
        return nil
    }
    if fi.Latency > 0 {
        select {
        case <-time.After(fi.Latency):
        case <-ctx.Done():
            return ctx.Err()
        }
    }
    if rand.Float64() < fi.ErrorRate {
        return errors.New("fault injected: simulated failure")
    }
    return nil
}

func FaultInjectionMiddleware(fi *FaultInjector) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if err := fi.MaybeInject(r.Context()); err != nil {
                http.Error(w, err.Error(), http.StatusServiceUnavailable)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

### Staff Lens: Chaos Engineering Validates Design

Without chaos testing, fault tolerance patterns have never faced real failure. Chaos Monkey, Gremlin, or hand-rolled fault injection reveal whether the patterns actually work. Run regularly in staging, and occasionally in production (behind feature flags or on dedicated instances).

---
