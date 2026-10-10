## Database Schema

The schema design reflects the two-tier storage strategy. ClickHouse stores the actual time-series data in two tables: a high-resolution raw table with a 7-day TTL and a lower-resolution aggregated table with a 1-year TTL. PostgreSQL handles the metadata that does not fit a columnar model, such as alert rules and alert event history. Notice how the ClickHouse tables use `LowCardinality(String)` for metric names and types, which dramatically improves compression and query speed for columns with limited distinct values.

```sql
-- ClickHouse: raw metrics (high-speed write, TTL-based deletion)
CREATE TABLE metrics (
    timestamp    DateTime64(3),     -- millisecond precision
    metric_name  LowCardinality(String),
    tags_json    String,
    value        Float64,
    metric_type  LowCardinality(String)
) ENGINE = MergeTree()
ORDER BY (metric_name, timestamp)
PARTITION BY toYYYYMMDD(timestamp)
TTL toDateTime(timestamp) + INTERVAL 7 DAY;  -- raw data: 7-day retention

-- ClickHouse: 1-minute aggregated metrics (1-year retention)
CREATE TABLE metrics_1m (
    timestamp    DateTime,
    metric_name  LowCardinality(String),
    tags_json    String,
    value_avg    Float64,
    value_min    Float64,
    value_max    Float64,
    value_count  UInt64
) ENGINE = MergeTree()
ORDER BY (metric_name, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 1 YEAR;

-- PostgreSQL: alert rules
CREATE TABLE alert_rules (
    id           VARCHAR(36) PRIMARY KEY,
    name         VARCHAR(200),
    metric_name  VARCHAR(200),
    tags         JSONB,
    condition    JSONB,         -- {"operator": "gt", "threshold": 90}
    "window"     VARCHAR(10),   -- 5m, 15m, 1h (reserved word, must be quoted)
    aggregation  VARCHAR(20),   -- avg, max, p99
    severity     VARCHAR(20),
    channels     TEXT[],
    enabled      BOOLEAN DEFAULT TRUE,
    created_at   TIMESTAMP DEFAULT NOW()
);

-- Alert history
CREATE TABLE alert_events (
    id          BIGSERIAL PRIMARY KEY,
    rule_id     VARCHAR(36) REFERENCES alert_rules(id),
    event       VARCHAR(20),   -- fired, resolved
    value       DOUBLE PRECISION,
    occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_rule_time ON alert_events (rule_id, occurred_at DESC);
```

---
