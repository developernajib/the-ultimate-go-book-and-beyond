## Part 3: Model Registry and Serving

Once a model is trained and its metrics look good, it needs a permanent home where it can be versioned, reviewed, and promoted to production. The model registry handles this lifecycle, while the model serving layer loads registered models and runs inference at low latency. Together, these two services bridge the gap between "the model works on my laptop" and "the model is serving real traffic."

### 3.1 Model Registry Service

The registry service lets you register a new model by name, create numbered versions of it, and transition each version through stages like "None," "Staging," "Production," and "Archived." This staged promotion pattern is standard in industry ML platforms because it gives teams a controlled way to roll out new models. The service also supports listing all versions of a model and fetching whichever version is currently in a given stage.

```go
// internal/service/registry/service.go
package registry

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"ml-platform/internal/domain"
	"ml-platform/internal/storage"
)

// Service handles model registry operations
type Service struct {
	store         storage.ModelStore
	artifactStore storage.ArtifactStore
	eventBus      EventBus
}

// NewService creates a new model registry service
func NewService(
	store storage.ModelStore,
	artifactStore storage.ArtifactStore,
	eventBus EventBus,
) *Service {
	return &Service{
		store:         store,
		artifactStore: artifactStore,
		eventBus:      eventBus,
	}
}

// RegisterModel registers a new model
func (s *Service) RegisterModel(ctx context.Context, req RegisterModelRequest) (*domain.RegisteredModel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	existing, err := s.store.GetModelByName(ctx, req.Name)
	if err != nil {
		return nil, fmt.Errorf("checking for existing model: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("model with name %s already exists", req.Name)
	}

	model := &domain.RegisteredModel{
		ID:             uuid.New(),
		Name:           req.Name,
		Description:    req.Description,
		Tags:           req.Tags,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
		LatestVersions: make(map[domain.ModelStage]int),
	}

	if err := s.store.CreateModel(ctx, model); err != nil {
		return nil, fmt.Errorf("creating model: %w", err)
	}

	s.eventBus.Publish(ModelRegisteredEvent{
		ModelID:   model.ID,
		ModelName: model.Name,
		Timestamp: time.Now(),
	})

	return model, nil
}

// CreateModelVersion creates a new version of a model
func (s *Service) CreateModelVersion(ctx context.Context, req CreateModelVersionRequest) (*domain.ModelVersion, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	model, err := s.store.GetModel(ctx, req.ModelID)
	if err != nil {
		return nil, fmt.Errorf("getting model: %w", err)
	}
	if model == nil {
		return nil, fmt.Errorf("model %s not found", req.ModelID)
	}

	nextVersion, err := s.store.GetNextVersionNumber(ctx, req.ModelID)
	if err != nil {
		return nil, fmt.Errorf("getting next version: %w", err)
	}

	version := &domain.ModelVersion{
		ID:                 uuid.New(),
		ModelID:            req.ModelID,
		Version:            nextVersion,
		RunID:              req.RunID,
		Stage:              domain.ModelStageNone,
		Description:        req.Description,
		Tags:               req.Tags,
		CreatedAt:          time.Now(),
		UpdatedAt:          time.Now(),
		SourcePath:         req.SourcePath,
		Format:             req.Format,
		Framework:          req.Framework,
		Signature:          req.Signature,
		Metadata:           req.Metadata,
		PerformanceMetrics: req.PerformanceMetrics,
	}

	if err := s.store.CreateModelVersion(ctx, version); err != nil {
		return nil, fmt.Errorf("creating model version: %w", err)
	}

	s.eventBus.Publish(ModelVersionCreatedEvent{
		ModelID:   model.ID,
		VersionID: version.ID,
		Version:   version.Version,
		Timestamp: time.Now(),
	})

	return version, nil
}

// TransitionModelStage transitions a model version to a different stage
func (s *Service) TransitionModelStage(ctx context.Context, req TransitionStageRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("invalid request: %w", err)
	}

	version, err := s.store.GetModelVersion(ctx, req.VersionID)
	if err != nil {
		return fmt.Errorf("getting model version: %w", err)
	}
	if version == nil {
		return fmt.Errorf("model version %s not found", req.VersionID)
	}

	if !isValidTransition(version.Stage, req.ToStage) {
		return fmt.Errorf("invalid stage transition from %s to %s", version.Stage, req.ToStage)
	}

	// If transitioning to production, demote current production version
	if req.ToStage == domain.ModelStageProduction {
		if err := s.demoteCurrentProduction(ctx, version.ModelID); err != nil {
			return fmt.Errorf("demoting current production: %w", err)
		}
	}

	transition := &domain.ModelTransition{
		ID:             uuid.New(),
		ModelVersionID: req.VersionID,
		FromStage:      version.Stage,
		ToStage:        req.ToStage,
		RequestedBy:    req.RequestedBy,
		RequestedAt:    time.Now(),
		ApprovedBy:     req.RequestedBy,
		Status:         "APPROVED",
		Comment:        req.Comment,
	}

	now := time.Now()
	transition.ApprovedAt = &now

	if err := s.store.CreateTransition(ctx, transition); err != nil {
		return fmt.Errorf("creating transition: %w", err)
	}

	version.Stage = req.ToStage
	version.UpdatedAt = time.Now()

	if err := s.store.UpdateModelVersion(ctx, version); err != nil {
		return fmt.Errorf("updating model version: %w", err)
	}

	model, _ := s.store.GetModel(ctx, version.ModelID)
	model.LatestVersions[req.ToStage] = version.Version
	s.store.UpdateModel(ctx, model)

	s.eventBus.Publish(ModelStageTransitionEvent{
		VersionID: version.ID,
		ModelID:   version.ModelID,
		FromStage: transition.FromStage,
		ToStage:   transition.ToStage,
		Timestamp: time.Now(),
	})

	return nil
}

func (s *Service) demoteCurrentProduction(ctx context.Context, modelID uuid.UUID) error {
	versions, err := s.store.GetModelVersionsByStage(ctx, modelID, domain.ModelStageProduction)
	if err != nil {
		return fmt.Errorf("getting production versions: %w", err)
	}

	for _, version := range versions {
		version.Stage = domain.ModelStageStaging
		version.UpdatedAt = time.Now()

		if err := s.store.UpdateModelVersion(ctx, version); err != nil {
			return fmt.Errorf("demoting version %d: %w", version.Version, err)
		}
	}

	return nil
}

func isValidTransition(from, to domain.ModelStage) bool {
	validTransitions := map[domain.ModelStage][]domain.ModelStage{
		domain.ModelStageNone: {
			domain.ModelStageStaging,
			domain.ModelStageArchived,
		},
		domain.ModelStageStaging: {
			domain.ModelStageProduction,
			domain.ModelStageArchived,
			domain.ModelStageNone,
		},
		domain.ModelStageProduction: {
			domain.ModelStageStaging,
			domain.ModelStageArchived,
		},
		domain.ModelStageArchived: {
			domain.ModelStageNone,
		},
	}

	allowed, ok := validTransitions[from]
	if !ok {
		return false
	}

	for _, stage := range allowed {
		if stage == to {
			return true
		}
	}

	return false
}

// Request types

type RegisterModelRequest struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Tags        map[string]string `json:"tags"`
}

func (r RegisterModelRequest) Validate() error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	return nil
}

type CreateModelVersionRequest struct {
	ModelID            uuid.UUID              `json:"model_id"`
	RunID              uuid.UUID              `json:"run_id"`
	Description        string                 `json:"description"`
	Tags               map[string]string      `json:"tags"`
	SourcePath         string                 `json:"source_path"`
	Format             domain.ModelFormat     `json:"format"`
	Framework          string                 `json:"framework"`
	Signature          domain.ModelSignature  `json:"signature"`
	Metadata           map[string]any `json:"metadata"`
	PerformanceMetrics map[string]float64     `json:"performance_metrics"`
}

func (r CreateModelVersionRequest) Validate() error {
	if r.ModelID == uuid.Nil() {
		return fmt.Errorf("model_id is required")
	}
	if r.SourcePath == "" {
		return fmt.Errorf("source_path is required")
	}
	if r.Format == "" {
		return fmt.Errorf("format is required")
	}
	return nil
}

type TransitionStageRequest struct {
	VersionID   uuid.UUID         `json:"version_id"`
	ToStage     domain.ModelStage `json:"to_stage"`
	RequestedBy string            `json:"requested_by"`
	Comment     string            `json:"comment"`
}

func (r TransitionStageRequest) Validate() error {
	if r.VersionID == uuid.Nil() {
		return fmt.Errorf("version_id is required")
	}
	if r.ToStage == "" {
		return fmt.Errorf("to_stage is required")
	}
	if r.RequestedBy == "" {
		return fmt.Errorf("requested_by is required")
	}
	return nil
}

// EventBus interface
type EventBus interface {
	Publish(event any) error
}

// Events
type ModelRegisteredEvent struct {
	ModelID   uuid.UUID
	ModelName string
	Timestamp time.Time
}

type ModelVersionCreatedEvent struct {
	ModelID   uuid.UUID
	VersionID uuid.UUID
	Version   int
	Timestamp time.Time
}

type ModelStageTransitionEvent struct {
	VersionID uuid.UUID
	ModelID   uuid.UUID
	FromStage domain.ModelStage
	ToStage   domain.ModelStage
	Timestamp time.Time
}
```


### 3.2 Model Serving Service with ONNX Support

Model serving is the component that actually runs predictions against incoming requests. This implementation supports multiple model formats through a common `ModelRunner` interface. ONNX (Open Neural Network Exchange) is an open format that lets you export models from frameworks like PyTorch or scikit-learn and run them in Go. The serving service loads models into memory, manages their lifecycle, and routes prediction requests to the correct runner. It also supports running multiple models simultaneously, which is essential for A/B testing and canary deployments.

```go
// internal/service/serving/service.go
package serving

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	onnxruntime "github.com/yalue/onnxruntime_go"
	"ml-platform/internal/domain"
	"ml-platform/internal/storage"
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

// ONNXRuntime implements ModelRuntime for ONNX models
type ONNXRuntime struct {
	session *onnxruntime.AdvancedSession
	signature domain.ModelSignature
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

	// Get model metadata
	registeredModel, err := s.modelStore.GetModelByName(ctx, modelName)
	if err != nil {
		return fmt.Errorf("getting model: %w", err)
	}
	if registeredModel == nil {
		return fmt.Errorf("model %s not found", modelName)
	}

	// Get specific version or latest for stage
	var modelVersion *domain.ModelVersion
	if version > 0 {
		modelVersion, err = s.modelStore.GetModelVersionByNumber(ctx, registeredModel.ID, version)
	} else {
		versions, err := s.modelStore.GetModelVersionsByStage(ctx, registeredModel.ID, stage)
		if err != nil || len(versions) == 0 {
			return fmt.Errorf("no model version found for stage %s", stage)
		}
		modelVersion = versions[0]
	}

	if modelVersion == nil {
		return fmt.Errorf("model version not found")
	}

	// Download model artifact
	modelData, err := s.artifactStore.DownloadArtifact(ctx, modelVersion.SourcePath)
	if err != nil {
		return fmt.Errorf("downloading model: %w", err)
	}

	// Load model based on format
	var runtime ModelRuntime
	switch modelVersion.Format {
	case domain.ModelFormatONNX:
		runtime, err = s.loadONNXModel(modelData, modelVersion.Signature)
		if err != nil {
			return fmt.Errorf("loading ONNX model: %w", err)
		}
	case domain.ModelFormatGoNative:
		runtime, err = s.loadGoNativeModel(modelData)
		if err != nil {
			return fmt.Errorf("loading Go native model: %w", err)
		}
	default:
		return fmt.Errorf("unsupported model format: %s", modelVersion.Format)
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

	// Store with key modelName:stage
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
		// Auto-load model if not loaded
		if err := s.LoadModel(ctx, req.ModelName, 0, req.Stage); err != nil {
			return nil, fmt.Errorf("model not loaded and auto-load failed: %w", err)
		}

		s.mu.RLock()
		loadedModel = s.loadedModels[key]
		s.mu.RUnlock()
	}

	// Perform prediction
	outputs, err := loadedModel.Runtime.Predict(ctx, req.Inputs)
	if err != nil {
		loadedModel.ErrorCount++
		s.metrics.RecordError(req.ModelName)
		return nil, fmt.Errorf("prediction failed: %w", err)
	}

	// Update metrics
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

// loadONNXModel loads an ONNX format model
func (s *Service) loadONNXModel(modelData []byte, signature domain.ModelSignature) (*ONNXRuntime, error) {
	// Initialize ONNX runtime
	err := onnxruntime.SetSharedLibraryPath("/usr/local/lib/onnxruntime.so")
	if err != nil {
		return nil, fmt.Errorf("setting ONNX library path: %w", err)
	}

	err = onnxruntime.InitializeEnvironment()
	if err != nil {
		return nil, fmt.Errorf("initializing ONNX environment: %w", err)
	}

	// Create session from model bytes
	inputNames := make([]string, len(signature.Inputs))
	outputNames := make([]string, len(signature.Outputs))

	for i, input := range signature.Inputs {
		inputNames[i] = input.Name
	}
	for i, output := range signature.Outputs {
		outputNames[i] = output.Name
	}

	session, err := onnxruntime.NewAdvancedSessionWithONNXData(
		modelData,
		inputNames,
		outputNames,
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("creating ONNX session: %w", err)
	}

	return &ONNXRuntime{
		session:   session,
		signature: signature,
	}, nil
}

// Predict implements ModelRuntime for ONNX
func (o *ONNXRuntime) Predict(ctx context.Context, inputs map[string]any) (map[string]any, error) {
	// Convert inputs to ONNX tensors
	inputTensors := make([]onnxruntime.Value, 0, len(o.signature.Inputs))

	for _, inputSpec := range o.signature.Inputs {
		value, ok := inputs[inputSpec.Name]
		if !ok {
			return nil, fmt.Errorf("missing required input: %s", inputSpec.Name)
		}

		tensor, err := convertToTensor(value, inputSpec)
		if err != nil {
			return nil, fmt.Errorf("converting input %s: %w", inputSpec.Name, err)
		}

		inputTensors = append(inputTensors, tensor)
	}

	// Run inference
	outputTensors, err := o.session.Run(inputTensors)
	if err != nil {
		return nil, fmt.Errorf("running inference: %w", err)
	}

	// Convert outputs
	outputs := make(map[string]any)
	for i, outputSpec := range o.signature.Outputs {
		if i >= len(outputTensors) {
			break
		}

		value, err := convertFromTensor(outputTensors[i], outputSpec)
		if err != nil {
			return nil, fmt.Errorf("converting output %s: %w", outputSpec.Name, err)
		}

		outputs[outputSpec.Name] = value
	}

	// Clean up tensors
	for _, tensor := range inputTensors {
		tensor.Destroy()
	}
	for _, tensor := range outputTensors {
		tensor.Destroy()
	}

	return outputs, nil
}

func (o *ONNXRuntime) Close() error {
	if o.session != nil {
		return o.session.Destroy()
	}
	return nil
}

// GoNativeRuntime implements ModelRuntime for Go-native models
type GoNativeRuntime struct {
	predictor func(map[string]any) (map[string]any, error)
}

func (s *Service) loadGoNativeModel(modelData []byte) (*GoNativeRuntime, error) {
	// In production, this would deserialize a Go model
	// For example, loading weights for a neural network implemented in Go
	// Or loading a decision tree, linear regression, etc.
	
	// Placeholder implementation
	return &GoNativeRuntime{
		predictor: func(inputs map[string]any) (map[string]any, error) {
			// Custom Go model prediction logic
			return inputs, nil
		},
	}, nil
}

func (g *GoNativeRuntime) Predict(ctx context.Context, inputs map[string]any) (map[string]any, error) {
	return g.predictor(inputs)
}

func (g *GoNativeRuntime) Close() error {
	return nil
}

// Helper functions

func convertToTensor(value any, spec domain.TensorSpec) (onnxruntime.Value, error) {
	// Convert Go values to ONNX tensors based on spec
	// This is simplified - production code would handle all tensor types
	
	switch v := value.(type) {
	case []float32:
		shape := make([]int64, len(spec.Shape))
		for i, s := range spec.Shape {
			shape[i] = int64(s)
		}
		return onnxruntime.NewTensor(shape, v)
	case [][]float32:
		// Handle 2D tensors
		flat := make([]float32, 0)
		for _, row := range v {
			flat = append(flat, row...)
		}
		shape := []int64{int64(len(v)), int64(len(v[0]))}
		return onnxruntime.NewTensor(shape, flat)
	default:
		return nil, fmt.Errorf("unsupported input type: %T", value)
	}
}

func convertFromTensor(tensor onnxruntime.Value, spec domain.TensorSpec) (any, error) {
	// Convert ONNX tensor to Go values
	data := tensor.GetData()
	
	switch spec.Type {
	case domain.TensorTypeFloat32:
		if floats, ok := data.([]float32); ok {
			return floats, nil
		}
	case domain.TensorTypeInt64:
		if ints, ok := data.([]int64); ok {
			return ints, nil
		}
	}
	
	return data, nil
}

// Request/Response types

type PredictRequest struct {
	ModelName string                 `json:"model_name"`
	Stage     domain.ModelStage      `json:"stage"`
	Inputs    map[string]any `json:"inputs"`
}

type PredictResponse struct {
	ModelName    string                 `json:"model_name"`
	ModelVersion int                    `json:"model_version"`
	Outputs      map[string]any `json:"outputs"`
	LatencyMS    int64                  `json:"latency_ms"`
	Timestamp    time.Time              `json:"timestamp"`
}

// ServingMetrics tracks prediction metrics
type ServingMetrics struct {
	mu                sync.RWMutex
	predictionCounts  map[string]int64
	errorCounts       map[string]int64
	totalLatency      map[string]float64
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

func (m *ServingMetrics) GetStats(modelName string) *ModelStats {
	m.mu.RLock()
	defer m.mu.RUnlock()

	count := m.predictionCounts[modelName]
	errors := m.errorCounts[modelName]
	totalLatency := m.totalLatency[modelName]

	avgLatency := 0.0
	if count > 0 {
		avgLatency = totalLatency / float64(count)
	}

	return &ModelStats{
		ModelName:        modelName,
		PredictionCount:  count,
		ErrorCount:       errors,
		AvgLatencyMS:     avgLatency,
	}
}

type ModelStats struct {
	ModelName       string  `json:"model_name"`
	PredictionCount int64   `json:"prediction_count"`
	ErrorCount      int64   `json:"error_count"`
	AvgLatencyMS    float64 `json:"avg_latency_ms"`
}
```

---
