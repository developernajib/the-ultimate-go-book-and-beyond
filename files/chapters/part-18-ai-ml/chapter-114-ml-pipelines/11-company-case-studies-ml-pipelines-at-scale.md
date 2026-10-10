## 114.10 Company Case Studies: ML Pipelines at Scale

### Google: Vertex AI Pipeline Patterns

Google's Vertex AI uses Kubeflow-based pipelines for ML workflows:

```go
// Google Vertex AI-style pipeline orchestration
package vertex

import (
    "context"
    "fmt"
    "time"
)

// Pipeline represents a Vertex AI-style ML pipeline
type Pipeline struct {
    Name        string
    Components  []PipelineComponent
    Artifacts   *ArtifactStore
    Metadata    *MetadataStore
}

type PipelineComponent struct {
    Name       string
    Image      string
    Command    []string
    Inputs     []ArtifactSpec
    Outputs    []ArtifactSpec
    Resources  ResourceSpec
}

type PipelineRun struct {
    ID           string
    Pipeline     *Pipeline
    Status       string
    StartTime    time.Time
    EndTime      *time.Time
    Parameters   map[string]any
    Artifacts    map[string]*Artifact
    Metrics      map[string]float64
}

// PipelineOrchestrator manages pipeline execution
type PipelineOrchestrator struct {
    kubeClient   KubernetesClient
    artifactStore *ArtifactStore
    metadataStore *MetadataStore
}

// Run executes a pipeline with given parameters
func (o *PipelineOrchestrator) Run(
    ctx context.Context,
    pipeline *Pipeline,
    params map[string]any,
) (*PipelineRun, error) {
    run := &PipelineRun{
        ID:         generateRunID(),
        Pipeline:   pipeline,
        Status:     "Running",
        StartTime:  time.Now(),
        Parameters: params,
        Artifacts:  make(map[string]*Artifact),
        Metrics:    make(map[string]float64),
    }

    // Record pipeline run in metadata store
    if err := o.metadataStore.RecordRun(run); err != nil {
        return nil, err
    }

    // Execute components in dependency order
    for _, component := range pipeline.Components {
        if err := o.executeComponent(ctx, run, component); err != nil {
            run.Status = "Failed"
            return run, err
        }
    }

    run.Status = "Succeeded"
    now := time.Now()
    run.EndTime = &now

    return run, nil
}

func (o *PipelineOrchestrator) executeComponent(
    ctx context.Context,
    run *PipelineRun,
    component PipelineComponent,
) error {
    // Create Kubernetes job for component
    job := o.buildJob(run, component)

    if err := o.kubeClient.CreateJob(ctx, job); err != nil {
        return fmt.Errorf("create job failed: %w", err)
    }

    // Wait for completion
    if err := o.kubeClient.WaitForJob(ctx, job.Name, 30*time.Minute); err != nil {
        return fmt.Errorf("job failed: %w", err)
    }

    // Record output artifacts
    for _, output := range component.Outputs {
        artifact, err := o.artifactStore.Get(run.ID, output.Name)
        if err == nil {
            run.Artifacts[output.Name] = artifact
        }
    }

    return nil
}

type ArtifactSpec struct {
    Name string
    URI  string
}

type ResourceSpec struct {
    CPU    string
    Memory string
    GPU    int
}

type Artifact struct {
    URI      string
    Metadata map[string]string
}

type ArtifactStore struct{}

func (s *ArtifactStore) Get(runID, name string) (*Artifact, error) {
    return &Artifact{URI: fmt.Sprintf("gs://artifacts/%s/%s", runID, name)}, nil
}

type MetadataStore struct{}

func (m *MetadataStore) RecordRun(run *PipelineRun) error {
    return nil
}

type KubernetesJob struct {
    Name string
}

type KubernetesClient interface {
    CreateJob(ctx context.Context, job *KubernetesJob) error
    WaitForJob(ctx context.Context, name string, timeout time.Duration) error
}

func generateRunID() string {
    return fmt.Sprintf("run-%d", time.Now().UnixNano())
}

func (o *PipelineOrchestrator) buildJob(run *PipelineRun, component PipelineComponent) *KubernetesJob {
    return &KubernetesJob{Name: fmt.Sprintf("%s-%s", component.Name, run.ID)}
}
```

### Netflix: Feature Store Architecture

Netflix's feature platform handles petabytes of feature data:

```go
// Netflix-style feature store
package featurestore

import (
    "context"
    "time"
)

// FeatureStore provides unified access to ML features
type FeatureStore struct {
    onlineStore   OnlineStore   // Low-latency serving (Redis/DynamoDB)
    offlineStore  OfflineStore  // Historical features (Spark/Hive)
    registry      FeatureRegistry
    monitoring    *FeatureMonitoring
}

type FeatureGroup struct {
    Name        string
    Entity      string
    Features    []FeatureDefinition
    Source      DataSource
    TTL         time.Duration
}

type FeatureDefinition struct {
    Name        string
    Type        string
    Description string
    Tags        []string
}

// GetOnlineFeatures retrieves features for real-time inference
func (fs *FeatureStore) GetOnlineFeatures(
    ctx context.Context,
    entityKey string,
    featureNames []string,
) (map[string]any, error) {
    // Get features from online store
    features, err := fs.onlineStore.Get(ctx, entityKey, featureNames)
    if err != nil {
        return nil, err
    }

    // Record feature freshness metrics
    fs.monitoring.RecordFetch(featureNames, features)

    // Fill missing features with defaults
    result := make(map[string]any)
    for _, name := range featureNames {
        if val, ok := features[name]; ok {
            result[name] = val
        } else {
            result[name] = fs.registry.GetDefault(name)
            fs.monitoring.RecordMissing(name)
        }
    }

    return result, nil
}

// Materialize syncs features from offline to online store
func (fs *FeatureStore) Materialize(
    ctx context.Context,
    group *FeatureGroup,
    startTime, endTime time.Time,
) error {
    // Read from offline store
    features, err := fs.offlineStore.Read(ctx, group, startTime, endTime)
    if err != nil {
        return err
    }

    // Write to online store in batches
    batch := make([]FeatureRecord, 0, 1000)
    for feature := range features {
        batch = append(batch, feature)

        if len(batch) >= 1000 {
            if err := fs.onlineStore.WriteBatch(ctx, batch); err != nil {
                return err
            }
            batch = batch[:0]
        }
    }

    // Write remaining
    if len(batch) > 0 {
        return fs.onlineStore.WriteBatch(ctx, batch)
    }

    return nil
}

type OnlineStore interface {
    Get(ctx context.Context, entityKey string, featureNames []string) (map[string]any, error)
    WriteBatch(ctx context.Context, batch []FeatureRecord) error
}

type OfflineStore interface {
    Read(ctx context.Context, group *FeatureGroup, startTime, endTime time.Time) (<-chan FeatureRecord, error)
}

type FeatureRegistry interface {
    GetDefault(name string) any
}

type FeatureMonitoring struct{}

func (m *FeatureMonitoring) RecordFetch(names []string, features map[string]any) {}
func (m *FeatureMonitoring) RecordMissing(name string)                           {}

type DataSource string

type FeatureRecord struct {
    EntityID string
    Values   map[string]any
}
```

### Uber: Michelangelo ML Platform

Uber's Michelangelo platform manages the full ML lifecycle:

```go
// Uber Michelangelo-style model management
package michelangelo

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// ModelRegistry manages model versions and metadata
type ModelRegistry struct {
    mu       sync.RWMutex
    models   map[string]*ModelEntry
    storage  ModelStorage
}

type ModelEntry struct {
    Name        string
    Versions    []ModelVersion
    Production  *ModelVersion
    Staging     *ModelVersion
}

type ModelVersion struct {
    Version     string
    Artifact    string
    Metrics     map[string]float64
    Parameters  map[string]any
    CreatedAt   time.Time
    CreatedBy   string
    Tags        []string
}

// RegisterModel registers a new model version
func (r *ModelRegistry) RegisterModel(
    ctx context.Context,
    name string,
    version ModelVersion,
) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    entry, ok := r.models[name]
    if !ok {
        entry = &ModelEntry{
            Name:     name,
            Versions: make([]ModelVersion, 0),
        }
        r.models[name] = entry
    }

    // Store model artifact
    artifact, err := r.storage.Store(ctx, version.Artifact)
    if err != nil {
        return err
    }
    version.Artifact = artifact

    entry.Versions = append(entry.Versions, version)

    return nil
}

// PromoteToStaging promotes a version to staging
func (r *ModelRegistry) PromoteToStaging(
    ctx context.Context,
    name, version string,
) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    entry, ok := r.models[name]
    if !ok {
        return fmt.Errorf("model not found: %s", name)
    }

    for i := range entry.Versions {
        if entry.Versions[i].Version == version {
            entry.Staging = &entry.Versions[i]
            return nil
        }
    }

    return fmt.Errorf("version not found: %s", version)
}

// PromoteToProduction promotes staging to production
func (r *ModelRegistry) PromoteToProduction(
    ctx context.Context,
    name string,
) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    entry, ok := r.models[name]
    if !ok {
        return fmt.Errorf("model not found: %s", name)
    }

    if entry.Staging == nil {
        return fmt.Errorf("no staging version to promote")
    }

    entry.Production = entry.Staging
    entry.Staging = nil

    return nil
}

// ModelServer serves models for inference
type ModelServer struct {
    registry   *ModelRegistry
    cache      *ModelCache
    metrics    *InferenceMetrics
}

// Predict performs model inference
func (s *ModelServer) Predict(
    ctx context.Context,
    modelName string,
    features map[string]any,
) (map[string]any, error) {
    start := time.Now()

    // Get model from cache
    model, err := s.cache.Get(modelName)
    if err != nil {
        // Load from registry
        entry := s.registry.GetModel(modelName)
        if entry == nil || entry.Production == nil {
            return nil, fmt.Errorf("model not found: %s", modelName)
        }

        model, err = s.cache.Load(entry.Production.Artifact)
        if err != nil {
            return nil, err
        }
    }

    // Run inference
    result, err := model.Predict(features)

    // Record metrics
    s.metrics.RecordLatency(modelName, time.Since(start))
    if err != nil {
        s.metrics.RecordError(modelName)
    }

    return result, err
}

type ModelStorage interface {
    Store(ctx context.Context, artifact string) (string, error)
}

func (r *ModelRegistry) GetModel(name string) *ModelEntry {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.models[name]
}

type ModelInstance interface {
    Predict(features map[string]any) (map[string]any, error)
}

type ModelCache struct{}

func (c *ModelCache) Get(modelName string) (ModelInstance, error) {
    return nil, fmt.Errorf("cache miss")
}

func (c *ModelCache) Load(artifact string) (ModelInstance, error) {
    return &stubModelInstance{}, nil
}

type stubModelInstance struct{}

func (s *stubModelInstance) Predict(features map[string]any) (map[string]any, error) {
    return features, nil
}

type InferenceMetrics struct{}

func (m *InferenceMetrics) RecordLatency(name string, d time.Duration) {}
func (m *InferenceMetrics) RecordError(name string)                   {}
```

### Amazon: SageMaker Pipeline Patterns

Amazon SageMaker provides managed ML pipeline infrastructure:

```go
// Amazon SageMaker-style pipeline components
package sagemaker

import (
    "context"
    "fmt"
)

// ProcessingJob represents a data processing job
type ProcessingJob struct {
    Name             string
    Image            string
    InstanceType     string
    InstanceCount    int
    ProcessingInputs []ProcessingInput
    ProcessingOutputs []ProcessingOutput
    Code             string
}

// TrainingJob represents a model training job
type TrainingJob struct {
    Name            string
    AlgorithmSpec   AlgorithmSpec
    HyperParameters map[string]string
    InputDataConfig []DataChannel
    OutputDataConfig OutputDataConfig
    ResourceConfig   ResourceConfig
}

// PipelineStep represents a step in the pipeline
type PipelineStep interface {
    Name() string
    Execute(ctx context.Context) error
    DependsOn() []string
}

// TrainingStep wraps a training job as a pipeline step
type TrainingStep struct {
    name         string
    trainingJob  *TrainingJob
    dependencies []string
    client       SageMakerClient
}

func (s *TrainingStep) Execute(ctx context.Context) error {
    // Create training job
    jobName := fmt.Sprintf("%s-%s", s.name, generateID())

    if err := s.client.CreateTrainingJob(ctx, s.trainingJob); err != nil {
        return err
    }

    // Wait for completion
    return s.client.WaitForTrainingJob(ctx, jobName)
}

// ConditionalStep executes based on condition
type ConditionalStep struct {
    name         string
    condition    func(ctx context.Context) bool
    ifTrue       PipelineStep
    ifFalse      PipelineStep
}

func (s *ConditionalStep) Execute(ctx context.Context) error {
    if s.condition(ctx) {
        return s.ifTrue.Execute(ctx)
    }
    if s.ifFalse != nil {
        return s.ifFalse.Execute(ctx)
    }
    return nil
}

// ConditionStep checks model quality before deployment
type ModelQualityCondition struct {
    metrics    *ModelMetrics
    threshold  float64
}

func (c *ModelQualityCondition) Evaluate(ctx context.Context) bool {
    return c.metrics.GetAUC() > c.threshold
}

type ProcessingInput struct{}
type ProcessingOutput struct{}
type AlgorithmSpec struct{}
type DataChannel struct{}
type OutputDataConfig struct{}
type ResourceConfig struct{}

type SageMakerClient interface {
    CreateTrainingJob(ctx context.Context, job *TrainingJob) error
    WaitForTrainingJob(ctx context.Context, jobName string) error
}

func generateID() string {
    return "job-1"
}

type ModelMetrics struct {
    AUC float64
}

func (m *ModelMetrics) GetAUC() float64 {
    return m.AUC
}
```

### Stripe: Online/Offline Feature Consistency

Stripe ensures feature parity between training and serving:

```go
// Stripe-style feature consistency
package features

import (
    "context"
    "time"
)

// FeatureSpec defines a feature with both offline and online computation
type FeatureSpec struct {
    Name           string
    OfflineCompute OfflineComputation
    OnlineCompute  OnlineComputation
    Validator      FeatureValidator
}

type OfflineComputation func(ctx context.Context, data DataFrame) ([]float64, error)
type OnlineComputation func(ctx context.Context, entity Entity) (float64, error)

// FeatureValidator ensures consistency between offline and online
type FeatureValidator interface {
    Validate(offline, online float64) error
}

// ConsistencyChecker validates feature parity
type ConsistencyChecker struct {
    specs      map[string]FeatureSpec
    tolerance  float64
    violations []ConsistencyViolation
}

type ConsistencyViolation struct {
    FeatureName  string
    EntityID     string
    OfflineValue float64
    OnlineValue  float64
    Difference   float64
}

// Check validates a sample of entities
func (c *ConsistencyChecker) Check(
    ctx context.Context,
    entities []Entity,
) ([]ConsistencyViolation, error) {
    c.violations = make([]ConsistencyViolation, 0)

    for _, entity := range entities {
        for name, spec := range c.specs {
            // Compute offline value
            offline, err := spec.OfflineCompute(ctx, entity.ToDataFrame())
            if err != nil {
                return nil, err
            }

            // Compute online value
            online, err := spec.OnlineCompute(ctx, entity)
            if err != nil {
                return nil, err
            }

            // Check consistency
            diff := abs(offline[0] - online)
            if diff > c.tolerance {
                c.violations = append(c.violations, ConsistencyViolation{
                    FeatureName:  name,
                    EntityID:     entity.ID,
                    OfflineValue: offline[0],
                    OnlineValue:  online,
                    Difference:   diff,
                })
            }
        }
    }

    return c.violations, nil
}

// FeatureLogger logs feature values for offline analysis
type FeatureLogger struct {
    sink FeatureSink
}

func (l *FeatureLogger) Log(
    ctx context.Context,
    entityID string,
    features map[string]float64,
    prediction any,
    label any,
) error {
    record := FeatureRecord{
        EntityID:   entityID,
        Features:   features,
        Prediction: prediction,
        Label:      label,
        Timestamp:  time.Now(),
    }

    return l.sink.Write(ctx, record)
}

type DataFrame struct{}

type Entity struct {
    ID string
}

func (e Entity) ToDataFrame() DataFrame {
    return DataFrame{}
}

func abs(x float64) float64 {
    if x < 0 {
        return -x
    }
    return x
}

type FeatureRecord struct {
    EntityID   string
    Features   map[string]float64
    Prediction any
    Label      any
    Timestamp  time.Time
}

type FeatureSink interface {
    Write(ctx context.Context, record FeatureRecord) error
}
```

### Junior → FAANG: Case Studies as Architecture Vocabulary

Understanding Vertex AI, FBLearner Flow, and Michelangelo at a high level gives you the vocabulary to participate in architecture discussions at FAANG. You do not need to have used these systems personally, but you should be able to describe what problem each one solves, how it fits into the broader ML platform, and what engineering tradeoffs it embodies. Get the descriptions right, because interviewers who have worked on these systems notice when you do not.

Vertex AI is Google Cloud's managed ML platform, announced in 2021 as a consolidation of the older AI Platform (training and prediction) with the AutoML product family, behind one API and console. FBLearner Flow, which Meta introduced publicly in 2016, is a workflow platform rather than a feature store: its contribution is the authoring and execution environment for distributed ML pipelines, an experiment management UI, and a library of reusable predefined pipelines, all aimed at letting many teams reuse algorithms and run large numbers of experiments. Michelangelo is Uber's end-to-end ML platform covering the full lifecycle, and its feature store is one component of it rather than the whole thing. Knowing these three, and knowing what each actually is, gives you reference points for almost any ML platform architecture discussion.

When studying these case studies, identify the specific pain points that drove each design decision. Michelangelo's dual online/offline store was designed specifically to solve the training-serving skew problem that had caused multiple production incidents. That causal relationship (incident caused pain, pain drove design) is the kind of reasoning that makes a case study valuable in an interview: "Uber built Michelangelo because they kept having incidents where training features and serving features diverged, so they designed a system where the transformation logic is defined once and executed identically in both contexts."

### Senior @ FAANG: Case Studies as Design Review Evidence

Senior engineers use these case studies as evidence in design reviews and investment proposals. When proposing to build a feature store, citing the specific ROI that Uber and Meta derived from their investments (reduced production incidents, faster model iteration cycles, lower feature engineering cost) is more persuasive than abstract arguments about engineering quality. The case studies provide third-party validation that the investment is worthwhile, which is often the difference between a proposal being approved and being deprioritized.

The evolution of these platforms over time is also instructive. None of them were designed in their final form from the beginning: they grew incrementally in response to specific pain points. Michelangelo started as a model training and serving framework and grew to include the feature store as the cost of inconsistent feature computation became clear. Vertex AI began as separate products, principally the AI Platform training and prediction services alongside the AutoML family, and was unified under a single API and console in 2021 after the fragmentation became a real barrier to adoption. This evolutionary pattern is the realistic expectation for any ML platform: start simple, add components as specific pain points emerge, and refactor aggressively when the system becomes too complex to extend cleanly.

At L6, the lesson from these case studies is that ML platform engineering is a long-term investment that compounds over time. The teams that built Michelangelo and FBLearner did not deliver immediate business value: they enabled the model teams to deliver business value more reliably and at higher velocity. Communicating this indirect value to leadership, and maintaining organizational support for platform investments that do not have immediate visible impact, is a critical staff-level skill that distinguishes effective platform engineers from those who lose budget battles to higher-visibility product work.

---
