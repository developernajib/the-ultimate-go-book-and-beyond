## 105D.2 SLO/SLI/SLA Framework

SLOs (Service Level Objectives) shift on-call alerting from reactive symptom monitoring to proactive error budget management: instead of paging when error rate exceeds 1%, you alert when the 30-day error budget is burning faster than sustainable. The `ErrorBudget` tracker below computes the remaining error budget from good and total event counts in real time, exposes burn rate and compliance as gauge metrics that Alertmanager rules can act on, and classifies the current status into OK, warning, and critical levels using the Google SRE burn-rate thresholds.

```go
package slo

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// SLO represents a Service Level Objective
type SLO struct {
	Name        string
	Description string
	SLI         SLI
	Target      float64       // e.g., 0.999 (99.9%)
	Window      time.Duration // e.g., 30 days
	Annotations map[string]string
}

// SLI represents a Service Level Indicator
type SLI struct {
	Name       string
	Type       SLIType
	GoodQuery  string // Prometheus query for "good" events
	TotalQuery string // Prometheus query for total events
}

// SLIType defines how the SLI is measured
type SLIType string

const (
	SLITypeAvailability SLIType = "availability"
	SLITypeLatency      SLIType = "latency"
	SLITypeQuality      SLIType = "quality"
	SLITypeFreshness    SLIType = "freshness"
)

// ErrorBudget tracks the error budget for an SLO
type ErrorBudget struct {
	mu          sync.RWMutex
	slo         SLO
	budget      float64 // Total error budget in events
	consumed    float64 // Consumed error budget
	remaining   float64 // Remaining percentage
	burnRate    float64 // Current burn rate multiplier
	windowStart time.Time

	// Prometheus metrics
	budgetRemainingGauge prometheus.Gauge
	burnRateGauge        prometheus.Gauge
	complianceGauge      prometheus.Gauge
}

// NewErrorBudget creates an error budget tracker
func NewErrorBudget(slo SLO, registerer prometheus.Registerer) *ErrorBudget {
	labels := prometheus.Labels{
		"slo":  slo.Name,
		"sli":  slo.SLI.Name,
	}

	eb := &ErrorBudget{
		slo:         slo,
		windowStart: time.Now(),
		budgetRemainingGauge: promauto.With(registerer).NewGauge(prometheus.GaugeOpts{
			Name:        "slo_error_budget_remaining",
			Help:        "Remaining error budget as a fraction (0.0 to 1.0)",
			ConstLabels: labels,
		}),
		burnRateGauge: promauto.With(registerer).NewGauge(prometheus.GaugeOpts{
			Name:        "slo_error_budget_burn_rate",
			Help:        "Current error budget burn rate (1.0 = consuming at target rate)",
			ConstLabels: labels,
		}),
		complianceGauge: promauto.With(registerer).NewGauge(prometheus.GaugeOpts{
			Name:        "slo_compliance",
			Help:        "SLO compliance (1.0 = meeting SLO, 0.0 = breaching)",
			ConstLabels: labels,
		}),
	}

	// Initialize remaining to 100%
	eb.remaining = 1.0
	eb.budgetRemainingGauge.Set(1.0)
	eb.complianceGauge.Set(1.0)

	return eb
}

// Update recalculates error budget from current SLI values
func (eb *ErrorBudget) Update(goodEvents, totalEvents float64) {
	eb.mu.Lock()
	defer eb.mu.Unlock()

	if totalEvents == 0 {
		return
	}

	// Current reliability
	currentReliability := goodEvents / totalEvents

	// Error budget calculation
	// Budget = (1 - SLO_target) * total_events
	budgetTotal := (1 - eb.slo.Target) * totalEvents
	badEvents := totalEvents - goodEvents
	budgetConsumed := math.Max(0, badEvents-budgetTotal)

	eb.consumed = budgetConsumed
	eb.budget = budgetTotal

	if budgetTotal > 0 {
		eb.remaining = 1 - (budgetConsumed / budgetTotal)
	}

	// Calculate burn rate
	// Burn rate = current error rate / allowed error rate
	allowedErrorRate := 1 - eb.slo.Target
	currentErrorRate := 1 - currentReliability
	if allowedErrorRate > 0 {
		eb.burnRate = currentErrorRate / allowedErrorRate
	}

	// Determine compliance
	compliance := 0.0
	if currentReliability >= eb.slo.Target {
		compliance = 1.0
	}

	// Update Prometheus metrics
	eb.budgetRemainingGauge.Set(math.Max(0, eb.remaining))
	eb.burnRateGauge.Set(eb.burnRate)
	eb.complianceGauge.Set(compliance)
}

// Status returns the current error budget status
func (eb *ErrorBudget) Status() ErrorBudgetStatus {
	eb.mu.RLock()
	defer eb.mu.RUnlock()

	var level AlertLevel
	switch {
	case eb.remaining <= 0:
		level = AlertLevelCritical
	case eb.burnRate >= 14.4: // Fast burn: exhausts a 30-day budget in ~2 days
		level = AlertLevelCritical
	case eb.burnRate >= 6: // Medium burn: exhausts a 30-day budget in 5 days
		level = AlertLevelWarning
	case eb.remaining < 0.1: // Less than 10% remaining
		level = AlertLevelWarning
	default:
		level = AlertLevelOK
	}

	return ErrorBudgetStatus{
		SLOName:   eb.slo.Name,
		Target:    eb.slo.Target,
		Remaining: eb.remaining,
		BurnRate:  eb.burnRate,
		Level:     level,
	}
}

// AlertLevel represents alert severity
type AlertLevel string

const (
	AlertLevelOK       AlertLevel = "ok"
	AlertLevelWarning  AlertLevel = "warning"
	AlertLevelCritical AlertLevel = "critical"
)

// ErrorBudgetStatus represents the current state of an error budget
type ErrorBudgetStatus struct {
	SLOName   string
	Target    float64
	Remaining float64
	BurnRate  float64
	Level     AlertLevel
}

// MultiWindowBurnRateAlert implements the Google SRE multi-window alerting approach
// Reference: The Site Reliability Workbook, Chapter 5 "Alerting on SLOs"
type MultiWindowBurnRateAlert struct {
	slo     SLO
	windows []burnRateWindow
}

type burnRateWindow struct {
	shortWindow   time.Duration
	longWindow    time.Duration
	burnRateThreshold float64
	severity      AlertLevel
}

// NewMultiWindowBurnRateAlert creates a multi-window burn rate alerter
func NewMultiWindowBurnRateAlert(slo SLO) *MultiWindowBurnRateAlert {
	// Windows from Google SRE error budget consumption approach
	// These thresholds exhaust the budget at specific times if maintained
	return &MultiWindowBurnRateAlert{
		slo: slo,
		windows: []burnRateWindow{
			{
				// Fast burn: 2% of the 30-day budget consumed in 1h,
				// exhausts the budget in ~2 days if sustained.
				// 5m short window confirms the burn is still active.
				shortWindow:       5 * time.Minute,
				longWindow:        1 * time.Hour,
				burnRateThreshold: 14.4,
				severity:          AlertLevelCritical,
			},
			{
				// Medium-fast burn: 5% of budget in 6h,
				// exhausts in 5 days if sustained
				shortWindow:       30 * time.Minute,
				longWindow:        6 * time.Hour,
				burnRateThreshold: 6,
				severity:          AlertLevelCritical,
			},
			{
				// Medium burn: exhausts the 30-day budget in 10 days
				shortWindow:       2 * time.Hour,
				longWindow:        24 * time.Hour,
				burnRateThreshold: 3,
				severity:          AlertLevelWarning,
			},
			{
				// Slow burn: consuming at exactly the budgeted rate,
				// exhausts in 30 days
				shortWindow:       6 * time.Hour,
				longWindow:        3 * 24 * time.Hour,
				burnRateThreshold: 1,
				severity:          AlertLevelWarning,
			},
		},
	}
}

// GeneratePrometheusRules generates Prometheus alert rules for this SLO
func (a *MultiWindowBurnRateAlert) GeneratePrometheusRules() string {
	rules := fmt.Sprintf(`
groups:
  - name: slo-%s
    rules:`, a.slo.Name)

	for i, window := range a.windows {
		rules += fmt.Sprintf(`
      - alert: %sErrorBudgetBurn%d
        expr: |
          (
            job:slo_errors_per_request:ratio_rate%s > (%.1f * %.6f)
          ) and (
            job:slo_errors_per_request:ratio_rate%s > (%.1f * %.6f)
          )
        for: %s
        labels:
          severity: %s
          slo: %s
        annotations:
          summary: "High error budget burn rate for %s"
          description: "Error budget burn rate is {{ $value | humanizePercentage }} for the last %s"
          runbook_url: "https://runbooks.example.com/slo/%s"`,
			a.slo.Name, i+1,
			formatDuration(window.longWindow),
			window.burnRateThreshold, 1-a.slo.Target,
			formatDuration(window.shortWindow),
			window.burnRateThreshold, 1-a.slo.Target,
			formatDuration(window.shortWindow/2),
			string(window.severity),
			a.slo.Name,
			a.slo.Name,
			formatDuration(window.longWindow),
			a.slo.Name,
		)
	}

	return rules
}

func formatDuration(d time.Duration) string {
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	if hours > 0 {
		return fmt.Sprintf("%dh", hours)
	}
	return fmt.Sprintf("%dm", minutes)
}

// SLODashboard generates a Grafana dashboard for SLO monitoring
type SLODashboard struct {
	slos []SLO
}

// GenerateDashboard creates a Grafana dashboard JSON
func (d *SLODashboard) GenerateDashboard() map[string]any {
	panels := make([]map[string]any, 0)

	y := 0
	for i, slo := range d.slos {
		// Availability gauge
		panels = append(panels, map[string]any{
			"id":    i*4 + 1,
			"type":  "gauge",
			"title": fmt.Sprintf("%s Availability", slo.Name),
			"gridPos": map[string]int{"x": 0, "y": y, "w": 6, "h": 4},
			"targets": []map[string]any{
				{
					"expr":    slo.SLI.GoodQuery + " / " + slo.SLI.TotalQuery,
					"instant": true,
				},
			},
			"fieldConfig": map[string]any{
				"defaults": map[string]any{
					"thresholds": map[string]any{
						"steps": []map[string]any{
							{"color": "red", "value": 0},
							{"color": "yellow", "value": slo.Target - 0.001},
							{"color": "green", "value": slo.Target},
						},
					},
					"unit": "percentunit",
					"min":  0.99,
					"max":  1.0,
				},
			},
		})

		// Error budget remaining
		panels = append(panels, map[string]any{
			"id":    i*4 + 2,
			"type":  "gauge",
			"title": fmt.Sprintf("%s Error Budget Remaining", slo.Name),
			"gridPos": map[string]int{"x": 6, "y": y, "w": 6, "h": 4},
			"targets": []map[string]any{
				{
					"expr": fmt.Sprintf(`slo_error_budget_remaining{slo="%s"}`, slo.Name),
				},
			},
		})

		// Burn rate time series
		panels = append(panels, map[string]any{
			"id":    i*4 + 3,
			"type":  "timeseries",
			"title": fmt.Sprintf("%s Burn Rate", slo.Name),
			"gridPos": map[string]int{"x": 12, "y": y, "w": 12, "h": 4},
			"targets": []map[string]any{
				{
					"expr":   fmt.Sprintf(`slo_error_budget_burn_rate{slo="%s"}`, slo.Name),
					"legendFormat": "burn rate",
				},
			},
		})

		y += 4
	}

	return map[string]any{
		"title":       "SLO Dashboard",
		"uid":         "slo-dashboard",
		"refresh":     "1m",
		"schemaVersion": 39,
		"panels":      panels,
		"time":        map[string]string{"from": "now-24h", "to": "now"},
		"templating": map[string]any{
			"list": []map[string]any{
				{
					"name":  "datasource",
					"type":  "datasource",
					"query": "prometheus",
				},
			},
		},
	}
}
```

### Junior → FAANG: SLO/SLI/SLA in a System Design Interview

System design interviews at FAANG often include "how would you monitor this system?" as a sub-question. The expected answer includes: identify the SLIs (what measurements represent user experience), define SLO targets (what levels are acceptable), and describe the alerting strategy (how you detect SLO breaches before they become SLA violations).

The common mistake in interviews is jumping to "I would set up Prometheus and Grafana" before defining the SLIs. The monitoring tooling is secondary to understanding what you are measuring and why. Interviewers who ask "how would you monitor a payment service" want to hear SLI definitions first, then the implementation.

### Senior @ FAANG: SLO Framework Implementation and Cross-Service Consistency

At L6, the SLO framework is implemented as a shared service: a central SLO database (or a Terraform/Pulumi configuration) that stores all SLO definitions, their associated SLI metrics, and their error budget policies. Each service's SLO is reviewed and approved by the platform team before being added to the database. Dashboard and alert templates are generated from the SLO database automatically, ensuring consistency across all services.

The benefit of centralizing SLO definitions is cross-service SLO health reporting: a single executive dashboard shows the error budget status for every service, with drill-down capability into individual services. This view is impossible without consistent SLO definition formats and a shared reporting infrastructure. An L6 engineer who has built this infrastructure has delivered organizational leverage that scales with the number of services.

---
