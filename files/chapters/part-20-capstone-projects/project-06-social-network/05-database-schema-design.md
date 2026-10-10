## Database Schema Design

The database schema is the foundation of any social network. Every table must be designed to handle high read and write throughput while maintaining data integrity through proper constraints and indexes. We use PostgreSQL as the primary relational store because it supports advanced features like array columns for hashtags, GIN indexes for efficient array searching, and reliable transaction handling. The schema below is split across multiple migration files so that changes can be applied incrementally in production without downtime.

### PostgreSQL Schema

The schema defines users, posts, comments, likes, followers, and notifications tables with proper foreign key constraints, indexes on frequently queried columns, and `created_at`/`updated_at` timestamps on every table.

```sql
-- migrations/001_create_users.sql

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    cover_url TEXT,
    location VARCHAR(100),
    website VARCHAR(255),
    birth_date DATE,
    is_verified BOOLEAN DEFAULT FALSE,
    is_private BOOLEAN DEFAULT FALSE,
    follower_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    post_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT username_length CHECK (char_length(username) >= 3),
    CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at DESC);
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NULL;

-- User settings
CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    privacy_level VARCHAR(20) DEFAULT 'public',
    allow_mentions BOOLEAN DEFAULT TRUE,
    allow_dms BOOLEAN DEFAULT TRUE,
    show_activity BOOLEAN DEFAULT TRUE,
    email_notifications BOOLEAN DEFAULT TRUE,
    push_notifications BOOLEAN DEFAULT TRUE,
    language VARCHAR(10) DEFAULT 'en',
    timezone VARCHAR(50) DEFAULT 'UTC',
    theme VARCHAR(20) DEFAULT 'light',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- migrations/002_create_follows.sql

-- Follows (social graph in PostgreSQL for backup/analytics)
CREATE TABLE follows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(follower_id, followee_id),
    CONSTRAINT no_self_follow CHECK (follower_id != followee_id)
);

CREATE INDEX idx_follows_follower ON follows(follower_id, created_at DESC);
CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);
CREATE INDEX idx_follows_created_at ON follows(created_at DESC);

-- Follow requests (for private accounts)
CREATE TABLE follow_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requestee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(requester_id, requestee_id)
);

CREATE INDEX idx_follow_requests_requestee ON follow_requests(requestee_id, status);

-- migrations/003_create_posts.sql

-- Posts
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    media_urls TEXT[], -- Array of media URLs
    media_types VARCHAR(20)[], -- image, video, gif
    hashtags TEXT[], -- Extracted hashtags
    mentions UUID[], -- User IDs mentioned
    reply_to_id UUID REFERENCES posts(id) ON DELETE SET NULL,
    repost_of_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    visibility VARCHAR(20) DEFAULT 'public', -- public, followers, private
    like_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    repost_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT content_not_empty CHECK (
        char_length(content) > 0 OR
        array_length(media_urls, 1) > 0 OR
        repost_of_id IS NOT NULL
    ),
    CONSTRAINT content_length CHECK (char_length(content) <= 280)
);

CREATE INDEX idx_posts_user_id ON posts(user_id, created_at DESC);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_reply_to ON posts(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX idx_posts_hashtags ON posts USING GIN(hashtags);
CREATE INDEX idx_posts_mentions ON posts USING GIN(mentions);
CREATE INDEX idx_posts_deleted_at ON posts(deleted_at) WHERE deleted_at IS NULL;

-- Post likes
CREATE TABLE post_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(post_id, user_id)
);

CREATE INDEX idx_post_likes_post ON post_likes(post_id, created_at DESC);
CREATE INDEX idx_post_likes_user ON post_likes(user_id, created_at DESC);

-- Comments (stored as posts with reply_to_id, but also tracked separately)
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_comments_post ON comments(post_id, created_at DESC);

-- migrations/004_create_feeds.sql

-- Feed entries (pre-computed feeds for fan-out on write)
CREATE TABLE feed_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    post_author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rank_score DOUBLE PRECISION DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(user_id, post_id)
);

CREATE INDEX idx_feed_entries_user ON feed_entries(user_id, rank_score DESC, created_at DESC);
CREATE INDEX idx_feed_entries_created_at ON feed_entries(created_at DESC);

-- Partitioning by user_id for scalability (example for user_id hash)
-- CREATE TABLE feed_entries_0 PARTITION OF feed_entries
--     FOR VALUES WITH (MODULUS 10, REMAINDER 0);

-- migrations/005_create_notifications.sql

-- Notifications
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- like, comment, follow, mention, repost
    entity_type VARCHAR(50), -- post, user, comment
    entity_id UUID,
    message TEXT,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    read_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- migrations/006_create_media.sql

-- Media metadata
CREATE TABLE media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_url TEXT NOT NULL,
    thumbnail_url TEXT,
    medium_url TEXT,
    large_url TEXT,
    media_type VARCHAR(20) NOT NULL, -- image, video, gif
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_seconds INTEGER, -- for videos
    blurhash VARCHAR(100), -- for progressive loading
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_media_user ON media(user_id, created_at DESC);

-- migrations/007_create_hashtags.sql

-- Hashtags (for trending)
CREATE TABLE hashtags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tag VARCHAR(100) UNIQUE NOT NULL,
    post_count INTEGER DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_hashtags_tag ON hashtags(tag);
CREATE INDEX idx_hashtags_trending ON hashtags(post_count DESC, last_used_at DESC);

-- Hashtag usage
CREATE TABLE hashtag_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(hashtag_id, post_id)
);

CREATE INDEX idx_hashtag_usage_hashtag ON hashtag_usage(hashtag_id, created_at DESC);

-- migrations/008_create_sessions.sql

-- Sessions (for authentication)
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- migrations/009_create_blocks.sql

-- Blocks (user blocking)
CREATE TABLE blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX idx_blocks_blocked ON blocks(blocked_id);

-- migrations/010_create_functions.sql

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_posts_updated_at BEFORE UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to increment counters atomically
CREATE OR REPLACE FUNCTION increment_user_followers(user_uuid UUID, delta INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE users SET follower_count = follower_count + delta WHERE id = user_uuid;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_user_following(user_uuid UUID, delta INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE users SET following_count = following_count + delta WHERE id = user_uuid;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_post_likes(post_uuid UUID, delta INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE posts SET like_count = like_count + delta WHERE id = post_uuid;
END;
$$ LANGUAGE plpgsql;
```

### Neo4j Schema (Social Graph)

Neo4j stores users as nodes and follow relationships as edges between those nodes. Unlike relational databases where you need expensive JOIN operations to traverse relationships, Neo4j can follow edges in constant time. The schema below defines uniqueness constraints and indexes that ensure fast lookups when querying the social graph.

```cypher
// Create constraints
CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE INDEX user_username IF NOT EXISTS FOR (u:User) ON (u.username);

// Create indexes for performance
CREATE INDEX follow_created_at IF NOT EXISTS FOR ()-[f:FOLLOWS]-() ON (f.created_at);

// Example user node
// CREATE (u:User {
//     id: 'uuid',
//     username: 'johndoe',
//     created_at: datetime()
// })

// Example follow relationship
// MATCH (follower:User {id: $follower_id})
// MATCH (followee:User {id: $followee_id})
// CREATE (follower)-[f:FOLLOWS {created_at: datetime()}]->(followee)
```

### Junior → FAANG: Schema Design for a Social Network

The social network schema has two hard design problems: representing the follower relationship (who follows whom) and representing post engagement (likes, comments, shares). Both are high-volume, many-to-many relationships.

The followers table (follower_id, followee_id, created_at) with composite primary key (follower_id, followee_id) is the correct relational representation. The two indexes needed are: (follower_id, followee_id) for "does user A follow user B" lookups, and (followee_id, created_at DESC) for "who are the recent followers of user B" queries. Know why both indexes are needed and which queries they serve.

Counters (follower_count, following_count on the users table) are denormalized data that must stay synchronized with the followers table. When a follow relationship is added, the counts must be incremented atomically. The recommended approach is a PostgreSQL function triggered on insert/delete to the followers table, or an optimistic counter with periodic reconciliation.

### Senior @ FAANG: Schema Design as a Long-Term Commitment

At senior level, the schema for a social network has temporal query implications that are not obvious from the initial design. Users typically want to see their feed in chronological order for recent posts and ranked order for older posts. Supporting both requires either storing a denormalized feed table (pre-sorted by some combination of recency and engagement) or computing rankings at query time (expensive).

The hashtag schema (stored as a PostgreSQL array with GIN index) is efficient for "find posts with hashtag X" queries but expensive for "what are the trending hashtags" queries. Trending hashtag computation requires either a separate materialized view (maintained by a background job) or a separate counter store (Redis sorted set with hashtag as key and post count as score). The schema ADR should document which approach is chosen and why.

Soft delete consistency is particularly important for social networks where GDPR right-to-erasure requirements mandate that deleted user data is actually removed. Soft deletes (is_deleted flag) satisfy operational requirements (can recover from accidental deletion) but do not satisfy GDPR requirements (data is still in the database). A separate "tombstone" table (recording that a user was deleted and when) combined with actual row deletion satisfies both requirements.

---
