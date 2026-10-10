// internal/domain/experiment.go
package domain

import (
	"time"
	"uuid"
)

// Experiment represents a collection of related ML runs
type Experiment struct {
	ID          uuid.UUID         `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Tags        map[string]string `json:"tags"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
	CreatedBy   string            `json:"created_by"`
	Metadata    map[string]any    `json:"metadata"`
}

// Run represents a single execution of an ML experiment
type Run struct {
	ID           uuid.UUID          `json:"id"`
	ExperimentID uuid.UUID          `json:"experiment_id"`
	Name         string             `json:"name"`
	Status       RunStatus          `json:"status"`
	StartTime    time.Time          `json:"start_time"`
	EndTime      *time.Time         `json:"end_time,omitempty"`
	Parameters   map[string]any     `json:"parameters"`
	Metrics      map[string]float64 `json:"metrics"`
	Tags         map[string]string  `json:"tags"`
	SourceType   string             `json:"source_type"` // "NOTEBOOK", "JOB", "LOCAL"
	SourceName   string             `json:"source_name"`
	GitCommit    string             `json:"git_commit,omitempty"`
	GitBranch    string             `json:"git_branch,omitempty"`
	Artifacts    []Artifact         `json:"artifacts"`
	User         string             `json:"user"`
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
	ID         uuid.UUID `json:"id"`
	RunID      uuid.UUID `json:"run_id"`
	Path       string    `json:"path"`
	Type       string    `json:"type"` // "MODEL", "DATASET", "PLOT", "NOTEBOOK"
	Size       int64     `json:"size"`
	Hash       string    `json:"hash"` // SHA256
	CreatedAt  time.Time `json:"created_at"`
	StorageURI string    `json:"storage_uri"` // s3://bucket/path
}

// MetricPoint represents a single metric measurement
type MetricPoint struct {
	RunID     uuid.UUID `json:"run_id"`
	Key       string    `json:"key"`
	Value     float64   `json:"value"`
	Timestamp time.Time `json:"timestamp"`
	Step      int64     `json:"step"` // Training step/epoch
}
