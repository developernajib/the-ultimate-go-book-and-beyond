## Database Schema

The database schema below covers the core entities of a video streaming platform: videos, users, subscriptions, watch history, recommendations, and tags. In production, video metadata lives in sharded MySQL (or Google Spanner) for strong consistency on writes, while watch history goes into Cassandra or Bigtable for high-throughput time-series writes. YouTube's own answer to the sharded-MySQL problem is public: Vitess, which they built to scale MySQL horizontally and later open-sourced. The DDL below is MySQL, so it uses MySQL's inline `INDEX` and `FULLTEXT` syntax, which will not run on PostgreSQL unchanged.

Two conventions in this schema are worth stating before you read it. Object storage locations are stored as **keys, not URLs**. A row holding `https://cdn.example.com/videos/v123/master.m3u8` welds your current CDN vendor into hundreds of millions of rows, and changing CDN then means rewriting the table. Store `videos/v123/master.m3u8` and let the serving layer prepend whichever base URL is live. Second, every `updated_at` carries `ON UPDATE CURRENT_TIMESTAMP`. Without it, MySQL sets the column once on insert and never touches it again, so the field that your cache invalidation and your incremental ETL both depend on quietly stays frozen at creation time.

```sql
-- Videos table - core metadata
CREATE TABLE videos (
    id              VARCHAR(36) PRIMARY KEY,
    uploader_id     VARCHAR(36) NOT NULL,
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    duration_secs   INT,
    status          VARCHAR(20) NOT NULL,  -- uploading, processing, ready, failed, removed
    visibility      VARCHAR(20) NOT NULL DEFAULT 'public',  -- public, unlisted, private
    category        VARCHAR(50),
    raw_key         VARCHAR(500),          -- raw/{video_id}/original
    master_key      VARCHAR(500),          -- videos/{video_id}/master.m3u8
    thumbnail_key   VARCHAR(500),          -- videos/{video_id}/thumb_0.jpg
    view_count      BIGINT NOT NULL DEFAULT 0,
    like_count      INT NOT NULL DEFAULT 0,
    dislike_count   INT NOT NULL DEFAULT 0,
    comment_count   INT NOT NULL DEFAULT 0,
    published_at    TIMESTAMP NULL DEFAULT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_uploader  (uploader_id, published_at DESC),
    INDEX idx_status    (status),
    INDEX idx_category  (category, view_count DESC),
    FULLTEXT idx_search (title, description)  -- fallback only, see below
);
-- The FULLTEXT index is a convenience for small deployments and a trap at scale.
-- Search runs on Elasticsearch (see the video search service later in this
-- chapter). Keeping a FULLTEXT index on a sharded, write-hot table costs you on
-- every insert and still cannot do relevance tuning, synonyms, or typo tolerance.
-- Ship it in v1, drop it when Elasticsearch lands.

-- published_at is deliberately NULL until the video is actually published. A
-- default of NOW() would claim every uploading, processing, and failed video was
-- published the moment it was created.

-- Video quality variants - one row per rung per video. A row exists here only
-- once the transcoder has actually written that rung to object storage, which is
-- what stops the player from being offered a quality level that 404s.
CREATE TABLE video_variants (
    id          VARCHAR(36) PRIMARY KEY,
    video_id    VARCHAR(36) NOT NULL,
    quality     VARCHAR(10) NOT NULL,  -- '4k', '1080p', '720p', '480p', '360p', '240p'
    width       INT NOT NULL,
    height      INT NOT NULL,
    bitrate_kbps INT NOT NULL,          -- advertised BANDWIDTH, video + audio
    codec       VARCHAR(20) NOT NULL,   -- RFC 6381 string, e.g. 'avc1.640028'
    playlist_key VARCHAR(500) NOT NULL, -- videos/{video_id}/{quality}/index.m3u8
    size_bytes  BIGINT,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    UNIQUE KEY  uk_video_quality (video_id, quality)
);

-- Users table
CREATE TABLE users (
    id                  VARCHAR(36) PRIMARY KEY,
    username            VARCHAR(50) NOT NULL UNIQUE,
    email               VARCHAR(255) NOT NULL UNIQUE,
    display_name        VARCHAR(100),
    avatar_key          VARCHAR(500),
    -- Denormalized follower count. The source of truth is channel_follows, and
    -- this column is maintained asynchronously, so it will lag under load. That
    -- is a deliberate trade: nobody churns over a follower count that is a few
    -- seconds stale, but everybody notices a channel page that takes 4 seconds
    -- to COUNT(*) over 50 million rows.
    follower_count      INT NOT NULL DEFAULT 0,
    -- Plan tier lives in plan_subscriptions, not here. Two places to write the
    -- same fact is two places to disagree about whether someone can watch 4K.
    country_code        CHAR(2),
    preferred_language  VARCHAR(10) DEFAULT 'en',
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Channel follows (the YouTube sense of "subscribe"). This table is only about
-- one user following one channel.
--
-- The original version of this table tried to be both this and the Netflix
-- billing relationship at once, with a nullable channel_id meaning "this row is
-- a platform subscription instead". That does not work, and the reason is worth
-- internalizing: MySQL's UNIQUE allows unlimited NULLs, so uk_sub would not stop
-- a user from accumulating any number of platform subscriptions. A column whose
-- NULL-ness changes what the row means is a union type smuggled into a schema,
-- and every query against it has to know the secret.
CREATE TABLE channel_follows (
    subscriber_id   VARCHAR(36) NOT NULL,
    channel_id      VARCHAR(36) NOT NULL,
    -- Drives the notification fan-out. 'all' is YouTube's bell.
    notification_level VARCHAR(20) NOT NULL DEFAULT 'default', -- 'all', 'default', 'none'
    followed_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (subscriber_id, channel_id),
    INDEX idx_channel (channel_id, followed_at DESC)
);

-- Platform subscription (the Netflix sense). One active plan per account, which
-- the schema now actually enforces rather than merely hoping for.
CREATE TABLE plan_subscriptions (
    user_id         VARCHAR(36) PRIMARY KEY,
    plan            VARCHAR(20) NOT NULL,   -- 'standard', 'premium', '4k'
    status          VARCHAR(20) NOT NULL,   -- 'active', 'past_due', 'cancelled'
    -- Money is stored in integer minor units. Never float: 0.1 + 0.2 != 0.3 in
    -- binary floating point, and a rounding error that reaches a customer's
    -- statement is not a rounding error any more, it is a billing incident.
    price_cents     INT NOT NULL,
    currency        CHAR(3) NOT NULL,       -- ISO 4217
    started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    renews_at       TIMESTAMP NULL DEFAULT NULL,
    expires_at      TIMESTAMP NULL DEFAULT NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_status_renewal (status, renews_at)
);

-- Watch history - time-series, use Cassandra/Bigtable in production
-- Here shown as MySQL for illustration
CREATE TABLE watch_history (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) NOT NULL,
    video_id        VARCHAR(36) NOT NULL,
    watch_duration_secs INT NOT NULL DEFAULT 0,
    position_secs   INT NOT NULL DEFAULT 0,   -- resume point
    completed       BOOLEAN NOT NULL DEFAULT FALSE,
    watched_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_user_history  (user_id, watched_at DESC),
    INDEX idx_video_views   (video_id, watched_at DESC)
);

-- Recommendations cache - pre-computed per user, refreshed periodically.
-- predicted_watch_secs is the ranker's output, in seconds, matching the two-stage
-- engine in this chapter. Naming it "score" invites the next engineer to write a
-- different model that emits a click probability and store it in the same column,
-- after which the ordering silently mixes two incomparable units.
CREATE TABLE recommendations (
    user_id     VARCHAR(36) NOT NULL,
    video_id    VARCHAR(36) NOT NULL,
    predicted_watch_secs FLOAT NOT NULL,
    source      VARCHAR(20) NOT NULL,  -- 'collaborative', 'content', 'trending'
    position    INT NOT NULL,          -- rank 1-20
    generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  TIMESTAMP NOT NULL,

    PRIMARY KEY (user_id, video_id),
    INDEX idx_user_recs (user_id, position)
);

-- Video tags (many-to-many)
CREATE TABLE video_tags (
    video_id    VARCHAR(36) NOT NULL,
    tag         VARCHAR(50) NOT NULL,
    PRIMARY KEY (video_id, tag),
    INDEX idx_tag (tag)
);
```

---
