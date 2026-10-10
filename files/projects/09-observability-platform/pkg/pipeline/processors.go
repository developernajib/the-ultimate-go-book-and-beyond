// pkg/pipeline/processors.go
package pipeline

import (
	"fmt"

	"github.com/example/observability-platform/pkg/models"
)

// Validator validates telemetry data
type Validator interface {
    ValidateMetric(*models.Metric) error
    ValidateLog(*models.LogEntry) error
    ValidateTrace(*models.Span) error
}

// Enricher enriches telemetry data
type Enricher interface {
    EnrichMetric(*models.Metric) error
    EnrichLog(*models.LogEntry) error
    EnrichTrace(*models.Span) error
}

// Sampler samples telemetry data
type Sampler interface {
    SampleMetric(*models.Metric) bool
    SampleLog(*models.LogEntry) bool
    SampleTrace(*models.Span) bool
}

// Aggregator aggregates telemetry data
type Aggregator interface {
    AggregateMetric(*models.Metric) *models.Metric
}

// BasicValidator validates basic fields
type BasicValidator struct{}

func (v *BasicValidator) ValidateMetric(m *models.Metric) error {
    if m.Name == "" {
        return fmt.Errorf("metric name is required")
    }
    if m.Timestamp.IsZero() {
        return fmt.Errorf("metric timestamp is required")
    }
    return nil
}

func (v *BasicValidator) ValidateLog(l *models.LogEntry) error {
    if l.Message == "" {
        return fmt.Errorf("log message is required")
    }
    if l.Timestamp.IsZero() {
        return fmt.Errorf("log timestamp is required")
    }
    return nil
}

func (v *BasicValidator) ValidateTrace(s *models.Span) error {
    if s.TraceID == "" {
        return fmt.Errorf("trace ID is required")
    }
    if s.SpanID == "" {
        return fmt.Errorf("span ID is required")
    }
    if s.StartTime.IsZero() {
        return fmt.Errorf("span start time is required")
    }
    return nil
}

// LabelEnricher adds labels to telemetry data
type LabelEnricher struct {
    Labels models.Labels
}

func (e *LabelEnricher) EnrichMetric(m *models.Metric) error {
    m.Labels = append(m.Labels, e.Labels...)
    return nil
}

func (e *LabelEnricher) EnrichLog(l *models.LogEntry) error {
    l.Labels = append(l.Labels, e.Labels...)
    return nil
}

func (e *LabelEnricher) EnrichTrace(s *models.Span) error {
    // Add as resource attributes
    for _, label := range e.Labels {
        s.Resource[label.Name] = label.Value
    }
    return nil
}

// RateSampler samples based on rate
type RateSampler struct {
    Rate    float64 // Sample rate (0-1)
    counter int64
}

func (s *RateSampler) SampleMetric(m *models.Metric) bool {
    s.counter++
    return float64(s.counter)* s.Rate >= 1.0
}

func (s *RateSampler) SampleLog(l *models.LogEntry) bool {
    s.counter++
    return float64(s.counter) * s.Rate >= 1.0
}

func (s *RateSampler) SampleTrace(span *models.Span) bool {
    s.counter++
    return float64(s.counter) * s.Rate >= 1.0
}

// TenantEnricher adds tenant ID
type TenantEnricher struct {
    TenantResolver func(any) string
}

func (e *TenantEnricher) EnrichMetric(m *models.Metric) error {
    if m.TenantID == "" {
        m.TenantID = e.TenantResolver(m)
    }
    return nil
}

func (e *TenantEnricher) EnrichLog(l *models.LogEntry) error {
    if l.TenantID == "" {
        l.TenantID = e.TenantResolver(l)
    }
    return nil
}

func (e *TenantEnricher) EnrichTrace(s *models.Span) error {
    if s.TenantID == "" {
        s.TenantID = e.TenantResolver(s)
    }
    return nil
}
