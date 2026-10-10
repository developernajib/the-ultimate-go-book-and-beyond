## 114.3 Data Pipeline with Go

### Core Pipeline Abstractions

Let's build a flexible, composable pipeline framework:

```go
// pkg/pipeline/types.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// DataFrame represents tabular data flowing through the pipeline
type DataFrame struct {
    Columns []string
    Rows    [][]any
    Meta    map[string]any
    mu      sync.RWMutex
}

// NewDataFrame creates a new DataFrame
func NewDataFrame(columns []string) *DataFrame {
    return &DataFrame{
        Columns: columns,
        Rows:    make([][]any, 0),
        Meta:    make(map[string]any),
    }
}

// AddRow adds a row to the DataFrame
func (df *DataFrame) AddRow(row []any) error {
    df.mu.Lock()
    defer df.mu.Unlock()

    if len(row) != len(df.Columns) {
        return fmt.Errorf("row length %d doesn't match columns %d",
            len(row), len(df.Columns))
    }

    df.Rows = append(df.Rows, row)
    return nil
}

// RowCount returns the number of rows
func (df *DataFrame) RowCount() int {
    df.mu.RLock()
    defer df.mu.RUnlock()
    return len(df.Rows)
}

// GetColumn returns all values for a column
func (df *DataFrame) GetColumn(name string) ([]any, error) {
    df.mu.RLock()
    defer df.mu.RUnlock()

    colIdx := -1
    for i, col := range df.Columns {
        if col == name {
            colIdx = i
            break
        }
    }

    if colIdx == -1 {
        return nil, fmt.Errorf("column %s not found", name)
    }

    values := make([]any, len(df.Rows))
    for i, row := range df.Rows {
        values[i] = row[colIdx]
    }

    return values, nil
}

// Clone creates a deep copy of the DataFrame
func (df *DataFrame) Clone() *DataFrame {
    df.mu.RLock()
    defer df.mu.RUnlock()

    newDF := NewDataFrame(df.Columns)
    for _, row := range df.Rows {
        rowCopy := make([]any, len(row))
        copy(rowCopy, row)
        newDF.Rows = append(newDF.Rows, rowCopy)
    }

    for k, v := range df.Meta {
        newDF.Meta[k] = v
    }

    return newDF
}

// Stage represents a single processing stage in the pipeline
type Stage interface {
    Process(ctx context.Context, data *DataFrame) (*DataFrame, error)
    Name() string
}

// Pipeline orchestrates multiple stages
type Pipeline struct {
    name    string
    stages  []Stage
    metrics *PipelineMetrics
    mu      sync.RWMutex
}

// PipelineMetrics tracks pipeline execution metrics
type PipelineMetrics struct {
    TotalRuns     int64
    SuccessfulRuns int64
    FailedRuns    int64
    StageMetrics  map[string]*StageMetrics
    mu            sync.RWMutex
}

// StageMetrics tracks individual stage metrics
type StageMetrics struct {
    ExecutionCount int64
    TotalDuration  time.Duration
    ErrorCount     int64
    LastError      error
    LastExecution  time.Time
}

// NewPipeline creates a new pipeline
func NewPipeline(name string) *Pipeline {
    return &Pipeline{
        name:   name,
        stages: make([]Stage, 0),
        metrics: &PipelineMetrics{
            StageMetrics: make(map[string]*StageMetrics),
        },
    }
}

// AddStage adds a stage to the pipeline
func (p *Pipeline) AddStage(stage Stage) *Pipeline {
    p.mu.Lock()
    defer p.mu.Unlock()

    p.stages = append(p.stages, stage)
    p.metrics.StageMetrics[stage.Name()] = &StageMetrics{}
    return p
}

// Execute runs the pipeline
func (p *Pipeline) Execute(ctx context.Context, input *DataFrame) (*DataFrame, error) {
    p.metrics.mu.Lock()
    p.metrics.TotalRuns++
    p.metrics.mu.Unlock()

    current := input
    var err error

    for _, stage := range p.stages {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        start := time.Now()
        current, err = p.executeStage(ctx, stage, current)
        duration := time.Since(start)

        p.recordStageMetrics(stage.Name(), duration, err)

        if err != nil {
            p.metrics.mu.Lock()
            p.metrics.FailedRuns++
            p.metrics.mu.Unlock()
            return nil, fmt.Errorf("stage %s failed: %w", stage.Name(), err)
        }
    }

    p.metrics.mu.Lock()
    p.metrics.SuccessfulRuns++
    p.metrics.mu.Unlock()

    return current, nil
}

func (p *Pipeline) executeStage(ctx context.Context, stage Stage, data *DataFrame) (*DataFrame, error) {
    return stage.Process(ctx, data)
}

func (p *Pipeline) recordStageMetrics(stageName string, duration time.Duration, err error) {
    p.metrics.mu.Lock()
    defer p.metrics.mu.Unlock()

    metrics := p.metrics.StageMetrics[stageName]
    metrics.ExecutionCount++
    metrics.TotalDuration += duration
    metrics.LastExecution = time.Now()

    if err != nil {
        metrics.ErrorCount++
        metrics.LastError = err
    }
}

// GetMetrics returns current pipeline metrics
func (p *Pipeline) GetMetrics() *PipelineMetrics {
    p.metrics.mu.RLock()
    defer p.metrics.mu.RUnlock()

    // Create a copy to avoid race conditions
    metricsCopy := &PipelineMetrics{
        TotalRuns:     p.metrics.TotalRuns,
        SuccessfulRuns: p.metrics.SuccessfulRuns,
        FailedRuns:    p.metrics.FailedRuns,
        StageMetrics:  make(map[string]*StageMetrics),
    }

    for name, metrics := range p.metrics.StageMetrics {
        metricsCopy.StageMetrics[name] = &StageMetrics{
            ExecutionCount: metrics.ExecutionCount,
            TotalDuration:  metrics.TotalDuration,
            ErrorCount:     metrics.ErrorCount,
            LastError:      metrics.LastError,
            LastExecution:  metrics.LastExecution,
        }
    }

    return metricsCopy
}
```

### Implementing Concrete Pipeline Stages

Each stage implements the same two-method `Stage` interface, which is what lets the pipeline compose them without knowing what any of them do. Note what this design is and is not: `Execute` runs the stages sequentially, in one goroutine, passing a whole `DataFrame` from each stage to the next. It is a batch pipeline, not a streaming one. That is the right starting shape, because it is trivially debuggable and every stage boundary is a natural checkpoint. It is also the shape that stops working once a DataFrame no longer fits in memory, at which point you move to channels between stages and process record by record. Build the simple one first.

```go
// pkg/pipeline/stages.go
package pipeline

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

// DataSourceStage loads data from a source
type DataSourceStage struct {
    name   string
    source DataSource
}

type DataSource interface {
    Load(ctx context.Context) (*DataFrame, error)
}

func NewDataSourceStage(name string, source DataSource) *DataSourceStage {
    return &DataSourceStage{
        name:   name,
        source: source,
    }
}

func (s *DataSourceStage) Process(ctx context.Context, data *DataFrame) (*DataFrame, error) {
    return s.source.Load(ctx)
}

func (s *DataSourceStage) Name() string {
    return s.name
}

// PostgresDataSource loads data from PostgreSQL
type PostgresDataSource struct {
    db    *sql.DB
    query string
}

func NewPostgresDataSource(db *sql.DB, query string) *PostgresDataSource {
    return &PostgresDataSource{
        db:    db,
        query: query,
    }
}

func (s *PostgresDataSource) Load(ctx context.Context) (*DataFrame, error) {
    rows, err := s.db.QueryContext(ctx, s.query)
    if err != nil {
        return nil, fmt.Errorf("query failed: %w", err)
    }
    defer rows.Close()

    columns, err := rows.Columns()
    if err != nil {
        return nil, fmt.Errorf("failed to get columns: %w", err)
    }

    df := NewDataFrame(columns)

    for rows.Next() {
        values := make([]any, len(columns))
        valuePtrs := make([]any, len(columns))
        for i := range values {
            valuePtrs[i] = &values[i]
        }

        if err := rows.Scan(valuePtrs...); err != nil {
            return nil, fmt.Errorf("scan failed: %w", err)
        }

        if err := df.AddRow(values); err != nil {
            return nil, err
        }
    }

    if err := rows.Err(); err != nil {
        return nil, err
    }

    df.Meta["source"] = "postgres"
    df.Meta["loaded_at"] = time.Now()

    return df, nil
}

// APIDataSource loads data from an HTTP API
type APIDataSource struct {
    url    string
    client *http.Client
}

func NewAPIDataSource(url string) *APIDataSource {
    return &APIDataSource{
        url: url,
        client: &http.Client{
            Timeout: 30 * time.Second,
        },
    }
}

func (s *APIDataSource) Load(ctx context.Context) (*DataFrame, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", s.url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := s.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
    }

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var data []map[string]any
    if err := json.Unmarshal(body, &data); err != nil {
        return nil, err
    }

    if len(data) == 0 {
        return NewDataFrame([]string{}), nil
    }

    // Extract columns from first record
    var columns []string
    for col := range data[0] {
        columns = append(columns, col)
    }

    df := NewDataFrame(columns)

    for _, record := range data {
        row := make([]any, len(columns))
        for i, col := range columns {
            row[i] = record[col]
        }
        if err := df.AddRow(row); err != nil {
            return nil, err
        }
    }

    df.Meta["source"] = "api"
    df.Meta["loaded_at"] = time.Now()

    return df, nil
}

// FilterStage filters rows based on a condition
type FilterStage struct {
    name      string
    condition FilterFunc
}

type FilterFunc func(row []any) bool

func NewFilterStage(name string, condition FilterFunc) *FilterStage {
    return &FilterStage{
        name:      name,
        condition: condition,
    }
}

func (s *FilterStage) Process(ctx context.Context, data *DataFrame) (*DataFrame, error) {
    data.mu.RLock()
    columns := data.Columns
    rows := data.Rows
    data.mu.RUnlock()

    filtered := NewDataFrame(columns)

    for _, row := range rows {
        if s.condition(row) {
            if err := filtered.AddRow(row); err != nil {
                return nil, err
            }
        }
    }

    // Copy metadata
    filtered.Meta = data.Meta

    return filtered, nil
}

func (s *FilterStage) Name() string {
    return s.name
}

// TransformStage applies transformations to columns
type TransformStage struct {
    name        string
    transforms  map[string]TransformFunc
    addColumns  bool
}

type TransformFunc func(value any) (any, error)

func NewTransformStage(name string, transforms map[string]TransformFunc, addColumns bool) *TransformStage {
    return &TransformStage{
        name:       name,
        transforms: transforms,
        addColumns: addColumns,
    }
}

func (s *TransformStage) Process(ctx context.Context, data *DataFrame) (*DataFrame, error) {
    data.mu.RLock()
    originalColumns := data.Columns
    originalRows := data.Rows
    data.mu.RUnlock()

    // Build new column list
    newColumns := make([]string, len(originalColumns))
    copy(newColumns, originalColumns)

    columnIndices := make(map[string]int)
    for i, col := range originalColumns {
        columnIndices[col] = i
    }

    // If adding columns, append new column names
    transformedColIndices := make(map[string]int)
    if s.addColumns {
        for col := range s.transforms {
            newColName := col + "_transformed"
            newColumns = append(newColumns, newColName)
            transformedColIndices[col] = len(newColumns) - 1
        }
    }

    result := NewDataFrame(newColumns)

    for _, row := range originalRows {
        newRow := make([]any, len(newColumns))
        copy(newRow, row)

        // Apply transformations
        for col, transform := range s.transforms {
            originalIdx, exists := columnIndices[col]
            if !exists {
                continue
            }

            transformed, err := transform(row[originalIdx])
            if err != nil {
                return nil, fmt.Errorf("transform failed for column %s: %w", col, err)
            }

            if s.addColumns {
                // Add as new column
                newRow[transformedColIndices[col]] = transformed
            } else {
                // Replace original column
                newRow[originalIdx] = transformed
            }
        }

        if err := result.AddRow(newRow); err != nil {
            return nil, err
        }
    }

    result.Meta = data.Meta

    return result, nil
}

func (s *TransformStage) Name() string {
    return s.name
}

// AggregationStage performs aggregations
type AggregationStage struct {
    name        string
    groupByCol  string
    aggregations map[string]AggFunc
}

type AggFunc func(values []any) (any, error)

func NewAggregationStage(name string, groupByCol string, aggs map[string]AggFunc) *AggregationStage {
    return &AggregationStage{
        name:        name,
        groupByCol:  groupByCol,
        aggregations: aggs,
    }
}

func (s *AggregationStage) Process(ctx context.Context, data *DataFrame) (*DataFrame, error) {
    data.mu.RLock()
    defer data.mu.RUnlock()

    // Find group by column index
    groupByIdx := -1
    for i, col := range data.Columns {
        if col == s.groupByCol {
            groupByIdx = i
            break
        }
    }

    if groupByIdx == -1 {
        return nil, fmt.Errorf("group by column %s not found", s.groupByCol)
    }

    // Group rows
    groups := make(map[any][]int)
    for i, row := range data.Rows {
        key := row[groupByIdx]
        groups[key] = append(groups[key], i)
    }

    // Build result columns
    resultColumns := []string{s.groupByCol}
    for aggName := range s.aggregations {
        resultColumns = append(resultColumns, aggName)
    }

    result := NewDataFrame(resultColumns)

    // Compute aggregations for each group
    for groupKey, rowIndices := range groups {
        resultRow := make([]any, len(resultColumns))
        resultRow[0] = groupKey

        colIdx := 1
        for aggName, aggFunc := range s.aggregations {
            // Extract column name from aggregation name (format: "col_sum", "col_avg", etc.)
            // For simplicity, we'll pass all row values
            values := make([]any, len(rowIndices))
            for i, idx := range rowIndices {
                // Assuming aggregation on the full row or specific logic
                values[i] = data.Rows[idx]
            }

            aggValue, err := aggFunc(values)
            if err != nil {
                return nil, fmt.Errorf("aggregation %s failed: %w", aggName, err)
            }

            resultRow[colIdx] = aggValue
            colIdx++
        }

        if err := result.AddRow(resultRow); err != nil {
            return nil, err
        }
    }

    return result, nil
}

func (s *AggregationStage) Name() string {
    return s.name
}

// Common aggregation functions

// Sum aggregation
func Sum(columnIdx int) AggFunc {
    return func(values []any) (any, error) {
        sum := 0.0
        for _, val := range values {
            row := val.([]any)
            if columnIdx >= len(row) {
                continue
            }

            switch v := row[columnIdx].(type) {
            case int:
                sum += float64(v)
            case int64:
                sum += float64(v)
            case float64:
                sum += v
            case float32:
                sum += float64(v)
            }
        }
        return sum, nil
    }
}

// Average aggregation
func Avg(columnIdx int) AggFunc {
    return func(values []any) (any, error) {
        sum := 0.0
        count := 0
        for _, val := range values {
            row := val.([]any)
            if columnIdx >= len(row) {
                continue
            }

            switch v := row[columnIdx].(type) {
            case int:
                sum += float64(v)
                count++
            case int64:
                sum += float64(v)
                count++
            case float64:
                sum += v
                count++
            case float32:
                sum += float64(v)
                count++
            }
        }

        if count == 0 {
            return 0.0, nil
        }

        return sum / float64(count), nil
    }
}

// Count aggregation
func Count() AggFunc {
    return func(values []any) (any, error) {
        return len(values), nil
    }
}
```

### Example: Building a Data Pipeline

Wiring the stages together: load seven days of user events from Postgres, drop the invalid rows, and derive normalized columns from the survivors. The stages are added in the order they run, and each one receives whatever the previous stage returned.

```go
// examples/data-pipeline/main.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "math"
    "time"

    _ "github.com/lib/pq"
    "yourmodule/pkg/pipeline"
)

func main() {
    // Connect to database
    db, err := sql.Open("postgres",
        "postgres://user:password@localhost/mldb?sslmode=disable")
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    // Create pipeline
    pipe := pipeline.NewPipeline("user-activity-pipeline")

    // Stage 1: Load data from PostgreSQL
    dataSource := pipeline.NewPostgresDataSource(db, `
        SELECT user_id, event_type, event_time, value
        FROM user_events
        WHERE event_time >= NOW() - INTERVAL '7 days'
    `)
    pipe.AddStage(pipeline.NewDataSourceStage("load-events", dataSource))

    // Stage 2: Filter out invalid events
    pipe.AddStage(pipeline.NewFilterStage("filter-valid", func(row []any) bool {
        // Assuming row: [user_id, event_type, event_time, value]
        if len(row) < 4 {
            return false
        }

        // Filter out null user_ids
        if row[0] == nil {
            return false
        }

        // Filter out negative values
        if val, ok := row[3].(float64); ok && val < 0 {
            return false
        }

        return true
    }))

    // Stage 3: Transform timestamps
    pipe.AddStage(pipeline.NewTransformStage("normalize-time",
        map[string]pipeline.TransformFunc{
            "event_time": func(value any) (any, error) {
                if t, ok := value.(time.Time); ok {
                    return t.Unix(), nil
                }
                return value, nil
            },
            "value": func(value any) (any, error) {
                // Normalize values using log transform
                if val, ok := value.(float64); ok {
                    if val > 0 {
                        return math.Log(val + 1), nil
                    }
                }
                return value, nil
            },
        },
        true, // Add as new columns
    ))

    // Execute pipeline
    ctx := context.Background()
    result, err := pipe.Execute(ctx, nil)
    if err != nil {
        log.Fatal("Pipeline failed:", err)
    }

    // Print results
    fmt.Printf("Processed %d rows\n", result.RowCount())

    // Print metrics
    metrics := pipe.GetMetrics()
    fmt.Printf("\nPipeline Metrics:\n")
    fmt.Printf("Total runs: %d\n", metrics.TotalRuns)
    fmt.Printf("Successful: %d\n", metrics.SuccessfulRuns)
    fmt.Printf("Failed: %d\n", metrics.FailedRuns)

    fmt.Printf("\nStage Metrics:\n")
    for stageName, stageMetrics := range metrics.StageMetrics {
        avgDuration := time.Duration(0)
        if stageMetrics.ExecutionCount > 0 {
            avgDuration = stageMetrics.TotalDuration / time.Duration(stageMetrics.ExecutionCount)
        }
        fmt.Printf("  %s:\n", stageName)
        fmt.Printf("    Executions: %d\n", stageMetrics.ExecutionCount)
        fmt.Printf("    Avg Duration: %v\n", avgDuration)
        fmt.Printf("    Errors: %d\n", stageMetrics.ErrorCount)
    }
}
```

One sharp edge is worth calling out before you run this against a real database. `AggregationStage` groups with `map[any][]int`, keyed on whatever value came out of the row. `database/sql` scans text and JSON columns into `[]byte`, and `[]byte` is not hashable: using one as a map key does not fail to compile, it panics at runtime with "hash of unhashable type []uint8". The failure lands in production the first time someone groups by a string column, which is to say almost immediately. Normalize scanned values to a hashable type (convert `[]byte` to `string`) as they enter the DataFrame, or make the group key an explicit `string` derived from the value.

### Junior → FAANG: Data Pipelines as Concurrent Go Programs

Once a dataset outgrows the in-memory batch design above, Go channels become the natural abstraction, because they enforce the producer-consumer pattern that prevents stages from accumulating unbounded backpressure. Each pipeline stage reads from an input channel, processes the record, and writes to an output channel. Stages run in separate goroutines so the entire pipeline processes records concurrently. A junior who understands this pattern can design a data pipeline on a whiteboard in minutes and defend the implementation against questions about throughput, backpressure handling, and error propagation.

The most common correctness error in Go data pipeline code is leaking goroutines when a downstream stage errors. If the downstream channel is full and the upstream goroutine is blocked writing to it, and the downstream goroutine exits due to an error, the upstream goroutine blocks forever. The solution is to use select with a context cancellation case in every channel write: if the context is canceled, the goroutine exits cleanly. Practice adding this pattern to every channel write in your pipeline code until it is automatic.

Error handling in data pipelines has two modes: record-level errors (malformed input, missing fields, out-of-range values) that should be logged and skipped so the pipeline continues, and stage-level errors (database unavailable, disk full) that should cancel the entire pipeline run. Implementing this distinction correctly, where record errors increment an error counter and stage errors propagate through the context, is the kind of production-quality Go that distinguishes mid-level from senior engineers.

### Senior @ FAANG: Data Pipeline Design for Scale and Reliability

At FAANG scale, data pipelines process billions of records per day and must meet strict SLOs: record latency (time from event occurrence to feature availability) under one minute for online features, and daily training dataset preparation completing within a two-hour window. Meeting these SLOs requires careful capacity planning: estimating peak throughput, designing for horizontal scalability (adding workers without code changes), and implementing backpressure mechanisms that prevent fast producers from overwhelming slow consumers.

Checkpointing is the most important reliability feature in a data pipeline. A pipeline that processes 100 million records and fails at record 80 million, then restarts from the beginning, wastes 80 million records of processing and potentially misses the training window deadline. Checkpointing at regular intervals (every 100,000 records or every 10 minutes) enables restart from the last successful checkpoint. Implementing checkpointing correctly requires that each stage is idempotent: processing the same record twice produces the same output as processing it once. Designing idempotent pipeline stages is a senior-level skill.

Schema evolution is a long-term operational concern. As the business evolves, new fields are added to input events, existing fields change type or meaning, and deprecated fields are removed. A pipeline that fails hard on unrecognized fields is brittle. A pipeline that silently ignores new fields misses potentially valuable features. The correct approach is schema versioning with explicit compatibility rules: new optional fields are backward compatible, new required fields require a pipeline version bump, and field type changes are always breaking changes that require a migration plan. Senior engineers define and enforce these schema evolution rules as part of the pipeline governance process.

Observability for data pipelines must be designed for debugging at 3 AM without the original author. Every stage should emit: records processed per second, records failed per second (with error reason breakdown), P99 processing latency per record, backlog depth (how many records are waiting to be processed), and end-to-end pipeline latency (time from record ingestion to final output). These metrics, combined with distributed tracing that links a record through all pipeline stages, make production incidents diagnosable within minutes rather than hours. At FAANG, pipeline observability requirements are usually as specific as: any production incident should be root-caused within 15 minutes using only the observability tooling, without needing to read the source code.
