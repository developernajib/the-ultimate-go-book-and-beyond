## 105B.3 Alerting Philosophy

### Alert on Symptoms, Not Causes

The most important principle in alerting: **page when users are being hurt, not when infrastructure metrics cross thresholds.**

Consider these two alert designs for the same problem:

**Bad alert (cause-based):**
```yaml
alert: HighCPUUsage
expr: rate(process_cpu_seconds_total[5m]) > 0.8
for: 5m
annotations:
  summary: "CPU usage above 80%"
```

**Good alert (symptom-based):**
```yaml
alert: HighErrorRate
expr: |
  sum(rate(http_requests_total{status=~"5.."}[5m]))
  /
  sum(rate(http_requests_total[5m])) > 0.01
for: 2m
annotations:
  summary: "Error rate above 1% for 2 minutes"
  runbook: "https://wiki/runbook/high-error-rate"
```

The CPU alert will fire constantly for benign reasons (batch jobs, GC pressure, startup). The error rate alert fires only when users are receiving errors.

A CPU spike that does not produce errors is not an incident. It is just a CPU spike.

### SLO-Based Alerting vs Threshold Alerting

Threshold alerting ("CPU > 80%", "latency > 500ms") has fundamental problems:

1. The threshold is arbitrary and not tied to user experience
2. Thresholds require constant manual tuning as traffic patterns change
3. A threshold alert fires the same whether you are burning 0.1% of your error budget or 100% of it

SLO-based alerting solves this. You define what "good service" means (the SLO), then alert when you are consuming error budget faster than acceptable.

**SLO alert question:** "At the current burn rate, how long until the error budget is exhausted?"

If the answer is "30 minutes," page immediately. If the answer is "45 days," do not page - create a ticket.

### Alert Fatigue: The Silent Killer

Alert fatigue is when an alert fires so often that engineers stop trusting it. It is the most dangerous reliability antipattern.

**Symptoms of alert fatigue:**
- Engineers close alerts without investigating
- Engineers set alert thresholds higher to reduce noise rather than fixing root cause
- Team jokes about "that alert that always fires"
- Real incidents are missed because alert was normalized

**The cure:**
- Every alert must be actionable. If there is nothing to do, the alert should not fire.
- Every alert must have a runbook. If you cannot write a runbook, the alert is not ready.
- Alert frequency should be reviewed monthly. An alert that fires >5 times/week without incidents is a candidate for removal or revision.
- Track "false positive rate" per alert. Goal: < 5%.

### Multi-Burn-Rate Alerts (Google SRE Approach)

Multi-burn-rate alerting is the production-grade approach described in the Google SRE Workbook. The key insight: a single burn rate threshold misses two important failure modes.

**Problem with single threshold:**
- Fast burn (100x normal error rate for 5 minutes): will deplete monthly budget in ~7 hours. You want a page NOW.
- Slow burn (2x normal error rate for days): will deplete monthly budget in 15 days. You want a ticket, not a page.

**Solution: alert on multiple time windows at different burn rates.**

The Google recommended configuration for a 99.9% SLO (0.1% error budget = 43.2 min per 30 days):

| Severity | Short Window | Long Window | Burn Rate | Budget Consumed | Action |
|---|---|---|---|---|---|
| Page (critical) | 5m | 1h | 14.4x | 2% in 1h | Page immediately |
| Page (warning) | 30m | 6h | 6x | 5% in 6h | Page |
| Ticket | 2h | 24h | 3x | 10% in 24h | File ticket |
| Ticket | 6h | 72h | 1x | 10% in 3d | File ticket |

A burn rate of 14.4x means you are consuming error budget 14.4 times faster than the rate that would exhaust it in exactly one month.

```go
// Go code: Prometheus recording rules for multi-burn-rate alerting
// This would be in a PrometheusRule CRD or rules file

const multiWindowAlertRules = `
groups:
  - name: slo_burn_rate_alerts
    rules:

    # === RECORDING RULES ===
    # Error ratio over various windows
    - record: job:http_error_ratio:rate5m
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[5m])) by (job)
        /
        sum(rate(http_requests_total[5m])) by (job)

    - record: job:http_error_ratio:rate30m
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[30m])) by (job)
        /
        sum(rate(http_requests_total[30m])) by (job)

    - record: job:http_error_ratio:rate1h
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[1h])) by (job)
        /
        sum(rate(http_requests_total[1h])) by (job)

    - record: job:http_error_ratio:rate6h
      expr: |
        sum(rate(http_requests_total{status=~"5.."}[6h])) by (job)
        /
        sum(rate(http_requests_total[6h])) by (job)

    # === ALERT RULES ===
    # For 99.9% SLO (0.1% error budget)
    # Burn rate = error_ratio / (1 - SLO) = error_ratio / 0.001

    # P0: Fast burn - 2% budget in 1 hour
    # Requires BOTH short (5m) and long (1h) windows to exceed threshold
    # Avoids false positives from brief spikes
    - alert: SLOBurnRateCritical
      expr: |
        (
          job:http_error_ratio:rate5m{job="payment-service"} > (14.4 * 0.001)
          and
          job:http_error_ratio:rate1h{job="payment-service"} > (14.4 * 0.001)
        )
      for: 2m
      labels:
        severity: critical
        slo: "99.9"
      annotations:
        summary: "Critical SLO burn rate for {{ $labels.job }}"
        description: |
          Service {{ $labels.job }} error ratio is {{ $value | humanizePercentage }},
          more than 14.4x the sustainable burn rate.
          At this rate, 2% of the monthly error budget is consumed per hour
          and the budget will be exhausted within ~2 days.
        runbook: "https://wiki.internal/runbooks/slo-burn-rate-critical"

    # P1: Moderate burn - 5% budget in 6 hours
    - alert: SLOBurnRateHigh
      expr: |
        (
          job:http_error_ratio:rate30m{job="payment-service"} > (6 * 0.001)
          and
          job:http_error_ratio:rate6h{job="payment-service"} > (6 * 0.001)
        )
      for: 15m
      labels:
        severity: warning
        slo: "99.9"
      annotations:
        summary: "Elevated SLO burn rate for {{ $labels.job }}"
        description: |
          Service {{ $labels.job }} is burning error budget at 6x the sustainable rate.
          At this rate, 5% of the monthly budget is consumed every 6 hours
          and the budget will be exhausted within ~5 days.
        runbook: "https://wiki.internal/runbooks/slo-burn-rate-high"
`
```

### Writing Good Metric Exporters in Go

The quality of your alerting depends entirely on the quality of your metrics. A metric exporter that does not distinguish error types, does not label by endpoint, or uses inconsistent bucket boundaries makes good alerting impossible.

```go
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// HTTPMetrics holds all HTTP-related metrics for a service.
// Design principles:
//   - Labels must be low-cardinality (avoid user IDs, request IDs)
//   - Histograms use SLO-aligned buckets (p50, p90, p99, p999)
//   - Error codes are captured to enable error-type-based alerting
type HTTPMetrics struct {
	requestDuration *prometheus.HistogramVec
	requestTotal    *prometheus.CounterVec
	requestInFlight *prometheus.GaugeVec
}

// SLOAlignedBuckets are histogram buckets aligned to common SLO thresholds.
// These enable accurate p50/p90/p99/p999 calculation in Prometheus.
var SLOAlignedBuckets = []float64{
	0.001, 0.005, 0.010, 0.025,  // < 25ms: fast
	0.050, 0.100, 0.250,          // 50ms-250ms: normal
	0.500, 1.000, 2.500,          // 500ms-2.5s: slow
	5.000, 10.000,                 // > 5s: very slow
}

// NewHTTPMetrics creates a metrics set registered with the given registerer.
// Using a registerer (not global) enables test isolation.
func NewHTTPMetrics(reg prometheus.Registerer, serviceName string) *HTTPMetrics {
	constLabels := prometheus.Labels{"service": serviceName}

	return &HTTPMetrics{
		requestDuration: promauto.With(reg).NewHistogramVec(
			prometheus.HistogramOpts{
				Name:        "http_request_duration_seconds",
				Help:        "HTTP request duration in seconds, partitioned by method, path, and status class.",
				Buckets:     SLOAlignedBuckets,
				ConstLabels: constLabels,
			},
			[]string{"method", "path", "status_class"},
		),
		requestTotal: promauto.With(reg).NewCounterVec(
			prometheus.CounterOpts{
				Name:        "http_requests_total",
				Help:        "Total HTTP requests, partitioned by method, path, status code, and error type.",
				ConstLabels: constLabels,
			},
			// error_type: "" (success), "client" (4xx), "server" (5xx), "timeout", "canceled"
			[]string{"method", "path", "status_code", "error_type"},
		),
		requestInFlight: promauto.With(reg).NewGaugeVec(
			prometheus.GaugeOpts{
				Name:        "http_requests_in_flight",
				Help:        "Current number of HTTP requests being processed.",
				ConstLabels: constLabels,
			},
			[]string{"method", "path"},
		),
	}
}

// statusClass converts a status code to a string class for low-cardinality labeling.
// Using "5xx" instead of "503" keeps cardinality manageable for SLO calculations.
func statusClass(code int) string {
	switch {
	case code < 200:
		return "1xx"
	case code < 300:
		return "2xx"
	case code < 400:
		return "3xx"
	case code < 500:
		return "4xx"
	default:
		return "5xx"
	}
}

// errorType classifies the error type for fine-grained alerting.
// This enables alerts like "timeout errors spiking" vs "application errors spiking."
func errorType(code int) string {
	switch {
	case code == 408 || code == 504:
		return "timeout"
	case code >= 400 && code < 500:
		return "client"
	case code >= 500:
		return "server"
	default:
		return ""
	}
}

// Middleware returns an http.Handler middleware that records metrics.
func (m *HTTPMetrics) Middleware(path string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		method := r.Method

		// Track in-flight requests for capacity alerting
		m.requestInFlight.WithLabelValues(method, path).Inc()
		defer m.requestInFlight.WithLabelValues(method, path).Dec()

		// Capture response code
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rw, r)

		duration := time.Since(start).Seconds()
		code := rw.statusCode
		codeStr := strconv.Itoa(code)

		m.requestDuration.WithLabelValues(
			method, path, statusClass(code),
		).Observe(duration)

		m.requestTotal.WithLabelValues(
			method, path, codeStr, errorType(code),
		).Inc()
	})
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}
```

### Junior → FAANG: Alerting Philosophy in One Sentence

Alert when a human is required to act. Do not alert when a human would look at the notification and ignore it. This single principle, applied consistently, eliminates the majority of alert fatigue.

The implementation of this principle requires discipline: before adding any alert, ask "what would I do if this fires at 3am?" If the answer is "check Grafana and probably ignore it if everything looks fine," the alert should not exist. If the answer is "restart the service immediately, because this has never been a false positive," the alert is justified.

### Senior @ FAANG: Alerting Philosophy as a Platform Standard

At L6, alerting philosophy is enforced through platform standards, not individual discipline. An alert standard document specifies: every alert must have a runbook, every critical alert must have been validated against 30 days of historical data to confirm the false positive rate is below 5%, and no alert may use a static threshold (all thresholds must be expressed as multiples of the error budget burn rate or derived from historical baseline calculations).

These standards are enforced by automated checks in the CI pipeline for alert rule changes and by a quarterly alert audit that measures false positive rates and removes alerts that consistently fail the >50% actionability threshold. An L6 engineer who has implemented and maintained these standards has built a self-correcting alerting system rather than one that requires constant manual curation.

---
