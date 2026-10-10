## Deep Dive: Query Optimizer

The query optimizer is what makes dashboard queries fast despite the massive data volume. Its two main strategies are automatic resolution selection and result caching. When a user queries a short time range (under 24 hours), the optimizer reads from the high-resolution raw table. For longer ranges, it automatically switches to the pre-aggregated 1-minute rollup table, which contains far fewer rows and returns results much faster. It also caches query results in Redis with a TTL that varies based on the time range, so repeated dashboard refreshes do not hit the database at all.

```go
package query

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type QueryMetricsRequest struct {
	Metric      string
	Tags        map[string]string
	Start       time.Time
	End         time.Time
	Aggregation string
	Interval    string
	GroupBy     []string
}

type TimeSeriesDB interface {
	Query(ctx context.Context, req QueryMetricsRequest) ([]TimeSeries, int64, error)
}

type QueryOptimizer struct {
	rawDB    TimeSeriesDB
	minuteDB TimeSeriesDB
	cache    *redis.Client
}

func (o *QueryOptimizer) OptimizedQuery(ctx context.Context, req QueryMetricsRequest) (*QueryMetricsResponse, error) {
	start := time.Now()

	// The cache key must cover every parameter that affects the result.
	// Omitting one (say, the end time) silently serves wrong data.
	cacheKey := fmt.Sprintf("qcache:%s:%v:%d:%d:%s:%s:%v",
		req.Metric, req.Tags, req.Start.Unix(), req.End.Unix(),
		req.Aggregation, req.Interval, req.GroupBy)

	if cached, err := o.cache.Get(ctx, cacheKey).Bytes(); err == nil {
		if resp, err := deserialize(cached); err == nil {
			resp.Meta.CacheHit = true
			return resp, nil
		}
	}

	// Tier selection: short ranges hit the raw 10-second table, longer
	// ranges hit the 1-minute rollup table with far fewer rows
	timeRange := req.End.Sub(req.Start)
	db, resolution := o.rawDB, "10s"
	if timeRange > 24*time.Hour {
		db, resolution = o.minuteDB, "1m"
	}
	if req.Interval != "" {
		resolution = req.Interval
	}

	results, scanned, err := db.Query(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}

	resp := &QueryMetricsResponse{
		Series: results,
		Meta: QueryMeta{
			ExecutionTimeMs: time.Since(start).Milliseconds(),
			RowsScanned:     scanned,
			Resolution:      resolution,
		},
	}

	// Short-range dashboards refresh often, so cache briefly.
	// Historical queries change slowly and can be cached longer.
	ttl := 30 * time.Second
	if timeRange > 24*time.Hour {
		ttl = 5 * time.Minute
	}
	if data, err := serialize(resp); err == nil {
		o.cache.Set(ctx, cacheKey, data, ttl)
	}
	return resp, nil
}

type QueryMetricsResponse struct {
	Series []TimeSeries
	Meta   QueryMeta
}

type QueryMeta struct {
	ExecutionTimeMs int64
	RowsScanned     int64
	Resolution      string
	CacheHit        bool
}

type TimeSeries struct {
	Metric     string
	Tags       map[string]string
	DataPoints []DataPoint
}

type DataPoint struct {
	Timestamp int64
	Value     float64
}

func serialize(r *QueryMetricsResponse) ([]byte, error) {
	return json.Marshal(r)
}

func deserialize(d []byte) (*QueryMetricsResponse, error) {
	var r QueryMetricsResponse
	if err := json.Unmarshal(d, &r); err != nil {
		return nil, err
	}
	return &r, nil
}
```

---
