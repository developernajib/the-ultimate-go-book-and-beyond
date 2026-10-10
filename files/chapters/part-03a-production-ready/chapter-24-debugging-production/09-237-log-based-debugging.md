## 24.7 Log-Based Debugging

### Structured Log Analysis

A lightweight span abstraction built on top of `slog` records operation name, duration, and arbitrary key-value attributes without requiring an external tracing backend. The `StartSpan`/`End` pair logs at DEBUG level on success and ERROR level on failure, so the same instrumentation provides both detailed development traces and actionable production error signals depending on the log level configuration.

A `Span` here is owned by one goroutine for its lifetime. The `attrs` map has no lock, so calling `SetAttribute` from a second goroutine while the first is in `End` is a data race, and the race detector will say so. If you need to record attributes from a fan-out, collect them on the parent and set them after the children join.

```go
package debug

import (
    "log/slog"
    "time"
)

// DebugLogger adds debug context to logs
type DebugLogger struct {
    *slog.Logger
    traceID string
}

func NewDebugLogger(logger *slog.Logger, traceID string) *DebugLogger {
    return &DebugLogger{
        Logger:  logger.With("trace_id", traceID),
        traceID: traceID,
    }
}

func (l *DebugLogger) StartSpan(operation string) *Span {
    span := &Span{
        logger:    l.Logger,
        operation: operation,
        startTime: time.Now(),
        attrs:     make(map[string]any),
    }
    l.Logger.Debug("span started", "operation", operation)
    return span
}

type Span struct {
    logger    *slog.Logger
    operation string
    startTime time.Time
    attrs     map[string]any
}

func (s *Span) SetAttribute(key string, value any) {
    s.attrs[key] = value
}

func (s *Span) End(err error) {
    duration := time.Since(s.startTime)

    args := []any{
        "operation", s.operation,
        "duration_ms", duration.Milliseconds(),
    }

    for k, v := range s.attrs {
        args = append(args, k, v)
    }

    if err != nil {
        args = append(args, "error", err.Error())
        s.logger.Error("span failed", args...)
    } else {
        s.logger.Debug("span completed", args...)
    }
}
```

### Log Aggregation Query Patterns

Structured logs stored in a queryable backend such as PostgreSQL, ClickHouse, or Elasticsearch enable precise incident investigation. Grouping errors by message across a sliding time window surfaces the dominant failure modes, while a `trace_id` filter reconstructs the complete request path across all services in chronological order.

```sql
-- Find slow requests
SELECT * FROM logs
WHERE duration_ms > 1000
  AND timestamp > now() - interval '1 hour'
ORDER BY duration_ms DESC
LIMIT 100;

-- Find error patterns
SELECT error, count(*) as count
FROM logs
WHERE level = 'error'
  AND timestamp > now() - interval '1 hour'
GROUP BY error
ORDER BY count DESC;

-- Trace a request
SELECT * FROM logs
WHERE trace_id = 'abc123'
ORDER BY timestamp;

-- Find anomalies
SELECT
    date_trunc('minute', timestamp) as minute,
    count(*) as requests,
    avg(duration_ms) as avg_duration,
    percentile_cont(0.99) within group (order by duration_ms) as p99
FROM logs
WHERE timestamp > now() - interval '1 hour'
GROUP BY 1
ORDER BY 1;
```

### Staff Lens: Log Search Is a Team Skill

Logs only help if engineers can find the relevant ones quickly. Training on the log query tool (Loki, Elasticsearch, CloudWatch) is as important as code training. Include in on-call onboarding.

---
