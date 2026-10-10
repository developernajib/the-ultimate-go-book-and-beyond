-- Migration: 000001_create_users (up)
-- Creates the users table and user_settings table.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(30) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    bio             TEXT,
    avatar_url      TEXT,
    cover_url       TEXT,
    location        VARCHAR(100),
    website         VARCHAR(255),
    birth_date      DATE,
    is_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
    is_private      BOOLEAN     NOT NULL DEFAULT FALSE,
    follower_count  INTEGER     NOT NULL DEFAULT 0,
    following_count INTEGER     NOT NULL DEFAULT 0,
    post_count      INTEGER     NOT NULL DEFAULT 0,
    last_seen_at    TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_username   ON users (username);
CREATE INDEX idx_users_email      ON users (email);
CREATE INDEX idx_users_deleted_at ON users (deleted_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_settings (
    user_id              UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    privacy_level        VARCHAR(20) NOT NULL DEFAULT 'public',
    allow_mentions       BOOLEAN     NOT NULL DEFAULT TRUE,
    allow_dms            BOOLEAN     NOT NULL DEFAULT TRUE,
    show_activity        BOOLEAN     NOT NULL DEFAULT TRUE,
    email_notifications  BOOLEAN     NOT NULL DEFAULT TRUE,
    push_notifications   BOOLEAN     NOT NULL DEFAULT TRUE,
    language             VARCHAR(10) NOT NULL DEFAULT 'en',
    timezone             VARCHAR(50) NOT NULL DEFAULT 'UTC',
    theme                VARCHAR(20) NOT NULL DEFAULT 'light',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER user_settings_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
