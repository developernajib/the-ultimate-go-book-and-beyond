// pkg/storage/metrics/prometheus.go
package metrics

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/prometheus/prometheus/model/labels"
	prom_storage "github.com/prometheus/prometheus/storage"
	"github.com/prometheus/prometheus/tsdb"
	"github.com/prometheus/prometheus/tsdb/chunkenc"
	"github.com/prometheus/prometheus/tsdb/wlog"

	"github.com/example/observability-platform/pkg/models"
	oberrors "github.com/example/observability-platform/pkg/errors"
)

// PrometheusStore implements MetricStore using Prometheus TSDB
type PrometheusStore struct {
	db            *tsdb.DB
	path          string
	retentionTime time.Duration
}

// NewPrometheusStore creates a new Prometheus metrics store
func NewPrometheusStore(path string, retentionTime time.Duration) (*PrometheusStore, error) {
	opts := tsdb.DefaultOptions()
	opts.RetentionDuration = int64(retentionTime / time.Millisecond)
	opts.WALCompression = wlog.CompressionSnappy
	opts.MaxBlockDuration = int64(2 * time.Hour / time.Millisecond)

	db, err := tsdb.Open(path, nil, nil, opts, nil)
	if err != nil {
		return nil, fmt.Errorf("opening TSDB: %w", err)
	}

	return &PrometheusStore{
		db:            db,
		path:          path,
		retentionTime: retentionTime,
	}, nil
}

// Write writes metrics to the store
func (s *PrometheusStore) Write(ctx context.Context, metrics []*models.Metric) error {
	if len(metrics) == 0 {
		return nil
	}

	appender := s.db.Appender(ctx)
	defer appender.Rollback()

	for _, metric := range metrics {
		lbls := make(labels.Labels, 0, len(metric.Labels)+1)
		lbls = append(lbls, labels.Label{
			Name:  "__name__",
			Value: metric.Name,
		})

		for _, label := range metric.Labels {
			lbls = append(lbls, labels.Label{
				Name:  label.Name,
				Value: label.Value,
			})
		}

		sort.Sort(lbls)

		timestamp := metric.Timestamp.UnixMilli()

		switch metric.Type {
		case models.MetricTypeGauge, models.MetricTypeCounter:
			if _, err := appender.Append(0, lbls, timestamp, metric.Value); err != nil {
				return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
			}

		case models.MetricTypeHistogram:
			for _, bucket := range metric.Buckets {
				bucketLbls := append(labels.Labels{}, lbls...)
				bucketLbls = append(bucketLbls, labels.Label{
					Name:  "le",
					Value: fmt.Sprintf("%g", bucket.UpperBound),
				})
				sort.Sort(bucketLbls)

				if _, err := appender.Append(0, bucketLbls, timestamp, float64(bucket.Count)); err != nil {
					return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
				}
			}
		}
	}

	if err := appender.Commit(); err != nil {
		return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
	}

	return nil
}

// Query queries metrics from the store
func (s *PrometheusStore) Query(ctx context.Context, query string, start, end time.Time) ([]*models.Series, error) {
	querier, err := s.db.Querier(start.UnixMilli(), end.UnixMilli())
	if err != nil {
		return nil, oberrors.E("PrometheusStore.Query", oberrors.ErrInternal, err)
	}
	defer querier.Close()

	matchers := []*labels.Matcher{}
	seriesSet := querier.Select(ctx, false, nil, matchers...)

	var result []*models.Series

	for seriesSet.Next() {
		series := seriesSet.At()
		lbls := series.Labels()

		modelLabels := make(models.Labels, 0, len(lbls))
		for _, l := range lbls {
			if l.Name != "__name__" {
				modelLabels = append(modelLabels, models.Label{
					Name:  l.Name,
					Value: l.Value,
				})
			}
		}

		iter := series.Iterator(nil)
		var samples []models.Sample

		for iter.Next() != chunkenc.ValNone {
			t, v := iter.At()
			samples = append(samples, models.Sample{
				Timestamp: time.UnixMilli(t),
				Value:     v,
			})
		}

		if iter.Err() != nil {
			return nil, oberrors.E("PrometheusStore.Query", oberrors.ErrInternal, iter.Err())
		}

		result = append(result, &models.Series{
			Labels:  modelLabels,
			Samples: samples,
		})
	}

	if seriesSet.Err() != nil {
		return nil, oberrors.E("PrometheusStore.Query", oberrors.ErrInternal, seriesSet.Err())
	}

	return result, nil
}

// Close closes the store
func (s *PrometheusStore) Close() error {
	return s.db.Close()
}

// Compact runs compaction
func (s *PrometheusStore) Compact() error {
	return s.db.Compact(context.Background())
}

// Queryable returns a Prometheus-compatible queryable
func (s *PrometheusStore) Queryable() prom_storage.Queryable {
	return s.db
}
