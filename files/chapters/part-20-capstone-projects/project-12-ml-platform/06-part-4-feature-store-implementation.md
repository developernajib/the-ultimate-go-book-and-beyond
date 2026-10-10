## Part 4: Feature Store Implementation

A feature store solves one of the most common problems in production ML: keeping the features used during training in sync with the features used during serving. If your training pipeline computes a "user_average_purchase" one way and your serving code computes it differently, your model will silently produce bad predictions. The feature store provides a single source of truth for feature definitions, stores precomputed feature values, and serves them at low latency using Redis for online lookups.

### 4.1 Feature Store Service

This service manages the full feature lifecycle. You register feature groups that describe a set of related features, ingest feature values from batch or streaming pipelines, and retrieve feature vectors at serving time. The online store (Redis) handles real-time lookups with sub-millisecond latency, while the offline store (PostgreSQL) holds the historical data needed for training. The service also validates feature values against their declared schemas before storing them, catching data quality issues early.

```go
// internal/service/featurestore/service.go
package featurestore

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/google/uuid"
	"ml-platform/internal/domain"
	"ml-platform/internal/storage"
)

// Service handles feature store operations
type Service struct {
	store          storage.FeatureStore
	onlineStore    *redis.Client
	offlineStore   storage.OfflineFeatureStore
}

// NewService creates a new feature store service
func NewService(
	store storage.FeatureStore,
	redisClient *redis.Client,
	offlineStore storage.OfflineFeatureStore,
) *Service {
	return &Service{
		store:        store,
		onlineStore:  redisClient,
		offlineStore: offlineStore,
	}
}

// CreateFeatureGroup creates a new feature group
func (s *Service) CreateFeatureGroup(ctx context.Context, req CreateFeatureGroupRequest) (*domain.FeatureGroup, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	fg := &domain.FeatureGroup{
		ID:          uuid.New(),
		Name:        req.Name,
		Description: req.Description,
		EntityType:  req.EntityType,
		Features:    req.Features,
		Source:      req.Source,
		Tags:        req.Tags,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	if err := s.store.CreateFeatureGroup(ctx, fg); err != nil {
		return nil, fmt.Errorf("creating feature group: %w", err)
	}

	return fg, nil
}

// CreateFeatureView creates a materialized feature view
func (s *Service) CreateFeatureView(ctx context.Context, req CreateFeatureViewRequest) (*domain.FeatureView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	fv := &domain.FeatureView{
		ID:             uuid.New(),
		Name:           req.Name,
		FeatureGroups:  req.FeatureGroups,
		Entities:       req.Entities,
		Features:       req.Features,
		OnlineEnabled:  req.OnlineEnabled,
		OfflineEnabled: req.OfflineEnabled,
		TTL:            req.TTL,
		CreatedAt:      time.Now(),
	}

	if err := s.store.CreateFeatureView(ctx, fv); err != nil {
		return nil, fmt.Errorf("creating feature view: %w", err)
	}

	// If online enabled, materialize to Redis
	if fv.OnlineEnabled {
		if err := s.materializeOnline(ctx, fv); err != nil {
			return nil, fmt.Errorf("materializing online features: %w", err)
		}
	}

	return fv, nil
}

// GetOnlineFeatures retrieves features from the online store (Redis)
func (s *Service) GetOnlineFeatures(ctx context.Context, req GetFeaturesRequest) (*domain.FeatureVector, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	features := make(map[string]any)

	// Fetch from Redis
	for _, featureViewName := range req.FeatureViews {
		key := fmt.Sprintf("features:%s:%s", featureViewName, req.EntityID)

		data, err := s.onlineStore.Get(ctx, key).Bytes()
		if err == redis.Nil {
			continue // Feature not found
		}
		if err != nil {
			return nil, fmt.Errorf("getting features from Redis: %w", err)
		}

		var viewFeatures map[string]any
		if err := json.Unmarshal(data, &viewFeatures); err != nil {
			return nil, fmt.Errorf("unmarshaling features: %w", err)
		}

		for k, v := range viewFeatures {
			features[k] = v
		}
	}

	return &domain.FeatureVector{
		EntityID:  req.EntityID,
		Features:  features,
		EventTime: time.Now(),
	}, nil
}

// GetOfflineFeatures retrieves historical features (point-in-time correct)
func (s *Service) GetOfflineFeatures(ctx context.Context, req domain.PointInTimeRequest) ([]domain.FeatureVector, error) {
	// Query offline store (typically data warehouse like BigQuery, Snowflake)
	vectors, err := s.offlineStore.GetPointInTimeFeatures(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("getting offline features: %w", err)
	}

	return vectors, nil
}

// WriteOnlineFeatures writes features to the online store
func (s *Service) WriteOnlineFeatures(ctx context.Context, featureViewName string, vectors []domain.FeatureVector) error {
	pipe := s.onlineStore.Pipeline()

	for _, vector := range vectors {
		key := fmt.Sprintf("features:%s:%s", featureViewName, vector.EntityID)

		data, err := json.Marshal(vector.Features)
		if err != nil {
			return fmt.Errorf("marshaling features: %w", err)
		}

		pipe.Set(ctx, key, data, 24*time.Hour) // TTL
	}

	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("executing pipeline: %w", err)
	}

	return nil
}

// materializeOnline populates Redis with features from offline store
func (s *Service) materializeOnline(ctx context.Context, fv *domain.FeatureView) error {
	// This would typically:
	// 1. Query the offline feature store
	// 2. Transform the data
	// 3. Write to Redis
	
	// Simplified implementation
	return nil
}

// ValidateFeatures validates feature values against their definitions
func (s *Service) ValidateFeatures(featureGroup *domain.FeatureGroup, features map[string]any) error {
	for _, featureDef := range featureGroup.Features {
		value, ok := features[featureDef.Name]
		if !ok {
			continue // Optional feature
		}

		if featureDef.Validator != nil {
			if err := validateFeature(value, featureDef.Validator); err != nil {
				return fmt.Errorf("validation failed for %s: %w", featureDef.Name, err)
			}
		}
	}

	return nil
}

func validateFeature(value any, validator *domain.FeatureValidator) error {
	if validator.MinValue != nil {
		if v, ok := value.(float64); ok {
			if v < *validator.MinValue {
				return fmt.Errorf("value %f below minimum %f", v, *validator.MinValue)
			}
		}
	}

	if validator.MaxValue != nil {
		if v, ok := value.(float64); ok {
			if v > *validator.MaxValue {
				return fmt.Errorf("value %f above maximum %f", v, *validator.MaxValue)
			}
		}
	}

	if len(validator.AllowedValues) > 0 {
		allowed := false
		for _, allowedValue := range validator.AllowedValues {
			if value == allowedValue {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("value %v not in allowed values", value)
		}
	}

	return nil
}

// Request types

type CreateFeatureGroupRequest struct {
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	EntityType  string                  `json:"entity_type"`
	Features    []domain.FeatureDefinition `json:"features"`
	Source      domain.DataSource       `json:"source"`
	Tags        map[string]string       `json:"tags"`
}

func (r CreateFeatureGroupRequest) Validate() error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if r.EntityType == "" {
		return fmt.Errorf("entity_type is required")
	}
	if len(r.Features) == 0 {
		return fmt.Errorf("at least one feature is required")
	}
	return nil
}

type CreateFeatureViewRequest struct {
	Name           string         `json:"name"`
	FeatureGroups  []string       `json:"feature_groups"`
	Entities       []string       `json:"entities"`
	Features       []string       `json:"features"`
	OnlineEnabled  bool           `json:"online_enabled"`
	OfflineEnabled bool           `json:"offline_enabled"`
	TTL            *time.Duration `json:"ttl,omitempty"`
}

func (r CreateFeatureViewRequest) Validate() error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if len(r.FeatureGroups) == 0 {
		return fmt.Errorf("at least one feature group is required")
	}
	return nil
}

type GetFeaturesRequest struct {
	EntityID     string   `json:"entity_id"`
	FeatureViews []string `json:"feature_views"`
}

func (r GetFeaturesRequest) Validate() error {
	if r.EntityID == "" {
		return fmt.Errorf("entity_id is required")
	}
	if len(r.FeatureViews) == 0 {
		return fmt.Errorf("at least one feature view is required")
	}
	return nil
}
```

---
