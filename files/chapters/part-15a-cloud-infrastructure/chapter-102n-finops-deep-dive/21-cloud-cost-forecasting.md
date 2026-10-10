## 102N.19 Cloud Cost Forecasting

Forecasting cloud costs enables capacity planning, budget negotiation, and proactive Savings Plan purchasing. This section implements exponential smoothing in pure Go and integrates with the AWS Cost Explorer forecast API.

### Exponential Smoothing Implementation

Holt's linear (double exponential) smoothing models both level and trend, making it well-suited for cloud cost time series that grow with business scale.

```go
// pkg/forecast/smoothing.go
package forecast

import "math"

// SES applies Simple Exponential Smoothing with factor alpha.
func SES(series []float64, alpha float64) []float64 {
	if len(series) == 0 {
		return nil
	}
	out := make([]float64, len(series))
	out[0] = series[0]
	for i := 1; i < len(series); i++ {
		out[i] = alpha*series[i] + (1-alpha)*out[i-1]
	}
	return out
}

// HoltLinear applies Holt's linear exponential smoothing and returns n-step-ahead forecasts.
// alpha controls level, beta controls trend. Recommended starting values: alpha=0.3, beta=0.1.
func HoltLinear(series []float64, alpha, beta float64, steps int) []float64 {
	if len(series) < 2 {
		return nil
	}
	level := series[0]
	trend := series[1] - series[0]
	for i := 1; i < len(series); i++ {
		prev := level
		level = alpha*series[i] + (1-alpha)*(level+trend)
		trend = beta*(level-prev) + (1-beta)*trend
	}
	out := make([]float64, steps)
	for h := 1; h <= steps; h++ {
		out[h-1] = math.Max(0, level+float64(h)*trend)
	}
	return out
}

// MAPE computes Mean Absolute Percentage Error. Returns -1 on invalid input.
// Values below 10% are considered good for cost forecasting.
func MAPE(actuals, forecasts []float64) float64 {
	if len(actuals) != len(forecasts) || len(actuals) == 0 {
		return -1
	}
	var sum float64
	for i := range actuals {
		if actuals[i] != 0 {
			sum += math.Abs((actuals[i]-forecasts[i])/actuals[i]) * 100
		}
	}
	return sum / float64(len(actuals))
}
```

### AWS Cost Explorer Forecast Integration

AWS Cost Explorer's `GetCostForecast` API uses machine-learning models trained on your account's historical spend, making it more accurate than a simple moving average for workloads with seasonal or event-driven patterns. The critical parameter is `PredictionIntervalLevel`, set to 80 here, which returns a lower and upper confidence bound alongside the mean estimate, giving budget owners a range rather than a single number to plan against. Filtering by a `service` tag lets teams retrieve forecasts scoped to a single microservice rather than the entire account, enabling per-team capacity planning without a separate AWS account per service.

```go
// pkg/forecast/aws_forecast.go
package forecast

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer/types"
)

// ForecastPoint holds one daily period from the Cost Explorer forecast API.
type ForecastPoint struct {
	PeriodStart time.Time
	PeriodEnd   time.Time
	MeanUSD     float64
	LowUSD      float64
	HighUSD     float64
}

// GetAWSForecast calls GetCostForecast for the next 30 days at daily granularity.
// Pass an empty serviceTag to forecast the entire account.
func GetAWSForecast(ctx context.Context, c *costexplorer.Client, serviceTag string) ([]ForecastPoint, error) {
	start, end := time.Now().AddDate(0, 0, 1), time.Now().AddDate(0, 1, 0)
	in := &costexplorer.GetCostForecastInput{
		TimePeriod: &types.DateInterval{
			Start: aws.String(start.Format("2006-01-02")),
			End:   aws.String(end.Format("2006-01-02")),
		},
		Granularity:             types.GranularityDaily,
		Metric:                  types.MetricUnblendedCost,
		PredictionIntervalLevel: aws.Int32(80),
	}
	if serviceTag != "" {
		in.Filter = &types.Expression{
			Tags: &types.TagValues{Key: aws.String("service"), Values: []string{serviceTag}},
		}
	}
	resp, err := c.GetCostForecast(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("GetCostForecast: %w", err)
	}
	pts := make([]ForecastPoint, 0, len(resp.ForecastResultsByTime))
	for _, fc := range resp.ForecastResultsByTime {
		mean, _ := strconv.ParseFloat(aws.ToString(fc.MeanValue), 64)
		low, _ := strconv.ParseFloat(aws.ToString(fc.PredictionIntervalLowerBound), 64)
		high, _ := strconv.ParseFloat(aws.ToString(fc.PredictionIntervalUpperBound), 64)
		s, _ := time.Parse("2006-01-02", aws.ToString(fc.TimePeriod.Start))
		e, _ := time.Parse("2006-01-02", aws.ToString(fc.TimePeriod.End))
		pts = append(pts, ForecastPoint{PeriodStart: s, PeriodEnd: e, MeanUSD: mean, LowUSD: low, HighUSD: high})
	}
	return pts, nil
}

// ProjectAnnualCost uses Holt-Winters on the provided daily series to estimate annual cost.
// Requires at least 7 data points.
func ProjectAnnualCost(daily []float64) float64 {
	if len(daily) < 7 {
		return 0
	}
	var total float64
	for _, v := range HoltLinear(daily, 0.3, 0.1, 365) {
		total += v
	}
	return total
}
```

### Capacity Planning from Cost Projections

A cost forecast only creates value when it drives a concrete infrastructure decision. The `Plan` function bridges the gap between a dollar figure and an actionable engineering task: it converts the difference between current and forecasted monthly spend into an estimated number of additional instances required (`delta / costPerInstance`), and categorizes growth severity into LOW/MEDIUM/HIGH tiers that each map to a specific response, doing nothing, purchasing Savings Plans, or escalating to budget owners. Setting the recommended Savings Plan coverage to 70% of forecasted spend follows the FinOps best practice of covering baseline usage with committed pricing while leaving 30% on-demand to absorb variance.

```go
// pkg/forecast/capacity_plan.go
package forecast

import "fmt"

// CapacityPlan translates a cost growth forecast into infrastructure action items.
type CapacityPlan struct {
	CurrentMonthlyCost    float64
	ForecastedMonthlyCost float64
	GrowthRatePct         float64
	RecommendedSPCoverage float64 // 70% of forecasted monthly - cover with Savings Plans
	AdditionalInstances   int
	BudgetImpact          string
}

// Plan derives capacity recommendations from current and forecasted monthly spend.
func Plan(current, forecasted, costPerInstance float64) CapacityPlan {
	growth := 0.0
	if current > 0 {
		growth = ((forecasted - current) / current) * 100
	}
	additional := 0
	if delta := forecasted - current; costPerInstance > 0 && delta > 0 {
		additional = int(delta / costPerInstance)
	}
	var impact string
	switch {
	case growth > 20:
		impact = fmt.Sprintf("HIGH: %.1f%% MoM growth - review autoscaling limits and request budget increase", growth)
	case growth > 10:
		impact = fmt.Sprintf("MEDIUM: %.1f%% MoM growth - consider purchasing additional Savings Plans", growth)
	default:
		impact = fmt.Sprintf("LOW: %.1f%% MoM growth - within normal variance", growth)
	}
	return CapacityPlan{
		CurrentMonthlyCost:    current,
		ForecastedMonthlyCost: forecasted,
		GrowthRatePct:         growth,
		RecommendedSPCoverage: forecasted * 0.70,
		AdditionalInstances:   additional,
		BudgetImpact:          impact,
	}
}
```

---

### Junior → FAANG: Cost Forecasting as a Planning and Budget Skill

Cost forecasting connects engineering decisions to financial planning in a concrete way. When product managers ask "what will the infrastructure cost be in Q3 if we grow from 100K to 500K daily active users?", the ability to answer with a model-based forecast (rather than "I don't know, it depends on a lot of things") is a differentiating skill. The exponential smoothing model in this section is the right level of sophistication for most forecast scenarios: it captures trend and seasonal patterns without requiring a data science background to implement or interpret.

The alpha parameter in exponential smoothing (the weight given to recent observations vs. historical trend) is the key tuning knob. A high alpha (0.9) makes the forecast highly reactive to recent changes but amplifies noise. A low alpha (0.1) produces smooth forecasts that lag actual trend changes. For cloud cost forecasting where costs change gradually (infrastructure changes take effect over days to weeks), an alpha of 0.3-0.5 typically balances responsiveness with stability. The correct approach: compute the mean squared error of the forecast against the last 30 days of actual data at three alpha values (0.1, 0.3, 0.7) and choose the alpha with the lowest MSE for your specific cost time series.

### Senior @ FAANG: Forecasting as Capital Planning Infrastructure

At staff level, cost forecasting is not a monthly report. It is the infrastructure for capital planning conversations with finance. Finance teams need 12-month rolling cost forecasts to plan commitments (Savings Plans, Reserved Instances, enterprise agreements with cloud providers). Engineering teams need 3-month forecasts for capacity planning. Both needs require different forecast models: 12-month forecasts need to account for seasonality (if traffic peaks in Q4, the forecast must reflect that) and planned business events (product launches, marketing campaigns). 3-month forecasts prioritize accuracy at shorter horizons.

The AWS Cost Explorer forecast API provides a starting point, but its accuracy degrades for organizations with irregular cost patterns (one-time large data migrations, step-function changes from major architecture migrations). Supplementing the Cost Explorer forecast with an organization-specific model (the exponential smoothing implementation in this section, trained on the organization's own cost history) typically produces more accurate forecasts for organizations with distinctive patterns. The staff engineer's contribution is building the forecast validation framework: running multiple models (AWS Cost Explorer, exponential smoothing, linear regression with seasonality) against the last 6 months of actual data and selecting the model with the best holdout performance as the organizational forecast standard. This turns forecast selection from a preference decision into an evidence-based decision.
