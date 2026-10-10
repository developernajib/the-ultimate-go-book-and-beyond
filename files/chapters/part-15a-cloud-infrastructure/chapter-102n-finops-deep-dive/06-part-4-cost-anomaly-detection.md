## 102N.4 Cost Anomaly Detection

Unexpected cost spikes, runaway data transfers, misconfigured auto-scaling, or a forgotten test environment, can accumulate thousands of dollars before a human notices. The detector below uses a sliding-window z-score algorithm: for each new data point it computes the mean and standard deviation of the preceding `minBaseline` days, then flags the point as anomalous when its z-score exceeds the configured sensitivity threshold and its cost is above the baseline mean. Severity is classified into four bands (low/medium/high/critical) based on the percentage deviation, giving downstream alerting systems enough signal to prioritize human attention appropriately.

```go
package anomaly

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer"
	"github.com/aws/aws-sdk-go-v2/service/costexplorer/types"
)

// DailyCostSeries represents a time series of daily costs
type DailyCostSeries struct {
	Service string
	Points  []CostPoint
}

type CostPoint struct {
	Date time.Time
	Cost float64
}

// AnomalyDetector detects cost anomalies using statistical methods
type AnomalyDetector struct {
	sensitivity float64 // z-score threshold (default: 2.0)
	minBaseline int     // minimum data points for baseline (default: 14)
}

func NewAnomalyDetector(sensitivity float64, minBaseline int) *AnomalyDetector {
	if sensitivity <= 0 {
		sensitivity = 2.0
	}
	if minBaseline <= 0 {
		minBaseline = 14
	}
	return &AnomalyDetector{
		sensitivity: sensitivity,
		minBaseline: minBaseline,
	}
}

// CostAnomaly represents a detected anomaly
type CostAnomaly struct {
	Service       string
	Date          time.Time
	ActualCost    float64
	ExpectedCost  float64
	Deviation     float64 // percentage above expected
	ZScore        float64
	Severity      string // "low", "medium", "high", "critical"
}

// Detect finds anomalies in a cost time series
func (d *AnomalyDetector) Detect(series DailyCostSeries) []CostAnomaly {
	if len(series.Points) < d.minBaseline+1 {
		return nil
	}

	var anomalies []CostAnomaly

	// Sliding window: use past N days as baseline for each point
	for i := d.minBaseline; i < len(series.Points); i++ {
		baseline := series.Points[i-d.minBaseline : i]
		current := series.Points[i]

		mean, stddev := statistics(baseline)
		if stddev == 0 {
			continue
		}

		zScore := (current.Cost - mean) / stddev
		if math.Abs(zScore) >= d.sensitivity && current.Cost > mean {
			deviation := (current.Cost - mean) / mean * 100
			anomalies = append(anomalies, CostAnomaly{
				Service:      series.Service,
				Date:         current.Date,
				ActualCost:   current.Cost,
				ExpectedCost: mean,
				Deviation:    deviation,
				ZScore:       zScore,
				Severity:     classifySeverity(deviation),
			})
		}
	}

	return anomalies
}

func statistics(points []CostPoint) (mean, stddev float64) {
	if len(points) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, p := range points {
		sum += p.Cost
	}
	mean = sum / float64(len(points))

	variance := 0.0
	for _, p := range points {
		diff := p.Cost - mean
		variance += diff * diff
	}
	variance /= float64(len(points))
	stddev = math.Sqrt(variance)
	return mean, stddev
}

func classifySeverity(deviationPercent float64) string {
	switch {
	case deviationPercent >= 100:
		return "critical"
	case deviationPercent >= 50:
		return "high"
	case deviationPercent >= 25:
		return "medium"
	default:
		return "low"
	}
}

// AWS Native Anomaly Detection (Cost Anomaly Detection service)
type AWSAnomalyMonitor struct {
	client *costexplorer.Client
}

func (m *AWSAnomalyMonitor) GetAnomalies(ctx context.Context, days int) ([]CostAnomaly, error) {
	end := time.Now()
	start := end.AddDate(0, 0, -days)

	out, err := m.client.GetAnomalies(ctx, &costexplorer.GetAnomaliesInput{
		DateInterval: &types.AnomalyDateInterval{
			StartDate: aws.String(start.Format("2006-01-02")),
			EndDate:   aws.String(end.Format("2006-01-02")),
		},
		TotalImpact: &types.TotalImpactFilter{
			NumericOperator: types.NumericOperatorGreaterThanOrEqual,
			StartValue:      aws.Float64(10.0), // minimum $10 impact
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get anomalies: %w", err)
	}

	var anomalies []CostAnomaly
	for _, a := range out.Anomalies {
		var service string
		if a.DimensionValue != nil {
			service = *a.DimensionValue
		} else if len(a.RootCauses) > 0 && a.RootCauses[0].Service != nil {
			service = *a.RootCauses[0].Service
		}

		var actual, expected, dev float64
		if a.Impact != nil {
			if a.Impact.TotalActualSpend != nil {
				actual = *a.Impact.TotalActualSpend
			}
			if a.Impact.TotalExpectedSpend != nil {
				expected = *a.Impact.TotalExpectedSpend
			}
			if expected > 0 {
				dev = (actual - expected) / expected * 100
			}
		}

		anomalies = append(anomalies, CostAnomaly{
			Service:      service,
			ActualCost:   actual,
			ExpectedCost: expected,
			Deviation:    dev,
		})
	}

	// Sort by impact (largest first)
	slices.SortFunc(anomalies, func(a, b CostAnomaly) int {
		return cmp.Compare(b.ActualCost, a.ActualCost)
	})

	return anomalies, nil
}
```

---

### Junior → FAANG: Anomaly Detection as the First Line of Cost Defense

The z-score anomaly detection algorithm in this section has one critical parameter to tune: the sensitivity threshold. A threshold of 2.0 (standard deviations) flags approximately 5% of data points as anomalous on normally distributed data, which generates too many false positives and causes alert fatigue. A threshold of 3.0 flags approximately 0.3% of data points, which is more appropriate for cost anomaly detection where you want to catch genuine outliers, not normal day-to-day variance. The minimum baseline of 14 days is also important: with fewer than two weeks of data, the standard deviation is unreliable and anomaly detection produces false positives for seasonal patterns (weekday vs. weekend traffic differences).

The severity classification (low/medium/high/critical based on percentage deviation) drives alert routing. Critical anomalies (>200% deviation) should page the on-call engineer directly. High anomalies should alert the team's cost channel. Low and medium anomalies should aggregate into a daily digest. This routing prevents the most common failure mode of anomaly detection systems: routing all severities to the same channel, which causes engineers to stop reading the channel when it fills with low-severity noise.

### Senior @ FAANG: Anomaly Detection System as a Production Service

At staff level, the anomaly detection system in this section is a production service with its own reliability requirements, not a script that runs on someone's laptop. The system needs a data pipeline (daily cost data ingestion from Cost Explorer), a storage layer (the historical time series for each service/team dimension), a detection layer (the z-score algorithm running on each new data point), an alerting layer (routing alerts to the appropriate channel based on severity), and an acknowledgment mechanism (marking alerts as reviewed so they do not re-fire daily for the same sustained anomaly).

The most important failure mode to design against: the anomaly detection system fires an alert for a real cost spike, the on-call engineer investigates and determines it is a legitimate business event (new feature launch driving higher DynamoDB reads), and the system fires the same alert every day until the baseline catches up (typically 14+ days). The fix is an acknowledgment mechanism: the engineer marks the anomaly as "expected due to [reason]" for a specified duration, suppressing future alerts for that dimension. Without this mechanism, alert fatigue makes the system useless within weeks.

The organizational metric for anomaly detection quality: mean time to detection (MTTD) for cost spikes above $1,000/day. A well-tuned system should achieve MTTD under 24 hours for spikes of this magnitude. Track MTTD monthly and use it as the feedback signal for threshold tuning. A MTTD above 48 hours indicates the threshold is too high. A false positive rate above 20% (more than one in five alerts turns out to be expected spend) indicates the threshold is too low or the seasonality model needs improvement.
