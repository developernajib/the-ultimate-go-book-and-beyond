## Additional Data Structures and Schemas

These tables support team and enterprise features, compliance auditing, and storage quota enforcement. The `teams` and `team_members` tables enable business accounts where an organization manages storage quotas and member access centrally. The `activity_log` table is partitioned by timestamp for efficient retention management and provides the audit trail that enterprise customers require for compliance. The `storage_usage` table tracks both logical size (what the user sees) and physical size (after deduplication) to support accurate quota enforcement and billing.

```sql
-- Team/business account management
CREATE TABLE teams (
    id           VARCHAR(36) PRIMARY KEY,
    name         VARCHAR(200),
    owner_id     VARCHAR(36) NOT NULL,
    storage_quota BIGINT DEFAULT 1099511627776, -- 1TB default
    storage_used BIGINT DEFAULT 0,
    plan         VARCHAR(20) DEFAULT 'business', -- business, enterprise
    created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE team_members (
    team_id      VARCHAR(36) REFERENCES teams(id),
    user_id      VARCHAR(36),
    role         VARCHAR(20) DEFAULT 'member', -- admin, member
    joined_at    TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

-- Activity log (compliance/audit)
CREATE TABLE activity_log (
    id           BIGINT GENERATED ALWAYS AS IDENTITY,
    user_id      VARCHAR(36) NOT NULL,
    team_id      VARCHAR(36),
    action       VARCHAR(50),  -- file_upload, file_delete, share_create, login
    target_path  TEXT,
    target_id    VARCHAR(36),
    ip_address   INET,
    user_agent   TEXT,
    metadata     JSONB,
    created_at   TIMESTAMP DEFAULT NOW(),
    -- Partition key must be part of the PK in PostgreSQL
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_activity_user_time ON activity_log (user_id, created_at DESC);
CREATE INDEX idx_activity_team_time ON activity_log (team_id, created_at DESC);

-- Storage quotas and usage tracking
CREATE TABLE storage_usage (
    user_id      VARCHAR(36) PRIMARY KEY,
    logical_bytes BIGINT DEFAULT 0,
    physical_bytes BIGINT DEFAULT 0,
    file_count   BIGINT DEFAULT 0,
    version_bytes BIGINT DEFAULT 0,
    quota_bytes  BIGINT DEFAULT 2147483648, -- 2GB free tier
    updated_at   TIMESTAMP DEFAULT NOW()
);
```


---
