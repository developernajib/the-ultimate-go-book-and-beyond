## Part 4: Storage Layer

The storage layer is responsible for persisting metrics, logs, and traces efficiently and making them queryable. Different signal types have very different access patterns: metrics are numeric time series that benefit from columnar compression, logs are text-heavy and need full-text indexing, and traces are hierarchical structures linked by trace IDs. For this reason, the platform uses specialized storage backends for each signal type rather than forcing everything into a single database.

### 4.1 Metrics Storage (Prometheus TSDB)

Prometheus TSDB is purpose-built for time-series data. It organizes samples into compressed blocks on disk and maintains a write-ahead log (WAL) for durability. This wrapper provides a clean interface for writing metric samples and querying them by label matchers and time ranges. The TSDB handles compaction automatically, merging small blocks into larger ones over time to improve query performance. You configure retention to control how long raw data is kept before being deleted or moved to long-term storage.

```go
// pkg/storage/metrics/prometheus.go
package metrics

import (
    "context"
    "fmt"
    "path/filepath"
    "time"

    "github.com/prometheus/prometheus/model/labels"
    "github.com/prometheus/prometheus/storage"
    "github.com/prometheus/prometheus/tsdb"

    "observability/pkg/models"
    oberrors "observability/pkg/errors"
)

// PrometheusStore implements MetricStore using Prometheus TSDB
type PrometheusStore struct {
    db           *tsdb.DB
    path         string
    retentionTime time.Duration
}

// NewPrometheusStore creates a new Prometheus metrics store
func NewPrometheusStore(path string, retentionTime time.Duration) (*PrometheusStore, error) {
    opts := tsdb.DefaultOptions()
    opts.RetentionDuration = int64(retentionTime / time.Millisecond)
    opts.WALCompression = true
    opts.MaxBlockDuration = int64(2 * time.Hour / time.Millisecond)

    db, err := tsdb.Open(path, nil, nil, opts, nil)
    if err != nil {
        return nil, fmt.Errorf("opening TSDB: %w", err)
    }

    return &PrometheusStore{
        db:           db,
        path:         path,
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
        // Convert to Prometheus labels
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

        // Sort labels
        sort.Sort(lbls)

        // Append sample
        timestamp := metric.Timestamp.UnixNano() / int64(time.Millisecond)

        switch metric.Type {
        case models.MetricTypeGauge, models.MetricTypeCounter:
            if _, err := appender.Append(0, lbls, timestamp, metric.Value); err != nil {
                return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
            }

        case models.MetricTypeHistogram:
            // Write histogram buckets
            for _, bucket := range metric.Buckets {
                bucketLbls := append(lbls, labels.Label{
                    Name:  "le",
                    Value: fmt.Sprintf("%g", bucket.UpperBound),
                })
                sort.Sort(bucketLbls)

                if _, err := appender.Append(0, bucketLbls, timestamp, float64(bucket.Count)); err != nil {
                    return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
                }
            }

            // Write sum
            sumLbls := append(lbls, labels.Label{
                Name:  "__suffix__",
                Value: "sum",
            })
            if _, err := appender.Append(0, sumLbls, timestamp, metric.Sum); err != nil {
                return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
            }

            // Write count
            countLbls := append(lbls, labels.Label{
                Name:  "__suffix__",
                Value: "count",
            })
            if _, err := appender.Append(0, countLbls, timestamp, float64(metric.Count)); err != nil {
                return oberrors.E("PrometheusStore.Write", oberrors.ErrInternal, err)
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
    querier, err := s.db.Querier(ctx, start.UnixNano()/int64(time.Millisecond), end.UnixNano()/int64(time.Millisecond))
    if err != nil {
        return nil, oberrors.E("PrometheusStore.Query", oberrors.ErrInternal, err)
    }
    defer querier.Close()

    // Parse query to get matchers
    // In production, use PromQL parser
    matchers := []*labels.Matcher{}

    seriesSet := querier.Select(false, nil, matchers...)

    var result []*models.Series

    for seriesSet.Next() {
        series := seriesSet.At()
        lbls := series.Labels()

        // Convert labels
        modelLabels := make(models.Labels, 0, len(lbls))
        for _, l := range lbls {
            if l.Name != "__name__" {
                modelLabels = append(modelLabels, models.Label{
                    Name:  l.Name,
                    Value: l.Value,
                })
            }
        }

        // Read samples
        iter := series.Iterator()
        var samples []models.Sample

        for iter.Next() {
            t, v := iter.At()
            samples = append(samples, models.Sample{
                Timestamp: time.Unix(0, t*int64(time.Millisecond)),
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
    return s.db.Compact()
}

// Snapshot creates a snapshot
func (s *PrometheusStore) Snapshot(dir string) error {
    return s.db.Snapshot(dir, true)
}
```

### 4.2 Log Storage (ClickHouse)

ClickHouse is a columnar database that excels at analytical queries over large datasets, making it an excellent choice for log storage. Logs are inserted in batches for throughput, and ClickHouse's built-in compression and partitioning keep storage costs low even at massive scale. This implementation creates a table partitioned by date with indexes on commonly queried fields like service name, log level, and labels. Full-text search on log messages is supported through ClickHouse's token-based indexing.

```go
// pkg/storage/logs/clickhouse.go
package logs

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "strings"
    "time"

    "github.com/ClickHouse/clickhouse-go/v2"

    "observability/pkg/models"
    oberrors "observability/pkg/errors"
)

// ClickHouseStore implements LogStore using ClickHouse
type ClickHouseStore struct {
    db       *sql.DB
    database string
    table    string
}

// NewClickHouseStore creates a new ClickHouse log store
func NewClickHouseStore(dsn, database, table string) (*ClickHouseStore, error) {
    db, err := sql.Open("clickhouse", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening ClickHouse: %w", err)
    }

    store := &ClickHouseStore{
        db:       db,
        database: database,
        table:    table,
    }

    // Create schema
    if err := store.createSchema(); err != nil {
        return nil, fmt.Errorf("creating schema: %w", err)
    }

    return store, nil
}

// createSchema creates the log table schema
func (s *ClickHouseStore) createSchema() error {
    query := fmt.Sprintf(`
        CREATE TABLE IF NOT EXISTS %s.%s (
            timestamp DateTime64(9),
            level String,
            message String,
            host String,
            service String,
            container String,
            pod String,
            namespace String,
            trace_id String,
            span_id String,
            tenant_id String,
            fields String,
            labels Array(String),
            INDEX idx_service service TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_host host TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_message message TYPE tokenbf_v1(30000, 3, 0) GRANULARITY 1
        ) ENGINE = MergeTree()
        PARTITION BY toYYYYMMDD(timestamp)
        ORDER BY (tenant_id, timestamp, service)
        TTL timestamp + INTERVAL 30 DAY
        SETTINGS index_granularity = 8192
    `, s.database, s.table)

    _, err := s.db.Exec(query)
    return err
}

// Write writes log entries to the store
func (s *ClickHouseStore) Write(ctx context.Context, entries []*models.LogEntry) error {
    if len(entries) == 0 {
        return nil
    }

    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return oberrors.E("ClickHouseStore.Write", oberrors.ErrInternal, err)
    }
    defer tx.Rollback()

    stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(`
        INSERT INTO %s.%s (
            timestamp, level, message, host, service, container, pod, namespace,
            trace_id, span_id, tenant_id, fields, labels
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, s.database, s.table))
    if err != nil {
        return oberrors.E("ClickHouseStore.Write", oberrors.ErrInternal, err)
    }
    defer stmt.Close()

    for _, entry := range entries {
        // Serialize fields to JSON
        fieldsJSON, err := json.Marshal(entry.Fields)
        if err != nil {
            return oberrors.E("ClickHouseStore.Write", oberrors.ErrInternal, err)
        }

        // Convert labels to array
        labelStrs := make([]string, len(entry.Labels))
        for i, label := range entry.Labels {
            labelStrs[i] = fmt.Sprintf("%s=%s", label.Name, label.Value)
        }

        _, err = stmt.ExecContext(ctx,
            entry.Timestamp,
            entry.Level.String(),
            entry.Message,
            entry.Host,
            entry.Service,
            entry.Container,
            entry.Pod,
            entry.Namespace,
            entry.TraceID,
            entry.SpanID,
            entry.TenantID,
            string(fieldsJSON),
            labelStrs,
        )
        if err != nil {
            return oberrors.E("ClickHouseStore.Write", oberrors.ErrInternal, err)
        }
    }

    if err := tx.Commit(); err != nil {
        return oberrors.E("ClickHouseStore.Write", oberrors.ErrInternal, err)
    }

    return nil
}

// Query queries log entries
func (s *ClickHouseStore) Query(ctx context.Context, query *models.LogQuery) (*models.LogQueryResult, error) {
    // Build WHERE clause
    var conditions []string
    var args []any

    conditions = append(conditions, "timestamp >= ? AND timestamp <= ?")
    args = append(args, query.StartTime, query.EndTime)

    if query.TenantID != "" {
        conditions = append(conditions, "tenant_id = ?")
        args = append(args, query.TenantID)
    }

    if query.Service != "" {
        conditions = append(conditions, "service = ?")
        args = append(args, query.Service)
    }

    if query.Host != "" {
        conditions = append(conditions, "host = ?")
        args = append(args, query.Host)
    }

    if query.Namespace != "" {
        conditions = append(conditions, "namespace = ?")
        args = append(args, query.Namespace)
    }

    if query.Level != nil {
        conditions = append(conditions, "level = ?")
        args = append(args, query.Level.String())
    }

    if query.TraceID != "" {
        conditions = append(conditions, "trace_id = ?")
        args = append(args, query.TraceID)
    }

    if query.SearchQuery != "" {
        conditions = append(conditions, "positionCaseInsensitive(message, ?) > 0")
        args = append(args, query.SearchQuery)
    }

    whereClause := strings.Join(conditions, " AND ")

    // Build full query
    sqlQuery := fmt.Sprintf(`
        SELECT
            timestamp, level, message, host, service, container, pod, namespace,
            trace_id, span_id, tenant_id, fields, labels
        FROM %s.%s
        WHERE %s
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
    `, s.database, s.table, whereClause)

    limit := query.Limit
    if limit == 0 {
        limit = 100
    }

    args = append(args, limit, query.Offset)

    rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
    if err != nil {
        return nil, oberrors.E("ClickHouseStore.Query", oberrors.ErrInternal, err)
    }
    defer rows.Close()

    var entries []*models.LogEntry

    for rows.Next() {
        var entry models.LogEntry
        var levelStr string
        var fieldsJSON string
        var labelStrs []string

        entry.Fields = make(map[string]any)

        err := rows.Scan(
            &entry.Timestamp,
            &levelStr,
            &entry.Message,
            &entry.Host,
            &entry.Service,
            &entry.Container,
            &entry.Pod,
            &entry.Namespace,
            &entry.TraceID,
            &entry.SpanID,
            &entry.TenantID,
            &fieldsJSON,
            &labelStrs,
        )
        if err != nil {
            return nil, oberrors.E("ClickHouseStore.Query", oberrors.ErrInternal, err)
        }

        entry.Level = models.ParseLogLevel(levelStr)

        // Deserialize fields
        if fieldsJSON != "" {
            if err := json.Unmarshal([]byte(fieldsJSON), &entry.Fields); err != nil {
                return nil, oberrors.E("ClickHouseStore.Query", oberrors.ErrInternal, err)
            }
        }

        // Parse labels
        for _, labelStr := range labelStrs {
            parts := strings.SplitN(labelStr, "=", 2)
            if len(parts) == 2 {
                entry.Labels = append(entry.Labels, models.Label{
                    Name:  parts[0],
                    Value: parts[1],
                })
            }
        }

        entries = append(entries, &entry)
    }

    if err := rows.Err(); err != nil {
        return nil, oberrors.E("ClickHouseStore.Query", oberrors.ErrInternal, err)
    }

    // Get total count
    countQuery := fmt.Sprintf(`
        SELECT COUNT(*) FROM %s.%s WHERE %s
    `, s.database, s.table, whereClause)

    var totalCount int64
    if err := s.db.QueryRowContext(ctx, countQuery, args[:len(args)-2]...).Scan(&totalCount); err != nil {
        return nil, oberrors.E("ClickHouseStore.Query", oberrors.ErrInternal, err)
    }

    return &models.LogQueryResult{
        Entries:    entries,
        TotalCount: totalCount,
        HasMore:    int64(query.Offset+len(entries)) < totalCount,
    }, nil
}

// Close closes the store
func (s *ClickHouseStore) Close() error {
    return s.db.Close()
}
```

### 4.3 Trace Storage (ClickHouse)

Distributed traces consist of spans that must be stored individually but queried as complete traces. This storage layer uses two ClickHouse tables: one for spans (the raw data) and one for trace-level indexes that allow fast lookups by service name, operation, duration, or tags. When you query for traces, the index table narrows down candidates quickly, and then the spans table retrieves all spans belonging to matching trace IDs. The service dependency map is computed by analyzing parent-child relationships across spans.

```go
// pkg/storage/traces/clickhouse.go
package traces

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "strings"
    "time"

    "observability/pkg/models"
    oberrors "observability/pkg/errors"
)

// ClickHouseStore implements TraceStore using ClickHouse
type ClickHouseStore struct {
    db         *sql.DB
    database   string
    spansTable string
    indexTable string
}

// NewClickHouseStore creates a new ClickHouse trace store
func NewClickHouseStore(dsn, database, spansTable, indexTable string) (*ClickHouseStore, error) {
    db, err := sql.Open("clickhouse", dsn)
    if err != nil {
        return nil, fmt.Errorf("opening ClickHouse: %w", err)
    }

    store := &ClickHouseStore{
        db:         db,
        database:   database,
        spansTable: spansTable,
        indexTable: indexTable,
    }

    // Create schema
    if err := store.createSchema(); err != nil {
        return nil, fmt.Errorf("creating schema: %w", err)
    }

    return store, nil
}

// createSchema creates the trace tables
func (s *ClickHouseStore) createSchema() error {
    // Spans table
    spansQuery := fmt.Sprintf(`
        CREATE TABLE IF NOT EXISTS %s.%s (
            trace_id String,
            span_id String,
            parent_id String,
            start_time DateTime64(9),
            end_time DateTime64(9),
            duration_ns UInt64,
            name String,
            kind String,
            status String,
            status_message String,
            service_name String,
            attributes String,
            resource String,
            events String,
            links String,
            tenant_id String,
            INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_service service_name TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_name name TYPE tokenbf_v1(30000, 3, 0) GRANULARITY 1
        ) ENGINE = MergeTree()
        PARTITION BY toYYYYMMDD(start_time)
        ORDER BY (tenant_id, start_time, trace_id, span_id)
        TTL start_time + INTERVAL 7 DAY
        SETTINGS index_granularity = 8192
    `, s.database, s.spansTable)

    if _, err := s.db.Exec(spansQuery); err != nil {
        return err
    }

    // Index table for trace lookups
    indexQuery := fmt.Sprintf(`
        CREATE TABLE IF NOT EXISTS %s.%s (
            trace_id String,
            start_time DateTime64(9),
            end_time DateTime64(9),
            duration_ns UInt64,
            service_name String,
            root_service String,
            root_operation String,
            span_count UInt32,
            error_count UInt32,
            tenant_id String,
            INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1,
            INDEX idx_service service_name TYPE bloom_filter(0.01) GRANULARITY 1
        ) ENGINE = MergeTree()
        PARTITION BY toYYYYMMDD(start_time)
        ORDER BY (tenant_id, start_time)
        TTL start_time + INTERVAL 7 DAY
        SETTINGS index_granularity = 8192
    `, s.database, s.indexTable)

    if _, err := s.db.Exec(indexQuery); err != nil {
        return err
    }

    return nil
}

// WriteSpans writes spans to the store
func (s *ClickHouseStore) WriteSpans(ctx context.Context, spans []*models.Span) error {
    if len(spans) == 0 {
        return nil
    }

    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return oberrors.E("ClickHouseStore.WriteSpans", oberrors.ErrInternal, err)
    }
    defer tx.Rollback()

    stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(`
        INSERT INTO %s.%s (
            trace_id, span_id, parent_id, start_time, end_time, duration_ns,
            name, kind, status, status_message, service_name,
            attributes, resource, events, links, tenant_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, s.database, s.spansTable))
    if err != nil {
        return oberrors.E("ClickHouseStore.WriteSpans", oberrors.ErrInternal, err)
    }
    defer stmt.Close()

    for _, span := range spans {
        // Serialize complex fields
        attributesJSON, _ := json.Marshal(span.Attributes)
        resourceJSON, _ := json.Marshal(span.Resource)
        eventsJSON, _ := json.Marshal(span.Events)
        linksJSON, _ := json.Marshal(span.Links)

        _, err = stmt.ExecContext(ctx,
            span.TraceID,
            span.SpanID,
            span.ParentID,
            span.StartTime,
            span.EndTime,
            span.Duration.Nanoseconds(),
            span.Name,
            span.Kind.String(),
            span.Status,
            span.StatusMsg,
            span.ServiceName,
            string(attributesJSON),
            string(resourceJSON),
            string(eventsJSON),
            string(linksJSON),
            span.TenantID,
        )
        if err != nil {
            return oberrors.E("ClickHouseStore.WriteSpans", oberrors.ErrInternal, err)
        }
    }

    if err := tx.Commit(); err != nil {
        return oberrors.E("ClickHouseStore.WriteSpans", oberrors.ErrInternal, err)
    }

    // Update trace index asynchronously
    go s.updateTraceIndex(context.Background(), spans)

    return nil
}

// updateTraceIndex updates the trace index table
func (s *ClickHouseStore) updateTraceIndex(ctx context.Context, spans []*models.Span) {
    // Group spans by trace_id
    traceSpans := make(map[string][]*models.Span)
    for _, span := range spans {
        traceSpans[span.TraceID] = append(traceSpans[span.TraceID], span)
    }

    for traceID := range traceSpans {
        s.indexTrace(ctx, traceID)
    }
}

// indexTrace creates/updates index entry for a trace
func (s *ClickHouseStore) indexTrace(ctx context.Context, traceID string) error {
    // Query all spans for this trace
    query := fmt.Sprintf(`
        SELECT
            start_time, end_time, duration_ns, service_name, parent_id, name, status
        FROM %s.%s
        WHERE trace_id = ?
        ORDER BY start_time
    `, s.database, s.spansTable)

    rows, err := s.db.QueryContext(ctx, query, traceID)
    if err != nil {
        return err
    }
    defer rows.Close()

    var (
        startTime      time.Time
        endTime        time.Time
        totalDuration  int64
        services       = make(map[string]bool)
        rootService    string
        rootOperation  string
        spanCount      int
        errorCount     int
        tenantID       string
    )

    for rows.Next() {
        var (
            st, et     time.Time
            duration   int64
            service    string
            parentID   string
            name       string
            status     string
        )

        if err := rows.Scan(&st, &et, &duration, &service, &parentID, &name, &status); err != nil {
            return err
        }

        spanCount++
        services[service] = true

        if startTime.IsZero() || st.Before(startTime) {
            startTime = st
        }
        if endTime.IsZero() || et.After(endTime) {
            endTime = et
        }

        // Root span (no parent)
        if parentID == "" {
            rootService = service
            rootOperation = name
        }

        if status == "error" {
            errorCount++
        }
    }

    totalDuration = endTime.Sub(startTime).Nanoseconds()

    // Upsert into index table
    _, err = s.db.ExecContext(ctx, fmt.Sprintf(`
        INSERT INTO %s.%s (
            trace_id, start_time, end_time, duration_ns, service_name,
            root_service, root_operation, span_count, error_count, tenant_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, s.database, s.indexTable),
        traceID,
        startTime,
        endTime,
        totalDuration,
        strings.Join(mapKeys(services), ","),
        rootService,
        rootOperation,
        spanCount,
        errorCount,
        tenantID,
    )

    return err
}

// QueryTraces queries traces
func (s *ClickHouseStore) QueryTraces(ctx context.Context, query *models.TraceQuery) ([]*models.Trace, error) {
    // Build WHERE clause
    var conditions []string
    var args []any

    conditions = append(conditions, "start_time >= ? AND start_time <= ?")
    args = append(args, query.StartTime, query.EndTime)

    if query.TenantID != "" {
        conditions = append(conditions, "tenant_id = ?")
        args = append(args, query.TenantID)
    }

    if query.ServiceName != "" {
        conditions = append(conditions, "positionCaseInsensitive(service_name, ?) > 0")
        args = append(args, query.ServiceName)
    }

    if query.Operation != "" {
        conditions = append(conditions, "root_operation = ?")
        args = append(args, query.Operation)
    }

    if query.MinDuration > 0 {
        conditions = append(conditions, "duration_ns >= ?")
        args = append(args, query.MinDuration.Nanoseconds())
    }

    if query.MaxDuration > 0 {
        conditions = append(conditions, "duration_ns <= ?")
        args = append(args, query.MaxDuration.Nanoseconds())
    }

    whereClause := strings.Join(conditions, " AND ")

    // Query index table
    sqlQuery := fmt.Sprintf(`
        SELECT DISTINCT trace_id
        FROM %s.%s
        WHERE %s
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?
    `, s.database, s.indexTable, whereClause)

    limit := query.Limit
    if limit == 0 {
        limit = 100
    }

    args = append(args, limit, query.Offset)

    rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
    if err != nil {
        return nil, oberrors.E("ClickHouseStore.QueryTraces", oberrors.ErrInternal, err)
    }
    defer rows.Close()

    var traceIDs []string
    for rows.Next() {
        var traceID string
        if err := rows.Scan(&traceID); err != nil {
            return nil, oberrors.E("ClickHouseStore.QueryTraces", oberrors.ErrInternal, err)
        }
        traceIDs = append(traceIDs, traceID)
    }

    // Fetch full traces
    var traces []*models.Trace
    for _, traceID := range traceIDs {
        trace, err := s.GetTrace(ctx, traceID)
        if err != nil {
            continue
        }
        traces = append(traces, trace)
    }

    return traces, nil
}

// GetTrace retrieves a complete trace
func (s *ClickHouseStore) GetTrace(ctx context.Context, traceID string) (*models.Trace, error) {
    query := fmt.Sprintf(`
        SELECT
            span_id, parent_id, start_time, end_time, duration_ns,
            name, kind, status, status_message, service_name,
            attributes, resource, events, links, tenant_id
        FROM %s.%s
        WHERE trace_id = ?
        ORDER BY start_time
    `, s.database, s.spansTable)

    rows, err := s.db.QueryContext(ctx, query, traceID)
    if err != nil {
        return nil, oberrors.E("ClickHouseStore.GetTrace", oberrors.ErrInternal, err)
    }
    defer rows.Close()

    var spans []*models.Span
    serviceMap := make(map[string]bool)

    for rows.Next() {
        var span models.Span
        var (
            durationNs                                     int64
            kind, status, attributesJSON, resourceJSON     string
            eventsJSON, linksJSON                          string
        )

        span.TraceID = traceID
        span.Attributes = make(map[string]any)
        span.Resource = make(map[string]any)

        err := rows.Scan(
            &span.SpanID,
            &span.ParentID,
            &span.StartTime,
            &span.EndTime,
            &durationNs,
            &span.Name,
            &kind,
            &status,
            &span.StatusMsg,
            &span.ServiceName,
            &attributesJSON,
            &resourceJSON,
            &eventsJSON,
            &linksJSON,
            &span.TenantID,
        )
        if err != nil {
            return nil, oberrors.E("ClickHouseStore.GetTrace", oberrors.ErrInternal, err)
        }

        span.Duration = time.Duration(durationNs)

        // Deserialize JSON fields
        json.Unmarshal([]byte(attributesJSON), &span.Attributes)
        json.Unmarshal([]byte(resourceJSON), &span.Resource)
        json.Unmarshal([]byte(eventsJSON), &span.Events)
        json.Unmarshal([]byte(linksJSON), &span.Links)

        spans = append(spans, &span)
        serviceMap[span.ServiceName] = true
    }

    if len(spans) == 0 {
        return nil, oberrors.E("ClickHouseStore.GetTrace", oberrors.ErrNotFound, nil)
    }

    // Build trace
    trace := &models.Trace{
        TraceID:    traceID,
        Spans:      spans,
        ServiceMap: serviceMap,
        StartTime:  spans[0].StartTime,
        EndTime:    spans[len(spans)-1].EndTime,
        SpanCount:  len(spans),
        TenantID:   spans[0].TenantID,
    }

    trace.Duration = trace.EndTime.Sub(trace.StartTime)

    // Find root span
    for _, span := range spans {
        if span.ParentID == "" {
            trace.RootSpan = span
            break
        }
    }

    // Count errors
    for _, span := range spans {
        if span.Status == models.SpanStatusError {
            trace.ErrorCount++
        }
    }

    return trace, nil
}

// Close closes the store
func (s *ClickHouseStore) Close() error {
    return s.db.Close()
}

// Helper function
func mapKeys(m map[string]bool) []string {
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    return keys
}
```
