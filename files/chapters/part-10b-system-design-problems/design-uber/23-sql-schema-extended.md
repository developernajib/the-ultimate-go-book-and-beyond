## SQL Schema: Extended

This extended schema covers the supporting tables that a production ride-sharing platform needs beyond the core trips and payments tables. It includes trip GPS traces for route recording, ratings for the driver/rider feedback system, promo codes for marketing campaigns, driver documents for the onboarding verification process, and support tickets for customer service.

Three conventions carry through, and the reasons matter more than the rules.

Indexes are declared as separate `CREATE INDEX` statements. PostgreSQL has no inline `INDEX` clause inside `CREATE TABLE`: that is MySQL syntax, and it is a hard error here, not a portability wart.

`trip_traces` is partitioned by time, which forces a detail people trip over constantly. A partitioned table's primary key must contain the partition key, because PostgreSQL enforces uniqueness per partition and cannot police a global key it would have to check across every partition. So the natural key `(trip_id, seq)` becomes `(trip_id, seq, recorded_at)`. This is not a formality: `ALTER TABLE ... PARTITION BY` with a PK that omits the partition column fails outright.

Money is `BIGINT` minor units. Note `promo_codes` in particular, where the original single `discount_value` column had to hold both "20" meaning 20% and "20" meaning $0.20, in the same `DECIMAL`, distinguished only by a sibling string column. Two different kinds of number in one column is a bug waiting for a careless read, so percentages get their own basis-points column and money gets its own cents column.

```sql
-- Trip GPS trace (append-only, very high write volume).
-- ~225 fixes per trip at one every 4s, x10M trips/day, is on the order of
-- 2 billion rows a day. This is only manageable as a partitioned table you can
-- drop a partition from, because DELETE at this volume never keeps up.
CREATE TABLE trip_traces (
    trip_id     VARCHAR(36) NOT NULL,
    seq         INT NOT NULL,
    lat         DECIMAL(10,7) NOT NULL,
    lng         DECIMAL(10,7) NOT NULL,
    speed       DECIMAL(6,2),
    heading     DECIMAL(5,2),
    accuracy    DECIMAL(6,2),
    recorded_at TIMESTAMPTZ NOT NULL,

    -- recorded_at is in the PK because it is the partition key. Writing just
    -- (trip_id, seq) here fails: a partitioned table's unique constraint must
    -- include the partition column.
    PRIMARY KEY (trip_id, seq, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE trip_traces_2026_07 PARTITION OF trip_traces
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE trip_traces_2026_08 PARTITION OF trip_traces
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_traces_trip_time ON trip_traces (trip_id, recorded_at);

-- Ratings
CREATE TABLE ratings (
    id          VARCHAR(36) PRIMARY KEY,
    trip_id     VARCHAR(36) NOT NULL,
    rater_id    VARCHAR(36) NOT NULL,
    ratee_id    VARCHAR(36) NOT NULL,
    score       SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment     TEXT,
    tags        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (trip_id) REFERENCES trips(id),
    -- One rating per rater per trip. This is what makes a double-tapped submit
    -- from a retrying client an error instead of a rating counted twice.
    CONSTRAINT uniq_rating_per_trip_rater UNIQUE (trip_id, rater_id)
);

CREATE INDEX idx_ratings_ratee ON ratings (ratee_id, created_at DESC);
CREATE INDEX idx_ratings_trip  ON ratings (trip_id);

-- Promo codes and discounts
CREATE TABLE promo_codes (
    code             VARCHAR(50) PRIMARY KEY,
    discount_type    VARCHAR(20) NOT NULL,  -- 'percentage', 'fixed_amount', 'free_ride'
    -- Percentage and fixed amounts are different units and get different
    -- columns. Basis points keep percentages exact integers (2000 = 20%).
    discount_bps     INT,
    discount_cents   BIGINT,
    max_uses         INT,
    used_count       INT NOT NULL DEFAULT 0,
    min_fare_cents   BIGINT,
    valid_from       TIMESTAMPTZ NOT NULL,
    valid_until      TIMESTAMPTZ NOT NULL,
    region           VARCHAR(50),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_period CHECK (valid_until > valid_from),
    CONSTRAINT used_within_limit CHECK (max_uses IS NULL OR used_count <= max_uses),
    -- Exactly the column that matches the type must be populated.
    CONSTRAINT discount_matches_type CHECK (
        (discount_type = 'percentage'   AND discount_bps IS NOT NULL AND discount_cents IS NULL) OR
        (discount_type = 'fixed_amount' AND discount_cents IS NOT NULL AND discount_bps IS NULL) OR
        (discount_type = 'free_ride'    AND discount_bps IS NULL AND discount_cents IS NULL)
    )
);

CREATE TABLE promo_usage (
    user_id               VARCHAR(36) NOT NULL,
    promo_code            VARCHAR(50) NOT NULL,
    trip_id               VARCHAR(36) NOT NULL,
    discount_amount_cents BIGINT NOT NULL,
    used_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One redemption per user per code. The PK is the enforcement, not a
    -- SELECT that checks first.
    PRIMARY KEY (user_id, promo_code),
    FOREIGN KEY (promo_code) REFERENCES promo_codes(code),
    FOREIGN KEY (trip_id) REFERENCES trips(id)
);

-- Driver documents (for onboarding)
CREATE TABLE driver_documents (
    id          VARCHAR(36) PRIMARY KEY,
    driver_id   VARCHAR(36) NOT NULL,
    doc_type    VARCHAR(50) NOT NULL,  -- 'license', 'insurance', 'registration', 'background_check'
    s3_key      VARCHAR(500) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected'
    reviewed_by VARCHAR(36),
    reviewed_at TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

CREATE INDEX idx_docs_driver ON driver_documents (driver_id, doc_type);

-- A partial index. The review queue only ever reads pending documents, so the
-- index stays the size of the backlog instead of the size of all history.
CREATE INDEX idx_docs_pending ON driver_documents (created_at)
    WHERE status = 'pending';

-- Expiring documents are a scheduled compliance concern, not a rare one.
CREATE INDEX idx_docs_expiring ON driver_documents (expires_at)
    WHERE status = 'approved' AND expires_at IS NOT NULL;

-- Support tickets
CREATE TABLE support_tickets (
    id          VARCHAR(36) PRIMARY KEY,
    trip_id     VARCHAR(36),
    user_id     VARCHAR(36) NOT NULL,
    user_type   VARCHAR(10) NOT NULL CHECK (user_type IN ('rider', 'driver')),
    category    VARCHAR(50) NOT NULL,
    subject     VARCHAR(200),
    description TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'open',
    priority    VARCHAR(10) NOT NULL DEFAULT 'normal',
    assigned_to VARCHAR(36),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_tickets_user ON support_tickets (user_id, created_at DESC);
CREATE INDEX idx_tickets_open ON support_tickets (priority, created_at)
    WHERE status = 'open';
```

One trap this schema sets deliberately: `promo_codes.used_count` against `max_uses`. Reading the count, comparing it to the limit, and then incrementing is the same race as the driver double-booking, and a popular code during a campaign is exactly the concurrency that breaks it. Redeem with a conditional write and let the row count tell you whether you won:

```sql
UPDATE promo_codes
   SET used_count = used_count + 1
 WHERE code = $1
   AND (max_uses IS NULL OR used_count < max_uses)
   AND NOW() BETWEEN valid_from AND valid_until;
-- 0 rows updated means the code is exhausted or expired. Do not apply it.
```

The `used_within_limit` CHECK is the backstop, not the mechanism. If a code ever does exceed its cap, the constraint turns a silent overspend into a failed transaction, and you find out from an error rather than from finance.

---
