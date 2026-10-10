## Database Schema

The database schema below captures the core tables needed for a payment system. Transactions are partitioned by month so that old data can be archived without affecting query performance on recent payments. The ledger_entries table stores the double-entry journal and is also partitioned, since it grows at twice the rate of transactions. Notice that amounts are stored as `BIGINT` in the smallest currency unit (for example, cents for USD) to avoid floating-point rounding errors that would be catastrophic in financial software.

Two PostgreSQL details about partitioning are worth internalizing, because they are where hand-written schemas usually fail on first `psql` run. First, indexes are separate `CREATE INDEX` statements, not clauses inside `CREATE TABLE`: the inline `INDEX` syntax is MySQL's and PostgreSQL rejects it. Second, every unique constraint on a partitioned table must contain the partition key, because PostgreSQL enforces uniqueness per partition and has no way to check a global constraint across partitions cheaply. That rule has a real consequence here. The primary key has to become `(id, created_at)`, which is harmless. The `UNIQUE` on `idempotency_key` is not harmless: it would have to become `(idempotency_key, created_at)`, and that constrains nothing useful, since the same key retried on either side of a month boundary lands in different partitions and both inserts succeed. A constraint that permits the exact duplicate it exists to forbid is worse than no constraint, because it reads like protection. So the guarantee moves rather than weakens: idempotency keys live in their own unpartitioned table where uniqueness is absolute, and the rows are small enough that keeping them forever is cheaper than reasoning about when it is safe to delete one.

```sql
-- Transactions (partitioned by created_at month for archiving)
CREATE TABLE transactions (
    id               VARCHAR(36) NOT NULL,
    idempotency_key  VARCHAR(255) NOT NULL,
    merchant_id      VARCHAR(36) NOT NULL,
    amount           BIGINT NOT NULL,       -- in smallest currency unit
    currency         VARCHAR(3) NOT NULL,   -- ISO 4217
    status           VARCHAR(30) NOT NULL,
    refunded_amount  BIGINT NOT NULL DEFAULT 0,  -- running total, minor units
    fraud_score      DECIMAL(5,4),
    processor_ref    VARCHAR(100),          -- external charge ID
    failure_code     VARCHAR(50),
    failure_message  TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    -- A partitioned table's PK must include the partition key
    PRIMARY KEY (id, created_at),
    -- Must stay in step with the PaymentState constants and the
    -- ValidTransitions map in the state machine deep dive.
    CONSTRAINT chk_status CHECK (status IN (
        'pending', 'authorized', 'captured', 'settled', 'failed',
        'blocked', 'voided', 'partially_refunded', 'refunded',
        'disputed')),
    CONSTRAINT chk_amount_positive CHECK (amount > 0),
    -- The database, not the application, is what makes it impossible to
    -- refund more than was charged. Application checks race, this cannot.
    CONSTRAINT chk_refund_bounds CHECK (refunded_amount BETWEEN 0 AND amount)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_txn_merchant ON transactions (merchant_id, created_at DESC);
CREATE INDEX idx_txn_status ON transactions (status, created_at DESC);
CREATE INDEX idx_txn_processor_ref ON transactions (processor_ref);
-- Lookup only. The uniqueness guarantee lives in idempotency_keys below,
-- because a UNIQUE here could only be (idempotency_key, created_at).
CREATE INDEX idx_txn_idempotency ON transactions (idempotency_key);

-- Idempotency keys: deliberately NOT partitioned, so the UNIQUE
-- constraint is global. This table is the exactly-once guarantee. Redis
-- in front of it is a cache and a lock, and both of those can lose their
-- contents without anyone being charged twice. This cannot.
CREATE TABLE idempotency_keys (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    merchant_id     VARCHAR(36) NOT NULL,
    -- Hash of the request body. A key replayed with different parameters
    -- is a merchant bug: return 400 rather than silently handing back the
    -- first charge's result for a second, different charge.
    request_hash    BYTEA NOT NULL,
    transaction_id  VARCHAR(36) NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Refunds
CREATE TABLE refunds (
    id             VARCHAR(36) PRIMARY KEY,
    transaction_id VARCHAR(36) NOT NULL,
    amount         BIGINT NOT NULL CHECK (amount > 0),
    reason         TEXT,
    processor_ref  VARCHAR(100),
    status         VARCHAR(20) NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refund_txn ON refunds (transaction_id);

-- Double-entry ledger. Append-only: no UPDATE, no DELETE. A correction
-- is a new, opposite entry, because an audit trail you can edit is not
-- an audit trail. Enforce that with table permissions, not convention.
CREATE TABLE ledger_entries (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    account_id     VARCHAR(100) NOT NULL,  -- merchant_id or customer txn ID
    account_type   VARCHAR(20) NOT NULL,   -- merchant, customer
    transaction_id VARCHAR(36) NOT NULL,
    amount         BIGINT NOT NULL,        -- positive=credit, negative=debit
    currency       VARCHAR(3) NOT NULL,
    type           VARCHAR(20) NOT NULL,   -- payment, refund, fee, payout
    related_id     VARCHAR(36),
    created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at),
    -- Makes LedgerService.Record retry-safe: a second attempt to post the
    -- same transaction's entries conflicts instead of double-crediting.
    --
    -- created_at is in the constraint because the partition key must be,
    -- and that only works because created_at here is the transaction's
    -- own timestamp rather than the wall clock at insert time. A retry
    -- therefore reproduces the identical value, lands in the identical
    -- partition, and collides. Had this been NOW(), every retry would
    -- carry a fresh timestamp, miss the constraint, and post again.
    UNIQUE (transaction_id, account_type, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_ledger_account ON ledger_entries (account_id, created_at DESC);
CREATE INDEX idx_ledger_transaction ON ledger_entries (transaction_id);

-- Merchant balances (materialized running total).
-- NOT NULL is not decoration: GetMerchantBalance scans these into int64,
-- and a NULL would fail the scan rather than read as zero. The ledger
-- remains the source of truth, and this table must be rebuildable from it
-- by summing entries, which is exactly what reconciliation checks.
CREATE TABLE merchant_balances (
    merchant_id    VARCHAR(36) NOT NULL,
    currency       VARCHAR(3) NOT NULL,
    available      BIGINT NOT NULL DEFAULT 0,  -- funds available for payout
    pending        BIGINT NOT NULL DEFAULT 0,  -- funds in settlement window
    held           BIGINT NOT NULL DEFAULT 0,  -- frozen against open disputes
    last_payout_at TIMESTAMP,                  -- NULL until first payout
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_id, currency),
    -- held is money we are sitting on, so it can never go negative.
    -- available deliberately CAN: a chargeback against a merchant who has
    -- already been paid out leaves them owing us, and that debt is a fact
    -- whether or not we are willing to write it down. Forbidding negative
    -- available would not prevent the exposure, it would only make the
    -- dispute handler fail and leave us not knowing about it.
    CONSTRAINT chk_held_nonneg CHECK (held >= 0)
);

-- Minimum payout amount per currency, in that currency's minor units.
-- A single global threshold is a bug in disguise: 2500 is $25.00, but it
-- is also ¥2500 and 2.5 BHD, which are not remotely the same amount.
CREATE TABLE payout_thresholds (
    currency VARCHAR(3) PRIMARY KEY,
    minimum  BIGINT NOT NULL CHECK (minimum > 0)
);
```

---
