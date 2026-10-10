## Database Schema

The crawler needs persistent storage to track which URLs have been crawled, when they were last visited, and when they should be recrawled. These tables form the metadata layer that survives worker restarts and Kafka rebalances. The `crawled_urls` table is the source of truth for crawl state, while `domain_metadata` stores per-domain configuration like robots.txt rules and whether a domain has been blocked. Both tables are indexed for the most common query patterns: looking up URLs by domain and finding URLs due for recrawling.

Three details in the DDL are worth pausing on. Timestamps are `TIMESTAMPTZ` rather than `TIMESTAMP`, because a crawler is a global system by definition and a bare `TIMESTAMP` silently discards the offset, which turns "recrawl in 6 hours" into an off-by-one-timezone bug twice a year. `crawl_delay_ms` is stored in milliseconds rather than seconds, because sites commonly publish `Crawl-delay: 0.5` and an integer-seconds column rounds that to 0, which is not "no delay specified" but "no politeness at all". And `status_code` must stay signed, since the fetcher writes -1 to mark a page that returned 200 but carried a meta robots noindex.

```sql
-- Crawled URLs (state tracking)
CREATE TABLE crawled_urls (
    url_hash     CHAR(16) PRIMARY KEY,   -- SHA256 truncated to 8 bytes = 16 hex chars
    url          TEXT NOT NULL,
    domain       VARCHAR(255),
    status_code  SMALLINT,               -- signed: -1 marks meta robots noindex
    content_hash CHAR(16),               -- SimHash fingerprint, 64 bits as hex
    crawled_at   TIMESTAMPTZ,
    next_crawl   TIMESTAMPTZ,            -- scheduled recrawl
    retry_count  SMALLINT DEFAULT 0
);

-- Indexes are separate statements. PostgreSQL has no inline INDEX clause inside
-- CREATE TABLE, and the partial index below is what makes the recrawl sweep cheap:
-- it holds only rows actually scheduled, not the whole 10B-row table.
CREATE INDEX idx_domain ON crawled_urls (domain, crawled_at DESC);
CREATE INDEX idx_next_crawl ON crawled_urls (next_crawl) WHERE next_crawl IS NOT NULL;

-- Domain metadata (robots.txt, crawl rate)
CREATE TABLE domain_metadata (
    domain         VARCHAR(255) PRIMARY KEY,
    robots_txt     TEXT,
    crawl_delay_ms INTEGER DEFAULT 1000,  -- milliseconds, not seconds: see below
    last_crawled   TIMESTAMPTZ,
    is_blocked     BOOLEAN DEFAULT FALSE,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);
```

---
