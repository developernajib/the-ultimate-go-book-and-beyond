## 114.8 Monitoring ML Models

### Data Drift Detection

Data drift occurs when the statistical distribution of production inputs diverges from the training distribution, degrading model accuracy over time without obvious error signals. The following detector tracks feature distribution statistics and generates alerts when drift metrics exceed configured thresholds.

```go
// pkg/monitoring/drift.go
package monitoring

import (
    "context"
    "math"
    "sync"
    "time"
)

// DriftDetector detects data drift in features
type DriftDetector struct {
    name      string
    baseline  *FeatureStatistics
    threshold float64
    mu        sync.RWMutex
}

// FeatureStatistics stores statistical information about features
type FeatureStatistics struct {
    Mean     map[string]float64
    Std      map[string]float64
    Min      map[string]float64
    Max      map[string]float64
    Count    int64
    Updated  time.Time
}

func NewDriftDetector(name string, threshold float64) *DriftDetector {
    return &DriftDetector{
        name:      name,
        threshold: threshold,
        baseline: &FeatureStatistics{
            Mean:  make(map[string]float64),
            Std:   make(map[string]float64),
            Min:   make(map[string]float64),
            Max:   make(map[string]float64),
            Count: 0,
        },
    }
}

// SetBaseline sets the baseline statistics
func (dd *DriftDetector) SetBaseline(stats *FeatureStatistics) {
    dd.mu.Lock()
    defer dd.mu.Unlock()
    dd.baseline = stats
}

// DetectDrift checks for drift in current data
func (dd *DriftDetector) DetectDrift(ctx context.Context,
    current *FeatureStatistics) (*DriftReport, error) {

    dd.mu.RLock()
    baseline := dd.baseline
    dd.mu.RUnlock()

    report := &DriftReport{
        DetectorName: dd.name,
        Timestamp:    time.Now(),
        Features:     make(map[string]*FeatureDrift),
    }

    // Check each feature present in the baseline.
    //
    // A feature that is absent from current reads as 0.0 out of the map, which
    // would be scored as a dramatic shift toward zero. That is a fabricated
    // drift alert caused by a missing feature, and it points at a broken
    // upstream pipeline rather than a changing population. The two need
    // different pages to different people, so report them separately.
    for feature := range baseline.Mean {
        if _, ok := current.Mean[feature]; !ok {
            report.MissingFeatures = append(report.MissingFeatures, feature)
            continue
        }

        drift := dd.calculateDrift(feature, baseline, current)
        report.Features[feature] = drift

        if drift.Drifted {
            report.HasDrift = true
            report.DriftedFeatures = append(report.DriftedFeatures, feature)
        }
    }

    return report, nil
}

// calculateDrift scores how far a feature's mean has moved, in units of the
// baseline standard deviation.
//
// This is a standardized mean shift, not the Population Stability Index. The
// distinction is not pedantry: PSI bins the whole distribution and reacts to
// any change in its shape, while this statistic only watches the mean. A
// feature whose variance doubles, or that becomes bimodal, while holding its
// mean constant scores 0 here and looks perfectly healthy. Use this as a cheap
// first-pass signal, and use a real binned PSI (as implemented in the
// fundamentals chapter) when you need to catch distributional change rather
// than just a shift in center.
//
// Interpret the score as a z-distance: 1.0 means the mean moved one baseline
// standard deviation. That is a different scale from PSI's 0.1/0.25 bands, so
// do not carry PSI thresholds over to it.
func (dd *DriftDetector) calculateDrift(feature string,
    baseline, current *FeatureStatistics) *FeatureDrift {

    baseMean := baseline.Mean[feature]
    baseStd := baseline.Std[feature]
    currMean := current.Mean[feature]

    drift := math.Abs(currMean-baseMean) / (baseStd + 1e-10)

    return &FeatureDrift{
        Feature:      feature,
        BaselineMean: baseMean,
        CurrentMean:  currMean,
        DriftScore:   drift,
        Drifted:      drift > dd.threshold,
        Threshold:    dd.threshold,
    }
}

// DriftReport contains drift detection results
type DriftReport struct {
    DetectorName    string
    Timestamp       time.Time
    HasDrift        bool
    DriftedFeatures []string
    // MissingFeatures were in the baseline but absent from the current
    // window. This is a data pipeline failure, not drift.
    MissingFeatures []string
    Features        map[string]*FeatureDrift
}

// FeatureDrift contains drift info for a single feature
type FeatureDrift struct {
    Feature      string
    BaselineMean float64
    CurrentMean  float64
    DriftScore   float64
    Drifted      bool
    Threshold    float64
}

// ComputeStatistics computes statistics from data
func ComputeStatistics(data map[string][]float64) *FeatureStatistics {
    stats := &FeatureStatistics{
        Mean:    make(map[string]float64),
        Std:     make(map[string]float64),
        Min:     make(map[string]float64),
        Max:     make(map[string]float64),
        Updated: time.Now(),
    }

    for feature, values := range data {
        if len(values) == 0 {
            continue
        }

        // Mean
        sum := 0.0
        min := values[0]
        max := values[0]

        for _, v := range values {
            sum += v
            if v < min {
                min = v
            }
            if v > max {
                max = v
            }
        }

        mean := sum / float64(len(values))

        // Standard deviation
        variance := 0.0
        for _, v := range values {
            variance += (v - mean) * (v - mean)
        }
        variance /= float64(len(values))
        std := math.Sqrt(variance)

        stats.Mean[feature] = mean
        stats.Std[feature] = std
        stats.Min[feature] = min
        stats.Max[feature] = max

        // Count is per-window, not per-feature: assigning it inside this loop
        // leaves whichever feature the map happened to yield last, and map
        // order is randomized. Take the max so a ragged input cannot make the
        // sample look smaller than it was.
        if n := int64(len(values)); n > stats.Count {
            stats.Count = n
        }
    }

    return stats
}
```

### Model Performance Monitoring

Model performance monitoring tracks prediction quality over time by comparing model outputs against ground-truth labels as they become available. The monitor computes rolling accuracy, precision, recall, and latency metrics, then fires alerts when any metric crosses a degradation threshold.

```go
// pkg/monitoring/performance.go
package monitoring

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// ModelMonitor monitors model performance
type ModelMonitor struct {
    modelName    string
    metrics      *PerformanceMetrics
    alertManager *AlertManager
    mu           sync.RWMutex
}

// PerformanceMetrics tracks model performance
type PerformanceMetrics struct {
    Predictions      int64
    Errors           int64
    Latencies        []float64
    Accuracies       []float64
    LastUpdate       time.Time
    ErrorRate        float64
    AverageLatency   float64
    AverageAccuracy  float64
    mu               sync.RWMutex
}

func NewModelMonitor(modelName string, alertMgr *AlertManager) *ModelMonitor {
    return &ModelMonitor{
        modelName:    modelName,
        alertManager: alertMgr,
        metrics: &PerformanceMetrics{
            Latencies:  make([]float64, 0),
            Accuracies: make([]float64, 0),
        },
    }
}

// RecordPrediction records a prediction
func (mm *ModelMonitor) RecordPrediction(latency float64, accuracy float64, err error) {
    mm.metrics.mu.Lock()
    defer mm.metrics.mu.Unlock()

    mm.metrics.Predictions++
    mm.metrics.Latencies = append(mm.metrics.Latencies, latency)

    if accuracy >= 0 {
        mm.metrics.Accuracies = append(mm.metrics.Accuracies, accuracy)
    }

    if err != nil {
        mm.metrics.Errors++
    }

    mm.metrics.LastUpdate = time.Now()

    // Keep only last 1000 samples
    if len(mm.metrics.Latencies) > 1000 {
        mm.metrics.Latencies = mm.metrics.Latencies[len(mm.metrics.Latencies)-1000:]
    }
    if len(mm.metrics.Accuracies) > 1000 {
        mm.metrics.Accuracies = mm.metrics.Accuracies[len(mm.metrics.Accuracies)-1000:]
    }

    // Recompute aggregates
    mm.updateAggregates()
}

func (mm *ModelMonitor) updateAggregates() {
    // Error rate
    if mm.metrics.Predictions > 0 {
        mm.metrics.ErrorRate = float64(mm.metrics.Errors) / float64(mm.metrics.Predictions)
    }

    // Average latency
    if len(mm.metrics.Latencies) > 0 {
        sum := 0.0
        for _, l := range mm.metrics.Latencies {
            sum += l
        }
        mm.metrics.AverageLatency = sum / float64(len(mm.metrics.Latencies))
    }

    // Average accuracy
    if len(mm.metrics.Accuracies) > 0 {
        sum := 0.0
        for _, a := range mm.metrics.Accuracies {
            sum += a
        }
        mm.metrics.AverageAccuracy = sum / float64(len(mm.metrics.Accuracies))
    }
}

// GetMetrics returns current metrics
func (mm *ModelMonitor) GetMetrics() *PerformanceMetrics {
    mm.metrics.mu.RLock()
    defer mm.metrics.mu.RUnlock()

    return &PerformanceMetrics{
        Predictions:     mm.metrics.Predictions,
        Errors:          mm.metrics.Errors,
        Latencies:       append([]float64{}, mm.metrics.Latencies...),
        Accuracies:      append([]float64{}, mm.metrics.Accuracies...),
        LastUpdate:      mm.metrics.LastUpdate,
        ErrorRate:       mm.metrics.ErrorRate,
        AverageLatency:  mm.metrics.AverageLatency,
        AverageAccuracy: mm.metrics.AverageAccuracy,
    }
}

// CheckThresholds checks if metrics exceed thresholds
func (mm *ModelMonitor) CheckThresholds(ctx context.Context,
    thresholds *PerformanceThresholds) error {

    metrics := mm.GetMetrics()

    // Check error rate
    if metrics.ErrorRate > thresholds.MaxErrorRate {
        alert := &Alert{
            Severity:  SeverityCritical,
            Model:     mm.modelName,
            Metric:    "error_rate",
            Value:     metrics.ErrorRate,
            Threshold: thresholds.MaxErrorRate,
            Message: fmt.Sprintf("Error rate %.2f%% exceeds threshold %.2f%%",
                metrics.ErrorRate*100, thresholds.MaxErrorRate*100),
            Timestamp: time.Now(),
        }
        mm.alertManager.SendAlert(ctx, alert)
    }

    // Check latency
    if metrics.AverageLatency > thresholds.MaxLatency {
        alert := &Alert{
            Severity:  SeverityWarning,
            Model:     mm.modelName,
            Metric:    "latency",
            Value:     metrics.AverageLatency,
            Threshold: thresholds.MaxLatency,
            Message: fmt.Sprintf("Average latency %.2fms exceeds threshold %.2fms",
                metrics.AverageLatency, thresholds.MaxLatency),
            Timestamp: time.Now(),
        }
        mm.alertManager.SendAlert(ctx, alert)
    }

    // Check accuracy
    if metrics.AverageAccuracy < thresholds.MinAccuracy {
        alert := &Alert{
            Severity:  SeverityCritical,
            Model:     mm.modelName,
            Metric:    "accuracy",
            Value:     metrics.AverageAccuracy,
            Threshold: thresholds.MinAccuracy,
            Message: fmt.Sprintf("Accuracy %.2f%% below threshold %.2f%%",
                metrics.AverageAccuracy*100, thresholds.MinAccuracy*100),
            Timestamp: time.Now(),
        }
        mm.alertManager.SendAlert(ctx, alert)
    }

    return nil
}

// PerformanceThresholds defines alert thresholds
type PerformanceThresholds struct {
    MaxErrorRate float64
    MaxLatency   float64
    MinAccuracy  float64
}

// AlertManager manages alerts
type AlertManager struct {
    handlers []AlertHandler
    mu       sync.RWMutex
}

// AlertHandler handles alerts
type AlertHandler interface {
    Handle(ctx context.Context, alert *Alert) error
}

type AlertSeverity string

const (
    SeverityInfo     AlertSeverity = "info"
    SeverityWarning  AlertSeverity = "warning"
    SeverityCritical AlertSeverity = "critical"
)

// Alert represents a monitoring alert
type Alert struct {
    Severity  AlertSeverity
    Model     string
    Metric    string
    Value     float64
    Threshold float64
    Message   string
    Timestamp time.Time
}

func NewAlertManager() *AlertManager {
    return &AlertManager{
        handlers: make([]AlertHandler, 0),
    }
}

// AddHandler adds an alert handler
func (am *AlertManager) AddHandler(handler AlertHandler) {
    am.mu.Lock()
    defer am.mu.Unlock()
    am.handlers = append(am.handlers, handler)
}

// SendAlert sends an alert to all handlers
func (am *AlertManager) SendAlert(ctx context.Context, alert *Alert) error {
    am.mu.RLock()
    handlers := am.handlers
    am.mu.RUnlock()

    for _, handler := range handlers {
        if err := handler.Handle(ctx, alert); err != nil {
            // Log error but continue with other handlers
            fmt.Printf("Alert handler error: %v\n", err)
        }
    }

    return nil
}

// LogAlertHandler logs alerts
type LogAlertHandler struct{}

func (h *LogAlertHandler) Handle(ctx context.Context, alert *Alert) error {
    fmt.Printf("[%s] %s - Model: %s, Metric: %s, Value: %.2f, Threshold: %.2f\n",
        alert.Severity, alert.Message, alert.Model, alert.Metric,
        alert.Value, alert.Threshold)
    return nil
}
```

One structural caveat about `CheckThresholds`: it compares against *lifetime* averages. `ErrorRate` divides all errors by all predictions since process start, so a model that begins failing after a week of healthy traffic barely moves the average, and the alert never fires. `AverageLatency` and `AverageAccuracy` are computed over the last 1000 samples, which is better but still a mean, and a mean hides the tail that your SLO is actually written against. Real monitoring windows by time, alerts on percentiles rather than averages, and compares a recent window to a baseline window. The shape here is right, the statistics are the part to replace first.

### Junior → FAANG: ML Monitoring as a First-Class Engineering Concern

ML model monitoring is fundamentally different from service monitoring, and many backend engineers underestimate it. Service monitoring checks if the service is up and responding within SLA. ML monitoring checks if the service is giving correct answers. A model can be 100% available and serve every request within SLA while silently giving wrong predictions for an entire user cohort. The only way to catch this is to monitor the statistical properties of predictions over time and compare them to a validated baseline.

Start with three metrics and expand from there. First, monitor the prediction score distribution: the histogram of model output values should be stable over time. A sudden shift in the distribution (the model is predicting high probability for everyone) often indicates a feature pipeline failure rather than model degradation. Second, monitor the feature distribution for your most important input features: if the feature values shift outside the training distribution, the model is extrapolating rather than interpolating. Third, monitor the business outcome: if you have delayed labels available, compare recent model precision and recall to the baseline from when the model was last evaluated.

For interviews, when asked "how do you monitor an ML model in production?", structure your answer in three layers: infrastructure monitoring (is the service up?), prediction quality monitoring (is the distribution of outputs stable?), and business outcome monitoring (are the outcomes driven by model predictions meeting their targets?). Walk through what you would alert on in each layer and what the remediation steps are.

### Senior @ FAANG: ML Observability as Infrastructure

Senior engineers design ML monitoring as a shared infrastructure concern, not a per-model implementation. The monitoring platform should: receive a stream of inference events (request, features, prediction, model version), compute drift statistics on a rolling window, compare against baselines stored at training time, and emit alerts when thresholds are exceeded. Model teams register their drift thresholds and baseline statistics during model promotion, and the monitoring platform handles the rest automatically.

Population Stability Index (PSI) and Kullback-Leibler divergence are the standard drift metrics for continuous features. For categorical features, the chi-squared test on the distribution of categories is the standard approach. Each metric has a threshold: PSI below 0.1 is stable, between 0.1 and 0.25 is worth investigating, above 0.25 is significant drift requiring action. These thresholds are industry conventions, not universal truths, and senior engineers calibrate them to the specific sensitivity requirements of each model based on the cost of false positives (unnecessary retraining triggered) versus false negatives (actual drift missed).

Monitoring feedback loops are a subtle risk that senior engineers must design against. If the monitoring system alerts when drift is detected, and the response to the alert is to retrain the model on the current data distribution, and the current data distribution reflects the model's own predictions from the last cycle, the feedback loop can cause the model to progressively diverge from the original training distribution in ways that are invisible to the drift detection metrics. Designing the monitoring system to track absolute metrics against the original training baseline, not just relative metrics against the last retraining baseline, prevents this failure mode.

At L6, ML monitoring governance includes defining SLOs for the monitoring system itself: how quickly must drift be detected (detection latency), how often does the monitoring system produce false positive alerts (alert precision), and what is the maximum tolerable drift before the monitoring system must alert (sensitivity). These SLOs drive the design of the statistical methods, the alerting thresholds, and the data retention policies. Writing these SLOs down and reviewing them annually as the model portfolio evolves is a staff-level responsibility.

The monitoring data pipeline is itself a production system that must be reliable. If the monitoring system fails silently during a period of model drift, the drift goes undetected and causes production degradation. Monitoring the monitoring system (meta-monitoring) is therefore required: alert if no monitoring events have been received in the last 10 minutes, alert if the drift computation job has not completed within its expected window, and alert if the baseline statistics used for drift comparison are stale. These meta-alerts ensure the monitoring system is itself operating correctly.
