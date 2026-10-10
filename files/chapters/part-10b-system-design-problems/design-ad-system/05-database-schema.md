## Database Schema

The ad system uses two distinct database technologies for different workloads. PostgreSQL stores campaign configuration and advertiser settings (OLTP), while ClickHouse handles the massive volume of impression and click logs (OLAP). This separation is critical because writing 1 trillion impression rows per day would overwhelm any traditional relational database, but ClickHouse's columnar storage and MergeTree engine are built for exactly this kind of append-heavy, analytics-oriented workload. Notice that money columns (`daily_budget_micros`, `total_budget_micros`, `cpm_bid_micros`, `win_price_micros`) are stored as `BIGINT`/`Int64` in microdollars (1 USD = 1_000_000 micros) rather than floating-point decimals to eliminate rounding drift across billions of auctions, and the impression and click tables include TTL-based automatic data expiration and partition-by-day for efficient queries and cleanup.

```sql
-- Campaigns (source of truth for advertiser settings)
CREATE TABLE campaigns (
    id          VARCHAR(36) PRIMARY KEY,
    advertiser_id VARCHAR(36) NOT NULL,
    name        VARCHAR(300),
    status      VARCHAR(20),  -- active, paused, ended
    daily_budget_micros BIGINT NOT NULL, -- microdollars (1 USD = 1_000_000)
    total_budget_micros BIGINT NOT NULL,
    start_date  DATE,
    end_date    DATE,
    targeting   JSONB,        -- geo, age, interests, devices
    cpm_bid_micros     BIGINT NOT NULL, -- max CPM bid in microdollars
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Creatives (ad content)
CREATE TABLE creatives (
    id          VARCHAR(36) PRIMARY KEY,
    campaign_id VARCHAR(36),
    format      VARCHAR(20),  -- banner, video, native
    width       SMALLINT,
    height      SMALLINT,
    content_url TEXT,         -- S3 URL for image/video
    click_url   TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Impression log (ClickHouse for high write throughput)
-- Columnar storage: aggregations read only the columns they touch
CREATE TABLE impressions (
    auction_id  VARCHAR(36),
    ad_id       VARCHAR(36),
    campaign_id VARCHAR(36),
    user_id     VARCHAR(64),
    domain      VARCHAR(200),
    win_price_micros Int64, -- CPM in microdollars
    is_fraud    UInt8,
    timestamp   DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (campaign_id, timestamp) -- primary index for campaign/time queries
PARTITION BY toYYYYMMDD(timestamp)
TTL timestamp + INTERVAL 90 DAY;

-- Click log (ClickHouse)
CREATE TABLE clicks (
    impression_id VARCHAR(36),
    ad_id        VARCHAR(36),
    user_id      VARCHAR(64),
    ip           VARCHAR(45),
    is_fraud     UInt8,
    timestamp    DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (ad_id, timestamp)
PARTITION BY toYYYYMMDD(timestamp)
TTL timestamp + INTERVAL 90 DAY;
```

---
