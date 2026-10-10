// internal/service/monitoring/service.go
package monitoring

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
	"uuid"

	"github.com/example/ml-platform/internal/storage"
)

// Service handles ML model monitoring
type Service struct {
	store         storage.MonitoringStore
	alertManager  *AlertManager
	driftDetector *DriftDetector
	metrics       *MonitoringMetrics
}

// NewService creates a new monitoring service
func NewService(store storage.MonitoringStore) *Service {
	return &Service{
		store:         store,
		alertManager:  NewAlertManager(),
		driftDetector: NewDriftDetector(),
		metrics:       NewMonitoringMetrics(),
	}
}

// RecordPrediction records a prediction for monitoring
func (s *Service) RecordPrediction(ctx context.Context, req RecordPredictionRequest) error {
	record := &storage.PredictionRecord{
		ID:           uuid.New(),
		ModelName:    req.ModelName,
		ModelVersion: req.ModelVersion,
		Timestamp:    time.Now(),
		Inputs:       req.Inputs,
		Outputs:      req.Outputs,
		LatencyMS:    req.LatencyMS,
		GroundTruth:  req.GroundTruth,
	}

	if err := s.store.RecordPrediction(ctx, record); err != nil {
		return fmt.Errorf("recording prediction: %w", err)
	}

	s.metrics.RecordPrediction(req.ModelName, req.LatencyMS)

	if err := s.checkDataDrift(ctx, req.ModelName, req.Inputs); err != nil {
		fmt.Printf("Error checking data drift: %v\n", err)
	}

	return nil
}

// RecordGroundTruth records ground truth for a prediction
func (s *Service) RecordGroundTruth(ctx context.Context, predictionID uuid.UUID, groundTruth any) error {
	if err := s.store.UpdatePredictionGroundTruth(ctx, predictionID, groundTruth); err != nil {
		return fmt.Errorf("recording ground truth: %w", err)
	}
	return nil
}

// checkDataDrift detects if input data has drifted
func (s *Service) checkDataDrift(ctx context.Context, modelName string, inputs map[string]any) error {
	baseline, err := s.store.GetBaselineStatistics(ctx, modelName)
	if err != nil {
		return fmt.Errorf("getting baseline: %w", err)
	}

	current := s.calculateInputStatistics(inputs)

	for feature, currentStats := range current {
		baselineStats, ok := baseline[feature]
		if !ok {
			continue
		}

		driftScore := s.driftDetector.DetectDrift(baselineStats, currentStats)

		if driftScore > 0.1 {
			s.alertManager.RaiseAlert(Alert{
				Type:      AlertTypeDataDrift,
				Severity:  AlertSeverityWarning,
				ModelName: modelName,
				Feature:   feature,
				Message:   fmt.Sprintf("Data drift detected for feature %s (score: %.3f)", feature, driftScore),
				Timestamp: time.Now(),
			})
		}
	}

	return nil
}

// calculateInputStatistics calculates statistics for input data
func (s *Service) calculateInputStatistics(inputs map[string]any) storage.BaselineStats {
	stats := make(storage.BaselineStats)

	for feature, value := range inputs {
		switch v := value.(type) {
		case float64:
			stats[feature] = &storage.FeatureStatistics{
				Mean:   v,
				StdDev: 0,
				Min:    v,
				Max:    v,
			}
		case []float64:
			stats[feature] = calculateArrayStats(v)
		}
	}

	return stats
}

func calculateArrayStats(values []float64) *storage.FeatureStatistics {
	if len(values) == 0 {
		return nil
	}

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

	variance := 0.0
	for _, v := range values {
		diff := v - mean
		variance += diff * diff
	}
	variance /= float64(len(values))
	stdDev := math.Sqrt(variance)

	return &storage.FeatureStatistics{
		Mean:   mean,
		StdDev: stdDev,
		Min:    min,
		Max:    max,
	}
}

// GetModelPerformance retrieves model performance metrics
func (s *Service) GetModelPerformance(ctx context.Context, modelName string, timeRange TimeRange) (*ModelPerformance, error) {
	predictions, err := s.store.GetPredictions(ctx, modelName, timeRange.Start, timeRange.End)
	if err != nil {
		return nil, fmt.Errorf("getting predictions: %w", err)
	}

	performance := &ModelPerformance{
		ModelName:        modelName,
		TimeRange:        timeRange,
		TotalPredictions: len(predictions),
	}

	correctPredictions := 0
	totalLatency := int64(0)

	for _, pred := range predictions {
		if pred.GroundTruth != nil {
			if s.isPredictionCorrect(pred.Outputs, pred.GroundTruth) {
				correctPredictions++
			}
		}
		totalLatency += pred.LatencyMS
	}

	if len(predictions) > 0 {
		performance.Accuracy = float64(correctPredictions) / float64(len(predictions))
		performance.AvgLatencyMS = float64(totalLatency) / float64(len(predictions))
	}

	return performance, nil
}

func (s *Service) isPredictionCorrect(output, groundTruth any) bool {
	return fmt.Sprintf("%v", output) == fmt.Sprintf("%v", groundTruth)
}

// DriftDetector detects data drift
type DriftDetector struct{}

func NewDriftDetector() *DriftDetector { return &DriftDetector{} }

func (d *DriftDetector) DetectDrift(baseline, current *storage.FeatureStatistics) float64 {
	meanDiff := math.Abs(baseline.Mean-current.Mean) / (baseline.StdDev + 1e-6)
	stdDevDiff := math.Abs(baseline.StdDev-current.StdDev) / (baseline.StdDev + 1e-6)
	return (meanDiff + stdDevDiff) / 2.0
}

// AlertManager manages alerts
type AlertManager struct {
	mu     sync.RWMutex
	alerts []Alert
}

func NewAlertManager() *AlertManager {
	return &AlertManager{alerts: make([]Alert, 0)}
}

func (a *AlertManager) RaiseAlert(alert Alert) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.alerts = append(a.alerts, alert)
	fmt.Printf("[ALERT] %s: %s\n", alert.Type, alert.Message)
}

func (a *AlertManager) GetAlerts() []Alert {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return append([]Alert{}, a.alerts...)
}

// Types

type RecordPredictionRequest struct {
	ModelName    string         `json:"model_name"`
	ModelVersion int            `json:"model_version"`
	Inputs       map[string]any `json:"inputs"`
	Outputs      map[string]any `json:"outputs"`
	LatencyMS    int64          `json:"latency_ms"`
	GroundTruth  any            `json:"ground_truth,omitempty"`
}

type Alert struct {
	Type      AlertType     `json:"type"`
	Severity  AlertSeverity `json:"severity"`
	ModelName string        `json:"model_name"`
	Feature   string        `json:"feature,omitempty"`
	Message   string        `json:"message"`
	Timestamp time.Time     `json:"timestamp"`
}

type AlertType string

const (
	AlertTypeDataDrift       AlertType = "DATA_DRIFT"
	AlertTypePerformanceDrop AlertType = "PERFORMANCE_DROP"
	AlertTypeHighLatency     AlertType = "HIGH_LATENCY"
	AlertTypeHighErrorRate   AlertType = "HIGH_ERROR_RATE"
)

type AlertSeverity string

const (
	AlertSeverityInfo     AlertSeverity = "INFO"
	AlertSeverityWarning  AlertSeverity = "WARNING"
	AlertSeverityCritical AlertSeverity = "CRITICAL"
)

type TimeRange struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

type ModelPerformance struct {
	ModelName        string    `json:"model_name"`
	TimeRange        TimeRange `json:"time_range"`
	TotalPredictions int       `json:"total_predictions"`
	Accuracy         float64   `json:"accuracy"`
	Precision        float64   `json:"precision"`
	Recall           float64   `json:"recall"`
	F1Score          float64   `json:"f1_score"`
	AvgLatencyMS     float64   `json:"avg_latency_ms"`
	ErrorRate        float64   `json:"error_rate"`
}

// MonitoringMetrics tracks real-time monitoring metrics
type MonitoringMetrics struct {
	mu               sync.RWMutex
	predictionCounts map[string]int64
	totalLatency     map[string]int64
}

func NewMonitoringMetrics() *MonitoringMetrics {
	return &MonitoringMetrics{
		predictionCounts: make(map[string]int64),
		totalLatency:     make(map[string]int64),
	}
}

func (m *MonitoringMetrics) RecordPrediction(modelName string, latencyMS int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.predictionCounts[modelName]++
	m.totalLatency[modelName] += latencyMS
}
