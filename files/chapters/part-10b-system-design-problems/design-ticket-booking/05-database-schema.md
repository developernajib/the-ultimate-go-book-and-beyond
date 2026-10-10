## Database Schema

The database schema separates concerns into four main tables: events hold event metadata and sale timing, seats track the inventory of every bookable position in a venue, bookings record completed purchases, and tickets represent individual delivered items with QR codes. PostgreSQL serves as the authoritative source of truth, while Redis acts as the fast, real-time cache layer in front of it.

Four details here are doing the real work. Money is stored in integer cents, never a floating point type, so that a 20% service fee on a $67.50 seat is 1350 exactly and stays that way through every sum. `seats.status` admits only `available` and `sold`, because a hold is a Redis concept: a `held` state in PostgreSQL would be a lie that nothing ever writes and that no crash could ever clean up. `bookings.hold_id` carries a UNIQUE constraint, which is what makes a retried confirm collide instead of quietly producing a second booking for the same hold.

And `seats` is keyed on `(event_id, id)` rather than on `id` alone. Seat identifiers are drawn from the venue's layout, so `FLOOR-A-12` is a position in a building, not a globally unique object. Key the table on `id` and the very first attempt to stage a second show at the same arena fails on the primary key, one seat at a time, which is a strange and memorable way to discover a data model problem in production.

```sql
-- Events
CREATE TABLE events (
    id          VARCHAR(36) PRIMARY KEY,
    name        VARCHAR(300),
    venue_id    VARCHAR(36),
    event_date  TIMESTAMPTZ,
    doors_open  TIMESTAMPTZ,
    status      VARCHAR(20),   -- on_sale, sold_out, canceled
    sale_start  TIMESTAMPTZ,
    presale_start TIMESTAMPTZ,
    max_tickets_per_user SMALLINT DEFAULT 4,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_date ON events (event_date);

-- Seats (inventory)
CREATE TABLE seats (
    -- A seat ID like 'FLOOR-A-12' identifies a physical position in a venue,
    -- so it is unique within an event, not globally. Making id the sole
    -- primary key means the second event ever staged at a venue collides with
    -- the first on every seat and cannot be created at all.
    id          VARCHAR(36) NOT NULL,
    event_id    VARCHAR(36) NOT NULL REFERENCES events(id),
    section     VARCHAR(20),
    row         VARCHAR(10),
    seat_number SMALLINT,
    tier        VARCHAR(30),   -- VIP, Floor, General
    price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
    -- No 'held' state: holds live in Redis with a TTL. The sale is the
    -- transition available -> sold, and that transition is the oversell
    -- guarantee for the whole system.
    status      VARCHAR(20) NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'sold')),
    booking_id  VARCHAR(36),
    PRIMARY KEY (event_id, id),
    CONSTRAINT sold_seats_have_a_booking
        CHECK ((status = 'sold') = (booking_id IS NOT NULL))
);

-- The workhorse index: "which seats are left for this event", run constantly
-- during a sale. Partial on 'available' because nobody queries for sold seats
-- in the hot path, and on a sold-out arena that keeps the index tiny.
CREATE INDEX idx_seats_event_available ON seats (event_id)
    WHERE status = 'available';
CREATE INDEX idx_seats_booking ON seats (booking_id);

-- Bookings
CREATE TABLE bookings (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    event_id    VARCHAR(36) NOT NULL REFERENCES events(id),
    -- One booking per hold, enforced by the database rather than by a
    -- read-then-write check that two concurrent retries would both pass.
    hold_id     VARCHAR(36) NOT NULL UNIQUE,
    total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
    service_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
    status      VARCHAR(20) NOT NULL,
    payment_id  VARCHAR(100),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bookings_user ON bookings (user_id, created_at DESC);
CREATE INDEX idx_bookings_event ON bookings (event_id);

-- Tickets (one per seat per booking)
CREATE TABLE tickets (
    id          VARCHAR(50) PRIMARY KEY,
    booking_id  VARCHAR(36) NOT NULL REFERENCES bookings(id),
    -- event_id and user_id are denormalized onto the ticket because the gate
    -- scanner verifies a barcode signed over (ticket, event, owner) and must
    -- recover the owner in one lookup, on venue wifi, with a queue behind it.
    event_id    VARCHAR(36) NOT NULL REFERENCES events(id),
    user_id     VARCHAR(36) NOT NULL,
    seat_id     VARCHAR(36) NOT NULL,
    qr_url      TEXT,
    barcode     TEXT,
    -- active: held by its owner. listed: frozen on the resale market, so the
    -- owner cannot also walk in with it. transferred: superseded by a reissued
    -- ticket, and no longer valid at the gate.
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'listed', 'transferred')),
    is_used     BOOLEAN NOT NULL DEFAULT FALSE,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    -- A seat is admitted once per event.
    CONSTRAINT one_ticket_per_seat UNIQUE (event_id, seat_id),
    -- Composite FK, matching the seats primary key. A ticket is for a seat at
    -- an event, and the pair has to resolve together.
    CONSTRAINT tickets_seat_fk
        FOREIGN KEY (event_id, seat_id) REFERENCES seats (event_id, id)
);

CREATE INDEX idx_tickets_booking ON tickets (booking_id);
CREATE INDEX idx_tickets_user ON tickets (user_id);
```

---
