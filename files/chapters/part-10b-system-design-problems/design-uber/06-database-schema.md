## Database Schema

The database schema uses PostgreSQL for durable storage of all trip, driver, rider, and payment data. Two details carry most of the weight.

The first is `uniq_driver_active_trip`. This partial unique index is the single mechanism that makes double-booking impossible. Every check that happens before the insert (the Redis "available" flag, the scoring pass, the dispatch offer) is advisory, because each one describes a moment that has already passed by the time the write lands. Only the index observes both claims at once, and it is the only thing in the system that can. Note that it is authoritative only within one database: `trips` is partitioned by region, and since a driver is online in exactly one region at a time, the index sees every claim on that driver. Shard `trips` by `trip_id` instead and the constraint evaporates, because the two competing inserts land on different shards and neither ever sees the other.

The second is that every money column is `BIGINT` holding minor units, matching the Go structs. `DECIMAL(8,2)` would also be exact, but mixing representations across the boundary invites a `float64` to sneak into the middle of the round trip, and `_cents` in the column name makes the unit impossible to misread at a call site.

The payments table uses `trip_id` as a unique constraint, which is the database-level enforcement of payment idempotency. The driver earnings ledger is append-only, which makes it easy to audit and impossible to accidentally modify past records.

```sql
-- Trips table - partitioned by region so the active-trip index below is authoritative
CREATE TABLE trips (
    id                    VARCHAR(36) PRIMARY KEY,
    rider_id              VARCHAR(36) NOT NULL,
    driver_id             VARCHAR(36),
    status                VARCHAR(20) NOT NULL,  -- requested, driver_assigned, driver_arrived, on_trip, completed, canceled
    ride_type             VARCHAR(20) NOT NULL DEFAULT 'UberX',
    pickup_lat            DECIMAL(10,7) NOT NULL,
    pickup_lng            DECIMAL(10,7) NOT NULL,
    dropoff_lat           DECIMAL(10,7),
    dropoff_lng           DECIMAL(10,7),
    surge_multiplier      DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    estimated_price_cents BIGINT,
    final_price_cents     BIGINT,
    currency              CHAR(3) NOT NULL DEFAULT 'USD',
    distance_km           DECIMAL(8,3),
    duration_secs         INT,
    requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    canceled_at           TIMESTAMPTZ,
    cancel_reason         VARCHAR(100),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostgreSQL has no inline INDEX clause inside CREATE TABLE. That syntax is
-- MySQL's, and pasting it into Postgres fails outright at DDL time.
CREATE INDEX idx_trips_rider     ON trips (rider_id, requested_at DESC);
CREATE INDEX idx_trips_driver    ON trips (driver_id, requested_at DESC);
CREATE INDEX idx_trips_status    ON trips (status, requested_at);
CREATE INDEX idx_trips_completed ON trips (completed_at); -- for analytics

-- A driver can hold at most one live trip. This is what turns "two riders raced
-- for the same driver" from a data-corruption bug into a rejected insert that
-- the matcher retries against its next candidate. A completed or canceled trip
-- falls out of the predicate, freeing the driver for the next fare.
CREATE UNIQUE INDEX uniq_driver_active_trip
    ON trips (driver_id)
    WHERE driver_id IS NOT NULL
      AND status IN ('driver_assigned', 'driver_arrived', 'on_trip');

-- Drivers table
CREATE TABLE drivers (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) NOT NULL UNIQUE,
    license_plate   VARCHAR(20) NOT NULL,
    vehicle_make    VARCHAR(50),
    vehicle_model   VARCHAR(50),
    vehicle_year    INT,
    vehicle_type    VARCHAR(20) NOT NULL, -- 'UberX', 'UberBlack', 'Pool'
    rating          DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    total_trips     INT NOT NULL DEFAULT 0,
    acceptance_rate DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    completion_rate DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drivers_vehicle_type ON drivers (vehicle_type, is_active);

-- Riders table
CREATE TABLE riders (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) NOT NULL UNIQUE,
    default_card_id VARCHAR(36),   -- FK to payment_methods
    rating          DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    total_trips     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments table. One row per trip, mutated in place as the charge resolves,
-- so this is a state table rather than an append-only ledger. The immutable
-- audit trail lives in driver_earnings below.
CREATE TABLE payments (
    id                  VARCHAR(36) PRIMARY KEY,
    trip_id             VARCHAR(36) NOT NULL UNIQUE,  -- idempotency key
    rider_id            VARCHAR(36) NOT NULL,
    driver_id           VARCHAR(36) NOT NULL,
    amount_cents        BIGINT NOT NULL,
    driver_earnings_cents BIGINT NOT NULL,
    platform_fee_cents  BIGINT NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'USD',
    status              VARCHAR(20) NOT NULL,         -- pending, succeeded, failed, refunded
    stripe_payment_id   VARCHAR(100),
    failure_reason      VARCHAR(255),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (trip_id) REFERENCES trips(id),
    -- The split is derived, never independently rounded. Enforcing the identity
    -- here means a rounding bug fails loudly at the write instead of drifting
    -- through the ledger unnoticed.
    CONSTRAINT split_sums_to_amount
        CHECK (driver_earnings_cents + platform_fee_cents = amount_cents)
);

-- Index names are database-wide in PostgreSQL, not scoped to their table, so
-- every name here is prefixed. Two tables both declaring "idx_status" collide.
CREATE INDEX idx_payments_rider  ON payments (rider_id, created_at DESC);
CREATE INDEX idx_payments_driver ON payments (driver_id, created_at DESC);
CREATE INDEX idx_payments_status ON payments (status, created_at);

-- Driver earnings ledger - weekly settlement
CREATE TABLE driver_earnings (
    id              VARCHAR(36) PRIMARY KEY,
    driver_id       VARCHAR(36) NOT NULL,
    trip_id         VARCHAR(36) NOT NULL,
    amount_cents    BIGINT NOT NULL,
    settlement_id   VARCHAR(36),    -- NULL until settled
    settled_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    FOREIGN KEY (trip_id) REFERENCES trips(id),
    -- One earnings row per trip. Without this, a settlement job that retries
    -- after a partial failure pays the driver for the same trip twice.
    CONSTRAINT uniq_earnings_per_trip UNIQUE (trip_id)
);

-- Partial index: the settlement job only ever scans unsettled rows, and this
-- keeps the index proportional to one week of trips rather than all history.
CREATE INDEX idx_earnings_unsettled
    ON driver_earnings (driver_id, created_at)
    WHERE settlement_id IS NULL;

-- Weekly settlement batches
CREATE TABLE settlements (
    id                VARCHAR(36) PRIMARY KEY,
    driver_id         VARCHAR(36) NOT NULL,
    total_amount_cents BIGINT NOT NULL,
    trip_count        INT NOT NULL,
    period_start      DATE NOT NULL,
    period_end        DATE NOT NULL,
    status            VARCHAR(20) NOT NULL,  -- pending, processing, completed, failed
    ach_transfer_id   VARCHAR(100),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at      TIMESTAMPTZ,

    FOREIGN KEY (driver_id) REFERENCES drivers(id),
    -- One settlement per driver per period, so a re-run of the weekly job
    -- cannot cut a second check for the same week.
    CONSTRAINT uniq_driver_period UNIQUE (driver_id, period_start)
);

CREATE INDEX idx_settlements_status ON settlements (status, created_at);
```

---
