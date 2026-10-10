## 90J.14 Zillow iBuying: When ML Models Lose $881 Million (2021)

### The Business

In 2018, Zillow launched Zillow Offers, an "iBuying" program where Zillow would use machine learning models
to estimate home values, purchase homes directly from sellers, make light renovations, and resell them for a
profit. The idea was that Zillow's data advantage - as the largest real estate website in the US - would allow
their ML models to price homes more accurately than human real estate agents.

### The Timeline

**2018-2020: The Ramp-Up**

Zillow's iBuying program grew steadily, purchasing thousands of homes per quarter. The ML model, called
"Zestimate," estimated home values using features like square footage, location, comparable sales, and
market trends. In a rising market, the model performed adequately - even when it overpaid slightly, the
rising market corrected the error before Zillow resold.

**2021: The Acceleration**

In 2021, Zillow dramatically accelerated its home purchasing, buying over 9,600 homes in Q3 2021 alone.
The company set aggressive growth targets that created pressure to buy more homes faster. To compete with
other iBuyers (Opendoor, Offerpad), Zillow began making higher offers.

**The Model's Failures**

The Zestimate model had several fundamental problems:

1. **Systematically overpaying**: The model consistently estimated home values above the actual market price.
   When Zillow needed to resell, they discovered they had paid too much for the majority of their inventory.

2. **Ignoring renovation costs**: The model did not adequately account for the cost and time required for
   renovations, and labor shortages during 2021 made renovations more expensive and slower than projected.

3. **Market shift blindness**: When the housing market began to cool in late 2021, the model was still
   pricing based on the rising market of previous months. ML models trained on historical data are
   inherently backward-looking.

4. **Feedback loop**: As Zillow bought more homes at inflated prices, those sales became comparable sales
   data that other valuations (including Zillow's own) used as references, creating a self-reinforcing
   inflation of values in areas where Zillow was active.

5. **Volume pressure**: The business targets incentivized the model to be aggressive - conservative pricing
   would mean fewer acquisitions and missed growth targets.

**October 2021: The Pause**

On October 17, 2021, Zillow announced it was pausing new home purchases due to a backlog of renovations and
labor constraints. The real reason was more alarming - Zillow had accumulated a massive inventory of homes it
had overpaid for and could not sell at a profit.

**November 2021: The Shutdown**

On November 2, 2021, Zillow announced it was shutting down Zillow Offers entirely and laying off 25% of its
workforce (approximately 2,000 people). The company took a write-down of approximately $881 million. Zillow
had to sell approximately 7,000 homes, many at a loss.

### Root Cause Analysis

1. **ML model overconfidence**: The model's confidence intervals were too narrow
2. **No human-in-the-loop for large purchases**: Individual home purchases worth hundreds of thousands of
   dollars were made automatically
3. **Inadequate model monitoring**: Systematic bias (overpaying) was not detected quickly enough
4. **Market regime change**: The model was trained on a rising market and could not adapt to a changing one
5. **Business pressure overriding model caution**: Growth targets pushed the model toward aggressive pricing
6. **Feedback loop undetected**: The model's own purchasing was contaminating its training data

### Go Code: ML Model Monitoring System

The Zillow disaster shows what happens when ML models are deployed without thorough monitoring. Here is a
system that continuously monitors model predictions against reality and triggers alerts when the model
begins to deviate:

```go
package mlmonitor

import (
	"fmt"
	"math"
	"slices"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// ML model monitoring for detecting systematic bias, drift, and
// degradation before they cause catastrophic losses
// -----------------------------------------------------------------------

// Prediction represents a model's prediction paired with the eventual
// actual outcome.
type Prediction struct {
	ID            string
	ModelVersion  string
	PredictedValue float64
	ActualValue    float64 // Set to 0 until outcome is known
	Features       map[string]float64
	Timestamp      time.Time
	OutcomeTime    time.Time
	HasOutcome     bool
}

// ModelMetrics tracks rolling statistics about model performance.
type ModelMetrics struct {
	mu                 sync.RWMutex
	ModelName          string
	TotalPredictions   int64
	ResolvedPredictions int64

	// Error distribution
	MeanError          float64 // Average (predicted - actual)
	MeanAbsoluteError  float64
	MedianError        float64
	RMSE               float64

	// Bias detection
	OverpredictionRate float64 // % of predictions above actual
	UnderPredictionRate float64
	SystematicBias     float64 // Consistent directional error

	// Drift detection
	RecentMeanError    float64 // Error in the last window
	HistoricalMeanError float64
	DriftScore         float64 // How much recent performance differs from historical

	// Financial impact
	TotalPnL           float64 // If prediction drives a financial decision
	CumulativeLoss     float64

	// Raw data for percentile calculations
	errors             []float64
	recentErrors       []float64
}

// MonitorConfig defines the alerting thresholds.
type MonitorConfig struct {
	// Bias thresholds
	MaxOverpredictionRate float64 // e.g., 0.55 means alert if > 55% of predictions are high
	MaxMeanBias           float64 // e.g., 5000 means alert if average error > 5000 units

	// Drift thresholds
	MaxDriftScore float64 // How much recent can differ from historical

	// Financial thresholds
	MaxCumulativeLoss float64 // e.g., -10_000_000 (10M unit loss)
	MaxSingleLoss     float64 // e.g., -500_000 per prediction

	// Window sizes
	RecentWindow   int           // Number of recent predictions for drift detection
	AlertCooldown  time.Duration // Minimum time between alerts

	// Feedback loop detection
	MaxSelfCorrelation float64 // Correlation between predictions and future training data
}

// Alert represents a monitoring alert.
type Alert struct {
	Severity  string    `json:"severity"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	Metric    string    `json:"metric"`
	Threshold float64   `json:"threshold"`
	Actual    float64   `json:"actual"`
	Timestamp time.Time `json:"timestamp"`
}

// ModelMonitor continuously evaluates model performance and triggers
// alerts when anomalies are detected.
type ModelMonitor struct {
	config     MonitorConfig
	metrics    *ModelMetrics
	alerts     []Alert
	mu         sync.RWMutex
	predictions map[string]*Prediction
	alertFn    func(alert Alert)
	lastAlert  time.Time
}

// NewModelMonitor creates a new model monitor.
func NewModelMonitor(modelName string, config MonitorConfig) *ModelMonitor {
	return &ModelMonitor{
		config: config,
		metrics: &ModelMetrics{
			ModelName: modelName,
		},
		predictions: make(map[string]*Prediction),
	}
}

// SetAlertCallback registers the alerting function.
func (mm *ModelMonitor) SetAlertCallback(fn func(alert Alert)) {
	mm.alertFn = fn
}

// RecordPrediction records a new model prediction before the outcome
// is known.
func (mm *ModelMonitor) RecordPrediction(pred Prediction) {
	mm.mu.Lock()
	defer mm.mu.Unlock()

	mm.predictions[pred.ID] = &pred
	mm.metrics.mu.Lock()
	mm.metrics.TotalPredictions++
	mm.metrics.mu.Unlock()
}

// RecordOutcome records the actual outcome for a previously recorded
// prediction. This is where errors are calculated and monitoring
// thresholds are checked.
func (mm *ModelMonitor) RecordOutcome(predictionID string, actualValue float64) {
	mm.mu.Lock()
	pred, exists := mm.predictions[predictionID]
	if !exists {
		mm.mu.Unlock()
		return
	}

	pred.ActualValue = actualValue
	pred.HasOutcome = true
	pred.OutcomeTime = time.Now()
	mm.mu.Unlock()

	// Calculate error.
	err := pred.PredictedValue - actualValue
	absErr := math.Abs(err)

	// Update metrics.
	mm.metrics.mu.Lock()
	mm.metrics.ResolvedPredictions++
	mm.metrics.errors = append(mm.metrics.errors, err)
	mm.metrics.recentErrors = append(mm.metrics.recentErrors, err)

	// Keep recent errors window sized.
	if len(mm.metrics.recentErrors) > mm.config.RecentWindow {
		mm.metrics.recentErrors = mm.metrics.recentErrors[len(mm.metrics.recentErrors)-mm.config.RecentWindow:]
	}

	// Recalculate metrics.
	mm.recalculateMetrics()
	mm.metrics.mu.Unlock()

	// Check financial impact (for Zillow-like scenarios where the
	// prediction drives a buying decision).
	pnl := -err // If we overpredicted, we overpaid, so PnL is negative
	mm.metrics.mu.Lock()
	mm.metrics.TotalPnL += pnl
	if pnl < 0 {
		mm.metrics.CumulativeLoss += pnl
	}
	mm.metrics.mu.Unlock()

	// Check alerting thresholds.
	mm.checkAlerts(err, absErr, pnl)
}

// recalculateMetrics updates all aggregate metrics. Must be called
// with metrics.mu held.
func (mm *ModelMonitor) recalculateMetrics() {
	m := mm.metrics
	errors := m.errors

	if len(errors) == 0 {
		return
	}

	// Mean error (bias direction).
	var sum float64
	var absSum float64
	var overCount int
	for _, e := range errors {
		sum += e
		absSum += math.Abs(e)
		if e > 0 {
			overCount++
		}
	}
	m.MeanError = sum / float64(len(errors))
	m.MeanAbsoluteError = absSum / float64(len(errors))
	m.OverpredictionRate = float64(overCount) / float64(len(errors))
	m.UnderPredictionRate = 1.0 - m.OverpredictionRate
	m.SystematicBias = m.MeanError

	// RMSE.
	var squaredSum float64
	for _, e := range errors {
		squaredSum += e * e
	}
	m.RMSE = math.Sqrt(squaredSum / float64(len(errors)))

	// Median error.
	sorted := make([]float64, len(errors))
	copy(sorted, errors)
	slices.Sort(sorted)
	m.MedianError = sorted[len(sorted)/2]

	// Drift detection: compare recent errors to historical.
	if len(m.recentErrors) >= mm.config.RecentWindow/2 {
		var recentSum float64
		for _, e := range m.recentErrors {
			recentSum += e
		}
		m.RecentMeanError = recentSum / float64(len(m.recentErrors))

		// Historical mean error (all errors).
		m.HistoricalMeanError = m.MeanError

		// Drift score: how many standard deviations the recent mean
		// is from the historical mean.
		if m.RMSE > 0 {
			m.DriftScore = math.Abs(m.RecentMeanError-m.HistoricalMeanError) / m.RMSE
		}
	}
}

// checkAlerts evaluates all alerting thresholds.
func (mm *ModelMonitor) checkAlerts(err, absErr, pnl float64) {
	mm.mu.Lock()
	defer mm.mu.Unlock()

	// Respect cooldown.
	if time.Since(mm.lastAlert) < mm.config.AlertCooldown {
		return
	}

	mm.metrics.mu.RLock()
	defer mm.metrics.mu.RUnlock()

	// Check overprediction bias (the Zillow problem).
	if mm.metrics.OverpredictionRate > mm.config.MaxOverpredictionRate &&
		mm.metrics.ResolvedPredictions > 50 {
		mm.fireAlert(Alert{
			Severity:  "critical",
			Type:      "bias",
			Message:   fmt.Sprintf("Model is systematically overpredicting: %.1f%% of predictions are above actual", mm.metrics.OverpredictionRate*100),
			Metric:    "overprediction_rate",
			Threshold: mm.config.MaxOverpredictionRate,
			Actual:    mm.metrics.OverpredictionRate,
			Timestamp: time.Now(),
		})
	}

	// Check mean bias.
	if math.Abs(mm.metrics.SystematicBias) > mm.config.MaxMeanBias &&
		mm.metrics.ResolvedPredictions > 50 {
		mm.fireAlert(Alert{
			Severity:  "critical",
			Type:      "bias",
			Message:   fmt.Sprintf("Systematic bias detected: mean error = $%.2f", mm.metrics.SystematicBias),
			Metric:    "systematic_bias",
			Threshold: mm.config.MaxMeanBias,
			Actual:    mm.metrics.SystematicBias,
			Timestamp: time.Now(),
		})
	}

	// Check drift.
	if mm.metrics.DriftScore > mm.config.MaxDriftScore {
		mm.fireAlert(Alert{
			Severity:  "warning",
			Type:      "drift",
			Message:   fmt.Sprintf("Model drift detected: recent performance deviates %.2f sigma from historical", mm.metrics.DriftScore),
			Metric:    "drift_score",
			Threshold: mm.config.MaxDriftScore,
			Actual:    mm.metrics.DriftScore,
			Timestamp: time.Now(),
		})
	}

	// Check cumulative loss.
	if mm.metrics.CumulativeLoss < -mm.config.MaxCumulativeLoss {
		mm.fireAlert(Alert{
			Severity:  "critical",
			Type:      "financial",
			Message:   fmt.Sprintf("Cumulative loss exceeds threshold: $%.2f", mm.metrics.CumulativeLoss),
			Metric:    "cumulative_loss",
			Threshold: -mm.config.MaxCumulativeLoss,
			Actual:    mm.metrics.CumulativeLoss,
			Timestamp: time.Now(),
		})
	}

	// Check single prediction loss.
	if pnl < -mm.config.MaxSingleLoss {
		mm.fireAlert(Alert{
			Severity:  "warning",
			Type:      "financial",
			Message:   fmt.Sprintf("Single prediction loss: $%.2f", pnl),
			Metric:    "single_loss",
			Threshold: -mm.config.MaxSingleLoss,
			Actual:    pnl,
			Timestamp: time.Now(),
		})
	}
}

// fireAlert sends an alert and records it.
func (mm *ModelMonitor) fireAlert(alert Alert) {
	mm.alerts = append(mm.alerts, alert)
	mm.lastAlert = time.Now()

	fmt.Printf("\n[ML MONITOR] %s ALERT: %s\n", alert.Severity, alert.Message)
	fmt.Printf("  Metric: %s, Threshold: %.4f, Actual: %.4f\n",
		alert.Metric, alert.Threshold, alert.Actual)

	if mm.alertFn != nil {
		mm.alertFn(alert)
	}
}

// GetMetricsSummary returns a snapshot of current model performance.
func (mm *ModelMonitor) GetMetricsSummary() map[string]any {
	mm.metrics.mu.RLock()
	defer mm.metrics.mu.RUnlock()

	return map[string]any{
		"model_name":           mm.metrics.ModelName,
		"total_predictions":    mm.metrics.TotalPredictions,
		"resolved_predictions": mm.metrics.ResolvedPredictions,
		"mean_error":           mm.metrics.MeanError,
		"mean_absolute_error":  mm.metrics.MeanAbsoluteError,
		"median_error":         mm.metrics.MedianError,
		"rmse":                 mm.metrics.RMSE,
		"overprediction_rate":  mm.metrics.OverpredictionRate,
		"systematic_bias":      mm.metrics.SystematicBias,
		"drift_score":          mm.metrics.DriftScore,
		"total_pnl":            mm.metrics.TotalPnL,
		"cumulative_loss":      mm.metrics.CumulativeLoss,
	}
}
```

### Engineering Lessons

1. **ML models need continuous monitoring, not just training-time evaluation** - model performance
   degrades in ways that offline metrics cannot detect.
2. **Systematic bias is the most dangerous model failure** - a model that is consistently wrong in one
   direction causes losses that compound over time.
3. **Human-in-the-loop for high-value decisions** - no ML model should autonomously commit hundreds of
   thousands of dollars per decision without human review.
4. **Feedback loops contaminate training data** - when a model's outputs influence its future inputs,
   the model can become self-reinforcing in its errors.
5. **Market regime changes invalidate historical models** - models trained on rising markets will fail
   when markets turn.
6. **Business targets and model accuracy are in tension** - aggressive growth targets push models toward
   aggressive (and risky) predictions.

---

### Junior → FAANG: ML Model Monitoring and Feedback Loop Detection as Interview Topics

Zillow is the interview answer to "how do you monitor a machine learning model in production?" The model did not fail at training time. It failed in production because housing market conditions changed and the model continued making predictions based on a regime that no longer existed. For FAANG interviews, the Zillow incident provides three concrete monitoring requirements. First, track the distribution of model inputs over time and alert when the distribution shifts significantly from the training distribution (population drift). Second, track model output distribution and alert when predictions systematically deviate in one direction (bias drift). Third, monitor model performance against ground truth as outcomes become available and alert when accuracy falls below a defined threshold. The Zillow model was systematically overpaying for houses, which means the output distribution was consistently biased upward relative to actual market prices. That signal was detectable before the $881 million loss accumulated, had there been monitoring in place.

### Senior @ FAANG: ML Model Safety Governance and Feedback Loop Prevention as Platform Standards

At L6, the Zillow failure illustrates the governance gap that exists when ML systems make high-value, high-frequency autonomous decisions without human oversight. The governance framework for high-stakes ML systems has four components. First, define a maximum autonomous decision value threshold. Any model making a decision above this threshold requires human review before execution. For Zillow's iBuying model, a reasonable threshold might have been $50,000 per decision, with a human reviewer approving any offer above that amount. The threshold is calibrated to the cost of a wrong decision relative to the cost of human review time. Second, implement feedback loop detection as a monitoring standard. When a model's outputs systematically influence its future training data, the model can become self-reinforcing in its errors. For Zillow, Zillow's own purchases were changing the market prices that would eventually be used to evaluate and retrain the model. Feedback loop detection requires tracking the fraction of model training data that was generated by the model's own previous predictions, and alerting when that fraction exceeds a defined threshold. Third, define model performance SLAs with automatic circuit breakers: if prediction error exceeds X% for N consecutive decisions, halt autonomous execution and require human review. The circuit breaker is the ML equivalent of the kill switch in Knight Capital. Fourth, separate the model performance team from the business growth team and give the performance team veto authority over production deployment when model accuracy metrics fall below defined thresholds. At Zillow, the pressure to buy homes at scale pushed the model toward aggressive predictions in a way that a performance team with veto authority would have halted before the losses accumulated.

---
