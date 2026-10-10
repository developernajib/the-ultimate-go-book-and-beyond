## Database Schema

These tables store the metadata that supports crawling and ranking. The `url_metadata` table tracks every known URL along with its PageRank score and crawl schedule, while the `link_graph` table stores the edges between pages that PageRank uses to compute authority. In production, Google uses custom storage systems like Bigtable rather than relational databases, but this SQL schema captures the same logical relationships and is easier to reason about during a design discussion.

```sql
-- Document store (Bigtable-equivalent, keyed by URL hash)
-- In production: custom SSTable-based storage (similar to LevelDB)

-- URL metadata table
CREATE TABLE url_metadata (
    doc_id      BYTEA PRIMARY KEY,      -- SHA256 of URL
    url         TEXT NOT NULL,
    title       TEXT,
    content_hash TEXT,                  -- for dedup detection
    page_rank   DOUBLE PRECISION DEFAULT 0,
    language    VARCHAR(10),
    last_crawled TIMESTAMP,
    next_crawl   TIMESTAMP
);

CREATE INDEX idx_domain ON url_metadata (substring(url, 1, 50));
CREATE INDEX idx_next_crawl ON url_metadata (next_crawl);

-- Link graph (for PageRank computation)
CREATE TABLE link_graph (
    from_doc_id BYTEA,
    to_doc_id   BYTEA,
    anchor_text TEXT,
    PRIMARY KEY (from_doc_id, to_doc_id)
);
```

---
