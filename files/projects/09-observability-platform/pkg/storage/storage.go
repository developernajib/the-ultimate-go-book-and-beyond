// pkg/storage/storage.go
package storage

import (
	"context"
	"time"

	"github.com/example/observability-platform/pkg/models"
)

// MetricStore defines the interface for metric storage
type MetricStore interface {
	Write(ctx context.Context, metrics []*models.Metric) error
	Query(ctx context.Context, query string, start, end time.Time) ([]*models.Series, error)
	Close() error
}

// LogStore defines the interface for log storage
type LogStore interface {
	Write(ctx context.Context, logs []*models.LogEntry) error
	Query(ctx context.Context, query *models.LogQuery) (*models.LogQueryResult, error)
	Close() error
}

// TraceStore defines the interface for trace storage
type TraceStore interface {
	WriteSpans(ctx context.Context, spans []*models.Span) error
	GetTrace(ctx context.Context, traceID string) (*models.Trace, error)
	QueryTraces(ctx context.Context, query *models.TraceQuery) ([]*models.Trace, error)
	Close() error
}
