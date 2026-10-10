## SQL Schema: Extended

These additional tables support the features beyond basic editing: suggestions for track-changes workflows, templates for creating new documents quickly, an audit log for compliance and security monitoring, and link sharing for making documents accessible via URL without requiring explicit per-user permissions. The audit log is particularly important in enterprise deployments where administrators need to track who accessed or modified sensitive documents.

```sql
-- Suggestions (track changes)
CREATE TABLE suggestions (
    id          VARCHAR(36) PRIMARY KEY,
    doc_id      VARCHAR(36) NOT NULL,
    author_id   VARCHAR(36) NOT NULL,
    ops         JSONB NOT NULL,
    original_text TEXT,
    new_text    TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMP DEFAULT NOW(),
    resolved_at TIMESTAMP,
    resolved_by VARCHAR(36)
);

CREATE INDEX idx_doc_suggestions ON suggestions (doc_id, status, created_at);
CREATE INDEX idx_author ON suggestions (author_id, created_at DESC);

-- Document templates
CREATE TABLE templates (
    id          VARCHAR(36) PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    category    VARCHAR(50),
    content_key TEXT NOT NULL,
    thumbnail_url TEXT,
    use_count   INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Audit log for compliance
CREATE TABLE audit_log (
    id          VARCHAR(36) PRIMARY KEY,
    doc_id      VARCHAR(36) NOT NULL,
    user_id     VARCHAR(36) NOT NULL,
    action      VARCHAR(50) NOT NULL,  -- 'edit', 'share', 'delete', 'restore', 'export'
    details     JSONB,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_doc_audit ON audit_log (doc_id, created_at DESC);
CREATE INDEX idx_user_audit ON audit_log (user_id, created_at DESC);

-- Link sharing
CREATE TABLE link_sharing (
    doc_id      VARCHAR(36) PRIMARY KEY,
    enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    role        VARCHAR(20) NOT NULL DEFAULT 'viewer',
    password_hash VARCHAR(255),  -- optional password protection, bcrypt/argon2 hash, never plaintext
    expires_at  TIMESTAMP,
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
);
```

---
