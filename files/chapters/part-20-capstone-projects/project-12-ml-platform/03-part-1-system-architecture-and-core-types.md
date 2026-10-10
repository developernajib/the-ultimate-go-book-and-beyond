## Part 1: System Architecture and Core Types

Before writing any business logic, you need to define the data structures that represent the core concepts in your ML platform. These domain models act as the shared language between every service in the system. Getting them right early prevents costly refactoring later, because every other component -- from experiment tracking to model serving -- depends on these types.

### 1.1 Core Domain Models

The domain models below capture what an experiment, a run, an artifact, and a metric measurement look like in your platform. An `Experiment` groups related training runs together, each `Run` records the parameters, metrics, and artifacts from a single training execution, and `Artifact` tracks the files produced along the way. These structs use standard Go conventions like UUID identifiers and JSON tags so they can be easily stored in a database and serialized over HTTP or gRPC.

```go
// internal/domain/experiment.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// Experiment represents a collection of related ML runs
type Experiment struct {
	ID          uuid.UUID              `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Tags        map[string]string      `json:"tags"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
	CreatedBy   string                 `json:"created_by"`
	Metadata    map[string]any `json:"metadata"`
}

// Run represents a single execution of an ML experiment
type Run struct {
	ID           uuid.UUID              `json:"id"`
	ExperimentID uuid.UUID              `json:"experiment_id"`
	Name         string                 `json:"name"`
	Status       RunStatus              `json:"status"`
	StartTime    time.Time              `json:"start_time"`
	EndTime      *time.Time             `json:"end_time,omitempty"`
	Parameters   map[string]any `json:"parameters"`
	Metrics      map[string]float64     `json:"metrics"`
	Tags         map[string]string      `json:"tags"`
	SourceType   string                 `json:"source_type"` // "NOTEBOOK", "JOB", "LOCAL"
	SourceName   string                 `json:"source_name"`
	GitCommit    string                 `json:"git_commit,omitempty"`
	GitBranch    string                 `json:"git_branch,omitempty"`
	Artifacts    []Artifact             `json:"artifacts"`
	User         string                 `json:"user"`
}

// RunStatus represents the state of an experiment run
type RunStatus string

const (
	RunStatusRunning   RunStatus = "RUNNING"
	RunStatusCompleted RunStatus = "COMPLETED"
	RunStatusFailed    RunStatus = "FAILED"
	RunStatusKilled    RunStatus = "KILLED"
	RunStatusScheduled RunStatus = "SCHEDULED"
)

// Artifact represents a file or object produced by a run
type Artifact struct {
	ID        uuid.UUID `json:"id"`
	RunID     uuid.UUID `json:"run_id"`
	Path      string    `json:"path"`
	Type      string    `json:"type"` // "MODEL", "DATASET", "PLOT", "NOTEBOOK"
	Size      int64     `json:"size"`
	Hash      string    `json:"hash"` // SHA256
	CreatedAt time.Time `json:"created_at"`
	StorageURI string   `json:"storage_uri"` // s3://bucket/path
}

// MetricPoint represents a single metric measurement
type MetricPoint struct {
	RunID     uuid.UUID `json:"run_id"`
	Key       string    `json:"key"`
	Value     float64   `json:"value"`
	Timestamp time.Time `json:"timestamp"`
	Step      int64     `json:"step"` // Training step/epoch
}
```

### 1.2 Model Registry Types

The model registry is where trained models go after an experiment run succeeds. Think of it like a version control system specifically for ML models. Each `RegisteredModel` has a unique name and can have many `ModelVersion` entries, and each version moves through stages such as "Staging" and "Production." This stage-based lifecycle lets your team promote models safely from development all the way to live traffic.

```go
// internal/domain/model.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// RegisteredModel represents a named model in the registry
type RegisteredModel struct {
	ID              uuid.UUID         `json:"id"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Tags            map[string]string `json:"tags"`
	CreatedAt       time.Time         `json:"created_at"`
	UpdatedAt       time.Time         `json:"updated_at"`
	LatestVersions  map[ModelStage]int `json:"latest_versions"`
}

// ModelVersion represents a specific version of a model
type ModelVersion struct {
	ID              uuid.UUID              `json:"id"`
	ModelID         uuid.UUID              `json:"model_id"`
	Version         int                    `json:"version"`
	RunID           uuid.UUID              `json:"run_id"`
	Stage           ModelStage             `json:"stage"`
	Description     string                 `json:"description"`
	Tags            map[string]string      `json:"tags"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`
	SourcePath      string                 `json:"source_path"`
	Format          ModelFormat            `json:"format"`
	Framework       string                 `json:"framework"` // "tensorflow", "pytorch", "onnx", "go"
	Signature       ModelSignature         `json:"signature"`
	Metadata        map[string]any `json:"metadata"`
	PerformanceMetrics map[string]float64  `json:"performance_metrics"`
}

// ModelStage represents the deployment stage of a model
type ModelStage string

const (
	ModelStageNone       ModelStage = "NONE"
	ModelStageStaging    ModelStage = "STAGING"
	ModelStageProduction ModelStage = "PRODUCTION"
	ModelStageArchived   ModelStage = "ARCHIVED"
)

// ModelFormat represents the serialization format of a model
type ModelFormat string

const (
	ModelFormatONNX       ModelFormat = "ONNX"
	ModelFormatTensorFlow ModelFormat = "TENSORFLOW"
	ModelFormatPyTorch    ModelFormat = "PYTORCH"
	ModelFormatSKLearn    ModelFormat = "SKLEARN"
	ModelFormatGoNative   ModelFormat = "GO_NATIVE"
)

// ModelSignature defines the input/output schema of a model
type ModelSignature struct {
	Inputs  []TensorSpec `json:"inputs"`
	Outputs []TensorSpec `json:"outputs"`
}

// TensorSpec describes a tensor's shape and type
type TensorSpec struct {
	Name  string      `json:"name"`
	Type  TensorType  `json:"type"`
	Shape []int       `json:"shape"` // -1 for variable dimensions
}

// TensorType represents the data type of a tensor
type TensorType string

const (
	TensorTypeFloat32 TensorType = "FLOAT32"
	TensorTypeFloat64 TensorType = "FLOAT64"
	TensorTypeInt32   TensorType = "INT32"
	TensorTypeInt64   TensorType = "INT64"
	TensorTypeString  TensorType = "STRING"
	TensorTypeBool    TensorType = "BOOL"
)

// ModelTransition represents a stage change request
type ModelTransition struct {
	ID              uuid.UUID  `json:"id"`
	ModelVersionID  uuid.UUID  `json:"model_version_id"`
	FromStage       ModelStage `json:"from_stage"`
	ToStage         ModelStage `json:"to_stage"`
	RequestedBy     string     `json:"requested_by"`
	RequestedAt     time.Time  `json:"requested_at"`
	ApprovedBy      string     `json:"approved_by,omitempty"`
	ApprovedAt      *time.Time `json:"approved_at,omitempty"`
	Status          string     `json:"status"` // "PENDING", "APPROVED", "REJECTED"
	Comment         string     `json:"comment"`
}
```

### 1.3 Feature Store Types

A feature store is a centralized place to define, store, and serve the input features that ML models need for training and prediction. Without one, teams end up duplicating feature computation logic across notebooks and services, leading to inconsistencies between training and serving. The types below define a `FeatureGroup` (a logical collection of related features), individual `Feature` definitions with their data types and validation rules, and a `FeatureVector` that bundles feature values together for a specific entity like a user or product.

```go
// internal/domain/feature.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// FeatureGroup represents a collection of related features
type FeatureGroup struct {
	ID          uuid.UUID         `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	EntityType  string            `json:"entity_type"` // "user", "item", "transaction"
	Features    []FeatureDefinition `json:"features"`
	Source      DataSource        `json:"source"`
	Tags        map[string]string `json:"tags"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

// FeatureDefinition defines a single feature
type FeatureDefinition struct {
	Name        string            `json:"name"`
	Type        FeatureType       `json:"type"`
	Description string            `json:"description"`
	Tags        map[string]string `json:"tags"`
	Validator   *FeatureValidator `json:"validator,omitempty"`
}

// FeatureType represents the data type of a feature
type FeatureType string

const (
	FeatureTypeInt64   FeatureType = "INT64"
	FeatureTypeFloat64 FeatureType = "FLOAT64"
	FeatureTypeString  FeatureType = "STRING"
	FeatureTypeBool    FeatureType = "BOOL"
	FeatureTypeBytes   FeatureType = "BYTES"
	FeatureTypeArray   FeatureType = "ARRAY"
)

// FeatureValidator defines validation rules for a feature
type FeatureValidator struct {
	MinValue *float64 `json:"min_value,omitempty"`
	MaxValue *float64 `json:"max_value,omitempty"`
	AllowedValues []any `json:"allowed_values,omitempty"`
	Regex    *string  `json:"regex,omitempty"`
}

// DataSource represents where features are sourced from
type DataSource struct {
	Type       string                 `json:"type"` // "BATCH", "STREAM", "REQUEST"
	BatchSource *BatchSource          `json:"batch_source,omitempty"`
	StreamSource *StreamSource        `json:"stream_source,omitempty"`
}

// BatchSource defines offline feature source
type BatchSource struct {
	Type          string    `json:"type"` // "PARQUET", "CSV", "DATABASE"
	Path          string    `json:"path"`
	EventTimestamp string   `json:"event_timestamp_column"`
	CreatedTimestamp string `json:"created_timestamp_column"`
}

// StreamSource defines online feature source
type StreamSource struct {
	Type  string `json:"type"` // "KAFKA", "KINESIS", "PUBSUB"
	Topic string `json:"topic"`
	BootstrapServers []string `json:"bootstrap_servers,omitempty"`
}

// FeatureView represents a materialized view of features
type FeatureView struct {
	ID             uuid.UUID       `json:"id"`
	Name           string          `json:"name"`
	FeatureGroups  []string        `json:"feature_groups"`
	Entities       []string        `json:"entities"`
	Features       []string        `json:"features"`
	OnlineEnabled  bool            `json:"online_enabled"`
	OfflineEnabled bool            `json:"offline_enabled"`
	TTL            *time.Duration  `json:"ttl,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

// FeatureVector represents feature values for an entity
type FeatureVector struct {
	EntityID   string                 `json:"entity_id"`
	Features   map[string]any `json:"features"`
	EventTime  time.Time              `json:"event_time"`
}

// PointInTimeRequest requests features as of a specific time
type PointInTimeRequest struct {
	EntityIDs    []string  `json:"entity_ids"`
	FeatureViews []string  `json:"feature_views"`
	Timestamp    time.Time `json:"timestamp"`
}
```

### 1.4 Pipeline Orchestration Types

ML workflows rarely consist of a single step. A typical pipeline might fetch data, clean it, extract features, train a model, evaluate it, and then register the result. The types here model this as a directed acyclic graph (DAG), where each `PipelineStep` declares which other steps it depends on. The `Pipeline` struct ties the steps together, and `PipelineExecution` tracks the runtime state of a pipeline run so you can monitor progress and retry failed steps.

```go
// internal/domain/pipeline.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// Pipeline represents a DAG of ML workflow steps
type Pipeline struct {
	ID          uuid.UUID         `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Steps       []PipelineStep    `json:"steps"`
	Schedule    *Schedule         `json:"schedule,omitempty"`
	Tags        map[string]string `json:"tags"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

// PipelineStep represents a single step in a pipeline
type PipelineStep struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Type         StepType          `json:"type"`
	Config       map[string]any `json:"config"`
	DependsOn    []string          `json:"depends_on"` // Step IDs
	RetryPolicy  *RetryPolicy      `json:"retry_policy,omitempty"`
	Timeout      time.Duration     `json:"timeout"`
	Resources    *ResourceRequirements `json:"resources,omitempty"`
}

// StepType defines the type of pipeline step
type StepType string

const (
	StepTypeDataPrep   StepType = "DATA_PREP"
	StepTypeTraining   StepType = "TRAINING"
	StepTypeValidation StepType = "VALIDATION"
	StepTypeDeployment StepType = "DEPLOYMENT"
	StepTypeCustom     StepType = "CUSTOM"
)

// RetryPolicy defines retry behavior for failed steps
type RetryPolicy struct {
	MaxRetries     int           `json:"max_retries"`
	BackoffSeconds []int         `json:"backoff_seconds"`
	RetryOn        []string      `json:"retry_on"` // Error types to retry
}

// ResourceRequirements specifies compute resources
type ResourceRequirements struct {
	CPUCores   float64 `json:"cpu_cores"`
	MemoryMB   int     `json:"memory_mb"`
	GPUCount   int     `json:"gpu_count,omitempty"`
	GPUType    string  `json:"gpu_type,omitempty"`
}

// Schedule defines when a pipeline runs
type Schedule struct {
	CronExpression string    `json:"cron_expression"`
	Timezone       string    `json:"timezone"`
	StartDate      time.Time `json:"start_date"`
	EndDate        *time.Time `json:"end_date,omitempty"`
}

// PipelineRun represents an execution of a pipeline
type PipelineRun struct {
	ID          uuid.UUID              `json:"id"`
	PipelineID  uuid.UUID              `json:"pipeline_id"`
	Status      PipelineStatus         `json:"status"`
	StartTime   time.Time              `json:"start_time"`
	EndTime     *time.Time             `json:"end_time,omitempty"`
	StepRuns    map[string]*StepRun    `json:"step_runs"`
	Params      map[string]any `json:"params"`
	TriggerType string                 `json:"trigger_type"` // "MANUAL", "SCHEDULED", "API"
}

// PipelineStatus represents the state of a pipeline run
type PipelineStatus string

const (
	PipelineStatusRunning   PipelineStatus = "RUNNING"
	PipelineStatusSucceeded PipelineStatus = "SUCCEEDED"
	PipelineStatusFailed    PipelineStatus = "FAILED"
	PipelineStatusCanceled PipelineStatus = "CANCELED"
)

// StepRun represents the execution of a single step
type StepRun struct {
	StepID      string         `json:"step_id"`
	Status      PipelineStatus `json:"status"`
	StartTime   time.Time      `json:"start_time"`
	EndTime     *time.Time     `json:"end_time,omitempty"`
	Attempts    int            `json:"attempts"`
	Error       string         `json:"error,omitempty"`
	Outputs     map[string]any `json:"outputs"`
}
```

---
