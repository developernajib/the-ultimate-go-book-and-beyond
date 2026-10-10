// pkg/query/promql/engine.go
package promql

import (
	"context"
	"time"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql"
	"github.com/prometheus/prometheus/storage"

	"github.com/example/observability-platform/pkg/models"
	oberrors "github.com/example/observability-platform/pkg/errors"
)

// Engine executes PromQL queries
type Engine struct {
	promEngine *promql.Engine
	queryable  storage.Queryable
	maxSamples int
	timeout    time.Duration
}

// NewEngine creates a new PromQL engine
func NewEngine(queryable storage.Queryable, maxSamples int, timeout time.Duration) *Engine {
	opts := promql.EngineOpts{
		MaxSamples:    maxSamples,
		Timeout:       timeout,
		LookbackDelta: 5 * time.Minute,
	}

	return &Engine{
		promEngine: promql.NewEngine(opts),
		queryable:  queryable,
		maxSamples: maxSamples,
		timeout:    timeout,
	}
}

// Query executes a PromQL query
func (e *Engine) Query(ctx context.Context, queryStr string, timestamp time.Time) (*QueryResult, error) {
	qry, err := e.promEngine.NewInstantQuery(ctx, e.queryable, nil, queryStr, timestamp)
	if err != nil {
		return nil, oberrors.E("PromQLEngine.Query", oberrors.ErrInvalidInput, err)
	}
	defer qry.Close()

	res := qry.Exec(ctx)
	if res.Err != nil {
		return nil, oberrors.E("PromQLEngine.Query", oberrors.ErrInternal, res.Err)
	}

	return convertResult(res), nil
}

// QueryRange executes a range query
func (e *Engine) QueryRange(ctx context.Context, queryStr string, start, end time.Time, step time.Duration) (*QueryResult, error) {
	qry, err := e.promEngine.NewRangeQuery(ctx, e.queryable, nil, queryStr, start, end, step)
	if err != nil {
		return nil, oberrors.E("PromQLEngine.QueryRange", oberrors.ErrInvalidInput, err)
	}
	defer qry.Close()

	res := qry.Exec(ctx)
	if res.Err != nil {
		return nil, oberrors.E("PromQLEngine.QueryRange", oberrors.ErrInternal, res.Err)
	}

	return convertResult(res), nil
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

// convertResult converts Prometheus result to our format
func convertResult(res *promql.Result) *QueryResult {
	result := &QueryResult{
		Type:   string(res.Value.Type()),
		Series: make([]*ResultSeries, 0),
	}

	switch v := res.Value.(type) {
	case promql.Matrix:
		for _, series := range v {
			rs := &ResultSeries{
				Metric: convertMetric(series.Metric),
				Values: make([]models.Sample, len(series.Floats)),
			}

			for i, point := range series.Floats {
				rs.Values[i] = models.Sample{
					Timestamp: time.UnixMilli(point.T),
					Value:     point.F,
				}
			}

			result.Series = append(result.Series, rs)
		}

	case promql.Vector:
		for _, sample := range v {
			rs := &ResultSeries{
				Metric: convertMetric(sample.Metric),
				Values: []models.Sample{
					{
						Timestamp: time.UnixMilli(sample.T),
						Value:     sample.F,
					},
				},
			}
			result.Series = append(result.Series, rs)
		}

	case promql.Scalar:
		result.Series = append(result.Series, &ResultSeries{
			Values: []models.Sample{
				{
					Timestamp: time.UnixMilli(v.T),
					Value:     v.V,
				},
			},
		})
	}

	return result
}

// convertMetric converts Prometheus labels to our labels
func convertMetric(lbls labels.Labels) models.Labels {
	result := make(models.Labels, 0, len(lbls))
	for _, l := range lbls {
		if l.Name != "__name__" {
			result = append(result, models.Label{
				Name:  l.Name,
				Value: l.Value,
			})
		}
	}
	return result
}
