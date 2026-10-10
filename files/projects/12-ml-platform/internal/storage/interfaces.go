// internal/storage/interfaces.go
package storage

import (
	"context"
	"time"
	"uuid"

	"github.com/example/ml-platform/internal/domain"
)

// ExperimentStore defines persistence for experiments and runs
type ExperimentStore interface {
	CreateExperiment(ctx context.Context, e *domain.Experiment) error
	GetExperiment(ctx context.Context, id uuid.UUID) (*domain.Experiment, error)
	ListExperiments(ctx context.Context) ([]*domain.Experiment, error)
	ExperimentNameExists(ctx context.Context, name string) (bool, error)
	CreateRun(ctx context.Context, r *domain.Run) error
	GetRun(ctx context.Context, id uuid.UUID) (*domain.Run, error)
	UpdateRun(ctx context.Context, r *domain.Run) error
	CreateArtifact(ctx context.Context, a *domain.Artifact) error
}

// MetricStore defines persistence for metric points
type MetricStore interface {
	LogMetric(ctx context.Context, m *domain.MetricPoint) error
	LogMetricBatch(ctx context.Context, ms []*domain.MetricPoint) error
	GetMetricHistory(ctx context.Context, runID uuid.UUID, key string) ([]domain.MetricPoint, error)
}

// ModelStore defines persistence for registered models and versions
type ModelStore interface {
	CreateModel(ctx context.Context, m *domain.RegisteredModel) error
	GetModel(ctx context.Context, id uuid.UUID) (*domain.RegisteredModel, error)
	GetModelByName(ctx context.Context, name string) (*domain.RegisteredModel, error)
	UpdateModel(ctx context.Context, m *domain.RegisteredModel) error
	CreateModelVersion(ctx context.Context, v *domain.ModelVersion) error
	GetModelVersion(ctx context.Context, id uuid.UUID) (*domain.ModelVersion, error)
	GetModelVersionByNumber(ctx context.Context, modelID uuid.UUID, version int) (*domain.ModelVersion, error)
	GetModelVersionsByStage(ctx context.Context, modelID uuid.UUID, stage domain.ModelStage) ([]*domain.ModelVersion, error)
	UpdateModelVersion(ctx context.Context, v *domain.ModelVersion) error
	GetNextVersionNumber(ctx context.Context, modelID uuid.UUID) (int, error)
	CreateTransition(ctx context.Context, t *domain.ModelTransition) error
}

// FeatureStore defines persistence for feature groups and views
type FeatureStore interface {
	CreateFeatureGroup(ctx context.Context, fg *domain.FeatureGroup) error
	GetFeatureGroup(ctx context.Context, id uuid.UUID) (*domain.FeatureGroup, error)
	CreateFeatureView(ctx context.Context, fv *domain.FeatureView) error
	GetFeatureView(ctx context.Context, id uuid.UUID) (*domain.FeatureView, error)
}

// OfflineFeatureStore defines offline feature retrieval
type OfflineFeatureStore interface {
	GetFeatures(ctx context.Context, entityKey string, features []string) (map[string]any, error)
	GetPointInTimeFeatures(ctx context.Context, req domain.PointInTimeRequest) ([]domain.FeatureVector, error)
}

// PipelineStore defines persistence for pipelines and runs
type PipelineStore interface {
	GetPipeline(ctx context.Context, id uuid.UUID) (*domain.Pipeline, error)
	CreatePipelineRun(ctx context.Context, r *domain.PipelineRun) error
	UpdatePipelineRun(ctx context.Context, r *domain.PipelineRun) error
}

// PredictionRecord is a monitoring record stored in the database
type PredictionRecord struct {
	ID           uuid.UUID      `json:"id"`
	ModelName    string         `json:"model_name"`
	ModelVersion int            `json:"model_version"`
	Timestamp    time.Time      `json:"timestamp"`
	Inputs       map[string]any `json:"inputs"`
	Outputs      map[string]any `json:"outputs"`
	LatencyMS    int64          `json:"latency_ms"`
	GroundTruth  any            `json:"ground_truth,omitempty"`
}

// BaselineStats holds baseline statistics for drift detection
type BaselineStats map[string]*FeatureStatistics

// FeatureStatistics holds statistical properties of a feature
type FeatureStatistics struct {
	Mean   float64 `json:"mean"`
	StdDev float64 `json:"std_dev"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
}

// MonitoringStore defines persistence for prediction monitoring
type MonitoringStore interface {
	RecordPrediction(ctx context.Context, r *PredictionRecord) error
	UpdatePredictionGroundTruth(ctx context.Context, id uuid.UUID, gt any) error
	GetBaselineStatistics(ctx context.Context, modelName string) (BaselineStats, error)
	GetPredictions(ctx context.Context, modelName string, start, end time.Time) ([]*PredictionRecord, error)
}

// ABTest is defined in the abtest service package; storage uses any here to avoid circular imports
type ABTestStore interface {
	CreateABTest(ctx context.Context, test any) error
	GetABTest(ctx context.Context, id uuid.UUID) (any, error)
	UpdateABTest(ctx context.Context, test any) error
	ListABTests(ctx context.Context, modelName string) ([]any, error)
}
