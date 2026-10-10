## Database Schema

The database schema below defines the relational backbone for file metadata, version history, and sharing permissions. The `file_nodes` table stores the current state of every file and folder, with a unique constraint on `(owner_id, path)` to prevent duplicate entries. The `file_versions` table is partitioned by `modified_at` so that old partitions beyond the 30-day retention window can be dropped efficiently without expensive DELETE queries. The `folder_shares` table uses a composite primary key to ensure each user-folder share is unique.

```sql
-- File nodes (current state)
CREATE TABLE file_nodes (
    id           VARCHAR(36) PRIMARY KEY,
    owner_id     VARCHAR(36) NOT NULL,
    parent_id    VARCHAR(100),
    name         VARCHAR(500) NOT NULL,
    path         TEXT NOT NULL,
    type         VARCHAR(10) NOT NULL,   -- file, folder
    size         BIGINT DEFAULT 0,
    block_hashes TEXT,                  -- JSON array of SHA256 hashes
    mime_type    VARCHAR(100),
    revision     INT DEFAULT 1,
    deleted      BOOLEAN DEFAULT FALSE,
    created_at   TIMESTAMP DEFAULT NOW(),
    modified_at  TIMESTAMP DEFAULT NOW(),
    UNIQUE (owner_id, path)
);

CREATE INDEX idx_owner_modified ON file_nodes (owner_id, modified_at DESC);
CREATE INDEX idx_parent ON file_nodes (parent_id);

-- Version history (archived snapshots)
CREATE TABLE file_versions (
    file_id      VARCHAR(36),
    revision     INT,
    block_hashes TEXT,           -- JSON array
    size         BIGINT,
    modified_at  TIMESTAMP,
    -- Partition key must be part of the PK in PostgreSQL
    PRIMARY KEY (file_id, revision, modified_at)
) PARTITION BY RANGE (modified_at);  -- Drop partitions older than 30 days

-- Shared folders
CREATE TABLE folder_shares (
    folder_id    VARCHAR(36),
    shared_with  VARCHAR(36),   -- user ID
    permission   VARCHAR(20),   -- view, edit
    shared_by    VARCHAR(36),
    shared_at    TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (folder_id, shared_with)
);
```

---
