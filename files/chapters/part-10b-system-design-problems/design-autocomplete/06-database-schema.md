## Database Schema

While the trie and Redis handle real-time serving, you still need a persistent store as the source of truth for term frequencies and user search history. These tables back the trie rebuild process and the personalization service. The term_frequencies table is read during each trie rebuild cycle, and user_searches powers the per-user suggestion boosting.

```sql
-- Term frequencies (source of truth for trie)
CREATE TABLE term_frequencies (
    term        VARCHAR(500) PRIMARY KEY,
    frequency   BIGINT DEFAULT 0,
    last_seen   TIMESTAMP,
    domain      VARCHAR(50) DEFAULT 'web'
);

CREATE INDEX idx_frequency ON term_frequencies (frequency DESC);

-- User search history (for personalization)
CREATE TABLE user_searches (
    user_id     VARCHAR(36),
    term        VARCHAR(500),
    searched_at TIMESTAMP DEFAULT NOW(),
    domain      VARCHAR(50)
) PARTITION BY RANGE (searched_at);

CREATE INDEX idx_user_recent ON user_searches (user_id, searched_at DESC);
```

---
