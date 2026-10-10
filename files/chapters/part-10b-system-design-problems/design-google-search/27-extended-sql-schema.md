## Extended SQL Schema

Beyond the core crawl and index tables, three additional tables support the feedback loops that keep search quality high over time. `autocomplete_phrases` is populated from aggregated query logs so that suggestion frequency reflects real user demand rather than editorial guesses. `search_quality_ratings` stores human relevance judgments on a 0-4 scale (the same scale used by major search quality rater programs), which are fed back into ranking model training. `spam_domains` gives the anti-spam pipeline a persistent blocklist with an auditable confirmation workflow so that false positives can be reviewed before a domain is permanently suppressed from results.

```sql
-- Autocomplete training data (from query logs)
CREATE TABLE autocomplete_phrases (
    phrase      TEXT PRIMARY KEY,
    frequency   BIGINT NOT NULL DEFAULT 1,
    last_seen   TIMESTAMP DEFAULT NOW(),
    language    VARCHAR(10)
);

CREATE INDEX idx_frequency ON autocomplete_phrases (frequency DESC);

-- Search quality annotations (human judges)
CREATE TABLE search_quality_ratings (
    id          BIGSERIAL PRIMARY KEY,
    query       TEXT NOT NULL,
    url         TEXT NOT NULL,
    relevance   SMALLINT NOT NULL CHECK (relevance BETWEEN 0 AND 4),
    judge_id    VARCHAR(36) NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_query_ratings ON search_quality_ratings (query, relevance DESC);

-- Known spam domains
CREATE TABLE spam_domains (
    domain      TEXT PRIMARY KEY,
    spam_score  DOUBLE PRECISION NOT NULL,
    reason      TEXT,
    reported_by VARCHAR(36),
    confirmed   BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_spam_score ON spam_domains (spam_score DESC);
```

---
