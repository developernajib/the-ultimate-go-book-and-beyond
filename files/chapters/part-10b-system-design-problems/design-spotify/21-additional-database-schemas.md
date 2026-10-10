## Additional Database Schemas

Beyond the core tables for tracks and playlists, a production platform needs schemas for royalty tracking, subscription payments, device management, podcast episodes, and social relationships. These tables support features routinely skipped in a first design but impossible to omit in a real one. As in the core schema, this is PostgreSQL, so indexes come after the table rather than inline.

The money tables carry the weight here, and three of their details are the whole point.

Amounts are `BIGINT` minor units, never `DECIMAL` and certainly never a float. `DECIMAL` at least computes exactly, so it is not the disaster a float is, but it invites application code to pull the value into a `float64` on the way through, and integers make that mistake impossible to write.

Payments store both what the customer was charged and what it converted to in the settlement currency. Summing a raw `amount` column across a multi-currency table adds euros to yen and produces a number that means nothing, which is a bug no test catches because the query runs fine and returns a plausible figure. The royalty pool is computed from `settled_usd_cents`, and `fx_rate_micros` stays on the row so the conversion is auditable rather than lost.

`royalty_records` has a UNIQUE constraint on `(track_id, period)`, not just an index. That constraint is what makes the monthly batch idempotent: it is the thing the `ON CONFLICT (track_id, period) DO NOTHING` in the royalty pipeline relies on, and without it a re-run pays every artist twice. Idempotency enforced by a database constraint survives a job running twice. Idempotency enforced by application logic does not.

```sql
-- One row per royalty batch run. Keeping the pool and the play total here makes
-- every per-track figure reproducible: rate is pool_cents / total_plays, and
-- storing that quotient instead would round away the evidence.
CREATE TABLE royalty_runs (
    period      VARCHAR(7) PRIMARY KEY,   -- YYYY-MM
    pool_cents  BIGINT NOT NULL,
    total_plays BIGINT NOT NULL,
    finalized_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Royalty records (monthly per track)
CREATE TABLE royalty_records (
    id           BIGSERIAL PRIMARY KEY,
    track_id     VARCHAR(36) NOT NULL,
    period       VARCHAR(7) NOT NULL REFERENCES royalty_runs (period),
    plays        BIGINT NOT NULL,
    amount_cents BIGINT NOT NULL,   -- integer minor units, never float
    label_id     VARCHAR(36),
    artist_id    VARCHAR(36),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The idempotency guarantee. A re-run of the batch conflicts here instead
    -- of inserting a second payment.
    CONSTRAINT uq_royalty_track_period UNIQUE (track_id, period)
);

CREATE INDEX idx_royalty_label_period ON royalty_records (label_id, period);

-- Subscription payments
CREATE TABLE subscription_payments (
    id                BIGSERIAL PRIMARY KEY,
    user_id           VARCHAR(36) NOT NULL,
    -- What the customer was actually charged, in their own currency.
    amount_cents      BIGINT NOT NULL,
    currency          CHAR(3) NOT NULL,
    -- The same payment converted to the settlement currency. The royalty pool
    -- sums this column. Summing amount_cents across currencies is meaningless.
    settled_usd_cents BIGINT NOT NULL,
    fx_rate_micros    BIGINT NOT NULL,   -- rate applied, kept for audit
    period            VARCHAR(7) NOT NULL,
    plan_type         VARCHAR(20) NOT NULL,  -- free, individual, family, student
    status            VARCHAR(20) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The royalty batch reads paid rows for one period and nothing else.
CREATE INDEX idx_payments_period ON subscription_payments (period)
    WHERE status = 'paid';

-- User devices for Spotify Connect
CREATE TABLE user_devices (
    user_id        VARCHAR(36) NOT NULL,
    device_id      VARCHAR(36) NOT NULL,
    device_name    VARCHAR(100),
    device_type    VARCHAR(20),   -- phone, tablet, computer, speaker, tv
    last_active_at TIMESTAMPTZ,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (user_id, device_id)
);

-- Podcast episodes
CREATE TABLE podcast_episodes (
    id           VARCHAR(36) PRIMARY KEY,
    podcast_id   VARCHAR(36) NOT NULL,
    title        VARCHAR(500) NOT NULL,
    description  TEXT,
    duration_ms  INT NOT NULL,  -- ms, not seconds: chapter offsets need it
    audio_url    TEXT,
    publish_date TIMESTAMPTZ,
    chapters     JSONB,         -- [{title, start_ms, end_ms}]
    transcript   TEXT,
    explicit     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_podcast_episodes ON podcast_episodes (podcast_id, publish_date DESC);

-- Social: following relationships
CREATE TABLE user_follows (
    follower_id  VARCHAR(36) NOT NULL,
    following_id VARCHAR(36) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- The PK serves "who does X follow". This serves the reverse, "who follows X".
CREATE INDEX idx_user_follows_reverse ON user_follows (following_id);
```


---
