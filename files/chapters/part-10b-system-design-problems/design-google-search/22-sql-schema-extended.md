## SQL Schema: Extended

These additional tables support the operational and analytical needs of the search engine beyond basic indexing. The `query_log` table records every search along with what the user clicked and how long they stayed, providing the training data for ranking model improvements and autocomplete suggestions. The `crawl_schedule` table manages when each URL should next be crawled, while `domain_reputation` stores pre-computed trust and spam scores used during ranking.

```sql
-- Query analytics (for autocomplete training and quality measurement)
CREATE TABLE query_log (
    id          BIGSERIAL PRIMARY KEY,
    query       TEXT NOT NULL,
    user_id     VARCHAR(36),
    result_count INT,
    clicked_url TEXT,
    clicked_position INT,
    dwell_time_secs INT,
    region      VARCHAR(10),
    language    VARCHAR(10),
    device_type VARCHAR(20),
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_query ON query_log (query, created_at DESC);
CREATE INDEX idx_clicked ON query_log (clicked_url, created_at DESC);

-- Crawl schedule
CREATE TABLE crawl_schedule (
    url_hash        BYTEA PRIMARY KEY,
    url             TEXT NOT NULL,
    domain          TEXT NOT NULL,
    priority        DOUBLE PRECISION DEFAULT 0,
    last_crawled    TIMESTAMP,
    next_crawl      TIMESTAMP NOT NULL,
    crawl_interval  INTERVAL DEFAULT '14 days',
    failure_count   INT DEFAULT 0,
    http_status     INT
);

CREATE INDEX idx_schedule_next_crawl ON crawl_schedule (next_crawl ASC);
CREATE INDEX idx_schedule_domain ON crawl_schedule (domain, next_crawl ASC);

-- Domain reputation (for TrustRank and spam detection)
CREATE TABLE domain_reputation (
    domain          TEXT PRIMARY KEY,
    trust_score     DOUBLE PRECISION DEFAULT 0,
    spam_score      DOUBLE PRECISION DEFAULT 0,
    page_count      INT DEFAULT 0,
    avg_page_rank   DOUBLE PRECISION DEFAULT 0,
    category        VARCHAR(50),
    last_computed   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trust ON domain_reputation (trust_score DESC);
```

---
