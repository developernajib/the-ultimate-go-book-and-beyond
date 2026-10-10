## Core Domain Models

The domain models are the heart of the CI/CD platform. They define the data structures that represent pipelines, jobs, steps, and their various states throughout execution. These types are used by every other package in the system, from the database layer to the API handlers, so getting them right is critical. Notice how we use Go's type system to model state machines with typed string constants, which prevents invalid state transitions and makes the code self-documenting.

### Domain Types

Create `internal/domain/types.go`:

```go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// PipelineStatus represents the execution state of a pipeline
type PipelineStatus string

const (
	PipelineStatusPending   PipelineStatus = "pending"
	PipelineStatusRunning   PipelineStatus = "running"
	PipelineStatusSuccess   PipelineStatus = "success"
	PipelineStatusFailed    PipelineStatus = "failed"
	PipelineStatusCanceled PipelineStatus = "canceled"
)

// JobStatus represents the execution state of a job
type JobStatus string

const (
	JobStatusPending   JobStatus = "pending"
	JobStatusQueued    JobStatus = "queued"
	JobStatusRunning   JobStatus = "running"
	JobStatusSuccess   JobStatus = "success"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCanceled JobStatus = "canceled"
	JobStatusSkipped   JobStatus = "skipped"
)

// TriggerType represents how a pipeline was triggered
type TriggerType string

const (
	TriggerTypePush             TriggerType = "push"
	TriggerTypePullRequest      TriggerType = "pull_request"
	TriggerTypeSchedule         TriggerType = "schedule"
	TriggerTypeManual           TriggerType = "manual"
	TriggerTypeWorkflowDispatch TriggerType = "workflow_dispatch"
)

// Repository represents a Git repository configuration
type Repository struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	FullName    string     `json:"full_name"` // org/repo
	CloneURL    string     `json:"clone_url"`
	Provider    string     `json:"provider"` // github, gitlab, bitbucket
	IsPrivate   bool       `json:"is_private"`
	WebhookID   string     `json:"webhook_id,omitempty"`
	Active      bool       `json:"active"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	LastSyncAt  *time.Time `json:"last_sync_at,omitempty"`
}

// Pipeline represents a pipeline definition
type Pipeline struct {
	ID           uuid.UUID  `json:"id"`
	RepositoryID uuid.UUID  `json:"repository_id"`
	Name         string     `json:"name"`
	Description  string     `json:"description,omitempty"`
	FilePath     string     `json:"file_path"` // .pipeline.yaml
	Config       string     `json:"config"`    // YAML content
	Active       bool       `json:"active"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// PipelineRun represents a single execution of a pipeline
type PipelineRun struct {
	ID              uuid.UUID      `json:"id"`
	PipelineID      uuid.UUID      `json:"pipeline_id"`
	RepositoryID    uuid.UUID      `json:"repository_id"`
	Number          int            `json:"number"`          // Incremental run number
	Status          PipelineStatus `json:"status"`
	TriggerType     TriggerType    `json:"trigger_type"`
	Ref             string         `json:"ref"`             // Branch or tag name
	Commit          string         `json:"commit"`          // SHA
	CommitMessage   string         `json:"commit_message"`
	Author          string         `json:"author"`
	AuthorEmail     string         `json:"author_email"`
	StartedAt       *time.Time     `json:"started_at,omitempty"`
	CompletedAt     *time.Time     `json:"completed_at,omitempty"`
	Duration        int64          `json:"duration,omitempty"` // Milliseconds
	CreatedBy       uuid.UUID      `json:"created_by,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// Job represents a job definition within a pipeline
type Job struct {
	ID         uuid.UUID `json:"id"`
	PipelineID uuid.UUID `json:"pipeline_id"`
	Name       string    `json:"name"`
	Stage      string    `json:"stage"`
	Image      string    `json:"image"`
	Config     string    `json:"config"` // JSON-encoded job config
	CreatedAt  time.Time `json:"created_at"`
}

// JobRun represents a single execution of a job
type JobRun struct {
	ID            uuid.UUID  `json:"id"`
	PipelineRunID uuid.UUID  `json:"pipeline_run_id"`
	JobID         uuid.UUID  `json:"job_id"`
	Name          string     `json:"name"`
	Stage         string     `json:"stage"`
	Status        JobStatus  `json:"status"`
	WorkerID      *uuid.UUID `json:"worker_id,omitempty"`
	ExitCode      *int       `json:"exit_code,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	CompletedAt   *time.Time `json:"completed_at,omitempty"`
	Duration      int64      `json:"duration,omitempty"` // Milliseconds
	LogPath       string     `json:"log_path,omitempty"`
	RetryCount    int        `json:"retry_count"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Artifact represents a build artifact
type Artifact struct {
	ID            uuid.UUID `json:"id"`
	PipelineRunID uuid.UUID `json:"pipeline_run_id"`
	JobRunID      uuid.UUID `json:"job_run_id"`
	Name          string    `json:"name"`
	Path          string    `json:"path"`         // Path in S3
	SizeBytes     int64     `json:"size_bytes"`
	ContentType   string    `json:"content_type"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// Secret represents an encrypted secret
type Secret struct {
	ID           uuid.UUID `json:"id"`
	RepositoryID uuid.UUID `json:"repository_id"`
	Name         string    `json:"name"`
	Value        string    `json:"-"` // Never expose in JSON
	EncryptedValue string  `json:"-"` // Stored encrypted
	CreatedBy    uuid.UUID `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Worker represents a job executor
type Worker struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Hostname    string     `json:"hostname"`
	IPAddress   string     `json:"ip_address"`
	Status      string     `json:"status"` // idle, busy, offline
	LastSeenAt  time.Time  `json:"last_seen_at"`
	Capacity    int        `json:"capacity"` // Max concurrent jobs
	CurrentJobs int        `json:"current_jobs"`
	Version     string     `json:"version"`
	CreatedAt   time.Time  `json:"created_at"`
}
```

### Pipeline Configuration Types

Create `internal/parser/types.go`:

```go
package parser

import "time"

// PipelineConfig represents the parsed .pipeline.yaml
type PipelineConfig struct {
	Name          string                 `yaml:"name"`
	Description   string                 `yaml:"description,omitempty"`
	On            TriggerConfig          `yaml:"on"`
	Env           map[string]string      `yaml:"env,omitempty"`
	Variables     map[string]string      `yaml:"variables,omitempty"`
	Cache         *CacheConfig           `yaml:"cache,omitempty"`
	Stages        []StageConfig          `yaml:"stages"`
	Matrix        *MatrixConfig          `yaml:"matrix,omitempty"`
	Notifications *NotificationConfig    `yaml:"notifications,omitempty"`
}

// TriggerConfig defines when the pipeline runs
type TriggerConfig struct {
	Push             *PushTrigger      `yaml:"push,omitempty"`
	PullRequest      *PullRequestTrigger `yaml:"pull_request,omitempty"`
	Schedule         []ScheduleTrigger `yaml:"schedule,omitempty"`
	WorkflowDispatch bool              `yaml:"workflow_dispatch,omitempty"`
}

type PushTrigger struct {
	Branches []string `yaml:"branches,omitempty"`
	Tags     []string `yaml:"tags,omitempty"`
	Paths    []string `yaml:"paths,omitempty"`
}

type PullRequestTrigger struct {
	Branches []string `yaml:"branches,omitempty"`
	Types    []string `yaml:"types,omitempty"` // opened, synchronize, reopened
}

type ScheduleTrigger struct {
	Cron string `yaml:"cron"`
}

// StageConfig represents a pipeline stage
type StageConfig struct {
	Name      string      `yaml:"name"`
	Condition string      `yaml:"condition,omitempty"`
	Parallel  int         `yaml:"parallel,omitempty"`
	Jobs      []JobConfig `yaml:"jobs"`
}

// JobConfig represents a job within a stage
type JobConfig struct {
	Name         string            `yaml:"name"`
	Image        string            `yaml:"image"`
	DependsOn    []string          `yaml:"depends_on,omitempty"`
	Condition    string            `yaml:"condition,omitempty"`
	Timeout      time.Duration     `yaml:"timeout,omitempty"`
	Retry        *RetryConfig      `yaml:"retry,omitempty"`
	Env          map[string]string `yaml:"env,omitempty"`
	Secrets      []string          `yaml:"secrets,omitempty"`
	Services     []ServiceConfig   `yaml:"services,omitempty"`
	Cache        *CacheConfig      `yaml:"cache,omitempty"`
	BeforeScript []string          `yaml:"before_script,omitempty"`
	Steps        []StepConfig      `yaml:"steps"`
	AfterScript  []string          `yaml:"after_script,omitempty"`
	Artifacts    *ArtifactConfig   `yaml:"artifacts,omitempty"`
}

// StepConfig represents a single step in a job
type StepConfig struct {
	Name    string            `yaml:"name,omitempty"`
	Run     string            `yaml:"run,omitempty"`
	Shell   string            `yaml:"shell,omitempty"` // bash, sh, powershell
	Env     map[string]string `yaml:"env,omitempty"`
	WorkDir string            `yaml:"work_dir,omitempty"`
}

// ServiceConfig represents a service container (e.g., database)
type ServiceConfig struct {
	Name    string            `yaml:"name"`
	Image   string            `yaml:"image"`
	Env     map[string]string `yaml:"env,omitempty"`
	Ports   []string          `yaml:"ports,omitempty"`
	Options []string          `yaml:"options,omitempty"` // Docker options
}

// CacheConfig defines cache behavior
type CacheConfig struct {
	Paths []string `yaml:"paths"`
	Key   string   `yaml:"key,omitempty"`
}

// ArtifactConfig defines artifact collection
type ArtifactConfig struct {
	Paths    []string      `yaml:"paths"`
	Name     string        `yaml:"name,omitempty"`
	ExpireIn time.Duration `yaml:"expire_in,omitempty"`
}

// RetryConfig defines retry behavior
type RetryConfig struct {
	Max     int           `yaml:"max"`
	Backoff time.Duration `yaml:"backoff,omitempty"`
}

// MatrixConfig defines matrix builds
type MatrixConfig struct {
	Include []map[string]string `yaml:"include"`
}

// NotificationConfig defines notification settings
type NotificationConfig struct {
	Email   []string `yaml:"email,omitempty"`
	Slack   string   `yaml:"slack,omitempty"`
	Webhook string   `yaml:"webhook,omitempty"`
}
```

---
