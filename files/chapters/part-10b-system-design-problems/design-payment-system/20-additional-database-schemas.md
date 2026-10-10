## Additional Database Schemas

Beyond the core payment and ledger tables, a production payment system needs several supporting tables for disputes, reconciliation audit trails, webhook delivery tracking, and payout records. These tables provide the operational visibility that your support team and finance team need to investigate issues and generate reports. As with the core schema, indexes are separate `CREATE INDEX` statements: the inline `INDEX` clause is MySQL syntax and PostgreSQL will not parse it.

Look at the `UNIQUE` on `disputes.processor_ref` and on `webhook_deliveries`. Those are not there for query speed. Both tables are written from at-least-once webhook deliveries, and the constraint is what turns a redelivered notification into a harmless no-op instead of a second hold on a merchant's funds. Idempotency in these paths is a schema property first and application logic second.

```sql
-- Disputes
CREATE TABLE disputes (
    id                    VARCHAR(50) PRIMARY KEY,
    transaction_id        VARCHAR(36) NOT NULL,
    merchant_id           VARCHAR(36) NOT NULL,
    amount                BIGINT NOT NULL CHECK (amount > 0),
    currency              VARCHAR(3) NOT NULL,
    reason                VARCHAR(50),
    status                VARCHAR(30) NOT NULL,
    -- The processor's dispute ID. UNIQUE is what makes
    -- HandleIncomingDispute idempotent against webhook redelivery.
    processor_ref         VARCHAR(100) NOT NULL UNIQUE,
    evidence_due_date     TIMESTAMP NOT NULL,
    evidence_submitted_at TIMESTAMP,
    resolved_at           TIMESTAMP,
    resolution            VARCHAR(20), -- won, lost
    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_dispute_status CHECK (status IN (
        'open', 'evidence_required', 'under_review', 'won', 'lost'))
);

CREATE INDEX idx_dispute_merchant ON disputes (merchant_id, created_at DESC);
CREATE INDEX idx_dispute_status ON disputes (status);
CREATE INDEX idx_dispute_txn ON disputes (transaction_id);
-- Drives the reminder job: open disputes, soonest deadline first.
CREATE INDEX idx_dispute_due ON disputes (evidence_due_date)
    WHERE resolved_at IS NULL;

-- Reconciliation results
CREATE TABLE reconciliation_results (
    id              BIGSERIAL PRIMARY KEY,
    date            DATE NOT NULL UNIQUE,  -- one result per day
    total_txns      INT NOT NULL,
    matched         INT NOT NULL,
    mismatched      INT NOT NULL,
    discrepancies   INT NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Transaction events (state machine audit trail)
CREATE TABLE transaction_events (
    id              BIGSERIAL PRIMARY KEY,
    transaction_id  VARCHAR(36) NOT NULL,
    from_state      VARCHAR(30),
    to_state        VARCHAR(30) NOT NULL,
    metadata        JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_event_txn ON transaction_events (transaction_id, created_at);

-- Webhook delivery log
CREATE TABLE webhook_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    event_id        VARCHAR(50) NOT NULL,
    merchant_id     VARCHAR(36) NOT NULL,
    status          VARCHAR(20) NOT NULL, -- delivered, retry, failed
    attempt         SMALLINT NOT NULL,
    -- INT, not SMALLINT: response codes are fine in a smallint, but this
    -- also records 0 for "no response at all", and widening a column
    -- under load is a migration nobody wants to schedule.
    response_code   INT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, attempt)
);

CREATE INDEX idx_delivery_event ON webhook_deliveries (event_id);

-- Payout records
CREATE TABLE payouts (
    id              VARCHAR(50) PRIMARY KEY,
    merchant_id     VARCHAR(36) NOT NULL,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        VARCHAR(3) NOT NULL,
    fee             BIGINT NOT NULL DEFAULT 0,
    net_amount      BIGINT NOT NULL,
    status          VARCHAR(20) NOT NULL,
    bank_ref        VARCHAR(100),
    initiated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMP,
    -- The database refuses to hold a payout whose parts do not add up.
    CONSTRAINT chk_payout_balanced CHECK (amount = net_amount + fee),
    CONSTRAINT chk_payout_status CHECK (status IN (
        'pending', 'in_transit', 'paid', 'failed', 'needs_review'))
);

CREATE INDEX idx_payout_merchant ON payouts (merchant_id, initiated_at DESC);
```


---
