-- Migration: 000004_create_feed (up)
-- Feed entries represent the fan-out write cache in PostgreSQL.
-- In production these are usually stored only in Redis sorted sets;
-- this table acts as the durable fallback for cold starts and large accounts.

CREATE TABLE IF NOT EXISTS feed_entries (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id        UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    post_author_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rank_score     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, post_id)
);

-- Most queries read the latest entries for a given user ordered by rank
CREATE INDEX idx_feed_entries_user_id    ON feed_entries (user_id, rank_score DESC, created_at DESC);
CREATE INDEX idx_feed_entries_post_id    ON feed_entries (post_id);
CREATE INDEX idx_feed_entries_created_at ON feed_entries (created_at DESC);
