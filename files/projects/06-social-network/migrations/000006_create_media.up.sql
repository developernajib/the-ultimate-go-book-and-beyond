-- Migration: 000006_create_media (up)
-- Tracks uploaded media assets (images, video) and their MinIO-backed variants.

CREATE TABLE IF NOT EXISTS media (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_url  TEXT        NOT NULL,
    thumbnail_url TEXT,
    medium_url    TEXT,
    large_url     TEXT,
    media_type    VARCHAR(20) NOT NULL CHECK (media_type IN ('image','video','gif')),
    mime_type     VARCHAR(100) NOT NULL,
    size_bytes    BIGINT      NOT NULL DEFAULT 0,
    width         INTEGER,
    height        INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_user_id    ON media (user_id);
CREATE INDEX idx_media_created_at ON media (created_at DESC);
