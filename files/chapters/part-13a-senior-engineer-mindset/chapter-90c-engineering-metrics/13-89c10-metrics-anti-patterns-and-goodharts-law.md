## 90C.10 Metrics Anti-Patterns and Goodhart's Law

### Goodhart's Law: The Core Problem

> "When a measure becomes a target, it ceases to be a good measure." - Charles Goodhart, 1975

Goodhart's Law is not a theoretical concern - it is the most common failure mode of engineering metrics programs. Every metric, once tied to individual performance reviews or team incentives, will be gamed. Not necessarily through malice, but because rational agents optimize for measured outcomes.

### The Classic Anti-Pattern Gallery

**Anti-pattern 1: Lines of Code (LOC)**

LOC was used at early software companies as a proxy for productivity. The result: code became unnecessarily verbose. Developers split obvious one-liners into multiple lines. Copy-paste replaced abstraction. LOC as a metric actively punishes good engineering (small, elegant solutions score poorly).

**Anti-pattern 2: Number of Commits**

Commit count became a GitHub-profile status symbol. The response: trivial commits (fix typo, update comment, add blank line). A developer with 400 commits per month might be making no meaningful contribution. Worse, commit count penalizes engineers who make fewer, larger, well-considered changes.

**Anti-pattern 3: Code Coverage as a Target**

Coverage is a useful diagnostic, but a terrible target. When 80% coverage is required to pass CI, teams write tests that execute code without asserting anything meaningful:

```go
// Anti-pattern: coverage theater
func TestProcessPayment_Coverage(t *testing.T) {
    // This test "covers" processPayment but asserts nothing meaningful
    _ = processPayment(nil) // just to hit the line
}
```

Coverage went from 40% to 85% in one sprint. Defect escape rate went up. The tests were not testing anything real.

**Anti-pattern 4: Story Points and Velocity**

Velocity (story points per sprint) becomes a pressure tool when management equates it with productivity. Teams respond by inflating estimates. A task that was historically 3 points becomes 5 points. Velocity goes up. Nothing actually changed. Meaningful comparison across teams becomes impossible since every team calibrates their own scale.

**Anti-pattern 5: Deployment Frequency Without Change Failure Rate**

A team can increase deployment frequency to "Elite" tier by deploying single-line whitespace changes ten times per day. Without correlating with change failure rate, this metric is meaningless. This is why DORA metrics must always be used together.

### Vanity Metrics vs. Actionable Metrics

| Vanity Metric | Why It Fails | Actionable Alternative |
|---------------|--------------|----------------------|
| Lines of code | Rewards verbosity, punishes elegance | Cyclomatic complexity trend |
| Commit count | Rewards trivial commits | PR merge rate with size distribution |
| Code coverage % | Rewards coverage theater | Coverage trend + mutation test score |
| Story point velocity | Inflates over time | Cycle time (wall clock, not estimates) |
| Uptime % | Hides mean incident severity | P99 MTTR and incident frequency |
| PR count | Rewards PR splitting | PR review turnaround time |

The pattern: vanity metrics measure activity volume. Actionable metrics measure outcomes and trends.

### How FAANG Companies Avoid Metric Gaming

**Google's approach (documented in "How Google Works" and engineering blog posts):**
- OKRs separate objectives (qualitative) from key results (quantitative). Key results are not tied to compensation.
- Engineering productivity is measured by the DORA equivalent internally, but individual engineers are evaluated on peer feedback, not metrics.
- The "20% project" philosophy: unstructured time prevents over-optimization for measured outcomes.

**Amazon's approach:**
- Leadership Principles are qualitative and evaluated through narrative writing, not scorecards.
- Service teams own SLOs that are visible to all internal customers, but individual engineers are not evaluated against SLO numbers.

**Meta's approach:**
- Infrastructure investment metrics (reliability, latency) are owned at the team level.
- Code review quality is measured through downstream defect correlation, not review count.

**The common thread**: metrics are team signals and diagnostic tools. They are never individual performance scorecards.

### Leading vs. Lagging Indicators

This distinction is critical for using metrics to prevent problems rather than just diagnose them.

**Lagging indicators** measure outcomes that have already occurred. You can only observe them after the fact.
- Defect escape rate (defects found by customers)
- MTTR (recovery time after an incident already happened)
- Change failure rate (failure after the deployment already occurred)
- Employee attrition rate

**Leading indicators** predict future outcomes. They allow you to intervene before problems materialize.
- PR review turnaround time (leads to cycle time. Slow review predicts long lead time)
- Flaky test rate (leads to CI distrust. High flakiness predicts reduced deployment frequency)
- Tech debt score trend (leads to defect rate. rising debt predicts future bugs)
- Onboarding time trend (leads to team velocity. Slow onboarding predicts retention problems)

Senior engineers focus on leading indicators. Lagging indicators tell you what went wrong. Leading indicators tell you what is about to go wrong.

### Anomaly Detection for Metric Gaming

When a metric improves dramatically and suddenly, it often indicates gaming rather than genuine improvement. This Go service flags suspicious patterns:

```go
package anomaly

import (
    "math"
    "time"
)

// MetricSample represents a single measurement at a point in time.
type MetricSample struct {
    Timestamp time.Time
    Value     float64
    TeamID    string
    MetricName string
}

// AnomalyAlert represents a suspicious metric change.
type AnomalyAlert struct {
    TeamID     string
    MetricName string
    Previous   float64
    Current    float64
    ChangeRate float64 // percentage change
    Reason     string
}

// DetectGaming checks for suspicious metric improvements.
// Returns alerts for patterns that commonly indicate gaming.
func DetectGaming(history []MetricSample, current MetricSample) []AnomalyAlert {
    var alerts []AnomalyAlert

    recent := recentSamples(history, current.TeamID, current.MetricName, 30)
    if len(recent) < 3 {
        return nil // insufficient history
    }

    baseline := average(recent)
    changeRate := (current.Value - baseline) / baseline * 100

    // Alert 1: Coverage jumped by more than 30 percentage points in one sprint
    if current.MetricName == "test_coverage" && changeRate > 30 {
        alerts = append(alerts, AnomalyAlert{
            TeamID:     current.TeamID,
            MetricName: current.MetricName,
            Previous:   baseline,
            Current:    current.Value,
            ChangeRate: changeRate,
            Reason:     "Test coverage increased by >30pp in one measurement period. Validate test quality - this pattern often indicates coverage theater.",
        })
    }

    // Alert 2: Deployment frequency doubled without corresponding PR volume increase
    if current.MetricName == "deployment_frequency" && changeRate > 100 {
        alerts = append(alerts, AnomalyAlert{
            TeamID:     current.TeamID,
            MetricName: current.MetricName,
            Previous:   baseline,
            Current:    current.Value,
            ChangeRate: changeRate,
            Reason:     "Deployment frequency doubled. Verify deployments contain meaningful changes and are not trivial single-line commits.",
        })
    }

    // Alert 3: Story point velocity increased by more than 2 standard deviations
    stddev := standardDeviation(recent)
    if current.MetricName == "velocity" && (current.Value-baseline) > 2*stddev {
        alerts = append(alerts, AnomalyAlert{
            TeamID:     current.TeamID,
            MetricName: current.MetricName,
            Previous:   baseline,
            Current:    current.Value,
            ChangeRate: changeRate,
            Reason:     "Velocity is more than 2 standard deviations above baseline. Review estimation calibration - estimates may have been inflated.",
        })
    }

    return alerts
}

func recentSamples(history []MetricSample, teamID, metricName string, days int) []float64 {
    cutoff := time.Now().AddDate(0, 0, -days)
    var values []float64
    for _, s := range history {
        if s.TeamID == teamID && s.MetricName == metricName && s.Timestamp.After(cutoff) {
            values = append(values, s.Value)
        }
    }
    return values
}

func average(values []float64) float64 {
    if len(values) == 0 {
        return 0
    }
    sum := 0.0
    for _, v := range values {
        sum += v
    }
    return sum / float64(len(values))
}

func standardDeviation(values []float64) float64 {
    if len(values) == 0 {
        return 0
    }
    avg := average(values)
    sumSq := 0.0
    for _, v := range values {
        diff := v - avg
        sumSq += diff * diff
    }
    return math.Sqrt(sumSq / float64(len(values)))
}
```

---
