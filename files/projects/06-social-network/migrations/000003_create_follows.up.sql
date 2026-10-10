-- Migration: 000003_create_follows (up)
-- Stores follow relationships in PostgreSQL (mirrored in Neo4j for graph queries).

CREATE TABLE IF NOT EXISTS follows (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'pending', 'blocked')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (follower_id, followee_id)
);

CREATE INDEX idx_follows_follower_id ON follows (follower_id);
CREATE INDEX idx_follows_followee_id ON follows (followee_id);
CREATE INDEX idx_follows_status      ON follows (status);
