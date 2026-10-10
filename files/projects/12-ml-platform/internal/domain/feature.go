// internal/domain/feature.go
package domain

import (
	"time"
	"uuid"
)

// FeatureGroup represents a collection of related features
type FeatureGroup struct {
	ID          uuid.UUID           `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	EntityType  string              `json:"entity_type"` // "user", "item", "transaction"
	Features    []FeatureDefinition `json:"features"`
	Source      DataSource          `json:"source"`
	Tags        map[string]string   `json:"tags"`
	CreatedAt   time.Time           `json:"created_at"`
	UpdatedAt   time.Time           `json:"updated_at"`
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
	MinValue      *float64 `json:"min_value,omitempty"`
	MaxValue      *float64 `json:"max_value,omitempty"`
	AllowedValues []any    `json:"allowed_values,omitempty"`
	Regex         *string  `json:"regex,omitempty"`
}

// DataSource represents where features are sourced from
type DataSource struct {
	Type         string        `json:"type"` // "BATCH", "STREAM", "REQUEST"
	BatchSource  *BatchSource  `json:"batch_source,omitempty"`
	StreamSource *StreamSource `json:"stream_source,omitempty"`
}

// BatchSource defines offline feature source
type BatchSource struct {
	Type             string `json:"type"` // "PARQUET", "CSV", "DATABASE"
	Path             string `json:"path"`
	EventTimestamp   string `json:"event_timestamp_column"`
	CreatedTimestamp string `json:"created_timestamp_column"`
}

// StreamSource defines online feature source
type StreamSource struct {
	Type             string   `json:"type"` // "KAFKA", "KINESIS", "PUBSUB"
	Topic            string   `json:"topic"`
	BootstrapServers []string `json:"bootstrap_servers,omitempty"`
}

// FeatureView represents a materialized view of features
type FeatureView struct {
	ID             uuid.UUID      `json:"id"`
	Name           string         `json:"name"`
	FeatureGroups  []string       `json:"feature_groups"`
	Entities       []string       `json:"entities"`
	Features       []string       `json:"features"`
	OnlineEnabled  bool           `json:"online_enabled"`
	OfflineEnabled bool           `json:"offline_enabled"`
	TTL            *time.Duration `json:"ttl,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
}

// FeatureVector represents feature values for an entity
type FeatureVector struct {
	EntityID  string         `json:"entity_id"`
	Features  map[string]any `json:"features"`
	EventTime time.Time      `json:"event_time"`
}

// PointInTimeRequest requests features as of a specific time
type PointInTimeRequest struct {
	EntityIDs    []string  `json:"entity_ids"`
	FeatureViews []string  `json:"feature_views"`
	Timestamp    time.Time `json:"timestamp"`
}
