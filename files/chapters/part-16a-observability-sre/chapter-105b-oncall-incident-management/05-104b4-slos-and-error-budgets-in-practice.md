## 105B.4 SLOs and Error Budgets in Practice

### Defining SLIs

A Service Level Indicator (SLI) is a quantitative measurement of service behavior. The SRE Book defines four canonical SLI categories:

**Availability SLI**
```
availability = good_requests / total_requests
```
Where "good" means HTTP 2xx or 3xx (excluding expected 4xx like 404 or 401).

**Latency SLI**
```
latency_sli = requests_under_threshold / total_requests
```
Example: "proportion of requests completing in under 300ms"

**Quality SLI** (for services with degraded-but-functional states)
```
quality_sli = requests_with_full_features / total_requests
```
Example: a personalization service returning cached results counts as "degraded quality," not "failure"

**Coverage SLI** (for batch/pipeline services)
```
coverage_sli = records_processed / records_expected
```

### Setting SLO Targets

Why not 100%? Several reasons:

1. **100% is technically impossible.** Planned maintenance, hardware failures, dependency outages: some failures are unavoidable.
2. **100% creates wrong incentives.** Teams pursuing 100% uptime become risk-averse to the point of shipping nothing.
3. **Users cannot tell the difference.** Beyond a certain point, a user's own last-mile connectivity fails more often than the service does, so the marginal value of going from 99.9% to 99.99% is invisible to most users.
4. **Cost scales exponentially.** Going from 99% to 99.9% may cost 2x. Going from 99.9% to 99.99% may cost 10x.

**Common SLO targets by service type:**

| Service Type | Typical SLO | Rationale |
|---|---|---|
| Critical payment path | 99.95% | High business impact, but absolute 100% wastes engineering |
| Core user-facing API | 99.9% | Standard for most production services |
| Internal microservice | 99.5% | Has circuit breakers and fallbacks |
| Batch pipeline | 99% | Can tolerate reruns, latency is secondary |
| Dev/staging environment | 95% | Not user-facing |

### Error Budget Calculation

For a 99.9% SLO over a 30-day month:

```
error_budget = (1 - SLO) * 30 days * 24 hours * 60 minutes
             = 0.001 * 43,200 minutes
             = 43.2 minutes per month

Daily budget  = 43.2 / 30 = 1.44 minutes/day
Hourly budget = 1.44 / 24 = 3.6 seconds/hour
```

This is the total time your service can be "down" (above the error threshold) in a month before breaching the SLO.

### Error Budget Policy

The error budget policy defines what happens when budget is consumed:

```
ERROR BUDGET POLICY - payment-service
======================================
SLO: 99.9% availability over 30-day rolling window

BUDGET STATUS THRESHOLDS:
- Green  (>50% remaining): Normal operations. Full deployment cadence.
- Yellow (25-50% remaining): Review change risk before deploying.
                              Require senior approval for high-risk changes.
- Orange (10-25% remaining): Freeze non-critical deployments.
                              Immediate toil reduction sprint begins.
- Red    (<10% remaining):   Feature freeze. All engineering effort on
                              reliability. Incident postmortems mandatory.
                              Executive notification required.

BUDGET EXHAUSTED:
- No new feature deployments until budget replenishes OR
  SRE and engineering leadership agree to override with explicit sign-off
- Mandatory postmortem for all incidents that contributed
- 30% of next sprint dedicated to reliability improvements

RESPONSIBILITY:
- Team lead monitors budget weekly minimum
- On-call engineer monitors budget daily during incidents
- Engineering manager notified when Yellow threshold crossed
```

### Go Code: SLO Calculation from Prometheus Metrics

The `SLOCalculator` below queries Prometheus for the good-request ratio over a rolling window and computes the remaining error budget as minutes and as a percentage of the window's allocation. The returned status struct is ready to be exported as a gauge or rendered on a budget dashboard.

```go
package slo

import (
	"context"
	"fmt"
	"time"

	prometheusapi "github.com/prometheus/client_golang/api"
	prometheusv1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

// SLOCalculator computes SLO compliance and error budget consumption
// by querying Prometheus.
type SLOCalculator struct {
	api     prometheusv1.API
	sloName string
	sloTarget float64 // e.g., 0.999 for 99.9%
}

// SLOStatus represents the current state of an SLO.
type SLOStatus struct {
	SLOName          string
	Target           float64
	CurrentValue     float64
	ErrorBudgetTotal float64 // minutes in window
	ErrorBudgetUsed  float64 // minutes consumed
	ErrorBudgetLeft  float64 // minutes remaining
	BudgetPercent    float64 // percent of budget remaining
	Window           time.Duration
	ComputedAt       time.Time
}

// BudgetStatus returns a human-readable budget health status.
func (s *SLOStatus) BudgetStatus() string {
	switch {
	case s.BudgetPercent > 50:
		return "GREEN"
	case s.BudgetPercent > 25:
		return "YELLOW"
	case s.BudgetPercent > 10:
		return "ORANGE"
	default:
		return "RED"
	}
}

func NewSLOCalculator(prometheusURL, sloName string, target float64) (*SLOCalculator, error) {
	client, err := prometheusapi.NewClient(prometheusapi.Config{
		Address: prometheusURL,
	})
	if err != nil {
		return nil, fmt.Errorf("creating prometheus client: %w", err)
	}

	return &SLOCalculator{
		api:       prometheusv1.NewAPI(client),
		sloName:   sloName,
		sloTarget: target,
	}, nil
}

// ComputeSLO queries Prometheus for the current SLO compliance over the given window.
// It uses the http_requests_total metric with status labels.
func (c *SLOCalculator) ComputeSLO(ctx context.Context, job string, window time.Duration) (*SLOStatus, error) {
	windowStr := durationToPromRange(window)

	// Query: ratio of good requests over window
	goodQuery := fmt.Sprintf(
		`sum(increase(http_requests_total{job="%s",error_type=""}[%s]))`,
		job, windowStr,
	)
	totalQuery := fmt.Sprintf(
		`sum(increase(http_requests_total{job="%s"}[%s]))`,
		job, windowStr,
	)

	goodResult, _, err := c.api.Query(ctx, goodQuery, time.Now())
	if err != nil {
		return nil, fmt.Errorf("querying good requests: %w", err)
	}

	totalResult, _, err := c.api.Query(ctx, totalQuery, time.Now())
	if err != nil {
		return nil, fmt.Errorf("querying total requests: %w", err)
	}

	good := extractScalar(goodResult)
	total := extractScalar(totalResult)

	if total == 0 {
		return nil, fmt.Errorf("no traffic observed for job %s in window %s", job, window)
	}

	currentSLO := good / total
	errorBudgetTotalMinutes := (1 - c.sloTarget) * window.Minutes()
	errorBudgetUsedMinutes := (c.sloTarget - currentSLO) * window.Minutes()
	if errorBudgetUsedMinutes < 0 {
		errorBudgetUsedMinutes = 0
	}
	errorBudgetLeftMinutes := errorBudgetTotalMinutes - errorBudgetUsedMinutes
	budgetPercent := (errorBudgetLeftMinutes / errorBudgetTotalMinutes) * 100

	return &SLOStatus{
		SLOName:          c.sloName,
		Target:           c.sloTarget,
		CurrentValue:     currentSLO,
		ErrorBudgetTotal: errorBudgetTotalMinutes,
		ErrorBudgetUsed:  errorBudgetUsedMinutes,
		ErrorBudgetLeft:  errorBudgetLeftMinutes,
		BudgetPercent:    budgetPercent,
		Window:           window,
		ComputedAt:       time.Now(),
	}, nil
}

func durationToPromRange(d time.Duration) string {
	switch {
	case d == 24*time.Hour:
		return "24h"
	case d == 7*24*time.Hour:
		return "7d"
	case d == 30*24*time.Hour:
		return "30d"
	default:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
}

func extractScalar(result model.Value) float64 {
	if vec, ok := result.(model.Vector); ok && len(vec) > 0 {
		return float64(vec[0].Value)
	}
	return 0
}
```

### Junior → FAANG: SLOs in Practice vs. SLOs in Theory

Reading about SLOs is different from operating with them. The gap shows up in two common ways for junior engineers: forgetting to update the SLO when the service's traffic patterns change significantly, and treating the SLO as a ceiling rather than a target (stopping reliability work once the SLO is met rather than using the remaining budget for controlled risk-taking).

For a first job, make the error budget visible: put it on the team's Grafana dashboard where everyone can see it daily. When the budget is high, that is the signal to try a faster deployment strategy or a riskier refactor. When it is low, that is the signal to slow down. The budget's job is to make the velocity-reliability trade-off explicit, not to be a static threshold that triggers a feature freeze.

### Senior @ FAANG: Error Budget Policy Exceptions and Edge Cases

A well-written error budget policy must handle edge cases, not just the normal case. Common edge cases that policies fail to address:

**Third-party dependency failures.** If a payment processor outage consumes 30% of the error budget and the team had no control over it, does that still trigger a feature freeze? Most mature organizations exclude uncontrollable external outages from the error budget calculation (or create a separate "internal vs. external" budget split), but this must be explicitly specified in the policy, not decided ad-hoc during an incident.

**Security patches.** A critical security patch may need to be deployed even when the error budget is exhausted. The policy must specify who can approve security exception deployments and what risk mitigation (canary deployment, rollback plan, manual smoke tests) is required.

**SLO target revision.** When the service consistently meets or exceeds the SLO and the team is burning its budget on deliberate experiments, it may be time to tighten the SLO. When the service consistently fails to meet the SLO despite sustained reliability investment, it may be time to lower it. An L6 engineer knows when and how to revise SLO targets and has the stakeholder management skills to do so without undermining trust in the reliability metrics.

---
