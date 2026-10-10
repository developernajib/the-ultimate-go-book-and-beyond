## Additional Database Schemas

These supplementary PostgreSQL schemas support the SLO monitoring and alert management features described in the deep-dive sections. The `slo_definitions` table stores the target percentage, SLI metric, and window configuration for each SLO, while `slo_snapshots` keeps hourly evaluations for trend reporting. `tag_cardinality_daily` persists the HyperLogLog counts surfaced by the tag manager, `dashboards` and `notification_channels` back the query and routing services, and `alert_silences` records temporary suppression windows so planned maintenance does not page anyone.

```sql
-- SLO definitions
CREATE TABLE slo_definitions (
    id              VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(200),
    service_name    VARCHAR(100),
    sli_metric      VARCHAR(200),
    sli_threshold   DOUBLE PRECISION,
    sli_operator    VARCHAR(5),
    target_percent  DECIMAL(5,2),
    window_days     INT DEFAULT 30,
    burn_rate_alert BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- SLO status snapshots (computed hourly)
CREATE TABLE slo_snapshots (
    slo_id            VARCHAR(36) REFERENCES slo_definitions(id),
    snapshot_time     TIMESTAMP,
    current_percent   DECIMAL(6,3),
    error_budget_used DECIMAL(12,2),
    error_budget_pct  DECIMAL(5,2),
    burn_rate_1h      DECIMAL(10,4),
    burn_rate_6h      DECIMAL(10,4),
    is_breaching      BOOLEAN,
    PRIMARY KEY (slo_id, snapshot_time)
) PARTITION BY RANGE (snapshot_time);

-- Tag cardinality tracking
CREATE TABLE tag_cardinality_daily (
    metric_name     VARCHAR(200),
    tag_key         VARCHAR(100),
    date            DATE,
    approx_distinct BIGINT,
    PRIMARY KEY (metric_name, tag_key, date)
);

-- Dashboard definitions
CREATE TABLE dashboards (
    id              VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(200),
    owner_id        VARCHAR(36),
    panels          JSONB,
    variables       JSONB,
    refresh_rate    VARCHAR(10),
    time_range      VARCHAR(20),
    is_public       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_owner ON dashboards (owner_id);

-- Notification channels
CREATE TABLE notification_channels (
    id              VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(100),
    type            VARCHAR(20),  -- slack, pagerduty, email, webhook
    config          JSONB,        -- channel-specific config
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Alert silences (suppress alerts temporarily)
CREATE TABLE alert_silences (
    id              VARCHAR(36) PRIMARY KEY,
    rule_id         VARCHAR(36) REFERENCES alert_rules(id),
    reason          TEXT,
    created_by      VARCHAR(36),
    starts_at       TIMESTAMP,
    ends_at         TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_silence_rule ON alert_silences (rule_id, ends_at);
```


---
