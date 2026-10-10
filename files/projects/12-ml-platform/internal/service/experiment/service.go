// internal/service/experiment/service.go
package experiment

import (
	"context"
	"fmt"
	"math"
	"time"
	"uuid"

	"github.com/example/ml-platform/internal/domain"
	"github.com/example/ml-platform/internal/storage"
)

// Service handles experiment tracking operations
type Service struct {
	store         storage.ExperimentStore
	artifactStore storage.ArtifactStore
	metricStore   storage.MetricStore
}

// NewService creates a new experiment service
func NewService(
	store storage.ExperimentStore,
	artifactStore storage.ArtifactStore,
	metricStore storage.MetricStore,
) *Service {
	return &Service{
		store:         store,
		artifactStore: artifactStore,
		metricStore:   metricStore,
	}
}

// CreateExperiment creates a new experiment
func (s *Service) CreateExperiment(ctx context.Context, req CreateExperimentRequest) (*domain.Experiment, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	// Check for duplicate name
	exists, err := s.store.ExperimentNameExists(ctx, req.Name)
	if err != nil {
		return nil, fmt.Errorf("checking name: %w", err)
	}
	if exists {
		return nil, fmt.Errorf("experiment with name %s already exists", req.Name)
	}

	experiment := &domain.Experiment{
		ID:          uuid.New(),
		Name:        req.Name,
		Description: req.Description,
		Tags:        req.Tags,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
		CreatedBy:   req.CreatedBy,
		Metadata:    req.Metadata,
	}

	if err := s.store.CreateExperiment(ctx, experiment); err != nil {
		return nil, fmt.Errorf("creating experiment: %w", err)
	}

	return experiment, nil
}

// CreateRun creates a new run within an experiment
func (s *Service) CreateRun(ctx context.Context, req CreateRunRequest) (*domain.Run, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	// Verify experiment exists
	experiment, err := s.store.GetExperiment(ctx, req.ExperimentID)
	if err != nil {
		return nil, fmt.Errorf("getting experiment: %w", err)
	}
	if experiment == nil {
		return nil, fmt.Errorf("experiment %s not found", req.ExperimentID)
	}

	run := &domain.Run{
		ID:           uuid.New(),
		ExperimentID: req.ExperimentID,
		Name:         req.Name,
		Status:       domain.RunStatusRunning,
		StartTime:    time.Now(),
		Parameters:   req.Parameters,
		Metrics:      make(map[string]float64),
		Tags:         req.Tags,
		SourceType:   req.SourceType,
		SourceName:   req.SourceName,
		GitCommit:    req.GitCommit,
		GitBranch:    req.GitBranch,
		User:         req.User,
		Artifacts:    make([]domain.Artifact, 0),
	}

	if err := s.store.CreateRun(ctx, run); err != nil {
		return nil, fmt.Errorf("creating run: %w", err)
	}

	return run, nil
}

// LogMetric logs a metric value for a run
func (s *Service) LogMetric(ctx context.Context, runID uuid.UUID, key string, value float64, step int64) error {
	run, err := s.store.GetRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("getting run: %w", err)
	}
	if run == nil {
		return fmt.Errorf("run %s not found", runID)
	}
	if run.Status != domain.RunStatusRunning {
		return fmt.Errorf("run %s is not active (status: %s)", runID, run.Status)
	}

	metric := &domain.MetricPoint{
		RunID:     runID,
		Key:       key,
		Value:     value,
		Timestamp: time.Now(),
		Step:      step,
	}

	if err := s.metricStore.LogMetric(ctx, metric); err != nil {
		return fmt.Errorf("logging metric: %w", err)
	}

	run.Metrics[key] = value
	if err := s.store.UpdateRun(ctx, run); err != nil {
		return fmt.Errorf("updating run: %w", err)
	}

	return nil
}

// LogMetrics logs multiple metrics at once (batch operation for efficiency)
func (s *Service) LogMetrics(ctx context.Context, runID uuid.UUID, metrics map[string]float64, step int64) error {
	run, err := s.store.GetRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("getting run: %w", err)
	}
	if run == nil {
		return fmt.Errorf("run %s not found", runID)
	}
	if run.Status != domain.RunStatusRunning {
		return fmt.Errorf("run %s is not active", runID)
	}

	metricPoints := make([]*domain.MetricPoint, 0, len(metrics))
	now := time.Now()

	for key, value := range metrics {
		metricPoints = append(metricPoints, &domain.MetricPoint{
			RunID:     runID,
			Key:       key,
			Value:     value,
			Timestamp: now,
			Step:      step,
		})
		run.Metrics[key] = value
	}

	if err := s.metricStore.LogMetricBatch(ctx, metricPoints); err != nil {
		return fmt.Errorf("logging metrics: %w", err)
	}

	if err := s.store.UpdateRun(ctx, run); err != nil {
		return fmt.Errorf("updating run: %w", err)
	}

	return nil
}

// LogArtifact logs an artifact for a run
func (s *Service) LogArtifact(ctx context.Context, req LogArtifactRequest) (*domain.Artifact, error) {
	run, err := s.store.GetRun(ctx, req.RunID)
	if err != nil {
		return nil, fmt.Errorf("getting run: %w", err)
	}
	if run == nil {
		return nil, fmt.Errorf("run %s not found", req.RunID)
	}

	// Upload artifact to storage (S3/MinIO)
	storageURI, hash, err := s.artifactStore.UploadArtifact(ctx, req.Data, req.Path)
	if err != nil {
		return nil, fmt.Errorf("uploading artifact: %w", err)
	}

	artifact := &domain.Artifact{
		ID:         uuid.New(),
		RunID:      req.RunID,
		Path:       req.Path,
		Type:       req.Type,
		Size:       int64(len(req.Data)),
		Hash:       hash,
		CreatedAt:  time.Now(),
		StorageURI: storageURI,
	}

	if err := s.store.CreateArtifact(ctx, artifact); err != nil {
		return nil, fmt.Errorf("creating artifact: %w", err)
	}

	return artifact, nil
}

// FinishRun marks a run as completed
func (s *Service) FinishRun(ctx context.Context, runID uuid.UUID, status domain.RunStatus) error {
	run, err := s.store.GetRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("getting run: %w", err)
	}
	if run == nil {
		return fmt.Errorf("run %s not found", runID)
	}

	now := time.Now()
	run.Status = status
	run.EndTime = &now

	if err := s.store.UpdateRun(ctx, run); err != nil {
		return fmt.Errorf("updating run: %w", err)
	}

	return nil
}

// GetMetricHistory retrieves the history of a metric for a run
func (s *Service) GetMetricHistory(ctx context.Context, runID uuid.UUID, key string) ([]domain.MetricPoint, error) {
	metrics, err := s.metricStore.GetMetricHistory(ctx, runID, key)
	if err != nil {
		return nil, fmt.Errorf("getting metric history: %w", err)
	}
	return metrics, nil
}

// CompareRuns compares multiple runs side-by-side
func (s *Service) CompareRuns(ctx context.Context, runIDs []uuid.UUID) (*RunComparison, error) {
	runs := make([]*domain.Run, 0, len(runIDs))

	for _, id := range runIDs {
		run, err := s.store.GetRun(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("getting run %s: %w", id, err)
		}
		if run == nil {
			return nil, fmt.Errorf("run %s not found", id)
		}
		runs = append(runs, run)
	}

	return compareRuns(runs), nil
}

// Request/Response types

type CreateExperimentRequest struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Tags        map[string]string `json:"tags"`
	CreatedBy   string            `json:"created_by"`
	Metadata    map[string]any    `json:"metadata"`
}

func (r CreateExperimentRequest) Validate() error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if r.CreatedBy == "" {
		return fmt.Errorf("created_by is required")
	}
	return nil
}

type CreateRunRequest struct {
	ExperimentID uuid.UUID         `json:"experiment_id"`
	Name         string            `json:"name"`
	Parameters   map[string]any    `json:"parameters"`
	Tags         map[string]string `json:"tags"`
	SourceType   string            `json:"source_type"`
	SourceName   string            `json:"source_name"`
	GitCommit    string            `json:"git_commit"`
	GitBranch    string            `json:"git_branch"`
	User         string            `json:"user"`
}

func (r CreateRunRequest) Validate() error {
	if r.ExperimentID == uuid.Nil() {
		return fmt.Errorf("experiment_id is required")
	}
	if r.User == "" {
		return fmt.Errorf("user is required")
	}
	return nil
}

type LogArtifactRequest struct {
	RunID uuid.UUID `json:"run_id"`
	Path  string    `json:"path"`
	Type  string    `json:"type"`
	Data  []byte    `json:"data"`
}

type RunComparison struct {
	Runs          []*domain.Run           `json:"runs"`
	CommonParams  map[string]any          `json:"common_params"`
	DiffParams    map[string][]any        `json:"diff_params"`
	CommonMetrics map[string]bool         `json:"common_metrics"`
	MetricSummary map[string]*MetricStats `json:"metric_summary"`
}

type MetricStats struct {
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Mean   float64 `json:"mean"`
	StdDev float64 `json:"std_dev"`
}

// Helper function to compare runs
func compareRuns(runs []*domain.Run) *RunComparison {
	comparison := &RunComparison{
		Runs:          runs,
		CommonParams:  make(map[string]any),
		DiffParams:    make(map[string][]any),
		CommonMetrics: make(map[string]bool),
		MetricSummary: make(map[string]*MetricStats),
	}

	if len(runs) == 0 {
		return comparison
	}

	// Find common and different parameters
	allParams := make(map[string]map[any]bool)
	for _, run := range runs {
		for k, v := range run.Parameters {
			if allParams[k] == nil {
				allParams[k] = make(map[any]bool)
			}
			allParams[k][v] = true
		}
	}

	for param, values := range allParams {
		if len(values) == 1 {
			for v := range values {
				comparison.CommonParams[param] = v
			}
		} else {
			vals := make([]any, 0, len(runs))
			for _, run := range runs {
				vals = append(vals, run.Parameters[param])
			}
			comparison.DiffParams[param] = vals
		}
	}

	// Find common metrics and compute statistics
	allMetrics := make(map[string]bool)
	for _, run := range runs {
		for metric := range run.Metrics {
			allMetrics[metric] = true
		}
	}

	for metric := range allMetrics {
		hasAll := true
		values := make([]float64, 0, len(runs))

		for _, run := range runs {
			if val, ok := run.Metrics[metric]; ok {
				values = append(values, val)
			} else {
				hasAll = false
				break
			}
		}

		comparison.CommonMetrics[metric] = hasAll

		if len(values) > 0 {
			comparison.MetricSummary[metric] = computeStats(values)
		}
	}

	return comparison
}

func computeStats(values []float64) *MetricStats {
	if len(values) == 0 {
		return nil
	}

	stats := &MetricStats{
		Min: values[0],
		Max: values[0],
	}

	sum := 0.0
	for _, v := range values {
		if v < stats.Min {
			stats.Min = v
		}
		if v > stats.Max {
			stats.Max = v
		}
		sum += v
	}

	stats.Mean = sum / float64(len(values))

	// Compute standard deviation
	variance := 0.0
	for _, v := range values {
		diff := v - stats.Mean
		variance += diff * diff
	}
	variance /= float64(len(values))
	stats.StdDev = math.Sqrt(variance)

	return stats
}
