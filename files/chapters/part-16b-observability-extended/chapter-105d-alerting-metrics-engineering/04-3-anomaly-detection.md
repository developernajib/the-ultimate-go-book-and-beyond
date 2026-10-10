## 105D.4 Anomaly Detection

Static threshold alerts fail for metrics with strong seasonality or growth trends: a request rate that doubles every month will always exceed a fixed threshold. The `AnomalyDetector` below implements a Z-score-based detector that compares the current value against a rolling statistical model of recent history, flagging points that deviate by more than a configurable number of standard deviations. This approach adapts to normal metric evolution while still triggering on genuine step-function changes from bugs or cascading failures.

```go
package anomalydetection

import (
	"fmt"
	"math"
	"slices"
	"sync"
	"time"
)

// AnomalyDetector detects anomalies in metric time series
type AnomalyDetector struct {
	mu         sync.RWMutex
	series     map[string]*TimeSeries
	algorithms map[string]DetectionAlgorithm
}

// TimeSeries holds a metric's historical values
type TimeSeries struct {
	Name        string
	Values      []DataPoint
	WindowSize  int
	MaxHistory  int
}

// DataPoint represents a metric value at a point in time
type DataPoint struct {
	Timestamp time.Time
	Value     float64
}

// DetectionAlgorithm defines an anomaly detection strategy
type DetectionAlgorithm interface {
	Detect(ts *TimeSeries) (*Anomaly, error)
	Name() string
}

// Anomaly represents a detected anomaly
type Anomaly struct {
	SeriesName  string
	Timestamp   time.Time
	Value       float64
	Expected    float64
	Deviation   float64
	Score       float64 // 0.0 to 1.0
	Algorithm   string
	Description string
}

// NewAnomalyDetector creates an anomaly detector
func NewAnomalyDetector() *AnomalyDetector {
	return &AnomalyDetector{
		series:     make(map[string]*TimeSeries),
		algorithms: make(map[string]DetectionAlgorithm),
	}
}

// RegisterAlgorithm adds a detection algorithm
func (d *AnomalyDetector) RegisterAlgorithm(alg DetectionAlgorithm) {
	d.mu.Lock()
	d.algorithms[alg.Name()] = alg
	d.mu.Unlock()
}

// AddDataPoint adds a new data point and checks for anomalies
func (d *AnomalyDetector) AddDataPoint(seriesName string, value float64) ([]*Anomaly, error) {
	d.mu.Lock()
	ts, exists := d.series[seriesName]
	if !exists {
		ts = &TimeSeries{
			Name:       seriesName,
			WindowSize: 60,
			MaxHistory: 1440, // 24 hours at 1-minute resolution
		}
		d.series[seriesName] = ts
	}

	ts.Values = append(ts.Values, DataPoint{
		Timestamp: time.Now(),
		Value:     value,
	})

	// Trim to max history
	if len(ts.Values) > ts.MaxHistory {
		ts.Values = ts.Values[len(ts.Values)-ts.MaxHistory:]
	}

	tsCopy := *ts
	algorithms := make(map[string]DetectionAlgorithm)
	for k, v := range d.algorithms {
		algorithms[k] = v
	}
	d.mu.Unlock()

	// Run detection algorithms
	var anomalies []*Anomaly
	for _, alg := range algorithms {
		if len(tsCopy.Values) < tsCopy.WindowSize {
			continue // Not enough data
		}

		anomaly, err := alg.Detect(&tsCopy)
		if err != nil {
			return nil, fmt.Errorf("detection failed for %s: %w", alg.Name(), err)
		}
		if anomaly != nil {
			anomalies = append(anomalies, anomaly)
		}
	}

	return anomalies, nil
}

// ZScoreDetector detects anomalies using Z-score
type ZScoreDetector struct {
	threshold float64 // Number of standard deviations
}

// NewZScoreDetector creates a Z-score anomaly detector
func NewZScoreDetector(threshold float64) *ZScoreDetector {
	return &ZScoreDetector{threshold: threshold}
}

func (d *ZScoreDetector) Name() string { return "zscore" }

// Detect detects anomalies using Z-score analysis
func (d *ZScoreDetector) Detect(ts *TimeSeries) (*Anomaly, error) {
	if len(ts.Values) < 2 {
		return nil, nil
	}

	// Calculate mean and standard deviation over window
	window := ts.Values
	if len(window) > ts.WindowSize {
		window = window[len(window)-ts.WindowSize:]
	}

	mean, stddev := calculateStats(window)
	if stddev == 0 {
		return nil, nil
	}

	// Check latest value
	latest := ts.Values[len(ts.Values)-1]
	zScore := math.Abs(latest.Value-mean) / stddev

	if zScore > d.threshold {
		return &Anomaly{
			SeriesName:  ts.Name,
			Timestamp:   latest.Timestamp,
			Value:       latest.Value,
			Expected:    mean,
			Deviation:   zScore,
			Score:       math.Min(1.0, zScore/d.threshold),
			Algorithm:   d.Name(),
			Description: fmt.Sprintf("Z-score %.2f exceeds threshold %.2f (mean=%.2f, stddev=%.2f)", zScore, d.threshold, mean, stddev),
		}, nil
	}

	return nil, nil
}

// SeasonalDecompositionDetector detects anomalies accounting for seasonal patterns
type SeasonalDecompositionDetector struct {
	seasonLength int     // Points per season (e.g., 1440 for daily)
	threshold    float64 // Residual threshold
}

// NewSeasonalDetector creates a seasonal decomposition detector
func NewSeasonalDetector(seasonLength int, threshold float64) *SeasonalDecompositionDetector {
	return &SeasonalDecompositionDetector{
		seasonLength: seasonLength,
		threshold:    threshold,
	}
}

func (d *SeasonalDecompositionDetector) Name() string { return "seasonal" }

// Detect uses seasonal decomposition to detect anomalies
func (d *SeasonalDecompositionDetector) Detect(ts *TimeSeries) (*Anomaly, error) {
	if len(ts.Values) < d.seasonLength*2 {
		return nil, nil // Need at least 2 seasons
	}

	// Extract values
	values := make([]float64, len(ts.Values))
	for i, dp := range ts.Values {
		values[i] = dp.Value
	}

	// Calculate seasonal component (simplified: average per position in season)
	seasonalComponent := make([]float64, d.seasonLength)
	seasonCounts := make([]int, d.seasonLength)

	for i, v := range values {
		pos := i % d.seasonLength
		seasonalComponent[pos] += v
		seasonCounts[pos]++
	}

	for i := range seasonalComponent {
		if seasonCounts[i] > 0 {
			seasonalComponent[i] /= float64(seasonCounts[i])
		}
	}

	// Calculate residuals
	residuals := make([]float64, len(values))
	for i, v := range values {
		residuals[i] = v - seasonalComponent[i%d.seasonLength]
	}

	// Check latest residual
	latestResidual := residuals[len(residuals)-1]
	_, residualStddev := calculateStatsFromSlice(residuals)

	if residualStddev == 0 {
		return nil, nil
	}

	zScore := math.Abs(latestResidual) / residualStddev

	if zScore > d.threshold {
		latest := ts.Values[len(ts.Values)-1]
		seasonal := seasonalComponent[(len(ts.Values)-1)%d.seasonLength]

		return &Anomaly{
			SeriesName:  ts.Name,
			Timestamp:   latest.Timestamp,
			Value:       latest.Value,
			Expected:    seasonal,
			Deviation:   zScore,
			Score:       math.Min(1.0, zScore/d.threshold),
			Algorithm:   d.Name(),
			Description: fmt.Sprintf("Seasonal anomaly: residual z-score %.2f (value=%.2f, expected_seasonal=%.2f)", zScore, latest.Value, seasonal),
		}, nil
	}

	return nil, nil
}

// MADDetector uses Median Absolute Deviation (robust to outliers)
type MADDetector struct {
	threshold float64
}

// NewMADDetector creates a MAD-based detector
func NewMADDetector(threshold float64) *MADDetector {
	return &MADDetector{threshold: threshold}
}

func (d *MADDetector) Name() string { return "mad" }

// Detect uses MAD to find anomalies
func (d *MADDetector) Detect(ts *TimeSeries) (*Anomaly, error) {
	if len(ts.Values) < 10 {
		return nil, nil
	}

	window := ts.Values
	if len(window) > ts.WindowSize {
		window = window[len(window)-ts.WindowSize:]
	}

	values := make([]float64, len(window))
	for i, dp := range window {
		values[i] = dp.Value
	}

	// Calculate median
	sorted := make([]float64, len(values))
	copy(sorted, values)
	slices.Sort(sorted)
	median := sorted[len(sorted)/2]

	// Calculate MAD
	deviations := make([]float64, len(values))
	for i, v := range values {
		deviations[i] = math.Abs(v - median)
	}
	slices.Sort(deviations)
	mad := deviations[len(deviations)/2]

	if mad == 0 {
		return nil, nil
	}

	// Modified Z-score: 0.6745 is a scaling factor for normal distribution
	latest := window[len(window)-1]
	modifiedZScore := 0.6745 * math.Abs(latest.Value-median) / mad

	if modifiedZScore > d.threshold {
		return &Anomaly{
			SeriesName:  ts.Name,
			Timestamp:   latest.Timestamp,
			Value:       latest.Value,
			Expected:    median,
			Deviation:   modifiedZScore,
			Score:       math.Min(1.0, modifiedZScore/d.threshold),
			Algorithm:   d.Name(),
			Description: fmt.Sprintf("MAD anomaly: modified z-score %.2f (value=%.2f, median=%.2f)", modifiedZScore, latest.Value, median),
		}, nil
	}

	return nil, nil
}

func calculateStats(dataPoints []DataPoint) (mean, stddev float64) {
	values := make([]float64, len(dataPoints))
	for i, dp := range dataPoints {
		values[i] = dp.Value
	}
	return calculateStatsFromSlice(values)
}

func calculateStatsFromSlice(values []float64) (mean, stddev float64) {
	if len(values) == 0 {
		return 0, 0
	}

	sum := 0.0
	for _, v := range values {
		sum += v
	}
	mean = sum / float64(len(values))

	varianceSum := 0.0
	for _, v := range values {
		diff := v - mean
		varianceSum += diff * diff
	}

	stddev = math.Sqrt(varianceSum / float64(len(values)))
	return mean, stddev
}
```

### Junior → FAANG: Anomaly Detection vs. Threshold Alerting

Static threshold alerting (error rate > 1%) fails when the baseline changes: a service with a normal error rate of 0.8% and an SLO of 1% has almost no budget above the threshold, causing constant noise. Anomaly detection alerts on deviation from the service's own historical baseline, which adapts to changes in traffic patterns.

For interviews, understand the basic statistical approach: compute the mean and standard deviation of the metric over a historical window (e.g., 7-day same-hour average), and alert when the current value exceeds mean + N standard deviations. This is simpler than ML-based anomaly detection and works well for metrics with predictable weekly patterns.

The key interview follow-up: "what are the limitations of statistical anomaly detection?" Answer: it lags during rapid baseline shifts (a new feature that doubles traffic looks anomalous for the first week), it requires sufficient historical data (at least 2-4 weeks for weekly seasonality), and it has difficulty with highly seasonal or bursty workloads.

### Senior @ FAANG: Anomaly Detection at Scale and ML-Based Approaches

At FAANG scale, statistical anomaly detection with PromQL is sufficient for most use cases. ML-based anomaly detection (using Prometheus' `predict_linear()` for trends, or external ML models trained on historical metric data) is justified for specific use cases: detecting subtle performance regressions that are below statistical significance for a single metric but visible as a pattern across correlated metrics, or detecting security anomalies (unusual request patterns, unauthorized access attempts) that require cross-metric correlation.

An L6 engineer evaluates the operational cost of ML-based anomaly detection against its incremental benefit: ML models require training pipelines, model versioning, drift detection, and on-call support for the ML infrastructure itself. For most reliability use cases, well-calibrated multi-window SLO alerts with anomaly detection for individual metrics provide adequate coverage without the ML infrastructure overhead.

---
