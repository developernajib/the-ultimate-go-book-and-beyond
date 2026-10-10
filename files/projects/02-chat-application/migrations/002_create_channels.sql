-- Migration: 002_create_channels
-- Creates channels and channel_members tables.

CREATE TYPE channel_type AS ENUM ('public', 'private', 'dm');
CREATE TYPE member_role  AS ENUM ('owner', 'admin', 'member');

CREATE TABLE IF NOT EXISTS channels (
    id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         VARCHAR(100) NOT NULL,
    description  VARCHAR(500) NOT NULL DEFAULT '',
    channel_type channel_type NOT NULL DEFAULT 'public',
    created_by   UUID         NOT NULL REFERENCES users (id),
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ
);

CREATE INDEX idx_channels_created_by ON channels (created_by) WHERE deleted_at IS NULL;
CREATE INDEX idx_channels_updated_at ON channels (updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS channel_members (
    id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_id            UUID        NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id               UUID        NOT NULL REFERENCES users    (id) ON DELETE CASCADE,
    role                  member_role NOT NULL DEFAULT 'member',
    joined_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_read_at          TIMESTAMPTZ,
    notifications_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
    UNIQUE (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user_id    ON channel_members (user_id);
CREATE INDEX idx_channel_members_channel_id ON channel_members (channel_id);
