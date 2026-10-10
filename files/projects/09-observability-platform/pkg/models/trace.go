// pkg/models/trace.go
package models

import (
    "time"
)

// SpanKind represents the span type
type SpanKind int

const (
    SpanKindInternal SpanKind = iota
    SpanKindServer
    SpanKindClient
    SpanKindProducer
    SpanKindConsumer
)

func (sk SpanKind) String() string {
    switch sk {
    case SpanKindInternal:
        return "internal"
    case SpanKindServer:
        return "server"
    case SpanKindClient:
        return "client"
    case SpanKindProducer:
        return "producer"
    case SpanKindConsumer:
        return "consumer"
    default:
        return "unknown"
    }
}

// SpanStatus represents span completion status
type SpanStatus int

const (
    SpanStatusUnset SpanStatus = iota
    SpanStatusOk
    SpanStatusError
)

// Span represents a distributed trace span
type Span struct {
    // Identity
    TraceID  string
    SpanID   string
    ParentID string

    // Timing
    StartTime time.Time
    EndTime   time.Time
    Duration  time.Duration

    // Description
    Name        string
    Kind        SpanKind
    Status      SpanStatus
    StatusMsg   string

    // Service info
    ServiceName string

    // Attributes
    Attributes map[string]any

    // Resource attributes
    Resource map[string]any

    // Events
    Events []SpanEvent

    // Links
    Links []SpanLink

    // Metadata
    TenantID string
}

// SpanEvent represents an event within a span
type SpanEvent struct {
    Timestamp  time.Time
    Name       string
    Attributes map[string]any
}

// SpanLink represents a link to another span
type SpanLink struct {
    TraceID    string
    SpanID     string
    Attributes map[string]any
}

// Trace represents a complete trace (collection of spans)
type Trace struct {
    TraceID     string
    RootSpan    *Span
    Spans       []*Span
    ServiceMap  map[string]bool
    StartTime   time.Time
    EndTime     time.Time
    Duration    time.Duration
    SpanCount   int
    ErrorCount  int
    TenantID    string
}

// TraceQuery represents a trace query
type TraceQuery struct {
    StartTime time.Time
    EndTime   time.Time

    // Filter criteria
    ServiceName string
    Operation   string
    MinDuration time.Duration
    MaxDuration time.Duration
    Status      *SpanStatus

    // Tag filtering
    Tags map[string]string

    // Pagination
    Limit  int
    Offset int

    // Tenant
    TenantID string
}

// ServiceDependency represents a service-to-service dependency
type ServiceDependency struct {
    Parent      string
    Child       string
    CallCount   int64
    ErrorCount  int64
    AvgDuration time.Duration
}
