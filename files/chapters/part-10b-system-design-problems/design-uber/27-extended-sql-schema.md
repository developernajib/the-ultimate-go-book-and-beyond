## Extended SQL Schema

This schema covers the additional tables needed for a full-featured ride-sharing platform: payment methods so riders can store multiple cards, per-city ride type configuration so pricing can vary by market, and safety incidents for the trust and safety team.

`ride_type_config` deserves attention because it is where the fare model actually lives. The core components section hardcodes a `fareRates` map in Go, which is fine for illustrating the arithmetic and wrong for a platform in 70 countries: pricing in New York has nothing to do with pricing in a smaller market, and a rate change should be a config update, not a deploy. Treat the Go map as a stand-in for a cached read of this table.

Two things it must get right that the Go map quietly assumed away. `currency_exponent` records how many minor units make one major unit, because "cents" is not universal: JPY has an exponent of 0, so ¥500 is stored as `500`, while most currencies use 2 and a few use 3. Hardcode 100 and a Tokyo fare is off by 100x. And `per_minute_rate_cents` exists here but nothing in the pricing code uses duration, which is a real gap rather than an oversight to paper over: fares that ignore time undercharge the driver stuck in traffic, which is exactly when their costs are highest.

```sql
-- Rider payment methods
CREATE TABLE payment_methods (
    id              VARCHAR(36) PRIMARY KEY,
    rider_id        VARCHAR(36) NOT NULL,
    type            VARCHAR(20) NOT NULL,  -- 'card', 'paypal', 'apple_pay'
    -- PCI-DSS: last four and brand are the only card data that may be stored.
    -- The PAN never touches this database. stripe_pm_id is a token that is
    -- useless to an attacker without our API credentials, which is the point.
    last_four       CHAR(4),
    brand           VARCHAR(20),           -- 'visa', 'mastercard'
    stripe_pm_id    VARCHAR(100) NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (rider_id) REFERENCES riders(id)
);

CREATE INDEX idx_pm_rider ON payment_methods (rider_id);

-- "Default" means exactly one. A plain boolean lets a rider accumulate three
-- defaults, and then "charge the default card" silently depends on row order.
CREATE UNIQUE INDEX uniq_rider_default_pm
    ON payment_methods (rider_id)
    WHERE is_default;

-- Ride types configuration per city
CREATE TABLE ride_type_config (
    city_id              VARCHAR(36) NOT NULL,
    ride_type            VARCHAR(20) NOT NULL,
    base_fare_cents      BIGINT NOT NULL,
    per_km_rate_cents    BIGINT NOT NULL,
    per_minute_rate_cents BIGINT NOT NULL,
    minimum_fare_cents   BIGINT NOT NULL,
    surge_cap            DECIMAL(4,2) NOT NULL DEFAULT 3.0,
    currency             CHAR(3) NOT NULL,
    -- Minor units per major unit: 2 for USD/EUR, 0 for JPY/KRW, 3 for KWD/BHD.
    -- Store it, never assume it.
    currency_exponent    SMALLINT NOT NULL DEFAULT 2,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (city_id, ride_type),
    CONSTRAINT sane_exponent CHECK (currency_exponent IN (0, 2, 3)),
    CONSTRAINT sane_surge_cap CHECK (surge_cap >= 1.0),
    CONSTRAINT nonneg_rates CHECK (
        base_fare_cents >= 0 AND per_km_rate_cents >= 0 AND
        per_minute_rate_cents >= 0 AND minimum_fare_cents >= 0
    )
);

-- Safety incidents
CREATE TABLE safety_incidents (
    id              VARCHAR(36) PRIMARY KEY,
    trip_id         VARCHAR(36),
    reporter_id     VARCHAR(36) NOT NULL,
    reporter_type   VARCHAR(10) NOT NULL CHECK (reporter_type IN ('rider', 'driver')),
    incident_type   VARCHAR(50) NOT NULL,
    description     TEXT,
    -- Panic button recording. This is among the most sensitive data the company
    -- holds: encrypted at rest, access audited, short retention, and served
    -- only through short-lived signed URLs. A bare public object URL here would
    -- be a catastrophic and entirely ordinary mistake.
    audio_url       TEXT,
    location_lat    DECIMAL(10,7),
    location_lng    DECIMAL(10,7),
    status          VARCHAR(20) NOT NULL DEFAULT 'reported',
    priority        VARCHAR(10) NOT NULL DEFAULT 'high',
    assigned_to     VARCHAR(36),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,

    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE INDEX idx_incidents_trip ON safety_incidents (trip_id);

-- Open incidents are a live queue, so the index covers only them.
CREATE INDEX idx_incidents_open ON safety_incidents (priority, created_at)
    WHERE status != 'resolved';
```

One caution on `safety_incidents`. Retention rules that are correct for trip data are wrong here in both directions: this data is sensitive enough to demand aggressive minimization, and it is also evidence in matters where a legal hold overrides any deletion schedule. That tension is not something to resolve in a schema comment. It is a conversation with legal, and the schema should make the outcome explicit rather than letting a generic 90-day cleanup job decide by default.

---
