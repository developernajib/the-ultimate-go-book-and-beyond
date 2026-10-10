## Additional Database Tables

These supplementary tables support the features built in the deep-dive sections above. The `custom_pricing` table allows hosts to override the default nightly price on specific dates. The `payouts` table tracks the full lifecycle of host earnings from scheduling through payment. The `conversations` and `messages` tables power the messaging service, with indexes optimized for the "inbox" query pattern (most recent conversations first). The `listing_moderation` table holds the review queue that new listings must pass through before becoming searchable.

```sql
-- Custom pricing per date
CREATE TABLE custom_pricing (
    listing_id  VARCHAR(36) NOT NULL,
    date        DATE NOT NULL,
    price_cents BIGINT CHECK (price_cents > 0),  -- integer minor units
    min_stay    INT DEFAULT 1,
    PRIMARY KEY (listing_id, date)
);

-- Host payouts
CREATE TABLE payouts (
    id           VARCHAR(36) PRIMARY KEY,
    host_id      VARCHAR(36) NOT NULL,
    booking_id   VARCHAR(36) NOT NULL,
    -- Integer minor units of `currency`, never DECIMAL and never a float.
    gross_amount_cents BIGINT NOT NULL,
    host_fee_cents     BIGINT NOT NULL,
    net_amount_cents   BIGINT NOT NULL,
    currency     CHAR(3) NOT NULL DEFAULT 'USD',
    -- The split conserves value, and the database enforces it. A payout that
    -- cannot account for every cent of its gross does not get written.
    CONSTRAINT payout_splits_evenly CHECK (
        gross_amount_cents = host_fee_cents + net_amount_cents
    ),
    status       VARCHAR(20) DEFAULT 'pending',
    scheduled_at TIMESTAMP,
    paid_at      TIMESTAMP,
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_payouts_host ON payouts (host_id, created_at DESC);
CREATE INDEX idx_payouts_status ON payouts (status, scheduled_at);

-- Conversations
CREATE TABLE conversations (
    id           VARCHAR(36) PRIMARY KEY,
    booking_id   VARCHAR(36),
    host_id      VARCHAR(36) NOT NULL,
    guest_id     VARCHAR(36) NOT NULL,
    last_message TEXT,
    updated_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_conversations_host ON conversations (host_id, updated_at DESC);
CREATE INDEX idx_conversations_guest ON conversations (guest_id, updated_at DESC);

-- Messages
CREATE TABLE messages (
    id              VARCHAR(36) PRIMARY KEY,
    conversation_id VARCHAR(36) NOT NULL REFERENCES conversations(id),
    sender_id       VARCHAR(36) NOT NULL,
    content         TEXT NOT NULL,
    read_at         TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- Listing moderation queue
CREATE TABLE listing_moderation (
    listing_id  VARCHAR(36) PRIMARY KEY,
    status      VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
    reviewer_id VARCHAR(36),
    reason      TEXT,
    reviewed_at TIMESTAMP,
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_moderation_status ON listing_moderation (status, created_at);
```
