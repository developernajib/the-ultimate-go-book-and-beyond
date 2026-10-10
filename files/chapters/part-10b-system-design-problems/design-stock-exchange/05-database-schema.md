## Database Schema

While the matching engine operates entirely in memory for speed, the exchange still needs a persistent database for regulatory compliance, audit trails, and historical queries. The orders table is append-only because regulators require a complete, unmodified record of every order ever submitted. Tables are partitioned by timestamp so that queries against recent data remain fast even as the database grows to terabytes. Notice that prices are stored as `BIGINT` in cents, matching the in-memory representation to avoid any conversion errors.

Two details in this schema trip people up in interviews. First, PostgreSQL requires every unique constraint on a partitioned table to include the partition key, so the primary key is `(id, submitted_at)` and not `id` alone. A schema that declares `id PRIMARY KEY` on a range-partitioned table does not create a table with a slightly weaker guarantee, it fails to create the table at all. Second, the columns are `NOT NULL` because the audit trail is read back into Go structs with non-nullable fields. A nullable `price` column scanned into an `int64` fails at runtime with "converting NULL to int64 is unsupported", and it fails on the row that happens to be missing a price rather than on the first row you test with.

```sql
-- Orders (immutable audit log - append only)
CREATE TABLE orders (
    id           VARCHAR(36) NOT NULL,
    symbol       VARCHAR(10) NOT NULL,
    trader_id    VARCHAR(36) NOT NULL,
    order_type   SMALLINT NOT NULL,  -- market, limit, stop, stop-limit
    side         SMALLINT NOT NULL,  -- buy, sell
    price        BIGINT NOT NULL,    -- in cents (0 for market orders)
    stop_price   BIGINT NOT NULL DEFAULT 0,  -- cents, stop types only
    quantity     BIGINT NOT NULL,
    filled       BIGINT NOT NULL DEFAULT 0,
    status       SMALLINT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL,
    sequence     BIGINT NOT NULL,    -- global monotonic sequence
    -- Every unique constraint on a partitioned table must contain the
    -- partition key, so the primary key is (id, submitted_at) rather than id.
    PRIMARY KEY (id, submitted_at),
    UNIQUE (sequence, submitted_at)
) PARTITION BY RANGE (submitted_at);

CREATE INDEX idx_orders_symbol ON orders (symbol, submitted_at DESC);
CREATE INDEX idx_orders_trader ON orders (trader_id, submitted_at DESC);

-- Trades (execution records)
CREATE TABLE trades (
    id            VARCHAR(36) NOT NULL,
    symbol        VARCHAR(10) NOT NULL,
    buy_order_id  VARCHAR(36) NOT NULL,
    sell_order_id VARCHAR(36) NOT NULL,
    price         BIGINT NOT NULL,  -- cents
    quantity      BIGINT NOT NULL,
    buyer_id      VARCHAR(36) NOT NULL,
    seller_id     VARCHAR(36) NOT NULL,
    executed_at   TIMESTAMPTZ NOT NULL,
    -- Settlement state. The status guard is what makes settlement idempotent:
    -- a settling run only claims trades that are still pending.
    settlement_status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (settlement_status IN ('pending', 'settled', 'failed')),
    settle_date   DATE,
    settled_at    TIMESTAMPTZ,
    PRIMARY KEY (id, executed_at)
) PARTITION BY RANGE (executed_at);

CREATE INDEX idx_trades_pending ON trades (executed_at)
    WHERE settlement_status = 'pending';

CREATE INDEX idx_trades_symbol ON trades (symbol, executed_at DESC);
CREATE INDEX idx_trades_buyer ON trades (buyer_id, executed_at DESC);
CREATE INDEX idx_trades_seller ON trades (seller_id, executed_at DESC);

-- One partition per trading day, created ahead of time by a maintenance job.
CREATE TABLE orders_2026_07_17 PARTITION OF orders
    FOR VALUES FROM ('2026-07-17') TO ('2026-07-18');
CREATE TABLE trades_2026_07_17 PARTITION OF trades
    FOR VALUES FROM ('2026-07-17') TO ('2026-07-18');

-- Position snapshots (for margin calculation)
CREATE TABLE positions (
    trader_id    VARCHAR(36) NOT NULL,
    symbol       VARCHAR(10) NOT NULL,
    quantity     BIGINT NOT NULL,  -- positive = long, negative = short
    avg_cost     BIGINT NOT NULL,  -- cents
    market_value BIGINT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trader_id, symbol)
);
```

---
