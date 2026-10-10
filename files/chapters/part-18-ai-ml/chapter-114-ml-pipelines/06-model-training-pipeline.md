## 114.5 Model Training Pipeline

### Training Pipeline Architecture

The training pipeline runs as a sequence of steps: start an experiment, load data, split it, train, log metrics, register the resulting model. Each dependency is an interface (`ExperimentTracker`, `ModelRegistry`, `DataLoader`, `Trainer`), which is what lets you run the whole pipeline against in-memory fakes in a unit test and against real infrastructure in production without the orchestration code knowing the difference.

Training is deliberately not concurrent here. A training run is one long compute-bound step, so there is nothing to overlap, and the ordering constraints are absolute: you cannot split data you have not loaded, or register a model you have not trained. Concurrency enters this chapter at the serving layer, where requests are independent, and in hyperparameter search, where whole runs are.

```go
// pkg/training/types.go
package training

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Experiment represents a model training experiment
type Experiment struct {
    ID          string
    Name        string
    Description string
    Parameters  map[string]any
    Metrics     map[string]float64
    Status      ExperimentStatus
    StartTime   time.Time
    EndTime     time.Time
    ModelPath   string
    Created     time.Time
}

type ExperimentStatus string

const (
    ExperimentStatusPending   ExperimentStatus = "pending"
    ExperimentStatusRunning   ExperimentStatus = "running"
    ExperimentStatusCompleted ExperimentStatus = "completed"
    ExperimentStatusFailed    ExperimentStatus = "failed"
)

// TrainingConfig configures model training
type TrainingConfig struct {
    ModelType       string
    Hyperparameters map[string]any
    DataPath        string
    OutputPath      string
    MaxEpochs       int
    BatchSize       int
    LearningRate    float64
    ValidationSplit float64
}

// TrainingJob represents a single training run
type TrainingJob struct {
    ID        string
    Config    *TrainingConfig
    Metrics   *TrainingMetrics
    Status    ExperimentStatus
    StartTime time.Time
    EndTime   time.Time
    Error     error
}

// TrainingMetrics tracks training progress
type TrainingMetrics struct {
    Epoch           int
    TrainLoss       float64
    ValidationLoss  float64
    TrainAccuracy   float64
    ValidationAccuracy float64
    LearningRate    float64
    mu              sync.RWMutex
}

// TrainingPipeline orchestrates model training
type TrainingPipeline struct {
    experimentTracker ExperimentTracker
    modelRegistry     ModelRegistry
    dataLoader        DataLoader
    trainer           Trainer
}

// ExperimentTracker tracks experiments and metrics
type ExperimentTracker interface {
    StartExperiment(ctx context.Context, exp *Experiment) error
    LogMetric(ctx context.Context, experimentID string, metric string, value float64) error
    LogParameter(ctx context.Context, experimentID string, param string, value any) error
    EndExperiment(ctx context.Context, experimentID string, status ExperimentStatus) error
    GetExperiment(ctx context.Context, experimentID string) (*Experiment, error)
    ListExperiments(ctx context.Context, filter map[string]any) ([]*Experiment, error)
}

// ModelRegistry stores and versions trained models
type ModelRegistry interface {
    RegisterModel(ctx context.Context, model *Model) error
    GetModel(ctx context.Context, modelID string) (*Model, error)
    GetModelVersion(ctx context.Context, modelName string, version int) (*Model, error)
    PromoteModel(ctx context.Context, modelID string, stage ModelStage) error
    ListModels(ctx context.Context) ([]*Model, error)
}

// Model represents a trained ML model
type Model struct {
    ID          string
    Name        string
    Version     int
    Framework   string
    Path        string
    Metrics     map[string]float64
    Parameters  map[string]any
    Stage       ModelStage
    Created     time.Time
    Updated     time.Time
}

type ModelStage string

const (
    ModelStageNone       ModelStage = "none"
    ModelStageStaging    ModelStage = "staging"
    ModelStageProduction ModelStage = "production"
    ModelStageArchived   ModelStage = "archived"
)

// DataLoader loads training data
type DataLoader interface {
    Load(ctx context.Context, path string) (TrainingData, error)
}

// TrainingData represents data for training
type TrainingData interface {
    NumSamples() int
    GetBatch(start, size int) ([][]float64, []float64, error)
    Split(ratio float64) (TrainingData, TrainingData, error)
}

// Trainer trains models.
//
// Validation data is a parameter, not an afterthought. An earlier shape of
// this interface took only the training split, which left RunTraining holding
// a valData it could not pass anywhere: the compiler rejects the unused
// variable, and the more interesting problem is that the pipeline was
// reporting validation_loss and validation_accuracy that nothing had computed.
// Metrics you cannot trace to a computation are worse than no metrics.
type Trainer interface {
    Train(ctx context.Context, trainData, valData TrainingData,
        config *TrainingConfig, metrics *TrainingMetrics) (string, error)
}

func NewTrainingPipeline(tracker ExperimentTracker, registry ModelRegistry,
    loader DataLoader, trainer Trainer) *TrainingPipeline {

    return &TrainingPipeline{
        experimentTracker: tracker,
        modelRegistry:     registry,
        dataLoader:        loader,
        trainer:           trainer,
    }
}

// RunTraining executes a training job
func (tp *TrainingPipeline) RunTraining(ctx context.Context, config *TrainingConfig) (*Model, error) {
    // Create experiment
    exp := &Experiment{
        ID:          fmt.Sprintf("exp_%d", time.Now().UnixNano()),
        Name:        fmt.Sprintf("training_%s", config.ModelType),
        Description: "Model training run",
        Parameters:  make(map[string]any),
        Metrics:     make(map[string]float64),
        Status:      ExperimentStatusPending,
        Created:     time.Now(),
    }

    // Log hyperparameters
    for k, v := range config.Hyperparameters {
        exp.Parameters[k] = v
    }

    // Start experiment
    if err := tp.experimentTracker.StartExperiment(ctx, exp); err != nil {
        return nil, fmt.Errorf("failed to start experiment: %w", err)
    }

    // Update experiment status
    exp.Status = ExperimentStatusRunning
    exp.StartTime = time.Now()

    // Load training data
    data, err := tp.dataLoader.Load(ctx, config.DataPath)
    if err != nil {
        tp.experimentTracker.EndExperiment(ctx, exp.ID, ExperimentStatusFailed)
        return nil, fmt.Errorf("failed to load data: %w", err)
    }

    // Split data
    trainData, valData, err := data.Split(config.ValidationSplit)
    if err != nil {
        tp.experimentTracker.EndExperiment(ctx, exp.ID, ExperimentStatusFailed)
        return nil, fmt.Errorf("failed to split data: %w", err)
    }

    // Train model. The trainer evaluates against valData each epoch and
    // records the validation metrics logged below.
    metrics := &TrainingMetrics{}
    modelPath, err := tp.trainer.Train(ctx, trainData, valData, config, metrics)
    if err != nil {
        tp.experimentTracker.EndExperiment(ctx, exp.ID, ExperimentStatusFailed)
        return nil, fmt.Errorf("training failed: %w", err)
    }

    // Log final metrics
    metrics.mu.RLock()
    exp.Metrics["train_loss"] = metrics.TrainLoss
    exp.Metrics["validation_loss"] = metrics.ValidationLoss
    exp.Metrics["train_accuracy"] = metrics.TrainAccuracy
    exp.Metrics["validation_accuracy"] = metrics.ValidationAccuracy
    metrics.mu.RUnlock()

    for metric, value := range exp.Metrics {
        tp.experimentTracker.LogMetric(ctx, exp.ID, metric, value)
    }

    // End experiment
    exp.Status = ExperimentStatusCompleted
    exp.EndTime = time.Now()
    exp.ModelPath = modelPath
    tp.experimentTracker.EndExperiment(ctx, exp.ID, ExperimentStatusCompleted)

    // Register model.
    //
    // Version is hardcoded to 1, which means every run of this pipeline
    // registers another "version 1" under the same name and GetModelVersion
    // returns whichever one the map iteration reaches first. Version
    // assignment belongs inside the registry, under the same lock that
    // performs the insert, so that two concurrent training runs cannot claim
    // the same number. Deriving it out here, where the read and the write are
    // separated, is a race no matter how careful the arithmetic looks.
    model := &Model{
        ID:         fmt.Sprintf("model_%d", time.Now().UnixNano()),
        Name:       config.ModelType,
        Version:    1, // TODO: assign inside ModelRegistry.RegisterModel
        Framework:  "custom",
        Path:       modelPath,
        Metrics:    exp.Metrics,
        Parameters: exp.Parameters,
        Stage:      ModelStageNone,
        Created:    time.Now(),
        Updated:    time.Now(),
    }

    if err := tp.modelRegistry.RegisterModel(ctx, model); err != nil {
        return nil, fmt.Errorf("failed to register model: %w", err)
    }

    return model, nil
}

// HyperparameterTuning runs multiple experiments with different hyperparameters
func (tp *TrainingPipeline) HyperparameterTuning(ctx context.Context,
    baseConfig *TrainingConfig, paramGrid map[string][]any) ([]*Model, error) {

    // Generate all combinations
    combinations := generateCombinations(paramGrid)

    models := make([]*Model, 0, len(combinations))

    for _, params := range combinations {
        // Create config with these parameters
        config := *baseConfig
        config.Hyperparameters = params

        // Run training
        model, err := tp.RunTraining(ctx, &config)
        if err != nil {
            // Log error but continue with other combinations
            fmt.Printf("Training failed for params %v: %v\n", params, err)
            continue
        }

        models = append(models, model)
    }

    return models, nil
}

func generateCombinations(paramGrid map[string][]any) []map[string]any {
    if len(paramGrid) == 0 {
        return []map[string]any{{}}
    }

    // Extract first parameter
    var firstKey string
    var firstValues []any
    for k, v := range paramGrid {
        firstKey = k
        firstValues = v
        break
    }

    // Create sub-grid without first parameter
    subGrid := make(map[string][]any)
    for k, v := range paramGrid {
        if k != firstKey {
            subGrid[k] = v
        }
    }

    // Recursively generate combinations
    subCombinations := generateCombinations(subGrid)

    // Combine first parameter with sub-combinations
    var results []map[string]any
    for _, value := range firstValues {
        for _, subCombo := range subCombinations {
            combo := make(map[string]any)
            for k, v := range subCombo {
                combo[k] = v
            }
            combo[firstKey] = value
            results = append(results, combo)
        }
    }

    return results
}
```

### In-Memory Experiment Tracker

An experiment tracker records hyperparameters, metrics, and the artifact path for each training run so experiments are reproducible and comparable. This implementation keeps runs in a plain map guarded by a `sync.RWMutex`, which is the right default: `sync.Map` is tuned for disjoint key sets across goroutines, and a mutex-guarded map is both faster and easier to reason about for a small collection with frequent reads.

It is a prototyping tracker, and the missing pieces are the ones that matter in production. Nothing is persisted, so a restart erases every experiment. `ListExperiments` accepts a filter argument and ignores it. There is no "best run by metric" query, no artifact storage, and no concurrent-run isolation. Those gaps are why teams reach for MLflow or Weights & Biases rather than growing this into a real service.

```go
// pkg/training/tracker.go
package training

import (
    "context"
    "fmt"
    "sync"
)

// InMemoryExperimentTracker implements ExperimentTracker in memory
type InMemoryExperimentTracker struct {
    experiments map[string]*Experiment
    mu          sync.RWMutex
}

func NewInMemoryExperimentTracker() *InMemoryExperimentTracker {
    return &InMemoryExperimentTracker{
        experiments: make(map[string]*Experiment),
    }
}

func (t *InMemoryExperimentTracker) StartExperiment(ctx context.Context,
    exp *Experiment) error {

    t.mu.Lock()
    defer t.mu.Unlock()

    if _, exists := t.experiments[exp.ID]; exists {
        return fmt.Errorf("experiment %s already exists", exp.ID)
    }

    t.experiments[exp.ID] = exp
    return nil
}

func (t *InMemoryExperimentTracker) LogMetric(ctx context.Context,
    experimentID string, metric string, value float64) error {

    t.mu.Lock()
    defer t.mu.Unlock()

    exp, exists := t.experiments[experimentID]
    if !exists {
        return fmt.Errorf("experiment %s not found", experimentID)
    }

    exp.Metrics[metric] = value
    return nil
}

func (t *InMemoryExperimentTracker) LogParameter(ctx context.Context,
    experimentID string, param string, value any) error {

    t.mu.Lock()
    defer t.mu.Unlock()

    exp, exists := t.experiments[experimentID]
    if !exists {
        return fmt.Errorf("experiment %s not found", experimentID)
    }

    exp.Parameters[param] = value
    return nil
}

func (t *InMemoryExperimentTracker) EndExperiment(ctx context.Context,
    experimentID string, status ExperimentStatus) error {

    t.mu.Lock()
    defer t.mu.Unlock()

    exp, exists := t.experiments[experimentID]
    if !exists {
        return fmt.Errorf("experiment %s not found", experimentID)
    }

    exp.Status = status
    return nil
}

func (t *InMemoryExperimentTracker) GetExperiment(ctx context.Context,
    experimentID string) (*Experiment, error) {

    t.mu.RLock()
    defer t.mu.RUnlock()

    exp, exists := t.experiments[experimentID]
    if !exists {
        return nil, fmt.Errorf("experiment %s not found", experimentID)
    }

    return exp, nil
}

func (t *InMemoryExperimentTracker) ListExperiments(ctx context.Context,
    filter map[string]any) ([]*Experiment, error) {

    t.mu.RLock()
    defer t.mu.RUnlock()

    var results []*Experiment
    for _, exp := range t.experiments {
        results = append(results, exp)
    }

    return results, nil
}
```

### In-Memory Model Registry

The registry is the pipeline's source of truth for which model versions exist and which one is live. An in-memory implementation behind the `ModelRegistry` interface keeps tests fast and dependency-free, while production swaps in a database-backed implementation of the same interface. A `sync.RWMutex` guards the map because registrations are rare and lookups dominate.
```go
// pkg/training/registry.go
package training

import (
    "context"
    "fmt"
    "sync"
)

// InMemoryModelRegistry implements ModelRegistry in memory
type InMemoryModelRegistry struct {
    models map[string]*Model
    mu     sync.RWMutex
}

func NewInMemoryModelRegistry() *InMemoryModelRegistry {
    return &InMemoryModelRegistry{
        models: make(map[string]*Model),
    }
}

func (r *InMemoryModelRegistry) RegisterModel(ctx context.Context, model *Model) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.models[model.ID]; exists {
        return fmt.Errorf("model %s already exists", model.ID)
    }

    r.models[model.ID] = model
    return nil
}

func (r *InMemoryModelRegistry) GetModel(ctx context.Context, modelID string) (*Model, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    model, exists := r.models[modelID]
    if !exists {
        return nil, fmt.Errorf("model %s not found", modelID)
    }

    return model, nil
}

func (r *InMemoryModelRegistry) GetModelVersion(ctx context.Context,
    modelName string, version int) (*Model, error) {

    r.mu.RLock()
    defer r.mu.RUnlock()

    for _, model := range r.models {
        if model.Name == modelName && model.Version == version {
            return model, nil
        }
    }

    return nil, fmt.Errorf("model %s version %d not found", modelName, version)
}

func (r *InMemoryModelRegistry) PromoteModel(ctx context.Context,
    modelID string, stage ModelStage) error {

    r.mu.Lock()
    defer r.mu.Unlock()

    model, exists := r.models[modelID]
    if !exists {
        return fmt.Errorf("model %s not found", modelID)
    }

    model.Stage = stage
    return nil
}

func (r *InMemoryModelRegistry) ListModels(ctx context.Context) ([]*Model, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    var results []*Model
    for _, model := range r.models {
        results = append(results, model)
    }

    return results, nil
}
```

### Junior → FAANG: Training Pipelines and Experiment Tracking

Experiment tracking is the feature of training pipelines that most juniors undervalue and most experienced ML engineers consider non-negotiable. When you train ten versions of a model with different hyperparameters and later need to reproduce the best one, you need to know exactly which dataset version, feature schema version, and hyperparameter configuration produced it. Without experiment tracking, this information lives in someone's memory or a Slack message and is effectively lost. Tools like MLflow provide this tracking, and the key habit is to log every training run with the complete configuration before looking at the results.

The training-serving boundary in Go means that the training pipeline (possibly Python) must produce an artifact that the Go serving layer can load. ONNX is the most portable format: it is supported by Python's torch.onnx.export and by tf2onnx on the TensorFlow side, and it can be loaded in Go through a maintained ONNX Runtime binding such as `yalue/onnxruntime_go`. Practice the complete workflow: train a scikit-learn model in Python, export to ONNX, load in Go, and run inference with identical results to the Python serving path. Any divergence in outputs indicates a training-serving skew bug that must be resolved before production deployment.

For interviews, the question "how does a new model version get to production?" should trigger a complete answer covering: training pipeline completes and produces an artifact, artifact is validated against a golden test set, artifact is registered in the model registry with evaluation metrics, a canary deployment routes 1% of traffic to the new model, metrics are compared to the champion model for 24 hours, and the new model is promoted if metrics meet the threshold or rolled back if they do not. Having this complete deployment lifecycle answer ready is a strong signal of production ML experience.

### Senior @ FAANG: Training Pipeline Reliability and Reproducibility

Reproducibility is the most valuable property of a training pipeline, and the hardest to achieve. A training run that cannot be reproduced six months later makes post-incident analysis nearly impossible: when a model is degrading and you want to understand what changed between the current model and the previous champion, you need to be able to retrain both from scratch and compare the outputs. Achieving reproducibility requires: pinned dataset versions, deterministic preprocessing (same seed for any randomized operations), pinned library versions, and deterministic training (fixed random seeds, deterministic operator implementations). Designing and auditing these requirements across the entire training pipeline is a senior-level responsibility.

Distributed training orchestration adds significant operational complexity. Training a large model across multiple machines requires: a reliable job scheduler that handles machine failures and restarts interrupted runs, gradient aggregation that is numerically stable across machines, checkpoint management that enables restart from the latest checkpoint rather than the beginning, and experiment tracking that records which machines participated in each training run. Senior engineers who have operated distributed training at FAANG have deep familiarity with these failure modes and design the orchestration system to handle them gracefully.

Model validation automation is the gate between training and serving, and it must be designed to be both conservative and fast. Conservative means: if the validation is uncertain, it fails rather than passes, and the on-call engineer reviews before promotion. Fast means: the validation must complete quickly enough that the training pipeline meets its end-to-end SLO. Designing a validation suite that covers the most important failure modes in under 10 minutes requires careful prioritization: the golden test set for accuracy, a performance benchmark for latency, a basic bias audit for the most regulated use cases, and a checksum validation of the model artifact for integrity.

At L6 and above, training pipeline governance includes the policy for training data retention and access control. Training datasets that contain personal information must be subject to access controls, retention limits, and audit logging for compliance purposes. Implementing these controls across all training pipelines in the organization requires platform-level enforcement rather than per-team compliance, and the platform team owns the enforcement mechanisms.
