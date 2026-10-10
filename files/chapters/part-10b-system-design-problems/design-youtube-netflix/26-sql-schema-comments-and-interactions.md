## SQL Schema: Comments and Interactions

Comments, likes, and playlists form the social layer. Comments shard by `video_id`, so every comment on a video lives together and rendering a video page hits one shard. Playlists shard by `user_id`, so a user's library is co-located. The comments table supports threaded replies via `parent_id`, pinned comments, and creator hearts. The moderation log records automated and human decisions alike, giving you the audit trail you will want the first time a removal is disputed.

This is MySQL, the same dialect as the main schema, and it is worth being explicit because mixing dialects is the most common way a schema in a design document turns out to have never been run. `JSONB` and partial indexes (`CREATE INDEX ... WHERE`) are PostgreSQL. MySQL rejects the first with `Unknown data type: 'JSONB'` and the second with a syntax error. MySQL's type is `JSON`, and the closest thing to a partial index is an index on a generated column. Pick one database and write its dialect.

Two consequences of sharding are visible in the DDL below and worth saying out loud, since interviewers ask. Foreign keys do not span shards: `comments` and `videos` shard on the same key so the reference is local, but the moment two tables shard differently, the constraint has to move into application code. And `comments.id` alone is not routable: given only a comment ID you cannot tell which shard holds it, which is why comment permalinks on real platforms always carry the video ID too.

```sql
-- Comments table (sharded by video_id for locality)
CREATE TABLE comments (
    id              VARCHAR(36) PRIMARY KEY,
    video_id        VARCHAR(36) NOT NULL,
    user_id         VARCHAR(36) NOT NULL,
    parent_id       VARCHAR(36),           -- NULL for top-level comments
    text            TEXT NOT NULL,
    like_count      INT NOT NULL DEFAULT 0,
    reply_count     INT NOT NULL DEFAULT 0,
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    is_heart        BOOLEAN NOT NULL DEFAULT FALSE,  -- creator heart
    status          VARCHAR(20) NOT NULL DEFAULT 'visible',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_video_comments (video_id, is_pinned DESC, like_count DESC, created_at DESC),
    INDEX idx_replies (parent_id, created_at ASC),
    INDEX idx_user_comments (user_id, created_at DESC),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Likes table (deduplicated by unique constraint)
CREATE TABLE video_likes (
    user_id     VARCHAR(36) NOT NULL,
    video_id    VARCHAR(36) NOT NULL,
    is_like     BOOLEAN NOT NULL,    -- TRUE = like, FALSE = dislike
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, video_id),
    INDEX idx_video_likes (video_id, is_like, created_at DESC),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Playlists
CREATE TABLE playlists (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    title       VARCHAR(200) NOT NULL,
    description TEXT,
    visibility  VARCHAR(20) NOT NULL DEFAULT 'private',
    video_count INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_playlists (user_id, updated_at DESC)
);

CREATE TABLE playlist_items (
    playlist_id VARCHAR(36) NOT NULL,
    video_id    VARCHAR(36) NOT NULL,
    position    INT NOT NULL,
    added_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (playlist_id, video_id),
    INDEX idx_playlist_order (playlist_id, position),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

-- Channel follows are defined once, in the main database schema section of this
-- chapter. Defining them again here with a different table name would give you
-- two tables meaning the same thing, which is how a user ends up subscribed
-- according to one service and not according to another. The one column this
-- section needs is the notification level, so it belongs on that table:
--
--   ALTER TABLE channel_follows
--     ADD COLUMN notification_level VARCHAR(20) NOT NULL DEFAULT 'default';
--     -- 'all', 'default', 'none'

-- Content moderation log. The audit trail: what we decided, why, how sure we
-- were, and whether a human was involved.
CREATE TABLE moderation_log (
    id          VARCHAR(36) PRIMARY KEY,
    video_id    VARCHAR(36) NOT NULL,
    -- These values match the pipeline's verdicts exactly. Letting the log speak
    -- a different vocabulary than the code that writes it makes every later
    -- question ("how many videos did we auto-remove last week?") a translation
    -- exercise nobody gets right twice.
    action      VARCHAR(20) NOT NULL,  -- 'approved', 'flagged', 'rejected', 'age_restricted'
    reason      VARCHAR(100),          -- the label that drove the verdict
    -- DECIMAL, not FLOAT. This value is evidence in an appeal, and it should
    -- read back exactly as it was written.
    confidence  DECIMAL(5,4),
    labels      JSON,                  -- MySQL's type. JSONB is PostgreSQL.
    reviewer_id VARCHAR(36),           -- NULL for automated, set for human review
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_video_moderation (video_id, created_at DESC),
    -- MySQL has no partial indexes. The PostgreSQL form,
    --   INDEX idx_pending_review (action, created_at) WHERE action = 'flagged'
    -- is a syntax error here. Leading with `action` gets the review queue what
    -- it needs from a plain composite index.
    INDEX idx_pending_review (action, created_at)
);
```

---
