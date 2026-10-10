## Trending and A/B Test Tables

These additional tables support trending detection and A/B testing, two features that elevate the system from basic autocomplete to a data-driven product. The trending_terms table materializes velocity-based scores so the serving layer does not need to compute them on the fly. The A/B test tables let you experiment with different ranking algorithms and measure their impact on click-through rate and user engagement.

```sql
-- Trending terms (materialized every 5 minutes)
CREATE TABLE trending_terms (
    id           SERIAL PRIMARY KEY,
    term         VARCHAR(500) NOT NULL,
    domain       VARCHAR(50) NOT NULL,
    velocity     DECIMAL(10,2),    -- current/historical ratio
    current_count BIGINT,
    historical_avg DECIMAL(10,2),
    detected_at  TIMESTAMP,
    expires_at   TIMESTAMP
);

CREATE INDEX idx_domain_velocity ON trending_terms (domain, velocity DESC);

-- A/B test configuration
CREATE TABLE ab_tests (
    id           VARCHAR(36) PRIMARY KEY,
    name         VARCHAR(200),
    description  TEXT,
    variant_a    JSONB,  -- { "algorithm": "trie_topk", "boost_trending": true }
    variant_b    JSONB,  -- { "algorithm": "trie_topk", "boost_trending": false }
    traffic_pct  DECIMAL(5,2) DEFAULT 5.0,  -- % in variant B
    status       VARCHAR(20) DEFAULT 'draft', -- draft, running, completed
    started_at   TIMESTAMP,
    ended_at     TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
);

-- A/B test results (aggregated hourly)
CREATE TABLE ab_test_results (
    test_id      VARCHAR(36),
    variant      VARCHAR(10), -- a or b
    hour         TIMESTAMP,
    impressions  BIGINT,
    clicks       BIGINT,
    ctr          DECIMAL(8,6),
    avg_position DECIMAL(4,2),
    abandonment  BIGINT,
    PRIMARY KEY (test_id, variant, hour)
);
```

---
