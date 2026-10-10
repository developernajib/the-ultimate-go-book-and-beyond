## 104.14 Exercises with Solutions

### Exercise 1: Complete Metrics Implementation

**Task**: Implement metrics for an order processing service with:
- Request rate and latency
- Order value distribution in cents
- Processing queue size
- Payment method breakdown

**Solution**:

```go
package metrics

import (
    "net/http"
    "strconv"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    // HTTP metrics
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "order_service",
            Name:      "http_requests_total",
            Help:      "Total HTTP requests",
        },
        []string{"method", "endpoint", "status"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "order_service",
            Name:      "http_request_duration_seconds",
            Help:      "HTTP request duration",
            Buckets:   []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
        },
        []string{"method", "endpoint"},
    )

    // Business metrics
    ordersTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Namespace: "order_service",
            Name:      "orders_total",
            Help:      "Total orders by status",
        },
        []string{"status", "payment_method", "region"},
    )

    orderValue = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "order_service",
            Name:      "order_value_cents",
            Help:      "Order value distribution in cents",
            Buckets:   []float64{1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000},
        },
        []string{"payment_method"},
    )

    orderProcessingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "order_service",
            Name:      "order_processing_duration_seconds",
            Help:      "Time to process an order",
            Buckets:   prometheus.DefBuckets,
        },
        []string{"status"},
    )

    // Queue metrics (saturation)
    orderQueueSize = promauto.NewGauge(
        prometheus.GaugeOpts{
            Namespace: "order_service",
            Name:      "order_queue_size",
            Help:      "Current order processing queue size",
        },
    )

    orderQueueLatency = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Namespace: "order_service",
            Name:      "order_queue_wait_seconds",
            Help:      "Time spent waiting in queue",
            Buckets:   []float64{0.1, 0.5, 1, 5, 10, 30, 60},
        },
        []string{"priority"},
    )
)

// Order represents an order
type Order struct {
    ID            string
    ValueCents    int64
    PaymentMethod string
    Region        string
    Priority      string
}

// OrderMetrics provides methods to record order metrics
type OrderMetrics struct{}

// RecordOrderCreated records a new order
func (m *OrderMetrics) RecordOrderCreated(order Order, duration time.Duration) {
    ordersTotal.WithLabelValues("created", order.PaymentMethod, order.Region).Inc()
    orderValue.WithLabelValues(order.PaymentMethod).Observe(float64(order.ValueCents))
    orderProcessingDuration.WithLabelValues("created").Observe(duration.Seconds())
}

// RecordOrderCompleted records order completion
func (m *OrderMetrics) RecordOrderCompleted(order Order, duration time.Duration) {
    ordersTotal.WithLabelValues("completed", order.PaymentMethod, order.Region).Inc()
    orderProcessingDuration.WithLabelValues("completed").Observe(duration.Seconds())
}

// RecordOrderFailed records order failure
func (m *OrderMetrics) RecordOrderFailed(order Order, reason string) {
    ordersTotal.WithLabelValues("failed", order.PaymentMethod, order.Region).Inc()
}

// UpdateQueueSize updates the current queue size
func (m *OrderMetrics) UpdateQueueSize(size int) {
    orderQueueSize.Set(float64(size))
}

// RecordQueueWait records time spent in queue
func (m *OrderMetrics) RecordQueueWait(priority string, duration time.Duration) {
    orderQueueLatency.WithLabelValues(priority).Observe(duration.Seconds())
}

// HTTPMiddleware wraps HTTP handlers with metrics
func HTTPMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        wrapped := &statusResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        next.ServeHTTP(wrapped, r)

        duration := time.Since(start).Seconds()
        // Numeric status codes so alert queries can match status=~"5.."
        status := strconv.Itoa(wrapped.statusCode)

        httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, status).Inc()
        httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
    })
}

type statusResponseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (w *statusResponseWriter) WriteHeader(code int) {
    w.statusCode = code
    w.ResponseWriter.WriteHeader(code)
}

// Handler returns the metrics HTTP handler
func Handler() http.Handler {
    return promhttp.Handler()
}
```

---

### Exercise 2: Write Alerting Rules

**Task**: Create Prometheus alerting rules for:
- High error rate (>1% for 5 minutes)
- P99 latency above SLO (500ms)
- Order queue backing up
- Error budget consumption

**Solution**:

```yaml
# prometheus/rules/order_service_alerts.yaml
groups:
  - name: order-service-alerts
    interval: 30s
    rules:
      # High Error Rate
      - alert: OrderServiceHighErrorRate
        expr: |
          sum(rate(order_service_http_requests_total{status=~"5.."}[5m])) /
          sum(rate(order_service_http_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
          service: order-service
        annotations:
          summary: "High error rate in order service"
          description: "Error rate is {{ $value | humanizePercentage }}"
          runbook_url: "https://wiki/runbooks/order-service/high-error-rate"

      # P99 Latency Above SLO
      - alert: OrderServiceHighLatency
        expr: |
          histogram_quantile(0.99, sum by (le) (
            rate(order_service_http_request_duration_seconds_bucket[5m])
          )) > 0.5
        for: 5m
        labels:
          severity: warning
          service: order-service
        annotations:
          summary: "P99 latency exceeds 500ms SLO"
          description: "P99 latency is {{ $value | humanizeDuration }}"
          runbook_url: "https://wiki/runbooks/order-service/high-latency"

      # Order Queue Backing Up
      - alert: OrderQueueBacklog
        expr: order_service_order_queue_size > 100
        for: 10m
        labels:
          severity: warning
          service: order-service
        annotations:
          summary: "Order processing queue is backing up"
          description: "Queue size is {{ $value }} orders"
          runbook_url: "https://wiki/runbooks/order-service/queue-backlog"

      # Queue Wait Time Too High
      - alert: OrderQueueWaitTimeHigh
        expr: |
          histogram_quantile(0.95, sum by (le) (
            rate(order_service_order_queue_wait_seconds_bucket[5m])
          )) > 30
        for: 5m
        labels:
          severity: warning
          service: order-service
        annotations:
          summary: "Orders waiting too long in queue"
          description: "P95 queue wait time is {{ $value | humanizeDuration }}"

  - name: order-service-slo
    interval: 1m
    rules:
      # Record SLI: Availability
      - record: order_service:sli:availability:5m
        expr: |
          1 - (
            sum(rate(order_service_http_requests_total{status=~"5.."}[5m])) /
            sum(rate(order_service_http_requests_total[5m]))
          )

      # Record SLI: Latency
      - record: order_service:sli:latency_under_500ms:5m
        expr: |
          sum(rate(order_service_http_request_duration_seconds_bucket{le="0.5"}[5m])) /
          sum(rate(order_service_http_request_duration_seconds_count[5m]))

      # Error Budget Burn Rate (monthly)
      - record: order_service:error_budget:burn_rate:1h
        expr: |
          (
            sum(increase(order_service_http_requests_total{status=~"5.."}[1h])) /
            sum(increase(order_service_http_requests_total[1h]))
          ) / 0.001  # 99.9% SLO = 0.001 error budget

      # Fast Error Budget Burn Alert
      - alert: OrderServiceErrorBudgetBurnFast
        expr: |
          order_service:error_budget:burn_rate:1h > 14.4
          and
          (
            sum(rate(order_service_http_requests_total{status=~"5.."}[5m])) /
            sum(rate(order_service_http_requests_total[5m]))
          ) / 0.001 > 14.4
        for: 2m
        labels:
          severity: critical
          service: order-service
          slo: error-budget
        annotations:
          summary: "Error budget burning fast, monthly budget gone in about 2 days at this rate"
          description: "Burn rate is {{ $value }}x normal"
          runbook_url: "https://wiki/runbooks/order-service/error-budget-burn"

      # Slow Error Budget Burn Alert
      - alert: OrderServiceErrorBudgetBurnSlow
        expr: |
          order_service:error_budget:burn_rate:1h > 3
          and
          (
            sum(rate(order_service_http_requests_total{status=~"5.."}[30m])) /
            sum(rate(order_service_http_requests_total[30m]))
          ) / 0.001 > 3
        for: 15m
        labels:
          severity: warning
          service: order-service
          slo: error-budget
        annotations:
          summary: "Error budget burning - will exhaust before month end"
          description: "Burn rate is {{ $value }}x normal"
```

---

### Exercise 3: PromQL Query Challenge

**Task**: Write PromQL queries for:
1. Top 5 endpoints by error rate
2. Services with degraded availability (below 99.9%)
3. Week-over-week traffic comparison
4. Apdex score calculation (target 200ms, tolerable 1s)

**Solution**:

```promql
# 1. Top 5 endpoints by error rate
topk(5,
  sum by (endpoint) (rate(http_requests_total{status=~"5.."}[5m])) /
  sum by (endpoint) (rate(http_requests_total[5m]))
)

# 2. Services with degraded availability (below 99.9%)
(
  1 - (
    sum by (service) (rate(http_requests_total{status=~"5.."}[1h])) /
    sum by (service) (rate(http_requests_total[1h]))
  )
) < 0.999

# 3. Week-over-week traffic comparison
# Current week request rate
sum(rate(http_requests_total[5m]))
/
# Same time last week
sum(rate(http_requests_total[5m] offset 1w))

# As percentage change
(
  sum(rate(http_requests_total[5m])) -
  sum(rate(http_requests_total[5m] offset 1w))
) / sum(rate(http_requests_total[5m] offset 1w)) * 100

# By service
(
  sum by (service) (rate(http_requests_total[5m])) -
  sum by (service) (rate(http_requests_total[5m] offset 1w))
) / sum by (service) (rate(http_requests_total[5m] offset 1w)) * 100

# 4. Apdex score (target 200ms, tolerable 1s)
# Apdex = (Satisfied + Tolerable/2) / Total
# The le values must match configured bucket boundaries (0.2 and 1 here)
(
  # Satisfied: under 200ms
  sum(rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  +
  # Tolerable: between 200ms and 1s (half-counted)
  (
    sum(rate(http_request_duration_seconds_bucket{le="1"}[5m])) -
    sum(rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  ) / 2
) / sum(rate(http_request_duration_seconds_count[5m]))

# Apdex by endpoint
(
  sum by (endpoint) (rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  +
  (
    sum by (endpoint) (rate(http_request_duration_seconds_bucket{le="1"}[5m])) -
    sum by (endpoint) (rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  ) / 2
) / sum by (endpoint) (rate(http_request_duration_seconds_count[5m]))

# Bonus: Services with poor Apdex (< 0.85)
(
  sum by (service) (rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  +
  (
    sum by (service) (rate(http_request_duration_seconds_bucket{le="1"}[5m])) -
    sum by (service) (rate(http_request_duration_seconds_bucket{le="0.2"}[5m]))
  ) / 2
) / sum by (service) (rate(http_request_duration_seconds_count[5m])) < 0.85
```

### Junior → FAANG: Using Exercises to Build Production Intuition

The chapter's exercises, these worked solutions plus the six-exercise list at the end of the chapter, progress from basic instrumentation to incident response simulation. Do them in order and do them in a running environment, not just by writing code. The cardinality explosion in exercise 1 is something every engineer should see once in a controlled environment before seeing it in production.

Exercise 6 (simulating an error budget burn) is the most valuable. Running through the full cycle, from alert fires to Alertmanager silence to burn rate recovery, builds the muscle memory needed to respond calmly during a real incident. Do this exercise at least twice: once with 5% error rate and once with 50%, to understand how different burn rates change the time-to-budget-exhaustion calculation.

### Senior @ FAANG: Exercises as Platform Validation and Onboarding

At L6, these exercises form the basis of a platform integration test suite that runs in CI against a real Prometheus and Grafana instance. Exercise 2 (alerting rules with `promtool check rules`) becomes an automated test gate: every PR that modifies alerting rules must pass `promtool test rules` with a corresponding test file. Exercise 3 (recording rules with performance measurement) becomes a benchmark that validates recording rule query time against the raw expression to ensure the recording rule provides the expected speedup.

Exercise 4 (SLO compliance dashboard as JSON in version control) becomes the organization's dashboard governance standard: every production service must have its SLO dashboard committed to the repository and deployed via Grafana provisioning before the service goes to production. This gates service promotion to production on observability readiness, not as a checkbox, but as a verified automated deployment.

---


---

### Additional Practice Scenarios


1. **Define Custom Metrics with Controlled Cardinality**: Add three custom Prometheus metrics to a Go HTTP service: a `Counter` for total requests labeled by `method`, `route`, and `status_code`. A `Histogram` for request durations with buckets aligned to your SLO thresholds (e.g., 50ms, 100ms, 200ms, 500ms, 1s). And a `Gauge` for current active connections. Deliberately introduce a high-cardinality label (e.g., raw URL path with query strings) on a fourth metric, observe the cardinality explosion in Prometheus, then fix it by normalizing the label value. Document the cardinality limit you would enforce in production and why.

2. **Write and Validate Alerting Rules**: Author a `prometheus-rules.yml` file containing at least four alerting rules: a 5-minute error rate alert, a p99 latency alert, a multi-window burn rate alert for a 99.9% SLO (using 1h and 5m windows), and a dead man's switch alert for a scheduled batch job. For each rule include `summary`, `description`, and `runbook_url` annotations and assign a `severity` label. Start Prometheus locally with the rules file, use `promtool check rules` to validate syntax, then manually trigger each alert condition by injecting errors and verify the alert fires as expected in the Alertmanager UI.

3. **Build Recording Rules for Dashboard Performance**: Identify three expensive PromQL queries you use frequently (e.g., `histogram_quantile` over a high-traffic metric, multi-service error rate aggregations). Convert each into a recording rule following the `namespace:metric:aggregation` naming convention and measure query time before and after using Prometheus query stats. Confirm the recording rules produce values identical to the original expressions by running both in parallel and computing the difference. Explain in comments why recording rules reduce Grafana dashboard load time and Prometheus memory pressure.

4. **Build an SLO Compliance Dashboard in Grafana**: Create a Grafana dashboard with at least five panels: current error rate vs. SLO threshold (stat panel with color thresholds), error budget remaining as a percentage of the 30-day window (gauge panel), p50/p95/p99 latency over time (time series), multi-window burn rate for fast and slow burn (time series with alert threshold lines), and a table showing per-endpoint error rate sorted descending. Use a Grafana variable for `service` selection so the dashboard works across multiple services. Export the dashboard as JSON and commit it to version control.

5. **Implement Histogram Bucket Alignment to SLOs**: Your service has an SLO of "99% of requests complete in under 300ms". Inspect the default Prometheus histogram buckets and identify why they fail to give an accurate 99th percentile measurement at the 300ms boundary. Reconfigure the histogram with custom buckets that include 300ms as an explicit boundary. Write a PromQL expression using `histogram_quantile` to compute the exact SLO compliance ratio and verify it matches a direct count-based calculation. Explain the trade-off between bucket granularity and time-series cardinality.

6. **Simulate and Respond to an Error Budget Burn**: Configure a test service to produce a controlled error rate of 5% (burning the 99.9% error budget at ~50× the normal rate). Observe the multi-window burn rate alert fire in Alertmanager within the expected timeframe. Silence the alert via the Alertmanager API (not the UI), reduce the error rate to 0.05%, and watch the burn rate recover. Calculate manually how many minutes of error budget were consumed during the incident and verify your calculation matches what the Prometheus recording rule reports. Write a one-paragraph incident summary explaining what the numbers mean for the monthly budget.

### Junior → FAANG: How to Get the Most from These Exercises

The exercises are ordered from foundational to advanced. Exercises 1 and 2 test basic mechanics (metric registration, alerting rules). Exercises 3 and 4 test operational thinking (performance optimization, dashboard design). Exercises 5 and 6 test SLO literacy and incident response.

For interview preparation, focus on exercises 5 and 6: they simulate the scenarios most commonly used in SRE system design interviews. If you can walk through exercise 6 (simulate a burn, observe the alert, silence it, watch recovery) and explain each step's significance, you demonstrate operational maturity that separates you from candidates who have only read about SRE.

### Senior @ FAANG: Exercises as a New-Service Onboarding Checklist

At L6, adapt these six exercises into a "launch readiness checklist" that every new service must complete before going to production. Exercise 1 confirms instrumentation is correct. Exercise 2 confirms alerting rules are tested. Exercise 3 confirms expensive queries are pre-computed as recording rules. Exercise 4 confirms the SLO dashboard is deployed and reviewed. Exercise 5 confirms histogram buckets are aligned to SLO thresholds. Exercise 6 confirms the on-call team has run through a simulated incident in staging.

A service that has completed all six exercises has verified its own observability readiness, not just its feature correctness. This checklist is a measurable, automatable gate in the production deployment pipeline.
