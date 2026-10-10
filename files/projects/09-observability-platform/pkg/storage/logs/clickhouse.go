// pkg/storage/logs/clickhouse.go
package logs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	_ "github.com/ClickHouse/clickhouse-go/v2"

	"github.com/example/observability-platform/pkg/models"
	oberrors "github.com/example/observability-platform/pkg/errors"
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
