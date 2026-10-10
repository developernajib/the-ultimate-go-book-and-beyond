// internal/service/registry/service.go
package registry

import (
	"context"
	"fmt"
	"slices"
	"time"
	"uuid"

	"github.com/example/ml-platform/internal/domain"
	"github.com/example/ml-platform/internal/storage"
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

	return slices.Contains(allowed, to)
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
	ModelID            uuid.UUID             `json:"model_id"`
	RunID              uuid.UUID             `json:"run_id"`
	Description        string                `json:"description"`
	Tags               map[string]string     `json:"tags"`
	SourcePath         string                `json:"source_path"`
	Format             domain.ModelFormat    `json:"format"`
	Framework          string                `json:"framework"`
	Signature          domain.ModelSignature `json:"signature"`
	Metadata           map[string]any        `json:"metadata"`
	PerformanceMetrics map[string]float64    `json:"performance_metrics"`
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
