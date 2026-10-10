-- 001_initial.sql
-- Initial schema for url-shortener

CREATE TABLE IF NOT EXISTS urls (
    id          BIGSERIAL PRIMARY KEY,
    short_code  VARCHAR(20) NOT NULL UNIQUE,
    original_url TEXT NOT NULL,
    user_id     VARCHAR(255),
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls (short_code);
CREATE INDEX IF NOT EXISTS idx_urls_user_id    ON urls (user_id);
CREATE INDEX IF NOT EXISTS idx_urls_expires_at ON urls (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS analytics_events (
    id          BIGSERIAL PRIMARY KEY,
    short_code  VARCHAR(20) NOT NULL REFERENCES urls(short_code) ON DELETE CASCADE,
    ip_address  INET,
    user_agent  TEXT,
    referer     TEXT,
    country     VARCHAR(3),
    city        VARCHAR(255),
    device_type VARCHAR(50),
    browser     VARCHAR(100),
    os          VARCHAR(100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_short_code  ON analytics_events (short_code);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at  ON analytics_events (created_at);
