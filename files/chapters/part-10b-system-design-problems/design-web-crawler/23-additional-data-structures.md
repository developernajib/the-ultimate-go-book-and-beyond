## Additional Data Structures

Beyond the core URL and domain tables, a production crawler needs several supporting tables for operational management. The `crawl_jobs` table tracks the lifecycle of each crawl run with its configuration and cumulative statistics. The `blocked_domains` table lets operators blacklist spam farms and other problematic sites. The `crawl_errors` table is partitioned by time for efficient cleanup of old error records, and the `page_quality` table stores quality scores that determine index priority. The `domain_sitemaps` table tracks which sitemaps have been discovered and when they were last processed.

As in the main schema, indexes are separate `CREATE INDEX` statements rather than inline clauses. `crawl_errors` adds a second constraint that catches people out: PostgreSQL requires every unique constraint on a partitioned table to include the partition key, so the primary key has to be `(id, created_at)` and not `id` alone. That is not a style preference, the server rejects the table outright otherwise. Note also that a partitioned parent holds no rows itself, so it needs at least one child partition before an insert will succeed, and creating next month's partition before it is needed is the kind of chore that belongs in a scheduled job rather than in an operator's memory.

```sql
-- Crawl job tracking
CREATE TABLE crawl_jobs (
    id           VARCHAR(36) PRIMARY KEY,
    state        VARCHAR(20),    -- running, paused, stopped, completed
    config       JSONB,          -- seed URLs, max depth, worker count
    started_at   TIMESTAMPTZ,
    stopped_at   TIMESTAMPTZ,
    urls_crawled BIGINT DEFAULT 0,
    urls_errored BIGINT DEFAULT 0,
    bytes_downloaded BIGINT DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Domain blocklist
CREATE TABLE blocked_domains (
    domain       VARCHAR(255) PRIMARY KEY,
    reason       VARCHAR(200),
    blocked_by   VARCHAR(36),
    blocked_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Crawl errors (recent, for debugging)
-- The primary key must include created_at: PostgreSQL requires every unique
-- constraint on a partitioned table to contain the partition key, so a bare
-- "id BIGSERIAL PRIMARY KEY" is rejected outright here.
CREATE TABLE crawl_errors (
    id           BIGSERIAL,
    url          TEXT,
    domain       VARCHAR(255),
    error_type   VARCHAR(50),  -- timeout, dns_failure, http_error, parse_error
    status_code  SMALLINT,
    error_msg    TEXT,
    retry_count  SMALLINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_errors_domain_time ON crawl_errors (domain, created_at DESC);

-- One partition per month. Dropping an old month is an instant DDL operation,
-- which is the point: DELETE across billions of error rows is not.
CREATE TABLE crawl_errors_2026_07 PARTITION OF crawl_errors
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Page quality scores (for index priority)
CREATE TABLE page_quality (
    url_hash        CHAR(16) PRIMARY KEY,
    overall_score   DECIMAL(4,3),
    content_score   DECIMAL(4,3),
    authority_score DECIMAL(4,3),
    freshness_score DECIMAL(4,3),
    word_count      INT,
    scored_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_score ON page_quality (overall_score DESC);

-- Sitemap tracking
CREATE TABLE domain_sitemaps (
    domain       VARCHAR(255),
    sitemap_url  TEXT,
    last_fetched TIMESTAMPTZ,
    url_count    INT,
    PRIMARY KEY (domain, sitemap_url)
);
```


---
