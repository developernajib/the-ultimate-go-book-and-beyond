-- Migration: 001_create_users
-- Creates the users table with presence tracking fields.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE user_status AS ENUM ('online', 'offline', 'away', 'busy');

CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    username      VARCHAR(50) NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    display_name  VARCHAR(100) NOT NULL DEFAULT '',
    avatar_url    TEXT        NOT NULL DEFAULT '',
    status        user_status NOT NULL DEFAULT 'offline',
    custom_status VARCHAR(150) NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ,
    deleted_at    TIMESTAMPTZ
);

-- Indexes for common lookup patterns
CREATE INDEX idx_users_username    ON users (username)    WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email       ON users (email)       WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status      ON users (status)      WHERE deleted_at IS NULL;
