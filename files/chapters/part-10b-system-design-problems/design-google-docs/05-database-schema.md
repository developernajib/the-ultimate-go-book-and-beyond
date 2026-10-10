## Database Schema

The schema below captures the four core entities: documents themselves, their version history, the operation log for real-time catch-up and recovery, and the permissions table for access control. Notice that the operation log uses a composite primary key of `(doc_id, revision)` so you can efficiently fetch all operations since a given revision. Comments use character-position anchors that must be adjusted as the document changes, which is why the comment anchoring logic in the deep dive section is essential.

```sql
-- PostgreSQL: document metadata
CREATE TABLE documents (
    id           VARCHAR(36) PRIMARY KEY,
    owner_id     VARCHAR(36) NOT NULL,
    title        VARCHAR(500),
    content_key  TEXT,                   -- S3 key for current content
    revision     INT DEFAULT 0,
    size         BIGINT DEFAULT 0,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_owner ON documents (owner_id, updated_at DESC);

-- Document versions (snapshots every N ops or time)
CREATE TABLE document_versions (
    doc_id      VARCHAR(36),
    revision    INT,
    content_key TEXT,           -- S3 key for this version
    saved_at    TIMESTAMP,
    saved_by    VARCHAR(36),
    PRIMARY KEY (doc_id, revision)
);

-- Operation log (for catch-up and audit)
CREATE TABLE operation_log (
    doc_id      VARCHAR(36),
    revision    INT,
    user_id     VARCHAR(36),
    ops         JSONB,
    applied_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (doc_id, revision)
);
-- No extra index needed: the primary key already covers (doc_id, revision)
-- range scans for catch-up queries

-- Access permissions
CREATE TABLE doc_permissions (
    doc_id      VARCHAR(36),
    user_id     VARCHAR(36),
    role        VARCHAR(20),    -- owner, editor, commenter, viewer
    granted_by  VARCHAR(36),
    granted_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX idx_user_docs ON doc_permissions (user_id, granted_at DESC);

-- Comments
CREATE TABLE comments (
    id          VARCHAR(36) PRIMARY KEY,
    doc_id      VARCHAR(36) NOT NULL,
    user_id     VARCHAR(36) NOT NULL,
    content     TEXT,
    resolved    BOOLEAN DEFAULT FALSE,
    anchor_start INT,            -- character position in doc
    anchor_end   INT,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_doc_comments ON comments (doc_id, created_at);
```

---
