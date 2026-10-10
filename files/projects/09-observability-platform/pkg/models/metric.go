// pkg/models/metric.go
package models

import (
    "fmt"
    "sort"
    "strings"
    "time"
)

// MetricType represents the type of metric
type MetricType int

const (
    MetricTypeGauge MetricType = iota
    MetricTypeCounter
    MetricTypeHistogram
    MetricTypeSummary
)

func (mt MetricType) String() string {
    switch mt {
    case MetricTypeGauge:
        return "gauge"
    case MetricTypeCounter:
        return "counter"
    case MetricTypeHistogram:
        return "histogram"
    case MetricTypeSummary:
        return "summary"
    default:
        return "unknown"
    }
}

// Label represents a key-value label
type Label struct {
    Name  string
    Value string
}

// Labels is a sortable slice of labels
type Labels []Label

func (l Labels) Len() int           { return len(l) }
func (l Labels) Less(i, j int) bool { return l[i].Name < l[j].Name }
func (l Labels) Swap(i, j int)      { l[i], l[j] = l[j], l[i] }

// Hash returns a consistent hash for the label set
func (l Labels) Hash() string {
    if len(l) == 0 {
        return ""
    }

    // Sort labels for consistent hashing
    sorted := make(Labels, len(l))
    copy(sorted, l)
    sort.Sort(sorted)

    var builder strings.Builder
    for i, label := range sorted {
        if i > 0 {
            builder.WriteByte(',')
        }
        builder.WriteString(label.Name)
        builder.WriteByte('=')
        builder.WriteString(label.Value)
    }
    return builder.String()
}

// Get returns the value for a label name
func (l Labels) Get(name string) (string, bool) {
    for _, label := range l {
        if label.Name == name {
            return label.Value, true
        }
    }
    return "", false
}

// Metric represents a single metric data point
type Metric struct {
    Name      string
    Type      MetricType
    Labels    Labels
    Timestamp time.Time
    Value     float64

    // For histograms
    Buckets []Bucket
    Count   uint64
    Sum     float64

    // For summaries
    Quantiles []Quantile

    // Metadata
    TenantID string
}

// Bucket represents a histogram bucket
type Bucket struct {
    UpperBound float64
    Count      uint64
}

// Quantile represents a summary quantile
type Quantile struct {
    Quantile float64
    Value    float64
}

// MetricFamily groups metrics by name
type MetricFamily struct {
    Name    string
    Type    MetricType
    Help    string
    Metrics []Metric
}

// Sample represents a time-series sample
type Sample struct {
    Timestamp time.Time
    Value     float64
}

// Series represents a time series
type Series struct {
    Labels  Labels
    Samples []Sample
}

// String returns a string representation of the metric
func (m *Metric) String() string {
    return fmt.Sprintf("%s%s %f @%d", m.Name, m.Labels.Hash(), m.Value, m.Timestamp.Unix())
}

// Clone creates a deep copy of the metric
func (m *Metric) Clone() *Metric {
    clone := &Metric{
        Name:      m.Name,
        Type:      m.Type,
        Labels:    make(Labels, len(m.Labels)),
        Timestamp: m.Timestamp,
        Value:     m.Value,
        Count:     m.Count,
        Sum:       m.Sum,
        TenantID:  m.TenantID,
    }

    copy(clone.Labels, m.Labels)

    if len(m.Buckets) > 0 {
        clone.Buckets = make([]Bucket, len(m.Buckets))
        copy(clone.Buckets, m.Buckets)
    }

    if len(m.Quantiles) > 0 {
        clone.Quantiles = make([]Quantile, len(m.Quantiles))
        copy(clone.Quantiles, m.Quantiles)
    }

    return clone
}
