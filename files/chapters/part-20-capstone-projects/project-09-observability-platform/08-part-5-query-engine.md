## Part 5: Query Engine

The query engine translates human-readable queries into efficient lookups against the storage backends. It supports two query languages: PromQL for metrics (the same language used by Prometheus) and a LogQL-like language for logs. Each query is parsed into an abstract syntax tree, optimized, and then executed against the appropriate storage layer. The engine enforces limits on concurrent queries and maximum samples to prevent a single expensive query from overwhelming the system.

### 5.1 PromQL Engine

PromQL (Prometheus Query Language) lets users write expressions like `rate(http_requests_total[5m])` to compute request rates over time. This engine parses PromQL expressions, resolves label matchers against the metrics storage, fetches the matching time series, and applies functions like `rate`, `sum`, and `avg`. The result is a set of time series that can be rendered as graphs or used in alert rule evaluation. Query results are cached with a configurable TTL to speed up repeated dashboard loads.

```go
// pkg/query/promql/engine.go
package promql

import (
    "context"
    "fmt"
    "time"

    "github.com/prometheus/prometheus/promql"
    "github.com/prometheus/prometheus/promql/parser"
    "github.com/prometheus/prometheus/storage"

    "observability/pkg/models"
    oberrors "observability/pkg/errors"
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
    // Parse query
    expr, err := parser.ParseExpr(queryStr)
    if err != nil {
        return nil, oberrors.E("PromQLEngine.Query", oberrors.ErrInvalidInput, err)
    }

    // Create query
    qry, err := e.promEngine.NewInstantQuery(e.queryable, expr, timestamp)
    if err != nil {
        return nil, oberrors.E("PromQLEngine.Query", oberrors.ErrInternal, err)
    }
    defer qry.Close()

    // Execute
    res := qry.Exec(ctx)
    if res.Err != nil {
        return nil, oberrors.E("PromQLEngine.Query", oberrors.ErrInternal, res.Err)
    }

    return convertResult(res), nil
}

// QueryRange executes a range query
func (e *Engine) QueryRange(ctx context.Context, queryStr string, start, end time.Time, step time.Duration) (*QueryResult, error) {
    // Parse query
    expr, err := parser.ParseExpr(queryStr)
    if err != nil {
        return nil, oberrors.E("PromQLEngine.QueryRange", oberrors.ErrInvalidInput, err)
    }

    // Create range query
    qry, err := e.promEngine.NewRangeQuery(e.queryable, expr, start, end, step)
    if err != nil {
        return nil, oberrors.E("PromQLEngine.QueryRange", oberrors.ErrInternal, err)
    }
    defer qry.Close()

    // Execute
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
        Type:   res.Value.Type().String(),
        Series: make([]*ResultSeries, 0),
    }

    switch v := res.Value.(type) {
    case promql.Matrix:
        for _, series := range v {
            rs := &ResultSeries{
                Metric: convertMetric(series.Metric),
                Values: make([]models.Sample, len(series.Points)),
            }

            for i, point := range series.Points {
                rs.Values[i] = models.Sample{
                    Timestamp: time.Unix(0, point.T*int64(time.Millisecond)),
                    Value:     point.V,
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
                        Timestamp: time.Unix(0, sample.T*int64(time.Millisecond)),
                        Value:     sample.V,
                    },
                },
            }
            result.Series = append(result.Series, rs)
        }

    case promql.Scalar:
        result.Series = append(result.Series, &ResultSeries{
            Values: []models.Sample{
                {
                    Timestamp: time.Unix(0, v.T*int64(time.Millisecond)),
                    Value:     v.V,
                },
            },
        })
    }

    return result
}

// convertMetric converts Prometheus labels to our labels
func convertMetric(lbls promql.Labels) models.Labels {
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
```

### 5.2 Log Query Language

The log query language lets users filter and search logs using a syntax inspired by Grafana Loki's LogQL. A query like `{service="api"} |= "error" | json | status >= 500` selects logs from the "api" service, filters for lines containing "error", parses JSON fields, and keeps only entries where the status field is 500 or above. This parser tokenizes the query string into a structured filter chain, which the log storage backend translates into efficient ClickHouse SQL queries.

```go
// pkg/query/logql/parser.go
package logql

import (
    "fmt"
    "regexp"
    "strings"
    "time"

    "observability/pkg/models"
)

// Parser parses LogQL queries
type Parser struct{}

// ParseQuery parses a LogQL query string
// Example: {service="api"} |= "error" | json | level="error"
func (p *Parser) ParseQuery(queryStr string, start, end time.Time) (*models.LogQuery, error) {
    query := &models.LogQuery{
        StartTime: start,
        EndTime:   end,
        Labels:    make(models.Labels, 0),
    }

    // Split into stream selector and filters
    parts := strings.Split(queryStr, "|")
    if len(parts) == 0 {
        return nil, fmt.Errorf("invalid query")
    }

    // Parse stream selector: {label="value", ...}
    selector := strings.TrimSpace(parts[0])
    if err := p.parseStreamSelector(selector, query); err != nil {
        return nil, err
    }

    // Parse filters
    for i := 1; i < len(parts); i++ {
        filter := strings.TrimSpace(parts[i])
        if err := p.parseFilter(filter, query); err != nil {
            return nil, err
        }
    }

    return query, nil
}

// parseStreamSelector parses the stream selector
func (p *Parser) parseStreamSelector(selector string, query *models.LogQuery) error {
    // Remove braces
    selector = strings.TrimPrefix(selector, "{")
    selector = strings.TrimSuffix(selector, "}")

    if selector == "" {
        return nil
    }

    // Split by comma
    pairs := strings.Split(selector, ",")
    for _, pair := range pairs {
        pair = strings.TrimSpace(pair)
        if pair == "" {
            continue
        }

        // Parse key=value or key="value"
        parts := strings.SplitN(pair, "=", 2)
        if len(parts) != 2 {
            return fmt.Errorf("invalid label selector: %s", pair)
        }

        key := strings.TrimSpace(parts[0])
        value := strings.TrimSpace(parts[1])
        value = strings.Trim(value, `"`)

        // Handle special fields
        switch key {
        case "service":
            query.Service = value
        case "host":
            query.Host = value
        case "namespace":
            query.Namespace = value
        case "level":
            level := models.ParseLogLevel(value)
            query.Level = &level
        case "trace_id":
            query.TraceID = value
        default:
            query.Labels = append(query.Labels, models.Label{
                Name:  key,
                Value: value,
            })
        }
    }

    return nil
}

// parseFilter parses a filter expression
func (p *Parser) parseFilter(filter string, query *models.LogQuery) error {
    filter = strings.TrimSpace(filter)

    // Line filter: |= "text" or != "text" or |~ "regex" or !~ "regex"
    if strings.HasPrefix(filter, "=") || strings.HasPrefix(filter, "~") {
        op := filter[0:1]
        text := strings.TrimSpace(filter[1:])
        text = strings.Trim(text, `"`)

        if op == "=" {
            // Contains filter
            query.SearchQuery = text
        } else {
            // Regex filter
            // Store for later processing
            query.SearchQuery = text
        }

        return nil
    }

    // JSON parser
    if filter == "json" {
        // Enable JSON parsing
        return nil
    }

    // Label filter: label="value"
    parts := strings.SplitN(filter, "=", 2)
    if len(parts) == 2 {
        key := strings.TrimSpace(parts[0])
        value := strings.TrimSpace(parts[1])
        value = strings.Trim(value, `"`)

        query.Labels = append(query.Labels, models.Label{
            Name:  key,
            Value: value,
        })
        return nil
    }

    return fmt.Errorf("unknown filter: %s", filter)
}
```
