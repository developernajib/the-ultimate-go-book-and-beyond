## Additional Database Tables

Beyond the core schema, the system needs tables for presale codes, resale listings, ticket transfers, and queue analytics. Presale codes are keyed by event and code together because the same code string might be reused across different events. The resale listings table tracks the full lifecycle of a listing from active to sold or canceled. Queue analytics capture historical data about queue performance, which is valuable for capacity planning of future events with similar demand profiles.

The constraints here are worth more than the columns. A partial unique index on `(ticket_id) WHERE status = 'active'` is what actually stops a ticket from being listed twice, and a `CHECK` is what actually enforces the anti-scalping cap. Both rules are also checked in application code, and both belong here anyway: application checks protect against the requests you thought of, and constraints protect against the ones you did not, including the concurrent retry and the migration script someone runs at midnight.

```sql
-- Presale codes
CREATE TABLE presale_codes (
    code         VARCHAR(50),
    event_id     VARCHAR(36) REFERENCES events(id),
    type         VARCHAR(30),  -- fan_club, amex, artist, venue
    max_uses     INT NOT NULL DEFAULT 1,
    used_count   INT NOT NULL DEFAULT 0,
    max_tickets  INT NOT NULL DEFAULT 4,
    valid_from   TIMESTAMPTZ,
    valid_until  TIMESTAMPTZ,
    PRIMARY KEY (event_id, code),
    -- The durable version of the limit the Redis Lua script enforces on the
    -- fast path. Redis can lose an increment to a failover; a committed row
    -- that violates this CHECK cannot exist.
    CONSTRAINT presale_within_limit CHECK (used_count <= max_uses)
);

-- Resale listings
CREATE TABLE resale_listings (
    id           VARCHAR(36) PRIMARY KEY,
    ticket_id    VARCHAR(50) NOT NULL REFERENCES tickets(id),
    event_id     VARCHAR(36) NOT NULL REFERENCES events(id),
    seller_id    VARCHAR(36) NOT NULL,
    section      VARCHAR(20),
    row          VARCHAR(10),
    seat_number  SMALLINT,
    face_value_cents   BIGINT NOT NULL CHECK (face_value_cents >= 0),
    asking_price_cents BIGINT NOT NULL CHECK (asking_price_cents >= 0),
    status       VARCHAR(20) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'sold', 'canceled')),
    buyer_id     VARCHAR(36),
    sold_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    -- Anti-scalping cap, enforced by the database rather than trusted to the
    -- one code path that happens to check it today.
    CONSTRAINT resale_price_cap
        CHECK (asking_price_cents <= face_value_cents * 120 / 100)
);

-- A ticket can have at most one live listing. Without this, two concurrent
-- list requests for the same ticket both pass an application-level "is it
-- already listed?" check and both insert, and the ticket sells twice.
CREATE UNIQUE INDEX idx_resale_one_active_per_ticket
    ON resale_listings (ticket_id) WHERE status = 'active';
CREATE INDEX idx_resale_event_status ON resale_listings (event_id, status);
CREATE INDEX idx_resale_seller ON resale_listings (seller_id);

-- Ticket transfers
CREATE TABLE ticket_transfers (
    id           VARCHAR(36) PRIMARY KEY,
    ticket_id    VARCHAR(50) NOT NULL REFERENCES tickets(id),
    from_user_id VARCHAR(36) NOT NULL,
    to_user_id   VARCHAR(36) NOT NULL,
    transfer_type VARCHAR(20), -- gift, resale
    transferred_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transfers_ticket ON ticket_transfers (ticket_id, transferred_at DESC);

-- Queue analytics
CREATE TABLE queue_analytics (
    event_id     VARCHAR(36) REFERENCES events(id),
    timestamp    TIMESTAMPTZ,
    queue_depth  INT,
    admission_rate INT,        -- users/min
    avg_wait_min DECIMAL(6,2),
    bot_blocked  INT,
    PRIMARY KEY (event_id, timestamp)
);
```


---
