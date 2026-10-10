## 50.5 Saga Monitoring and Observability

### Saga Metrics

Saga-specific metrics track dimensions that standard HTTP or gRPC instrumentation misses: how many sagas are in flight, how often compensations fire, which steps trigger retries, and how long the full saga takes from start to terminal state. The `SagaMetrics` struct below registers Prometheus counters, gauges, and histograms for these dimensions. Each method corresponds to a lifecycle event that the orchestrator calls at the appropriate point. `SagaStarted` fires when a new saga begins, `StepCompleted` after each step resolves, and `CompensationExecuted` when a rollback fires.

```go
// pkg/saga/metrics.go
package saga

import (
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// SagaMetrics provides Prometheus metrics for saga execution
type SagaMetrics struct {
	sagaTotal       *prometheus.CounterVec
	sagaInProgress  *prometheus.GaugeVec
	sagaDuration    *prometheus.HistogramVec
	stepDuration    *prometheus.HistogramVec
	compensationTotal *prometheus.CounterVec
	stepRetries     *prometheus.CounterVec
}

// NewSagaMetrics creates saga metrics
func NewSagaMetrics() *SagaMetrics {
	return &SagaMetrics{
		sagaTotal: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_total",
				Help: "Total number of sagas",
			},
			[]string{"saga_name", "status"},
		),
		sagaInProgress: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "saga_in_progress",
				Help: "Number of sagas currently in progress",
			},
			[]string{"saga_name"},
		),
		sagaDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "saga_duration_seconds",
				Help:    "Duration of saga execution",
				Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60, 120},
			},
			[]string{"saga_name", "status"},
		),
		stepDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "saga_step_duration_seconds",
				Help:    "Duration of saga step execution",
				Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10},
			},
			[]string{"saga_name", "step_name", "status"},
		),
		compensationTotal: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_compensation_total",
				Help: "Total number of saga compensations",
			},
			[]string{"saga_name", "step_name"},
		),
		stepRetries: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_step_retries_total",
				Help: "Total number of step retries",
			},
			[]string{"saga_name", "step_name"},
		),
	}
}

// SagaStarted records saga start
func (m *SagaMetrics) SagaStarted(sagaName string) {
	m.sagaInProgress.WithLabelValues(sagaName).Inc()
}

// SagaCompleted records saga completion
func (m *SagaMetrics) SagaCompleted(sagaName, status string, duration time.Duration) {
	m.sagaTotal.WithLabelValues(sagaName, status).Inc()
	m.sagaInProgress.WithLabelValues(sagaName).Dec()
	m.sagaDuration.WithLabelValues(sagaName, status).Observe(duration.Seconds())
}

// StepCompleted records step completion
func (m *SagaMetrics) StepCompleted(sagaName, stepName, status string, duration time.Duration) {
	m.stepDuration.WithLabelValues(sagaName, stepName, status).Observe(duration.Seconds())
}

// CompensationExecuted records compensation
func (m *SagaMetrics) CompensationExecuted(sagaName, stepName string) {
	m.compensationTotal.WithLabelValues(sagaName, stepName).Inc()
}

// StepRetried records step retry
func (m *SagaMetrics) StepRetried(sagaName, stepName string) {
	m.stepRetries.WithLabelValues(sagaName, stepName).Inc()
}
```

### Saga Dashboard Queries

The Prometheus alerting rules here expose four critical saga health signals: high failure rate, long saga duration, pending sagas that have not progressed (indicating a stuck saga), and compensation failures that require manual resolution. These four rules map to different failure modes. A spike in `saga_failures_total` suggests a bad deployment, while growing `saga_pending` with no corresponding completion typically indicates a consumer is down or a message is stuck. Pairing these alerts with a Grafana dashboard showing saga state transitions per second gives operators the visibility needed to distinguish transient retries from genuine processing failures.

```yaml
# prometheus_rules.yml
groups:
  - name: saga_alerts
    rules:
      # Alert on high saga failure rate
      - alert: HighSagaFailureRate
        expr: |
          sum(rate(saga_total{status="failed"}[5m])) by (saga_name)
          /
          sum(rate(saga_total[5m])) by (saga_name)
          > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High saga failure rate for {{ $labels.saga_name }}"
          description: "Saga {{ $labels.saga_name }} has >10% failure rate"

      # Alert on stuck sagas
      - alert: StuckSagas
        expr: |
          saga_in_progress > 0
          and
          time() - saga_in_progress_started_timestamp > 300
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Stuck sagas detected"

      # Alert on high compensation rate
      - alert: HighCompensationRate
        expr: |
          sum(rate(saga_compensation_total[5m])) by (saga_name)
          > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High compensation rate for {{ $labels.saga_name }}"
```

### Junior -> FAANG: Building the Observability Habit from Day One

Saga observability is not something you add after the feature works. It is something you design before writing the first handler, because the metrics you need at debug time are almost never the metrics you thought to add after the fact.

The minimum viable saga instrumentation for a first-year engineer: every saga execution increments a counter labeled with saga name and terminal status (completed, compensated, failed). Every step execution observes a duration histogram labeled with saga name, step name, and success/failure. Every compensation increments a counter labeled with saga name and step name. These four series answer the four questions you will be asked in every incident review: how many sagas ran, how many failed, which step failed most often, and how frequently is compensation firing.

A common mistake is using a gauge for `sagas_completed_total`. Gauges represent the current value of something, like memory usage. Counters represent a monotonically increasing total that you compute rates from. Use `prometheus.Counter` or `prometheus.CounterVec` for any metric that counts discrete events. The Prometheus client library will reject a gauge where a counter is semantically correct.

The `SagaMetrics.StepRetried` method in the code above records a retry counter, but it does not record which retry attempt caused the step to eventually succeed or fail. Add an `attempt` label to the retry counter: `m.stepRetries.WithLabelValues(sagaName, stepName, strconv.Itoa(attempt)).Inc()`. This shows whether your retry policy is working (most successes on attempt 1 or 2) or whether you are using retries to paper over a persistent downstream problem (many successes on attempt 3, which means you are near your retry limit).

### Senior @ FAANG: Saga Observability as a Platform Contract

At FAANG scale, saga observability is not optional and not ad hoc. It is a contract between the saga author and the platform, enforced by code review and sometimes by automated checks in CI.

**Required metric cardinality policy.** High-cardinality labels on Prometheus metrics are a serious operational problem. If `step_name` takes on 50 possible values across all sagas, and `saga_name` takes on 30 possible values, the step duration histogram has 50 x 30 x 2 x (number of buckets) time series. At 20 histogram buckets, that is 60,000 series for one metric. Prometheus scrape memory is proportional to the number of active time series. Enforce a cardinality budget per metric in the platform's observability contract: step names must come from a closed enum, saga names must be registered in a central registry, and dynamic values (like customer IDs or order IDs) are never labels.

**Saga-level distributed trace correlation.** The `ObservableSaga` wrapper in the interview questions section starts an OpenTelemetry span for the saga and child spans for each step. The key requirement at FAANG scale is that the saga trace ID is propagated into every downstream service call made by the saga's activities. This means the gRPC metadata or HTTP header carrying the trace ID must be populated from the activity context, not from a new root span. Temporal propagates the workflow trace context to activities through the workflow context, but only if you configure a custom header propagator that reads the trace context from the Temporal workflow header and injects it into the OpenTelemetry context.

**Stuck-saga alerting without noise.** The `StuckSagas` alert in the Prometheus rules above is dangerously naive. It fires if any saga has been in progress for more than 5 minutes. A subscription renewal saga that legitimately waits 30 days for the renewal date would fire this alert every 5 minutes for 30 days. The correct implementation maintains a per-saga-type SLO in the monitoring configuration and compares saga age against the type-specific SLO. Sagas running within their SLO window are not alerted on, regardless of absolute age.

**The canonical saga operations dashboard.** Staff engineers who own saga infrastructure converge on the same set of panels after enough incidents: in-flight sagas by type and status (the gauge of current state), saga completion rate by terminal status over the last hour (the health signal), step duration p95 and p99 per saga type (the performance signal), compensation rate per step per saga type (the correctness signal), and the N oldest in-flight sagas with their current step and elapsed time (the triage signal). The last panel is often the most valuable in an active incident because it tells the on-call engineer which specific sagas are stuck and at what step, without requiring a manual database query.

**Alerting escalation policy for compensation failures.** A single compensation failure at 2am should not page the primary on-call immediately. The escalation policy for saga compensation failures typically has three tiers: first tier is a Slack message to the team channel after any compensation failure, second tier is a PagerDuty page to the primary on-call after 5 compensation failures for the same step within 10 minutes (indicating a systemic problem, not noise), third tier is an escalation to the secondary on-call and platform team after 50 compensation failures within 10 minutes (indicating a downstream outage affecting the compensation path). Encode this escalation logic in your alerting system, not in the application code.

---
