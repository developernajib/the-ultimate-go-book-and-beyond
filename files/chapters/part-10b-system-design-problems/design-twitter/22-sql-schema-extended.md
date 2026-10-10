## SQL Schema: Extended

Beyond the core tweets, users, and follows tables, a production Twitter system needs schemas for notifications, direct messages, bookmarks, lists, mutes, and blocks. Each table is designed with specific indexing strategies for its primary access pattern. For example, the notifications table indexes by recipient and creation time because the most common query is "show me my recent notifications," while the blocks table indexes by blocked_id so the system can quickly check if a user is blocked before delivering content. The DM tables here are the full version of the sketch in the database schema section earlier in the chapter.

Watch the unique constraints as you read, because two of them are doing work that is easy to get subtly wrong. A UNIQUE on a pair of user IDs only deduplicates if the pair has a canonical order, and a dedupe key only survives Kafka redelivery if the key is derived from the event rather than generated per attempt.

```sql
-- Notifications table
CREATE TABLE notifications (
    id              BIGINT PRIMARY KEY,  -- Snowflake ID
    recipient_id    BIGINT NOT NULL,
    type            VARCHAR(20) NOT NULL,  -- 'mention', 'like', 'retweet', 'follow', 'reply'
    actor_id        BIGINT NOT NULL,
    tweet_id        BIGINT,
    text            VARCHAR(200),
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    dedupe_key      VARCHAR(100) NOT NULL,  -- e.g. 'like:{tweet_id}:{actor_id}'
    created_at      TIMESTAMP NOT NULL,

    -- Kafka is at-least-once, so the notification consumer will see the same
    -- like event twice. This constraint is what turns the replay into a
    -- rejected insert instead of a second buzz on someone's phone.
    UNIQUE KEY uq_dedupe (dedupe_key),
    INDEX idx_recipient (recipient_id, created_at DESC),
    INDEX idx_unread (recipient_id, is_read, created_at DESC)
);

-- DM conversations
CREATE TABLE dm_conversations (
    id              BIGINT PRIMARY KEY,
    participant_low  BIGINT NOT NULL,  -- always the smaller user id
    participant_high BIGINT NOT NULL,  -- always the larger user id
    last_message    TEXT,
    last_sender_id  BIGINT,
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    -- The pair must be stored in a canonical order. A plain
    -- UNIQUE (participant_1, participant_2) does not dedupe a conversation at
    -- all: (alice, bob) and (bob, alice) are different rows, so whoever
    -- messages first wins a conversation and the other direction silently opens
    -- a second one. The CHECK is what makes the UNIQUE mean what it looks like.
    CONSTRAINT ck_participant_order CHECK (participant_low < participant_high),
    UNIQUE KEY uq_participants (participant_low, participant_high),
    INDEX idx_participant_low (participant_low, updated_at DESC),
    INDEX idx_participant_high (participant_high, updated_at DESC)
);

-- Per-participant conversation state. Unread counts are per viewer, not per
-- conversation, so they cannot live on the row above.
CREATE TABLE dm_participant_state (
    conversation_id BIGINT NOT NULL,
    user_id         BIGINT NOT NULL,
    unread_count    INT NOT NULL DEFAULT 0,
    last_read_id    BIGINT,
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (conversation_id, user_id),
    INDEX idx_user_inbox (user_id, updated_at DESC)
);

-- DM messages (encrypted at rest)
CREATE TABLE dm_messages (
    id              BIGINT PRIMARY KEY,  -- Snowflake ID
    conversation_id BIGINT NOT NULL,
    sender_id       BIGINT NOT NULL,
    text            TEXT,
    media_url       VARCHAR(500),
    read_at         TIMESTAMP,
    created_at      TIMESTAMP NOT NULL,

    INDEX idx_conv_messages (conversation_id, id DESC),
    FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id)
);

-- Bookmarks
CREATE TABLE bookmarks (
    user_id     BIGINT NOT NULL,
    tweet_id    BIGINT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, tweet_id),
    INDEX idx_user_bookmarks (user_id, created_at DESC)
);

-- Lists
CREATE TABLE lists (
    id          BIGINT PRIMARY KEY,
    owner_id    BIGINT NOT NULL,
    name        VARCHAR(100) NOT NULL,
    description VARCHAR(200),
    is_private  BOOLEAN NOT NULL DEFAULT FALSE,
    member_count INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

    INDEX idx_owner_lists (owner_id, created_at DESC)
);

CREATE TABLE list_members (
    list_id     BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    added_at    TIMESTAMP NOT NULL DEFAULT NOW(),

    PRIMARY KEY (list_id, user_id),
    INDEX idx_user_memberships (user_id, added_at DESC)
);

-- Muted and blocked users
CREATE TABLE mutes (
    user_id     BIGINT NOT NULL,
    muted_id    BIGINT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, muted_id)
);

CREATE TABLE blocks (
    user_id     BIGINT NOT NULL,
    blocked_id  BIGINT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, blocked_id),
    INDEX idx_blocked (blocked_id)
);
```

---
