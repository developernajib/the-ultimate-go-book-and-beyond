package domain

import (
	"encoding/json"
	"testing"
	"time"
	"uuid"
)

func TestRegisteredModel_JSON(t *testing.T) {
	id := uuid.New()
	model := RegisteredModel{
		ID:          id,
		Name:        "fraud-detector",
		Description: "Detects fraudulent transactions",
		Tags: map[string]string{
			"env": "production",
		},
		CreatedAt: time.Now().UTC().Truncate(time.Second),
		UpdatedAt: time.Now().UTC().Truncate(time.Second),
		LatestVersions: map[ModelStage]int{
			ModelStageProduction: 2,
			ModelStageStaging:    3,
		},
	}

	data, err := json.Marshal(model)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var unmarshaled RegisteredModel
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	if unmarshaled.Name != model.Name || unmarshaled.ID != model.ID {
		t.Errorf("model mismatch: %+v vs %+v", unmarshaled, model)
	}
	if unmarshaled.LatestVersions[ModelStageProduction] != 2 {
		t.Errorf("stage version mismatch: got %d", unmarshaled.LatestVersions[ModelStageProduction])
	}
}

func TestFeatureGroup_JSON(t *testing.T) {
	minVal := 0.0
	maxVal := 100.0
	fg := FeatureGroup{
		ID:         uuid.New(),
		Name:       "user_features",
		EntityType: "user",
		Features: []FeatureDefinition{
			{
				Name: "age",
				Type: FeatureTypeFloat64,
				Validator: &FeatureValidator{
					MinValue: &minVal,
					MaxValue: &maxVal,
				},
			},
		},
	}

	data, err := json.Marshal(fg)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var unmarshaled FeatureGroup
	if err := json.Unmarshal(data, &unmarshaled); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	if len(unmarshaled.Features) != 1 || unmarshaled.Features[0].Name != "age" {
		t.Errorf("feature mismatch: %+v", unmarshaled)
	}
}
