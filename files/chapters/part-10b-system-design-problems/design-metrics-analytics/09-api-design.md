## API Design

The API surface is deliberately small. There are only a handful of endpoints, but each one is carefully designed to support the full range of dashboard and alerting workflows. The query endpoint accepts flexible parameters for metric name, tag filters, aggregation function, time range, and grouping, which lets a single endpoint power everything from a simple CPU chart to a complex multi-series comparison. The `group_by` field is especially important because it allows queries like "show me average latency broken down by region" without needing separate endpoints for each use case.

```go
package api

import "time"

// POST /api/v1/metrics: submit metric batch
// POST /api/v1/query: query metrics
type QueryMetricsRequest struct {
	Metric      string            `json:"metric" validate:"required"`
	Tags        map[string]string `json:"tags"`
	Start       time.Time         `json:"start" validate:"required"`
	End         time.Time         `json:"end" validate:"required"`
	Aggregation string            `json:"aggregation"` // avg, sum, min, max, p50, p95, p99
	Interval    string            `json:"interval"`    // 10s, 1m, 5m, 1h
	GroupBy     []string          `json:"group_by"`
}

// POST /api/v1/alerts: create alert rule
// GET /api/v1/dashboards/{id}: get dashboard with panels
// GET /api/v1/metrics/names: list metric names
// GET /api/v1/metrics/{name}/tags: list tags for metric
```

---
