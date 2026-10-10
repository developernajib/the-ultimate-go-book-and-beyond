// internal/domain/model.go
package domain

import (
	"time"
	"uuid"
)

// RegisteredModel represents a named model in the registry
type RegisteredModel struct {
	ID             uuid.UUID          `json:"id"`
	Name           string             `json:"name"`
	Description    string             `json:"description"`
	Tags           map[string]string  `json:"tags"`
	CreatedAt      time.Time          `json:"created_at"`
	UpdatedAt      time.Time          `json:"updated_at"`
	LatestVersions map[ModelStage]int `json:"latest_versions"`
}

// ModelVersion represents a specific version of a model
type ModelVersion struct {
	ID                 uuid.UUID          `json:"id"`
	ModelID            uuid.UUID          `json:"model_id"`
	Version            int                `json:"version"`
	RunID              uuid.UUID          `json:"run_id"`
	Stage              ModelStage         `json:"stage"`
	Description        string             `json:"description"`
	Tags               map[string]string  `json:"tags"`
	CreatedAt          time.Time          `json:"created_at"`
	UpdatedAt          time.Time          `json:"updated_at"`
	SourcePath         string             `json:"source_path"`
	Format             ModelFormat        `json:"format"`
	Framework          string             `json:"framework"` // "tensorflow", "pytorch", "onnx", "go"
	Signature          ModelSignature     `json:"signature"`
	Metadata           map[string]any     `json:"metadata"`
	PerformanceMetrics map[string]float64 `json:"performance_metrics"`
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
	Name  string     `json:"name"`
	Type  TensorType `json:"type"`
	Shape []int      `json:"shape"` // -1 for variable dimensions
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
	ID             uuid.UUID  `json:"id"`
	ModelVersionID uuid.UUID  `json:"model_version_id"`
	FromStage      ModelStage `json:"from_stage"`
	ToStage        ModelStage `json:"to_stage"`
	RequestedBy    string     `json:"requested_by"`
	RequestedAt    time.Time  `json:"requested_at"`
	ApprovedBy     string     `json:"approved_by,omitempty"`
	ApprovedAt     *time.Time `json:"approved_at,omitempty"`
	Status         string     `json:"status"` // "PENDING", "APPROVED", "REJECTED"
	Comment        string     `json:"comment"`
}
