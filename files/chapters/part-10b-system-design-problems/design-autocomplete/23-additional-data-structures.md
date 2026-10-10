## Administrative and Analytics Tables

Beyond the core term frequency and user history tables, the system needs administrative controls and analytics. The term_boosts table lets operators manually promote specific terms (for example, during a product launch), the blocked_terms table maintains the content blocklist, and search_analytics aggregates hourly metrics for measuring suggestion quality over time.

```sql
-- Term boost overrides (admin-managed)
CREATE TABLE term_boosts (
    term         VARCHAR(500) PRIMARY KEY,
    boost_factor DECIMAL(4,2) DEFAULT 1.0,
    reason       VARCHAR(200),
    expires_at   TIMESTAMP,
    created_by   VARCHAR(36),
    created_at   TIMESTAMP DEFAULT NOW()
);

-- Content blocklist
CREATE TABLE blocked_terms (
    term         VARCHAR(500) PRIMARY KEY,
    reason       VARCHAR(200),
    blocked_by   VARCHAR(36),
    blocked_at   TIMESTAMP DEFAULT NOW()
);

-- Search analytics (aggregated hourly)
CREATE TABLE search_analytics (
    hour         TIMESTAMP,
    domain       VARCHAR(50),
    prefix       VARCHAR(10),
    suggestion_shown_count BIGINT,
    suggestion_click_count BIGINT,
    avg_position DECIMAL(4,2),
    PRIMARY KEY (hour, domain, prefix)
) PARTITION BY RANGE (hour);
```


---
