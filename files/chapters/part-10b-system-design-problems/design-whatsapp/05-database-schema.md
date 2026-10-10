## Database Schema

The database design uses two different storage systems, each chosen for its strengths. Cassandra handles the high-write, time-series nature of messages because it can absorb millions of writes per second and naturally partitions data by conversation. PostgreSQL stores user metadata and group information where relational queries and consistency matter more than raw write throughput. Messages are partitioned by conversation ID so that loading a chat history is a single-partition read, which is extremely fast in Cassandra.

The choice of clustering key is the one decision here that everything else bends around, and it is easy to get wrong in a way that only surfaces at runtime. The obvious instinct is to cluster on `sent_at` and keep `message_id` as a plain identifier. That reads beautifully: `WHERE conv_id = ? AND sent_at < ? ORDER BY sent_at DESC` is a clean backwards scan. The problem appears the moment you try to mark one message as read. Cassandra requires an `UPDATE` to name the complete primary key, so `WHERE conv_id = ? AND message_id = ?` is rejected outright with `Some clustering keys are missing: sent_at`, and every read receipt in the system fails. You cannot supply `sent_at` either, because the device acknowledging the message knows its ID, not the server clock value that was stamped on it.

Clustering on a `TIMEUUID` message ID resolves both needs at once. The ID *is* the timestamp, so `(conv_id, message_id)` is simultaneously a complete primary key that point updates can address and a chronological sort key that range scans can walk. Ordering is on `message_id` rather than `sent_at` because Cassandra can only order and range-scan on clustering columns, and CQL compares `timeuuid` values by their embedded time. `sent_at` survives as a denormalized convenience column for clients that would rather read a timestamp than decode a UUID.

```sql
-- Cassandra: messages table (partitioned by conversation)
CREATE TABLE messages (
    conv_id       TEXT,
    message_id    TIMEUUID,   -- server-assigned, carries its own timestamp
    client_msg_id TEXT,       -- sender's idempotency token
    sender_id     TEXT,
    recipient_id  TEXT,
    group_id      TEXT,
    type          TEXT,
    content       TEXT,       -- base64 E2E ciphertext, opaque to the server
    media_url     TEXT,
    status        TEXT,
    sent_at       TIMESTAMP,
    delivered_at  TIMESTAMP,
    read_at       TIMESTAMP,
    PRIMARY KEY (conv_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND default_time_to_live = 2592000;  -- 30 days

-- Cassandra: group_members
CREATE TABLE group_members (
    group_id  TEXT,
    user_id   TEXT,
    role      TEXT,    -- admin, member
    joined_at TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);

-- PostgreSQL: users (for metadata, not messages)
CREATE TABLE users (
    id          VARCHAR(36) PRIMARY KEY,
    phone       VARCHAR(20) UNIQUE NOT NULL,
    name        VARCHAR(100),
    avatar_url  TEXT,
    about       TEXT,
    last_seen   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- No separate index on phone: the UNIQUE constraint already builds one, and a
-- second index on the same column would be dead weight on every write.

-- PostgreSQL: groups metadata
CREATE TABLE groups (
    id          VARCHAR(36) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    creator_id  VARCHAR(36) REFERENCES users(id),
    avatar_url  TEXT,
    max_members INT NOT NULL DEFAULT 1024,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_groups_creator ON groups (creator_id);
```

---
