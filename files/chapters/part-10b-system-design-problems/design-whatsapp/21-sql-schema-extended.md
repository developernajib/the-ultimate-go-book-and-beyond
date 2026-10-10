## SQL Schema: Extended

This extended schema covers the additional tables needed for features beyond basic messaging. User blocks require a dedicated table so the system can quickly check whether one user has blocked another during contact sync and message delivery. The user devices table is essential for multi-device support and E2E key management, storing each device's identity key and push notification token. Cassandra tables for status items and viewers use TTLs matching the 24-hour expiration window so expired content is automatically garbage collected.

```sql
-- PostgreSQL: user blocks
CREATE TABLE user_blocks (
    blocker_id  VARCHAR(36) NOT NULL REFERENCES users(id),
    blocked_id  VARCHAR(36) NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
-- The PK already indexes (blocker_id, blocked_id) left to right, so
-- "who have I blocked" is covered. This index serves the other direction,
-- "who has blocked me", which is the query contact sync actually runs.
CREATE INDEX idx_user_blocks_blocked ON user_blocks (blocked_id);

-- PostgreSQL: user devices (for multi-device + E2E key management)
CREATE TABLE user_devices (
    id             VARCHAR(36) PRIMARY KEY,
    user_id        VARCHAR(36) NOT NULL REFERENCES users(id),
    device_id      VARCHAR(100) NOT NULL,
    platform       VARCHAR(20) NOT NULL,
    push_token     TEXT,
    identity_key   TEXT NOT NULL,  -- X3DH long-term identity key, per device
    signed_pre_key TEXT NOT NULL,
    -- Without the signature the prekey is unverifiable, and the server could
    -- swap in its own and machine-in-the-middle every new session. It is not
    -- optional metadata: it is what binds the prekey to the identity key.
    signed_pre_key_sig TEXT NOT NULL,
    last_active    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_device UNIQUE (user_id, device_id),
    CHECK (platform IN ('ios', 'android', 'web', 'desktop'))
);
CREATE INDEX idx_user_devices_active ON user_devices (user_id, last_active DESC);

-- PostgreSQL: one-time prekeys, handed out at most once each.
CREATE TABLE one_time_prekeys (
    device_id  VARCHAR(36) NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    key_id     INT NOT NULL,
    public_key TEXT NOT NULL,
    claimed_at TIMESTAMPTZ,   -- NULL while available
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, key_id)
);
-- Partial index: only unclaimed keys are ever searched, and the index stays
-- small as the claimed ones accumulate.
CREATE INDEX idx_prekeys_available ON one_time_prekeys (device_id)
    WHERE claimed_at IS NULL;

-- Cassandra: status items (24-hour TTL)
CREATE TABLE status_items (
    user_id    TEXT,
    status_id  TIMEUUID,   -- carries its own creation time
    type       TEXT,
    media_url  TEXT,
    text       TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, status_id)
) WITH CLUSTERING ORDER BY (status_id DESC)
  AND default_time_to_live = 86400;  -- 24 hours auto-delete

-- Cassandra: status viewers.
-- PRIMARY KEY (status_id, viewer_id), NOT (status_id, viewed_at, viewer_id).
-- With viewed_at in the key, the same person opening a status three times
-- writes three rows and "viewed by" counts them all. Keying on viewer_id makes
-- a repeat view an idempotent upsert of the same row.
CREATE TABLE status_viewers (
    status_id TEXT,
    viewer_id TEXT,
    viewed_at TIMESTAMP,   -- plain column: last view wins
    PRIMARY KEY (status_id, viewer_id)
) WITH default_time_to_live = 86400;

-- PostgreSQL: conversation metadata
CREATE TABLE conversations (
    id         VARCHAR(36) PRIMARY KEY,
    type       VARCHAR(10) NOT NULL,
    name       VARCHAR(100),
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (type IN ('direct', 'group'))
);

CREATE TABLE conversation_members (
    conv_id     VARCHAR(36) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id     VARCHAR(36) NOT NULL REFERENCES users(id),
    role        VARCHAR(20) NOT NULL DEFAULT 'member',
    muted_until TIMESTAMPTZ,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conv_id, user_id)
);
-- "list my conversations", the reverse of the PK's leading column.
CREATE INDEX idx_conv_members_user ON conversation_members (user_id, joined_at DESC);
```

Two notes on the Cassandra side, since both are traps rather than preferences.

The `status_items` table lost its `view_count` column. The instinct is to keep a running total there and bump it on each view, but Cassandra cannot do that. Incrementing a plain `INT` means read-modify-write, which loses updates whenever two viewers race. The apparent fix, declaring it `COUNTER`, is worse: Cassandra rejects any table that mixes counter columns with ordinary ones, so the `CREATE TABLE` fails outright. Counters must live in their own table whose non-key columns are all counters. Since `status_viewers` already records exactly who viewed, and a status lives 24 hours with a bounded audience, counting that partition is the simpler answer than maintaining a second source of truth that can disagree with it.

`status_id` is a `TIMEUUID` for the same reason `message_id` is: it sorts chronologically as a clustering key and it is unique without a coordinator. Note that the partition key is `user_id`, so every read must name the poster. That is deliberate, and it means an API taking only a bare `status_id` cannot be served by this table, which is exactly the kind of mismatch that surfaces as "we need a secondary index" late in a design review.

---
