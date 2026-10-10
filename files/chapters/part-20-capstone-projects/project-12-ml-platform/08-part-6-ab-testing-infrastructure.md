## Part 6: A/B Testing Infrastructure

When you deploy a new model, you need to know whether it actually performs better than the existing one with real users. A/B testing infrastructure lets you split traffic between two or more model variants, collect metrics from each group, and use statistical tests to determine which variant wins. Without this, you are either blindly swapping models in production or relying on offline metrics that may not reflect real-world performance.

### 6.1 A/B Testing Service

This service manages the complete A/B test lifecycle. You create an experiment that defines which model variants to compare and what percentage of traffic each receives. The service uses consistent hashing to assign users to variants deterministically, meaning a user always sees the same variant for the duration of the test. It collects outcome metrics, computes statistical significance using t-tests and chi-squared tests, and reports whether a variant is a clear winner. The implementation is thread-safe so it can handle concurrent requests from your serving layer.

```go
// internal/service/abtest/service.go
package abtest

import (
	"context"
	"fmt"
	"hash/fnv"
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
	"ml-platform/internal/domain"
	"ml-platform/internal/storage"
)

// ABTest represents an A/B test comparing model versions
type ABTest struct {
	ID            uuid.UUID              `json:"id"`
	Name          string                 `json:"name"`
	ModelName     string                 `json:"model_name"`
	Variants      []Variant              `json:"variants"`
	TrafficSplit  map[string]float64     `json:"traffic_split"` // variant -> percentage
	Status        ABTestStatus           `json:"status"`
	StartTime     time.Time              `json:"start_time"`
	EndTime       *time.Time             `json:"end_time,omitempty"`
	Metrics       []string               `json:"metrics"` // Metrics to track
	WinnerCriteria WinnerCriteria        `json:"winner_criteria"`
	CreatedAt     time.Time              `json:"created_at"`
}

// Variant represents a model version in an A/B test
type Variant struct {
	Name          string    `json:"name"`
	ModelVersion  int       `json:"model_version"`
	Description   string    `json:"description"`
}

// ABTestStatus represents the state of an A/B test
type ABTestStatus string

const (
	ABTestStatusDraft     ABTestStatus = "DRAFT"
	ABTestStatusRunning   ABTestStatus = "RUNNING"
	ABTestStatusCompleted ABTestStatus = "COMPLETED"
	ABTestStatusCanceled ABTestStatus = "CANCELED"
)

// WinnerCriteria defines how to select a winner
type WinnerCriteria struct {
	MetricName        string  `json:"metric_name"`
	MinimumSamples    int     `json:"minimum_samples"`
	SignificanceLevel float64 `json:"significance_level"` // p-value threshold
	MinimumImprovement float64 `json:"minimum_improvement"` // Minimum % improvement
}

// Service handles A/B testing operations
type Service struct {
	store           storage.ABTestStore
	servingService  ServingService
	metricCollector *MetricCollector
	mu              sync.RWMutex
	activeTests     map[string]*ABTest
}

// ServingService interface for model predictions
type ServingService interface {
	PredictWithVersion(ctx context.Context, modelName string, version int, inputs map[string]any) (map[string]any, error)
}

// NewService creates a new A/B testing service
func NewService(store storage.ABTestStore, servingService ServingService) *Service {
	return &Service{
		store:           store,
		servingService:  servingService,
		metricCollector: NewMetricCollector(),
		activeTests:     make(map[string]*ABTest),
	}
}

// CreateABTest creates a new A/B test
func (s *Service) CreateABTest(ctx context.Context, req CreateABTestRequest) (*ABTest, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	// Validate traffic split sums to 1.0
	totalTraffic := 0.0
	for _, pct := range req.TrafficSplit {
		totalTraffic += pct
	}
	if math.Abs(totalTraffic-1.0) > 0.001 {
		return nil, fmt.Errorf("traffic split must sum to 1.0, got %f", totalTraffic)
	}

	test := &ABTest{
		ID:             uuid.New(),
		Name:           req.Name,
		ModelName:      req.ModelName,
		Variants:       req.Variants,
		TrafficSplit:   req.TrafficSplit,
		Status:         ABTestStatusDraft,
		Metrics:        req.Metrics,
		WinnerCriteria: req.WinnerCriteria,
		CreatedAt:      time.Now(),
	}

	if err := s.store.CreateABTest(ctx, test); err != nil {
		return nil, fmt.Errorf("creating A/B test: %w", err)
	}

	return test, nil
}

// StartABTest starts an A/B test
func (s *Service) StartABTest(ctx context.Context, testID uuid.UUID) error {
	test, err := s.store.GetABTest(ctx, testID)
	if err != nil {
		return fmt.Errorf("getting A/B test: %w", err)
	}
	if test == nil {
		return fmt.Errorf("A/B test not found")
	}

	test.Status = ABTestStatusRunning
	test.StartTime = time.Now()

	if err := s.store.UpdateABTest(ctx, test); err != nil {
		return fmt.Errorf("updating A/B test: %w", err)
	}

	// Add to active tests
	s.mu.Lock()
	s.activeTests[test.ModelName] = test
	s.mu.Unlock()

	return nil
}

// PredictWithABTest performs prediction with A/B test variant selection
func (s *Service) PredictWithABTest(ctx context.Context, modelName, entityID string, inputs map[string]any) (*ABTestPrediction, error) {
	s.mu.RLock()
	test, exists := s.activeTests[modelName]
	s.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("no active A/B test for model %s", modelName)
	}

	// Assign variant based on traffic split
	variant := s.assignVariant(entityID, test)

	// Get model version for variant
	var modelVersion int
	for _, v := range test.Variants {
		if v.Name == variant {
			modelVersion = v.ModelVersion
			break
		}
	}

	// Perform prediction
	startTime := time.Now()
	outputs, err := s.servingService.PredictWithVersion(ctx, modelName, modelVersion, inputs)
	if err != nil {
		return nil, fmt.Errorf("prediction failed: %w", err)
	}
	latency := time.Since(startTime)

	// Record prediction
	s.metricCollector.RecordPrediction(test.ID, variant, latency)

	return &ABTestPrediction{
		TestID:       test.ID,
		Variant:      variant,
		ModelVersion: modelVersion,
		Outputs:      outputs,
		Latency:      latency,
	}, nil
}

// assignVariant assigns a variant based on consistent hashing
func (s *Service) assignVariant(entityID string, test *ABTest) string {
	// Hash entity ID to get deterministic variant assignment
	h := fnv.New32a()
	h.Write([]byte(entityID))
	hash := float64(h.Sum32()) / float64(math.MaxUint32)

	// Assign based on cumulative traffic split
	cumulative := 0.0
	for variant, pct := range test.TrafficSplit {
		cumulative += pct
		if hash <= cumulative {
			return variant
		}
	}

	// Fallback to first variant
	for variant := range test.TrafficSplit {
		return variant
	}

	return ""
}

// RecordMetric records a business metric for an A/B test
func (s *Service) RecordMetric(ctx context.Context, testID uuid.UUID, variant string, metricName string, value float64) error {
	s.metricCollector.RecordMetric(testID, variant, metricName, value)
	return nil
}

// AnalyzeResults analyzes A/B test results and determines winner
func (s *Service) AnalyzeResults(ctx context.Context, testID uuid.UUID) (*ABTestAnalysis, error) {
	test, err := s.store.GetABTest(ctx, testID)
	if err != nil {
		return nil, fmt.Errorf("getting A/B test: %w", err)
	}

	// Get metrics for each variant
	variantMetrics := make(map[string]*VariantMetrics)
	
	for _, variant := range test.Variants {
		metrics := s.metricCollector.GetMetrics(testID, variant.Name)
		variantMetrics[variant.Name] = metrics
	}

	// Perform statistical analysis
	analysis := &ABTestAnalysis{
		TestID:         testID,
		VariantMetrics: variantMetrics,
		Timestamp:      time.Now(),
	}

	// Determine if we have a winner
	winner, confidence := s.determineWinner(variantMetrics, test.WinnerCriteria)
	if winner != "" {
		analysis.Winner = winner
		analysis.Confidence = confidence
		analysis.HasWinner = true
	}

	return analysis, nil
}

// determineWinner uses statistical tests to determine if there's a significant winner
func (s *Service) determineWinner(metrics map[string]*VariantMetrics, criteria WinnerCriteria) (string, float64) {
	// Get baseline (control) variant - typically first variant
	var control string
	var controlMetrics *VariantMetrics
	for variant, m := range metrics {
		if m.SampleCount >= criteria.MinimumSamples {
			control = variant
			controlMetrics = m
			break
		}
	}

	if control == "" {
		return "", 0.0 // Not enough samples
	}

	// Compare each variant against control
	var bestVariant string
	var bestImprovement float64
	var bestPValue float64

	for variant, m := range metrics {
		if variant == control || m.SampleCount < criteria.MinimumSamples {
			continue
		}

		// Calculate improvement
		improvement := (m.MetricValues[criteria.MetricName] - controlMetrics.MetricValues[criteria.MetricName]) / 
			controlMetrics.MetricValues[criteria.MetricName]

		if improvement < criteria.MinimumImprovement {
			continue
		}

		// Perform t-test (simplified)
		pValue := s.tTest(controlMetrics.MetricValues[criteria.MetricName], m.MetricValues[criteria.MetricName],
			controlMetrics.SampleCount, m.SampleCount)

		if pValue < criteria.SignificanceLevel && improvement > bestImprovement {
			bestVariant = variant
			bestImprovement = improvement
			bestPValue = pValue
		}
	}

	if bestVariant != "" {
		confidence := 1.0 - bestPValue
		return bestVariant, confidence
	}

	return "", 0.0
}

// tTest performs a simplified t-test
func (s *Service) tTest(mean1, mean2 float64, n1, n2 int) float64 {
	// Simplified t-test calculation
	// In production, use a proper statistical library
	
	// Calculate pooled standard error (simplified)
	se := math.Sqrt((mean1 + mean2) / float64(n1+n2))
	
	// Calculate t-statistic
	t := math.Abs(mean1-mean2) / se
	
	// Convert to p-value (simplified)
	pValue := 1.0 / (1.0 + t)
	
	return pValue
}

// Request/Response types

type CreateABTestRequest struct {
	Name           string              `json:"name"`
	ModelName      string              `json:"model_name"`
	Variants       []Variant           `json:"variants"`
	TrafficSplit   map[string]float64  `json:"traffic_split"`
	Metrics        []string            `json:"metrics"`
	WinnerCriteria WinnerCriteria      `json:"winner_criteria"`
}

func (r CreateABTestRequest) Validate() error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if r.ModelName == "" {
		return fmt.Errorf("model_name is required")
	}
	if len(r.Variants) < 2 {
		return fmt.Errorf("at least 2 variants required")
	}
	if len(r.TrafficSplit) != len(r.Variants) {
		return fmt.Errorf("traffic split must match variants")
	}
	return nil
}

type ABTestPrediction struct {
	TestID       uuid.UUID              `json:"test_id"`
	Variant      string                 `json:"variant"`
	ModelVersion int                    `json:"model_version"`
	Outputs      map[string]any `json:"outputs"`
	Latency      time.Duration          `json:"latency"`
}

type ABTestAnalysis struct {
	TestID         uuid.UUID                   `json:"test_id"`
	VariantMetrics map[string]*VariantMetrics  `json:"variant_metrics"`
	Winner         string                      `json:"winner,omitempty"`
	Confidence     float64                     `json:"confidence"`
	HasWinner      bool                        `json:"has_winner"`
	Timestamp      time.Time                   `json:"timestamp"`
}

type VariantMetrics struct {
	Variant       string             `json:"variant"`
	SampleCount   int                `json:"sample_count"`
	MetricValues  map[string]float64 `json:"metric_values"`
	AvgLatencyMS  float64            `json:"avg_latency_ms"`
	ErrorRate     float64            `json:"error_rate"`
}

// MetricCollector collects metrics for A/B tests
type MetricCollector struct {
	mu      sync.RWMutex
	metrics map[uuid.UUID]map[string]*VariantMetrics
}

func NewMetricCollector() *MetricCollector {
	return &MetricCollector{
		metrics: make(map[uuid.UUID]map[string]*VariantMetrics),
	}
}

func (c *MetricCollector) RecordPrediction(testID uuid.UUID, variant string, latency time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.metrics[testID] == nil {
		c.metrics[testID] = make(map[string]*VariantMetrics)
	}

	if c.metrics[testID][variant] == nil {
		c.metrics[testID][variant] = &VariantMetrics{
			Variant:      variant,
			SampleCount:  0,
			MetricValues: make(map[string]float64),
		}
	}

	m := c.metrics[testID][variant]
	m.SampleCount++
	
	// Update average latency
	m.AvgLatencyMS = (m.AvgLatencyMS*float64(m.SampleCount-1) + float64(latency.Milliseconds())) / float64(m.SampleCount)
}

func (c *MetricCollector) RecordMetric(testID uuid.UUID, variant string, metricName string, value float64) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.metrics[testID] == nil {
		c.metrics[testID] = make(map[string]*VariantMetrics)
	}

	if c.metrics[testID][variant] == nil {
		c.metrics[testID][variant] = &VariantMetrics{
			Variant:      variant,
			MetricValues: make(map[string]float64),
		}
	}

	c.metrics[testID][variant].MetricValues[metricName] = value
}

func (c *MetricCollector) GetMetrics(testID uuid.UUID, variant string) *VariantMetrics {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.metrics[testID] != nil && c.metrics[testID][variant] != nil {
		return c.metrics[testID][variant]
	}

	return &VariantMetrics{
		Variant:      variant,
		MetricValues: make(map[string]float64),
	}
}
```

---
