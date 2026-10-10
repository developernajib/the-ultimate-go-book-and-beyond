// pkg/models/log.go
package models

import (
	"encoding/json"
	"maps"
	"time"
)

// LogLevel represents log severity
type LogLevel int

const (
	LogLevelDebug LogLevel = iota
	LogLevelInfo
	LogLevelWarn
	LogLevelError
	LogLevelFatal
)

func (l LogLevel) String() string {
	switch l {
	case LogLevelDebug:
		return "debug"
	case LogLevelInfo:
		return "info"
	case LogLevelWarn:
		return "warn"
	case LogLevelError:
		return "error"
	case LogLevelFatal:
		return "fatal"
	default:
		return "unknown"
	}
}

// ParseLogLevel parses a log level string
func ParseLogLevel(s string) LogLevel {
	switch s {
	case "debug", "DEBUG":
		return LogLevelDebug
	case "info", "INFO":
		return LogLevelInfo
	case "warn", "WARN", "warning", "WARNING":
		return LogLevelWarn
	case "error", "ERROR":
		return LogLevelError
	case "fatal", "FATAL":
		return LogLevelFatal
	default:
		return LogLevelInfo
	}
}

// LogEntry represents a single log entry
type LogEntry struct {
	// Core fields
	Timestamp time.Time
	Level     LogLevel
	Message   string

	// Source information
	Host      string
	Service   string
	Container string
	Pod       string
	Namespace string

	// Structured fields
	Fields map[string]any

	// Labels for indexing
	Labels Labels

	// Trace context
	TraceID string
	SpanID  string

	// Metadata
	TenantID string
}

// Clone creates a deep copy of the log entry
func (l *LogEntry) Clone() *LogEntry {
	clone := &LogEntry{
		Timestamp: l.Timestamp,
		Level:     l.Level,
		Message:   l.Message,
		Host:      l.Host,
		Service:   l.Service,
		Container: l.Container,
		Pod:       l.Pod,
		Namespace: l.Namespace,
		TraceID:   l.TraceID,
		SpanID:    l.SpanID,
		TenantID:  l.TenantID,
		Labels:    make(Labels, len(l.Labels)),
		Fields:    make(map[string]any),
	}

	copy(clone.Labels, l.Labels)

	maps.Copy(clone.Fields, l.Fields)

	return clone
}

// ToJSON serializes the log entry to JSON
func (l *LogEntry) ToJSON() ([]byte, error) {
	return json.Marshal(l)
}

// LogQuery represents a log query
type LogQuery struct {
	StartTime time.Time
	EndTime   time.Time

	// Filter criteria
	Level     *LogLevel
	Service   string
	Host      string
	Namespace string
	Labels    Labels

	// Full-text search
	SearchQuery string

	// Trace filtering
	TraceID string

	// Pagination
	Limit  int
	Offset int

	// Tenant
	TenantID string
}

// LogQueryResult represents query results
type LogQueryResult struct {
	Entries    []*LogEntry
	TotalCount int64
	HasMore    bool
}
