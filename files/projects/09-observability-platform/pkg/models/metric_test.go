package models_test

import (
	"testing"
	"time"

	"github.com/example/observability-platform/pkg/models"
)

func TestMetricTypeString(t *testing.T) {
	tests := []struct {
		mt       models.MetricType
		expected string
	}{
		{models.MetricTypeGauge, "gauge"},
		{models.MetricTypeCounter, "counter"},
		{models.MetricTypeHistogram, "histogram"},
		{models.MetricTypeSummary, "summary"},
		{models.MetricType(99), "unknown"},
	}

	for _, tt := range tests {
		if got := tt.mt.String(); got != tt.expected {
			t.Errorf("Expected %s, got %s", tt.expected, got)
		}
	}
}

func TestLabelsHash(t *testing.T) {
	labels1 := models.Labels{
		{Name: "service", Value: "api"},
		{Name: "env", Value: "prod"},
	}
	labels2 := models.Labels{
		{Name: "env", Value: "prod"},
		{Name: "service", Value: "api"},
	}

	if labels1.Hash() != labels2.Hash() {
		t.Errorf("Labels hashes should match regardless of ordering: %s vs %s", labels1.Hash(), labels2.Hash())
	}

	emptyLabels := models.Labels{}
	if emptyLabels.Hash() != "" {
		t.Errorf("Expected empty hash for empty labels, got %s", emptyLabels.Hash())
	}
}

func TestMetricCreation(t *testing.T) {
	now := time.Now()
	m := &models.Metric{
		Name:      "http_requests_total",
		Type:      models.MetricTypeCounter,
		Timestamp: now,
		Value:     42.0,
		Labels: models.Labels{
			{Name: "method", Value: "GET"},
			{Name: "status", Value: "200"},
		},
	}

	if m.Name != "http_requests_total" {
		t.Errorf("Expected name http_requests_total, got %s", m.Name)
	}
	if m.Value != 42.0 {
		t.Errorf("Expected value 42.0, got %f", m.Value)
	}
}
