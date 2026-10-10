## Database Schema

The schema below defines the core tables that support listings, bookings, availability, and reviews. Notice how `blocked_dates` uses date-range overlap queries rather than storing individual dates, this is far more efficient for a calendar with millions of listings. The indexes are carefully chosen to support the most frequent query patterns: searching listings by location, looking up bookings by guest or host, and checking availability by listing and date range. PostgreSQL serves as the source of truth, even though Elasticsearch mirrors listing data for fast search.

Every money column is `BIGINT` holding integer minor units, never `DECIMAL` and never `DOUBLE PRECISION`. A float column is the worst of the three because it cannot represent 0.10 exactly and the error is silent. `DECIMAL` at least computes exactly, but it invites the application to scan the value into a `float64` on the way through, and an integer column makes that mistake impossible to write. The bookings table stores all four money components rather than the total alone, because the payout and cancellation paths each need a different subset and neither should be re-deriving them by division. The `currency` column is what makes the integer mean something: `12000` is $120.00 in USD but ¥12000 in JPY, and section 17 covers the multi-currency extension.

```sql
-- Listings
CREATE TABLE listings (
    id              VARCHAR(36) PRIMARY KEY,
    host_id         VARCHAR(36) NOT NULL,
    title           VARCHAR(500),
    description     TEXT,
    property_type   VARCHAR(50),   -- entire_home, private_room, shared_room
    accommodates    INT,
    bedrooms        INT,
    bathrooms       DECIMAL(3,1),  -- not money: 1.5 baths is a real quantity
    price_per_night_cents BIGINT NOT NULL CHECK (price_per_night_cents > 0),
    cleaning_fee_cents    BIGINT NOT NULL DEFAULT 0 CHECK (cleaning_fee_cents >= 0),
    currency        CHAR(3) NOT NULL DEFAULT 'USD',  -- ISO 4217
    status          VARCHAR(20) DEFAULT 'active',
    lat             DECIMAL(10,7),
    lng             DECIMAL(10,7),
    amenities       TEXT[],        -- array of amenity tags
    rating          DECIMAL(3,2) DEFAULT 0,
    review_count    INT DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_listings_location ON listings (lat, lng);
CREATE INDEX idx_listings_host ON listings (host_id);
CREATE INDEX idx_listings_status ON listings (status);

-- Bookings
CREATE TABLE bookings (
    id          VARCHAR(36) PRIMARY KEY,
    listing_id  VARCHAR(36) NOT NULL REFERENCES listings(id),
    guest_id    VARCHAR(36) NOT NULL,
    host_id     VARCHAR(36) NOT NULL,
    check_in    DATE NOT NULL,
    check_out   DATE NOT NULL,
    guests      INT,
    -- Money components, all integer minor units of `currency`.
    subtotal_cents     BIGINT NOT NULL,  -- nightly rate x nights
    cleaning_fee_cents BIGINT NOT NULL DEFAULT 0,
    service_fee_cents  BIGINT NOT NULL,  -- 14% guest fee, half-up
    total_cents        BIGINT NOT NULL,
    currency    CHAR(3) NOT NULL DEFAULT 'USD',
    -- The total is the sum of its parts, and the database says so. This is
    -- the invariant a float representation cannot hold onto.
    CONSTRAINT total_is_sum_of_parts CHECK (
        total_cents = subtotal_cents + cleaning_fee_cents + service_fee_cents
    ),
    status      VARCHAR(30),  -- pending, confirmed, canceled, completed
    payment_id  VARCHAR(100),
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_bookings_guest ON bookings (guest_id, created_at DESC);
CREATE INDEX idx_bookings_host ON bookings (host_id, check_in DESC);
CREATE INDEX idx_bookings_listing ON bookings (listing_id, check_in);

-- Availability calendar (blocked dates)
CREATE TABLE blocked_dates (
    listing_id  VARCHAR(36) NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    reason      VARCHAR(30),   -- booked, owner_blocked, maintenance
    booking_id  VARCHAR(36)
);
CREATE INDEX idx_blocked_listing_dates ON blocked_dates (listing_id, start_date, end_date);

-- Defense in depth: the database itself rejects overlapping ranges for the
-- same listing, even if application-level locking has a bug
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE blocked_dates ADD CONSTRAINT no_calendar_overlap
    EXCLUDE USING gist (
        listing_id WITH =,
        daterange(start_date, end_date) WITH &&
    );

-- Reviews
CREATE TABLE reviews (
    id          VARCHAR(36) PRIMARY KEY,
    booking_id  VARCHAR(36) NOT NULL,
    reviewer_id VARCHAR(36) NOT NULL,
    reviewee_id VARCHAR(36) NOT NULL,  -- can be user or listing
    target_type VARCHAR(20),           -- listing, host, guest
    rating      INT CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    is_visible  BOOLEAN DEFAULT FALSE,  -- hidden until both sides review (blind review)
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_reviews_target ON reviews (reviewee_id, target_type, created_at DESC);
```

---
