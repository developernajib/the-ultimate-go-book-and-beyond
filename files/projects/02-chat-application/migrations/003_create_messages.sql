-- Migration: 003_create_messages
-- Creates messages, reactions, and attachments tables.

CREATE TYPE message_type AS ENUM ('text', 'file', 'image', 'system');

CREATE TABLE IF NOT EXISTS messages (
    id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id        UUID         NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id           UUID         NOT NULL REFERENCES users    (id),
    content           TEXT         NOT NULL,
    message_type      message_type NOT NULL DEFAULT 'text',
    metadata          JSONB,
    parent_message_id UUID         REFERENCES messages (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_messages_channel_id  ON messages (channel_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_user_id     ON messages (user_id)                     WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_parent      ON messages (parent_message_id)            WHERE parent_message_id IS NOT NULL;

-- Full-text search index
CREATE INDEX idx_messages_fts ON messages USING GIN (to_tsvector('english', content))
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS reactions (
    id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users    (id) ON DELETE CASCADE,
    emoji      VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message_id ON reactions (message_id);

CREATE TABLE IF NOT EXISTS attachments (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id    UUID        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    filename      TEXT        NOT NULL,
    file_size     BIGINT      NOT NULL,
    mime_type     VARCHAR(100) NOT NULL,
    storage_key   TEXT        NOT NULL,
    thumbnail_key TEXT,
    width         INT,
    height        INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_message_id ON attachments (message_id);
