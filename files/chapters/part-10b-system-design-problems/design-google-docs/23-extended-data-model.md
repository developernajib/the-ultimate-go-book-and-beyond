## Extended Data Model

These additional tables power features that users expect from a modern document editor but that go beyond core editing. The full-text search index enables "search across all my docs" functionality using PostgreSQL's built-in tsvector support. The activity feed tracks all document events so collaborators can see a timeline of who did what. Named versions let users create labeled snapshots (like "Final Draft" or "Pre-Review") on top of the automatic version history.

```sql
-- Full-text search on document content (for "search across all my docs")
CREATE TABLE document_search_index (
    doc_id          VARCHAR(36) NOT NULL,
    content_tsv     TSVECTOR,           -- PostgreSQL full-text search vector
    title_tsv       TSVECTOR,
    content_text    TEXT,               -- raw text kept for ts_headline snippets
    updated_at      TIMESTAMP DEFAULT NOW(),

    PRIMARY KEY (doc_id)
);

CREATE INDEX idx_content_fts ON document_search_index USING GIN (content_tsv);
CREATE INDEX idx_title_fts ON document_search_index USING GIN (title_tsv);

-- Document activity feed (for "Recent activity" sidebar)
CREATE TABLE document_activity (
    id          BIGSERIAL PRIMARY KEY,
    doc_id      VARCHAR(36) NOT NULL,
    user_id     VARCHAR(36) NOT NULL,
    action      VARCHAR(50) NOT NULL,  -- 'edit', 'comment', 'resolve', 'share', 'rename'
    details     JSONB,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_doc_activity ON document_activity (doc_id, created_at DESC);
CREATE INDEX idx_user_activity ON document_activity (user_id, created_at DESC);

-- Named versions (user-created snapshots, like "Final Draft")
CREATE TABLE named_versions (
    id          VARCHAR(36) PRIMARY KEY,
    doc_id      VARCHAR(36) NOT NULL,
    name        VARCHAR(200) NOT NULL,
    revision    INT NOT NULL,
    created_by  VARCHAR(36) NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW(),

    FOREIGN KEY (doc_id, revision) REFERENCES document_versions(doc_id, revision)
);

CREATE INDEX idx_doc_versions ON named_versions (doc_id, created_at DESC);
```

---
