## Database Schema

The database schema is the foundation of the entire system. Tweets are sharded by user_id so that all of a single user's tweets live on the same shard, making timeline queries fast.

The follow graph needs more care than it first appears. A single table sharded by follower_id answers "who does this user follow?" from one shard, but "who follows this user?" then has to ask all 256 shards and union the results. That second question is exactly what the fan-out worker asks on every tweet, so a scatter-gather there would put the whole write path on the slowest shard in the fleet. The fix is to store each edge twice, once in each direction, and shard each copy by the ID it is queried on. The cost is a write that must touch two shards and a reconciliation job to repair drift, which is the trade the read pattern demands.

Composite primary keys carry real weight here. `PRIMARY KEY (follower_id, following_id)` is what makes a duplicate follow a no-op rather than a second edge, and `PRIMARY KEY (user_id, tweet_id)` on likes is what makes a double-tap fail to insert instead of incrementing the counter twice. Likes, hashtags, and media are stored in separate tables to keep each table focused and independently scalable.

```sql
-- tweets table - sharded by user_id % N for write scalability
CREATE TABLE tweets (
    id              BIGINT PRIMARY KEY,          -- Snowflake ID (time-ordered)
    user_id         BIGINT NOT NULL,
    text            VARCHAR(280),
    retweet_id      BIGINT,                      -- NULL for original tweets
    reply_to_id     BIGINT,                      -- NULL for top-level tweets
    quote_tweet_id  BIGINT,
    like_count      INT NOT NULL DEFAULT 0,
    retweet_count   INT NOT NULL DEFAULT 0,
    reply_count     INT NOT NULL DEFAULT 0,
    lang            CHAR(5),                     -- detected language code
    is_sensitive    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL,
    deleted_at      TIMESTAMP,                   -- soft delete

    INDEX idx_user_timeline (user_id, id DESC),  -- timeline queries
    INDEX idx_reply_thread  (reply_to_id, id)    -- thread loading
);
-- Shard key: user_id % 256 → route to one of 256 MySQL shards
--
-- No foreign keys on retweet_id / reply_to_id / quote_tweet_id. The parent
-- tweet is keyed by its own author's user_id, so it almost always lives on a
-- different shard, and MySQL cannot enforce a constraint across shards. The
-- application validates the parent on write and the hydration path treats a
-- missing parent as a deleted tweet.

-- users table
CREATE TABLE users (
    id              BIGINT PRIMARY KEY,          -- Snowflake ID
    username        VARCHAR(50) NOT NULL UNIQUE,
    display_name    VARCHAR(100),
    bio             VARCHAR(160),
    avatar_url      VARCHAR(500),
    header_url      VARCHAR(500),
    location        VARCHAR(100),
    website         VARCHAR(255),
    follower_count  INT NOT NULL DEFAULT 0,
    following_count INT NOT NULL DEFAULT 0,
    tweet_count     INT NOT NULL DEFAULT 0,
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    is_protected    BOOLEAN NOT NULL DEFAULT FALSE,  -- private account
    created_at      TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL
    -- No separate index on username: the UNIQUE constraint already builds one.
);

-- follows graph
-- Stored twice, once per direction, because the two questions shard differently.
-- "Who does X follow?" shards by follower_id. "Who follows X?" shards by
-- following_id, and that is the fan-out hot path, so it must not scatter-gather
-- across every shard. The application writes both rows in one transaction when
-- both land on the same shard, and repairs any drift with a reconciliation job
-- when they do not.
CREATE TABLE follows (
    follower_id  BIGINT NOT NULL,   -- shard key
    following_id BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (follower_id, following_id)  -- makes a repeated follow a no-op
);

CREATE TABLE followers (
    following_id BIGINT NOT NULL,   -- shard key
    follower_id  BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (following_id, follower_id)
);

-- likes
CREATE TABLE likes (
    user_id     BIGINT NOT NULL,
    tweet_id    BIGINT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, tweet_id),  -- double-tap inserts nothing, so counters stay honest
    INDEX idx_tweet_likes (tweet_id, created_at DESC)
);

-- hashtag index - for trending computation and search
CREATE TABLE hashtags (
    tweet_id    BIGINT NOT NULL,
    tag         VARCHAR(100) NOT NULL,
    created_at  TIMESTAMP NOT NULL,

    PRIMARY KEY (tweet_id, tag),
    INDEX idx_tag_time (tag, created_at DESC)  -- "tweets with #golang since X"
);

-- media attachments
CREATE TABLE tweet_media (
    id          VARCHAR(36) PRIMARY KEY,
    tweet_id    BIGINT NOT NULL,
    media_type  VARCHAR(10) NOT NULL,  -- 'image', 'video', 'gif'
    s3_key      VARCHAR(500) NOT NULL,
    cdn_url     VARCHAR(500) NOT NULL,
    width       INT,
    height      INT,
    duration_ms INT,                   -- for video/gif
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

    INDEX idx_tweet_media (tweet_id)
);

-- direct messages - stored separately, encrypted at rest
CREATE TABLE direct_messages (
    conversation_id BIGINT NOT NULL,
    message_id      BIGINT NOT NULL,  -- Snowflake ID
    sender_id       BIGINT NOT NULL,
    text            TEXT,
    is_encrypted    BOOLEAN NOT NULL DEFAULT TRUE,
    sent_at         TIMESTAMP NOT NULL,
    read_at         TIMESTAMP,

    PRIMARY KEY (conversation_id, message_id),
    INDEX idx_sender (sender_id, sent_at DESC)
);
```

---
