// internal/domain/pipeline.go
package domain

import (
	"time"
	"uuid"
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
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Type        StepType              `json:"type"`
	Config      map[string]any        `json:"config"`
	DependsOn   []string              `json:"depends_on"` // Step IDs
	RetryPolicy *RetryPolicy          `json:"retry_policy,omitempty"`
	Timeout     time.Duration         `json:"timeout"`
	Resources   *ResourceRequirements `json:"resources,omitempty"`
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
	MaxRetries     int      `json:"max_retries"`
	BackoffSeconds []int    `json:"backoff_seconds"`
	RetryOn        []string `json:"retry_on"` // Error types to retry
}

// ResourceRequirements specifies compute resources
type ResourceRequirements struct {
	CPUCores float64 `json:"cpu_cores"`
	MemoryMB int     `json:"memory_mb"`
	GPUCount int     `json:"gpu_count,omitempty"`
	GPUType  string  `json:"gpu_type,omitempty"`
}

// Schedule defines when a pipeline runs
type Schedule struct {
	CronExpression string     `json:"cron_expression"`
	Timezone       string     `json:"timezone"`
	StartDate      time.Time  `json:"start_date"`
	EndDate        *time.Time `json:"end_date,omitempty"`
}

// PipelineRun represents an execution of a pipeline
type PipelineRun struct {
	ID          uuid.UUID           `json:"id"`
	PipelineID  uuid.UUID           `json:"pipeline_id"`
	Status      PipelineStatus      `json:"status"`
	StartTime   time.Time           `json:"start_time"`
	EndTime     *time.Time          `json:"end_time,omitempty"`
	StepRuns    map[string]*StepRun `json:"step_runs"`
	Params      map[string]any      `json:"params"`
	TriggerType string              `json:"trigger_type"` // "MANUAL", "SCHEDULED", "API"
}

// PipelineStatus represents the state of a pipeline run
type PipelineStatus string

const (
	PipelineStatusRunning   PipelineStatus = "RUNNING"
	PipelineStatusSucceeded PipelineStatus = "SUCCEEDED"
	PipelineStatusFailed    PipelineStatus = "FAILED"
	PipelineStatusCancelled PipelineStatus = "CANCELLED"
)

// StepRun represents the execution of a single step
type StepRun struct {
	StepID    string         `json:"step_id"`
	Status    PipelineStatus `json:"status"`
	StartTime time.Time      `json:"start_time"`
	EndTime   *time.Time     `json:"end_time,omitempty"`
	Attempts  int            `json:"attempts"`
	Error     string         `json:"error,omitempty"`
	Outputs   map[string]any `json:"outputs"`
}
