// pkg/query/query.go
package query

import (
	"context"
	"time"

	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/storage"
)

// Engine is the query engine facade
type Engine struct {
	metricStore storage.MetricStore
	maxSamples  int
	timeout     time.Duration
}

// NewEngine creates a new query engine
func NewEngine(metricStore storage.MetricStore, maxSamples int, timeout time.Duration) *Engine {
	return &Engine{
		metricStore: metricStore,
		maxSamples:  maxSamples,
		timeout:     timeout,
	}
}

// QueryResult represents query results
type QueryResult struct {
	Type   string
	Series []*ResultSeries
}

// ResultSeries represents a result series
type ResultSeries struct {
	Metric models.Labels
	Values []models.Sample
}

// Query executes a query at a given time
func (e *Engine) Query(ctx context.Context, queryStr string, timestamp time.Time) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	end := timestamp
	start := timestamp.Add(-5 * time.Minute)

	series, err := e.metricStore.Query(ctx, queryStr, start, end)
	if err != nil {
		return nil, err
	}

	result := &QueryResult{
		Type:   "vector",
		Series: make([]*ResultSeries, 0, len(series)),
	}

	for _, s := range series {
		rs := &ResultSeries{
			Metric: s.Labels,
			Values: s.Samples,
		}
		result.Series = append(result.Series, rs)
	}

	return result, nil
}

// QueryRange executes a range query
func (e *Engine) QueryRange(ctx context.Context, queryStr string, start, end time.Time, step time.Duration) (*QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	series, err := e.metricStore.Query(ctx, queryStr, start, end)
	if err != nil {
		return nil, err
	}

	result := &QueryResult{
		Type:   "matrix",
		Series: make([]*ResultSeries, 0, len(series)),
	}

	for _, s := range series {
		rs := &ResultSeries{
			Metric: s.Labels,
			Values: s.Samples,
		}
		result.Series = append(result.Series, rs)
	}

	return result, nil
}
