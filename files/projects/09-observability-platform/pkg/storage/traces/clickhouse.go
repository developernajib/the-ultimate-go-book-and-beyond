// pkg/storage/traces/clickhouse.go
package traces

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "strings"
    "time"

    "github.com/example/observability-platform/pkg/models"
    oberrors "github.com/example/observability-platform/pkg/errors"
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
