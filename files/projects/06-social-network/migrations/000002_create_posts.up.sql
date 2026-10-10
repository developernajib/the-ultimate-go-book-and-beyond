-- Migration: 000002_create_posts (up)
-- Creates the posts table and post_likes table.

CREATE TABLE IF NOT EXISTS posts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content       TEXT,
    media_urls    TEXT[]      NOT NULL DEFAULT '{}',
    media_types   TEXT[]      NOT NULL DEFAULT '{}',
    hashtags      TEXT[]      NOT NULL DEFAULT '{}',
    mentions      UUID[]      NOT NULL DEFAULT '{}',
    reply_to_id   UUID        REFERENCES posts(id) ON DELETE SET NULL,
    repost_of_id  UUID        REFERENCES posts(id) ON DELETE SET NULL,
    visibility    VARCHAR(20) NOT NULL DEFAULT 'public'
                              CHECK (visibility IN ('public', 'followers', 'private')),
    like_count    INTEGER     NOT NULL DEFAULT 0,
    comment_count INTEGER     NOT NULL DEFAULT 0,
    repost_count  INTEGER     NOT NULL DEFAULT 0,
    view_count    INTEGER     NOT NULL DEFAULT 0,
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_posts_user_id    ON posts (user_id);
CREATE INDEX idx_posts_created_at ON posts (created_at DESC);
CREATE INDEX idx_posts_hashtags   ON posts USING GIN (hashtags);
CREATE INDEX idx_posts_mentions   ON posts USING GIN (mentions);
CREATE INDEX idx_posts_deleted_at ON posts (deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_posts_visibility ON posts (visibility);

CREATE TABLE IF NOT EXISTS post_likes (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (post_id, user_id)
);

CREATE INDEX idx_post_likes_post_id ON post_likes (post_id);
CREATE INDEX idx_post_likes_user_id ON post_likes (user_id);

CREATE TRIGGER posts_updated_at
    BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
