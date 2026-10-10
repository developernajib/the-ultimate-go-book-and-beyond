-- 001_initial.sql
-- Initial schema for SaaS platform

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Plans
CREATE TABLE IF NOT EXISTS plans (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    VARCHAR(100) NOT NULL UNIQUE,
    display_name            VARCHAR(255) NOT NULL,
    description             TEXT,
    price_monthly           BIGINT NOT NULL DEFAULT 0,
    price_yearly            BIGINT NOT NULL DEFAULT 0,
    trial_days              INT NOT NULL DEFAULT 14,
    features                JSONB NOT NULL DEFAULT '{}',
    limits                  JSONB NOT NULL DEFAULT '{}',
    is_public               BOOLEAN NOT NULL DEFAULT TRUE,
    stripe_price_id_monthly VARCHAR(255),
    stripe_price_id_yearly  VARCHAR(255),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                VARCHAR(255) NOT NULL,
    slug                VARCHAR(100) NOT NULL UNIQUE,
    subdomain           VARCHAR(100) NOT NULL UNIQUE,
    custom_domain       VARCHAR(255),
    status              VARCHAR(50) NOT NULL DEFAULT 'provisioning',
    isolation_strategy  VARCHAR(50) NOT NULL DEFAULT 'shared_schema',
    plan_id             UUID NOT NULL REFERENCES plans(id),
    subscription_id     VARCHAR(255),
    trial_ends_at       TIMESTAMPTZ,
    billing_email       VARCHAR(255) NOT NULL,
    settings            JSONB NOT NULL DEFAULT '{}',
    branding            JSONB NOT NULL DEFAULT '{}',
    features            JSONB NOT NULL DEFAULT '{}',
    metadata            JSONB NOT NULL DEFAULT '{}',
    database_host       VARCHAR(255),
    database_name       VARCHAR(255),
    database_user       VARCHAR(255),
    database_password   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug         ON tenants (slug);
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain    ON tenants (subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants (custom_domain) WHERE custom_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_status       ON tenants (status);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email               VARCHAR(255) NOT NULL,
    email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash       TEXT,
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    avatar_url          TEXT,
    role                VARCHAR(50) NOT NULL DEFAULT 'member',
    permissions         TEXT[] NOT NULL DEFAULT '{}',
    mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret          TEXT,
    sso_provider        VARCHAR(50),
    sso_external_id     VARCHAR(255),
    status              VARCHAR(50) NOT NULL DEFAULT 'active',
    last_login_at       TIMESTAMPTZ,
    last_login_ip       INET,
    invited_by          UUID REFERENCES users(id),
    invited_at          TIMESTAMPTZ,
    invite_accepted_at  TIMESTAMPTZ,
    metadata            JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id   ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_status      ON users (status);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    refresh_token TEXT NOT NULL UNIQUE,
    device_info   TEXT,
    ip_address    INET,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id       ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions (refresh_token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at    ON sessions (expires_at);
