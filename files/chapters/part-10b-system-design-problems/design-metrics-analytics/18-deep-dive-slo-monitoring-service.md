## Deep Dive: SLO Monitoring Service

The SLO Monitoring Service evaluates Service Level Objectives against live time-series data to compute error budgets, burn rates, and projected time to exhaustion. Each SLO definition specifies an SLI metric name, a threshold operator, a target availability percentage, and a rolling time window, the service queries the time-series database for good and total event counts within that window, then derives the burn rate over 1-hour and 6-hour intervals to drive multi-window alerting. Burn rate alerting is far more actionable than simple threshold breaches because it signals how quickly the error budget is being consumed, enabling teams to respond before the budget is exhausted.

```go
package slo

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DataPoint struct {
	Timestamp int64
	Value     float64
}

type QueryRequest struct {
	MetricName  string
	Start       time.Time
	End         time.Time
	Aggregation string
	Interval    string
}

type QueryResult struct {
	Metric     string
	DataPoints []DataPoint
}

type TimeSeriesQuerier interface {
	Query(ctx context.Context, req QueryRequest) ([]QueryResult, error)
}

// SLOService monitors Service Level Objectives and error budgets
type SLOService struct {
	db   *pgxpool.Pool
	tsdb TimeSeriesQuerier
}

type SLO struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	ServiceName     string    `json:"service_name"`
	SLIMetric       string    `json:"sli_metric"`       // e.g., "http.request.latency.p99"
	SLIThreshold    float64   `json:"sli_threshold"`    // e.g., 200 (ms)
	SLIOperator     string    `json:"sli_operator"`     // lt, gt
	TargetPercent   float64   `json:"target_percent"`   // e.g., 99.9
	WindowDays      int       `json:"window_days"`      // e.g., 30
	BurnRateAlert   bool      `json:"burn_rate_alert"`
}

type SLOStatus struct {
	SLO             SLO       `json:"slo"`
	CurrentPercent  float64   `json:"current_percent"`  // e.g., 99.85
	ErrorBudget     float64   `json:"error_budget"`     // total allowed failures
	ErrorBudgetUsed float64   `json:"error_budget_used"`
	ErrorBudgetPct  float64   `json:"error_budget_pct"` // % of budget consumed
	IsBreaching     bool      `json:"is_breaching"`
	BurnRate1h      float64   `json:"burn_rate_1h"`     // current burn rate
	BurnRate6h      float64   `json:"burn_rate_6h"`
	TimeToExhaust   string    `json:"time_to_exhaust"`  // at current rate
}

// EvaluateSLO computes the current SLO status
func (s *SLOService) EvaluateSLO(ctx context.Context, slo SLO) (*SLOStatus, error) {
	end := time.Now()
	start := end.Add(-time.Duration(slo.WindowDays) * 24 * time.Hour)

	// Total events in window
	totalResult, err := s.tsdb.Query(ctx, QueryRequest{
		MetricName:  slo.SLIMetric + ".count",
		Start:       start,
		End:         end,
		Aggregation: "sum",
		Interval:    fmt.Sprintf("%dd", slo.WindowDays),
	})
	if err != nil {
		return nil, err
	}

	// Sum every returned bucket rather than reading only the first,
	// so the result is correct regardless of how the TSDB buckets the window
	var totalEvents float64
	if len(totalResult) > 0 {
		for _, dp := range totalResult[0].DataPoints {
			totalEvents += dp.Value
		}
	}

	// Good events (meeting SLI threshold)
	var goodMetric string
	if slo.SLIOperator == "lt" {
		goodMetric = fmt.Sprintf("%s.below_%v", slo.SLIMetric, slo.SLIThreshold)
	} else {
		goodMetric = fmt.Sprintf("%s.above_%v", slo.SLIMetric, slo.SLIThreshold)
	}

	goodResult, err := s.tsdb.Query(ctx, QueryRequest{
		MetricName:  goodMetric,
		Start:       start,
		End:         end,
		Aggregation: "sum",
		Interval:    fmt.Sprintf("%dd", slo.WindowDays),
	})

	var goodEvents float64
	if err == nil && len(goodResult) > 0 {
		for _, dp := range goodResult[0].DataPoints {
			goodEvents += dp.Value
		}
	}

	// Compute SLO metrics
	currentPercent := 0.0
	if totalEvents > 0 {
		currentPercent = (goodEvents / totalEvents) * 100
	}

	errorBudget := totalEvents * (1 - slo.TargetPercent/100)
	badEvents := totalEvents - goodEvents
	errorBudgetPct := 0.0
	if errorBudget > 0 {
		errorBudgetPct = (badEvents / errorBudget) * 100
	}

	// Burn rates (for alerting)
	burnRate1h := s.computeBurnRate(ctx, slo, 1*time.Hour)
	burnRate6h := s.computeBurnRate(ctx, slo, 6*time.Hour)

	// Time to exhaust error budget at current rate
	remainingBudget := errorBudget - badEvents
	var timeToExhaust string
	if burnRate1h > 0 && remainingBudget > 0 {
		hoursLeft := remainingBudget / burnRate1h
		timeToExhaust = fmt.Sprintf("%.1f hours", hoursLeft)
	} else if remainingBudget <= 0 {
		timeToExhaust = "exhausted"
	} else {
		timeToExhaust = "infinite"
	}

	return &SLOStatus{
		SLO:             slo,
		CurrentPercent:  currentPercent,
		ErrorBudget:     errorBudget,
		ErrorBudgetUsed: badEvents,
		ErrorBudgetPct:  errorBudgetPct,
		IsBreaching:     currentPercent < slo.TargetPercent,
		BurnRate1h:      burnRate1h,
		BurnRate6h:      burnRate6h,
		TimeToExhaust:   timeToExhaust,
	}, nil
}

// computeBurnRate calculates errors per hour over a window.
// A query failure returns -1 so callers can distinguish "no errors"
// from "burn rate unknown", a silent zero would mask a broken alert path.
func (s *SLOService) computeBurnRate(ctx context.Context, slo SLO, window time.Duration) float64 {
	end := time.Now()
	start := end.Add(-window)
	result, err := s.tsdb.Query(ctx, QueryRequest{
		MetricName:  slo.SLIMetric + ".errors",
		Start:       start,
		End:         end,
		Aggregation: "sum",
	})
	if err != nil {
		return -1
	}
	var errors float64
	if len(result) > 0 {
		for _, dp := range result[0].DataPoints {
			errors += dp.Value
		}
	}
	return errors / window.Hours()
}
```

---
