## 104.8 Production Pitfalls: Prometheus & Grafana Mistakes

### Pitfall 1: High-Cardinality Labels Killing Prometheus

**Real Incident Report**: A team added a `user_id` label to request metrics. With 5 million users, they created 5 million time series per metric. Prometheus memory usage exploded from 4GB to 200GB, queries timed out, and the entire monitoring system became unusable during an actual incident.

**The Anti-Pattern**:
```go
// WRONG: High-cardinality labels
requestCount := prometheus.NewCounterVec(
    prometheus.CounterOpts{Name: "http_requests_total"},
    []string{"method", "path", "status", "user_id"}, // 5M users!
)
requestCount.WithLabelValues("GET", "/api/users", "200", userID).Inc()
```

**The Better Approach**:
```go
// RIGHT: Low-cardinality labels only
requestCount := prometheus.NewCounterVec(
    prometheus.CounterOpts{Name: "http_requests_total"},
    []string{"method", "path", "status", "user_tier"}, // premium/free/trial
)
requestCount.WithLabelValues("GET", "/api/users", "200", user.Tier).Inc()

// For per-user analysis, use logs/traces with user_id
// Metrics are for aggregations, not individual entities
```

**Key Insight**: Each unique label combination is a separate time series. Labels should have bounded, low cardinality.

### Pitfall 2: Counter vs Gauge Confusion

**Real Incident Report**: A team used a Gauge for request counts. After a pod restart, the gauge reset to 0 instead of continuing from the previous value. Rate calculations showed negative spikes, dashboards looked broken, and alerts fired incorrectly.

**The Anti-Pattern**:
```go
// WRONG: Using Gauge for counts
var requestCount = prometheus.NewGauge(
    prometheus.GaugeOpts{Name: "http_requests"},
)
requestCount.Inc()
// Problem: Resets to 0 on restart, rate() breaks
```

**The Better Approach**:
```go
// RIGHT: Counter for monotonically increasing values
var requestCount = prometheus.NewCounter(
    prometheus.CounterOpts{Name: "http_requests_total"},
)
requestCount.Inc()

// Use Gauge for values that can go up and down:
var activeConnections = prometheus.NewGauge(
    prometheus.GaugeOpts{Name: "active_connections"},
)
activeConnections.Inc()
activeConnections.Dec()

// Rule of thumb:
// - Counter: requests, errors, bytes sent (always increases)
// - Gauge: temperature, queue size, connections (can go up/down)
// - Histogram: latencies, request sizes (distributions)
```

**Key Insight**: Counter resets are expected and handled by `rate()`. Gauge resets look like real drops.

### Pitfall 3: Missing Units in Metric Names

**Real Incident Report**: A metric named `request_duration` stored values in milliseconds. A new engineer assumed it was seconds and wrote an alert for `request_duration > 5`. The alert fired constantly because 5ms is far below normal latency. An outage went unnoticed because of alert fatigue.

**The Anti-Pattern**:
```go
// WRONG: No units in name
var requestDuration = prometheus.NewHistogram(
    prometheus.HistogramOpts{
        Name:    "request_duration",  // Seconds? Milliseconds?
        Buckets: []float64{0.01, 0.05, 0.1},
    },
)
```

**The Better Approach**:
```go
// RIGHT: Units in metric name
var requestDuration = prometheus.NewHistogram(
    prometheus.HistogramOpts{
        Name:    "request_duration_seconds",  // Clear!
        Help:    "Request duration in seconds.",
        Buckets: prometheus.DefBuckets, // 0.005 to 10 seconds
    },
)

// Convention:
// _seconds for time durations
// _bytes for sizes
// _total for counters
// _ratio for percentages (0-1)
```

**Key Insight**: Prometheus convention is to use base units (seconds, bytes) and include the unit in the metric name.

### Pitfall 4: Histogram Buckets Misaligned with SLOs

**Real Incident Report**: A team needed to measure p99 latency for their 500ms SLO. Their histogram had buckets at 0.1, 1, 10 seconds. With no bucket near 500ms, the p99 estimate was wildly inaccurate, showing either 0.1s or 1s but never the actual values around 500ms.

**The Anti-Pattern**:
```go
// WRONG: Buckets don't match SLOs
var requestDuration = prometheus.NewHistogram(
    prometheus.HistogramOpts{
        Name:    "request_duration_seconds",
        Buckets: []float64{0.1, 1, 10},  // No bucket near 500ms SLO!
    },
)
// SLO is 500ms but we can't measure it accurately
```

**The Better Approach**:
```go
// RIGHT: Buckets aligned with SLOs
var requestDuration = prometheus.NewHistogram(
    prometheus.HistogramOpts{
        Name: "request_duration_seconds",
        Buckets: []float64{
            0.1,   // 100ms - fast
            0.25,  // 250ms - good
            0.5,   // 500ms - SLO boundary
            0.75,  // 750ms - above SLO
            1.0,   // 1s - slow
            2.5,   // 2.5s - very slow
            5.0,   // 5s - timeout zone
        },
    },
)
// Can accurately measure SLO compliance
```

**Key Insight**: Put histogram buckets at your SLO boundaries. If your SLO is 500ms, you need a bucket at 0.5.

### Pitfall 5: Alerting on Instantaneous Values

**Real Incident Report**: An alert fired: `error_rate > 0.01`. It triggered for a single errored request among thousands of successes, a momentary spike from one request. The on-call engineer was paged at 3 AM for a non-issue. They disabled the alert, and a real outage went unnoticed.

**The Anti-Pattern**:
```yaml
# WRONG: Alerting on instantaneous rate
- alert: HighErrorRate
  expr: rate(http_requests_total{status="500"}[1m]) > 0
  # Fires for a single error
```

**The Better Approach**:
```yaml
# RIGHT: Alert on sustained issues with error budget burn
- alert: HighErrorRate
  expr: |
    (
      sum(rate(http_requests_total{status=~"5.."}[5m])) /
      sum(rate(http_requests_total[5m]))
    ) > 0.01
  for: 5m
  labels:
    severity: warning

# BETTER: Multi-window burn rate (Google SRE approach)
- alert: SLOBudgetBurn
  expr: |
    (
      sum(rate(http_requests_total{status=~"5.."}[1h])) /
      sum(rate(http_requests_total[1h]))
    ) > (14.4 * 0.001)  # 14.4x burn rate
    and
    (
      sum(rate(http_requests_total{status=~"5.."}[5m])) /
      sum(rate(http_requests_total[5m]))
    ) > (14.4 * 0.001)
  for: 2m
  labels:
    severity: critical
```

**Key Insight**: Alerting on instantaneous values causes alert fatigue. Use sustained conditions with `for` duration and burn rates.

### Quick Reference: Prometheus Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| High-cardinality labels | Prometheus OOM, slow queries | Labels must have bounded, low cardinality |
| Counter vs Gauge confusion | Rate shows negatives after restart | Counter for counts, Gauge for levels |
| Missing units | Wrong assumptions, bad alerts | Include units in metric name (_seconds) |
| Wrong bucket boundaries | Can't measure SLO accurately | Align buckets with SLO thresholds |
| Instantaneous alerts | 3 AM pages for single errors | Use `for` duration, burn rates |
| No `rate()` for counters | Values jump after restart | Always use rate() or increase() |

### Junior → FAANG: Diagnosing Pitfalls from Symptoms

Each pitfall in this table manifests as a specific symptom. Learning to diagnose from symptom to cause is an interview skill:

**"Rate shows negatives after process restart."** Cause: using `delta()` or subtraction on a counter instead of `rate()`. Counters reset to zero on restart. `rate()` handles resets by detecting when the new value is lower than the previous value and adjusting accordingly. `delta()` does not.

**"Alert fires once and immediately resolves."** Cause: missing `for` clause in the alert rule. A single scrape where the condition is true triggers the alert. Add `for: 5m` to require the condition to be continuously true before firing.

**"histogram_quantile() returns NaN."** Cause: aggregating away the `le` label before calling `histogram_quantile()`. The `le` label is required to reconstruct the distribution. Always aggregate `by(le, ...)`.

### Senior @ FAANG: Pitfall Prevention Through Platform Standards and Static Analysis

**Metric naming linting.** Implement a custom PromQL linter (using the `prometheus/prometheus` Go packages) that validates metric names against the platform naming standard, checks that histogram metrics end in `_seconds` or `_bytes`, and flags counter metrics that do not end in `_total`. This linter runs in CI and prevents naming mistakes before they reach production.

**Alert rule testing.** The `promtool test rules` command allows writing unit tests for alert rules using YAML fixtures. Every alert rule must have a corresponding test that verifies it fires under the expected condition and does not fire otherwise. Alert tests are part of the repository's CI pipeline. This prevents regressions where a PromQL query change silently breaks an existing alert.

**Cardinality budget enforcement.** The platform's Prometheus installation sets per-target limits in the scrape configuration: `sample_limit` caps the number of series a single scrape may return, and `label_limit` and `label_value_length_limit` bound label abuse. When a target exceeds its `sample_limit`, Prometheus fails that scrape entirely (the target shows `up == 0` with a scrape error), which triggers an alert to the platform team, who then work with the service team to reduce the label cardinality. This automated backstop prevents any single service from affecting Prometheus availability for the entire organization.

---
