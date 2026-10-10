## Additional Database Tables

These tables extend the core schema to support features beyond basic file sync: public link sharing with optional password protection and expiration, full-text search indexing, block reference counting for garbage collection, and per-device sync state tracking. The `block_references` table is particularly important because it enables the garbage collector to efficiently identify orphaned blocks without scanning the entire `file_nodes` table. The `device_sync_state` table stores each device's cursor and selective sync configuration, so the server knows exactly which changes to send to which device.

```sql
-- Link sharing (public links)
CREATE TABLE share_links (
    id          VARCHAR(36) PRIMARY KEY,
    folder_id   VARCHAR(36) NOT NULL,
    owner_id    VARCHAR(36) NOT NULL,
    permission  VARCHAR(10) DEFAULT 'view',
    token       VARCHAR(32) UNIQUE NOT NULL, -- URL token
    password    VARCHAR(60),                 -- optional bcrypt hash
    expires_at  TIMESTAMP,
    max_views   INT,
    view_count  INT DEFAULT 0,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_share_links_folder ON share_links (folder_id);
-- token already has a unique index via the UNIQUE constraint

-- File content index (for search)
CREATE TABLE file_content_index (
    file_id     VARCHAR(36) PRIMARY KEY,
    owner_id    VARCHAR(36) NOT NULL,
    name        VARCHAR(500),
    content     TEXT,                        -- extracted text
    indexed_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_index_owner ON file_content_index (owner_id);

-- Block reference counting (for garbage collection)
CREATE TABLE block_references (
    block_hash  CHAR(64) PRIMARY KEY,
    ref_count   INT DEFAULT 1,
    size_bytes  INT NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW(),
    last_accessed TIMESTAMP DEFAULT NOW()
);

-- Device sync state
CREATE TABLE device_sync_state (
    device_id   VARCHAR(36),
    user_id     VARCHAR(36),
    device_name VARCHAR(200),
    platform    VARCHAR(50),  -- windows, mac, linux, ios, android
    cursor      TIMESTAMP,    -- last synced timestamp
    last_seen   TIMESTAMP,
    sync_folders TEXT[],       -- selective sync folder list
    PRIMARY KEY (device_id)
);

CREATE INDEX idx_device_sync_user ON device_sync_state (user_id);
```


---
