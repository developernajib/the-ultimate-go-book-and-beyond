// internal/service/serving/service.go
package serving

import (
	"context"
	"fmt"
	"sync"
	"time"
	"uuid"

	"github.com/example/ml-platform/internal/domain"
	"github.com/example/ml-platform/internal/storage"
)

// Service handles model serving operations
type Service struct {
	modelStore    storage.ModelStore
	artifactStore storage.ArtifactStore
	loadedModels  map[string]*LoadedModel
	mu            sync.RWMutex
	metrics       *ServingMetrics
}

// LoadedModel represents a model loaded in memory
type LoadedModel struct {
	ID             uuid.UUID
	Version        *domain.ModelVersion
	Runtime        ModelRuntime
	LoadedAt       time.Time
	LastUsedAt     time.Time
	RequestCount   int64
	ErrorCount     int64
	TotalLatencyMS int64
}

// ModelRuntime is the interface all model runtimes must implement
type ModelRuntime interface {
	Predict(ctx context.Context, inputs map[string]any) (map[string]any, error)
	Close() error
}

// NewService creates a new model serving service
func NewService(
	modelStore storage.ModelStore,
	artifactStore storage.ArtifactStore,
) *Service {
	return &Service{
		modelStore:    modelStore,
		artifactStore: artifactStore,
		loadedModels:  make(map[string]*LoadedModel),
		metrics:       NewServingMetrics(),
	}
}

// LoadModel loads a model into memory for serving
func (s *Service) LoadModel(ctx context.Context, modelName string, version int, stage domain.ModelStage) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	registeredModel, err := s.modelStore.GetModelByName(ctx, modelName)
	if err != nil {
		return fmt.Errorf("getting model: %w", err)
	}
	if registeredModel == nil {
		return fmt.Errorf("model %s not found", modelName)
	}

	var modelVersion *domain.ModelVersion
	if version > 0 {
		modelVersion, err = s.modelStore.GetModelVersionByNumber(ctx, registeredModel.ID, version)
		if err != nil {
			return fmt.Errorf("getting model version: %w", err)
		}
	} else {
		versions, verErr := s.modelStore.GetModelVersionsByStage(ctx, registeredModel.ID, stage)
		if verErr != nil || len(versions) == 0 {
			return fmt.Errorf("no model version found for stage %s", stage)
		}
		modelVersion = versions[0]
	}

	if modelVersion == nil {
		return fmt.Errorf("model version not found")
	}

	modelData, err := s.artifactStore.DownloadArtifact(ctx, modelVersion.SourcePath)
	if err != nil {
		return fmt.Errorf("downloading model: %w", err)
	}

	var runtime ModelRuntime
	switch modelVersion.Format {
	case domain.ModelFormatONNX:
		runtime, err = newGoNativeRuntime(modelData)
		if err != nil {
			return fmt.Errorf("loading ONNX model: %w", err)
		}
	case domain.ModelFormatGoNative:
		runtime, err = newGoNativeRuntime(modelData)
		if err != nil {
			return fmt.Errorf("loading Go native model: %w", err)
		}
	default:
		runtime, err = newGoNativeRuntime(modelData)
		if err != nil {
			return fmt.Errorf("loading model: %w", err)
		}
	}

	loadedModel := &LoadedModel{
		ID:           uuid.New(),
		Version:      modelVersion,
		Runtime:      runtime,
		LoadedAt:     time.Now(),
		LastUsedAt:   time.Now(),
		RequestCount: 0,
		ErrorCount:   0,
	}

	key := fmt.Sprintf("%s:%s", modelName, stage)
	s.loadedModels[key] = loadedModel

	return nil
}

// Predict performs inference using a loaded model
func (s *Service) Predict(ctx context.Context, req PredictRequest) (*PredictResponse, error) {
	startTime := time.Now()

	s.mu.RLock()
	key := fmt.Sprintf("%s:%s", req.ModelName, req.Stage)
	loadedModel, exists := s.loadedModels[key]
	s.mu.RUnlock()

	if !exists {
		if err := s.LoadModel(ctx, req.ModelName, 0, req.Stage); err != nil {
			return nil, fmt.Errorf("model not loaded and auto-load failed: %w", err)
		}

		s.mu.RLock()
		loadedModel = s.loadedModels[key]
		s.mu.RUnlock()
	}

	outputs, err := loadedModel.Runtime.Predict(ctx, req.Inputs)
	if err != nil {
		loadedModel.ErrorCount++
		s.metrics.RecordError(req.ModelName)
		return nil, fmt.Errorf("prediction failed: %w", err)
	}

	latencyMS := time.Since(startTime).Milliseconds()
	loadedModel.RequestCount++
	loadedModel.TotalLatencyMS += latencyMS
	loadedModel.LastUsedAt = time.Now()

	s.metrics.RecordPrediction(req.ModelName, float64(latencyMS))

	return &PredictResponse{
		ModelName:    req.ModelName,
		ModelVersion: loadedModel.Version.Version,
		Outputs:      outputs,
		LatencyMS:    latencyMS,
		Timestamp:    time.Now(),
	}, nil
}

// GoNativeRuntime implements ModelRuntime for Go-native models
type GoNativeRuntime struct {
	predictor func(map[string]any) (map[string]any, error)
}

func newGoNativeRuntime(_ []byte) (*GoNativeRuntime, error) {
	return &GoNativeRuntime{
		predictor: func(inputs map[string]any) (map[string]any, error) {
			// Pass-through placeholder; real implementation would deserialize weights
			return inputs, nil
		},
	}, nil
}

func (g *GoNativeRuntime) Predict(_ context.Context, inputs map[string]any) (map[string]any, error) {
	return g.predictor(inputs)
}

func (g *GoNativeRuntime) Close() error {
	return nil
}

// Request/Response types

type PredictRequest struct {
	ModelName string            `json:"model_name"`
	Stage     domain.ModelStage `json:"stage"`
	Inputs    map[string]any    `json:"inputs"`
}

type PredictResponse struct {
	ModelName    string         `json:"model_name"`
	ModelVersion int            `json:"model_version"`
	Outputs      map[string]any `json:"outputs"`
	LatencyMS    int64          `json:"latency_ms"`
	Timestamp    time.Time      `json:"timestamp"`
}

// ServingMetrics tracks prediction metrics
type ServingMetrics struct {
	mu               sync.RWMutex
	predictionCounts map[string]int64
	errorCounts      map[string]int64
	totalLatency     map[string]float64
}

func NewServingMetrics() *ServingMetrics {
	return &ServingMetrics{
		predictionCounts: make(map[string]int64),
		errorCounts:      make(map[string]int64),
		totalLatency:     make(map[string]float64),
	}
}

func (m *ServingMetrics) RecordPrediction(modelName string, latencyMS float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.predictionCounts[modelName]++
	m.totalLatency[modelName] += latencyMS
}

func (m *ServingMetrics) RecordError(modelName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.errorCounts[modelName]++
}

// ModelStats holds serving statistics
type ModelStats struct {
	ModelName       string  `json:"model_name"`
	PredictionCount int64   `json:"prediction_count"`
	ErrorCount      int64   `json:"error_count"`
	AvgLatencyMS    float64 `json:"avg_latency_ms"`
}
