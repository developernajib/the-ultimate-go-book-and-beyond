## 105.2 Defining SLIs and SLOs

### Common SLI Categories

SLI (Service Level Indicator) selection determines what is measured to evaluate service health, and the choice of indicators directly constrains what SLOs can be defined and enforced. The following categories represent the standard SLI types, latency, availability, error rate, and saturation, with Go implementation examples for each.

```go
package slo

import (
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// SLI Types for a typical Go service
var (
    // Availability SLI: Ratio of successful requests
    requestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "sli_requests_total",
            Help: "Total requests for availability SLI",
        },
        []string{"status_class"}, // 2xx, 4xx, 5xx
    )

    // Latency SLI: Request duration
    requestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name: "sli_request_duration_seconds",
            Help: "Request duration for latency SLI",
            // Buckets aligned with SLO targets
            Buckets: []float64{0.05, 0.1, 0.2, 0.5, 1.0, 2.0},
        },
        []string{"endpoint"},
    )

    // Throughput SLI: Successful operations per second
    operationsProcessed = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "sli_operations_processed_total",
            Help: "Total successful operations",
        },
    )

    // Freshness SLI: Data staleness
    dataAge = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "sli_data_age_seconds",
            Help: "Age of data in seconds",
        },
    )
)

// SLO Definitions
type SLO struct {
    Name        string
    Target      float64
    Window      time.Duration
    Description string
}

var ServiceSLOs = []SLO{
    {
        Name:        "availability",
        Target:      0.999, // 99.9%
        Window:      30 * 24 * time.Hour,
        Description: "99.9% of requests succeed (non-5xx)",
    },
    {
        Name:        "latency_p50",
        Target:      0.50, // 50% of requests
        Window:      30 * 24 * time.Hour,
        Description: "P50 latency < 100ms",
    },
    {
        Name:        "latency_p99",
        Target:      0.99, // 99% of requests
        Window:      30 * 24 * time.Hour,
        Description: "P99 latency < 500ms",
    },
}

// RecordRequest records metrics for SLI calculation
func RecordRequest(statusCode int, duration time.Duration, endpoint string) {
    statusClass := "2xx"
    if statusCode >= 400 && statusCode < 500 {
        statusClass = "4xx"
    } else if statusCode >= 500 {
        statusClass = "5xx"
    }

    requestsTotal.WithLabelValues(statusClass).Inc()
    requestDuration.WithLabelValues(endpoint).Observe(duration.Seconds())

    if statusCode < 400 {
        operationsProcessed.Inc()
    }
}
```

### PromQL for SLO Monitoring

Service Level Objectives define reliability targets that balance user expectations with engineering effort, forming the contractual basis for on-call decisions. The following example implements the measurement and alerting logic needed to track SLO compliance in real time.

```promql
# Availability SLO (99.9%)
# Current availability over 30 days
1 - (
  sum(increase(sli_requests_total{status_class="5xx"}[30d])) /
  sum(increase(sli_requests_total[30d]))
)

# Error budget remaining (in minutes)
# Total budget for 30 days at 99.9% = 43.2 minutes
(0.001 - (
  sum(increase(sli_requests_total{status_class="5xx"}[30d])) /
  sum(increase(sli_requests_total[30d]))
)) * 30 * 24 * 60

# Latency SLO (99% of requests < 200ms)
sum(rate(sli_request_duration_seconds_bucket{le="0.2"}[5m])) /
sum(rate(sli_request_duration_seconds_count[5m]))

# Error budget burn rate (should be ~1 for sustainable pace)
(
  sum(rate(sli_requests_total{status_class="5xx"}[1h])) /
  sum(rate(sli_requests_total[1h]))
) / 0.001  # 0.001 = 1 - 0.999 (error budget)

# Multi-window burn rate alert
# Fast burn (14.4x rate consumes 2% of the 30-day budget in 1 hour)
sum(rate(sli_requests_total{status_class="5xx"}[1h])) /
sum(rate(sli_requests_total[1h])) > 14.4 * 0.001

# Slow burn (6x rate consumes 5% of the 30-day budget in 6 hours)
sum(rate(sli_requests_total{status_class="5xx"}[6h])) /
sum(rate(sli_requests_total[6h])) > 6 * 0.001
```

### Junior → FAANG: SLI Definition Precision Is Testable

An imprecise SLI definition leads to implementation disputes. "Availability" is not an SLI. "The proportion of HTTP requests to the /checkout endpoint that return a 2xx response, measured over a rolling 30-day window, excluding requests that fail due to client error (4xx)" is an SLI. The precision matters because it determines which Prometheus metric label values count as good requests and which count as bad.

Common interview follow-up: "What request failures would you exclude from your availability SLI?" Correct exclusions: 429 (client rate-limited, not service failure), 400 (client sent invalid data, not service failure). Incorrect exclusions: 500 (service error), 503 (service unavailable). Justifying these decisions during an interview shows operational judgment, not just PromQL knowledge.

### Senior @ FAANG: SLI Design for Complex User Journeys

A single HTTP endpoint SLI does not capture user-perceived reliability for multi-step workflows. A checkout flow that requires five sequential API calls is "available" from an endpoint perspective if each call returns 200, but a user who times out waiting for the entire flow to complete has a bad experience that no individual endpoint SLI captures.

An L6 engineer designs journey-level SLIs using synthetic monitoring: a canary service periodically executes the full user journey and records success/failure as a custom metric. This journey SLI is the primary reliability signal for the product, while individual endpoint SLIs serve as diagnostic signals that help identify which step in the journey is failing. This two-level SLI architecture is a staff-level observability design pattern.

---
