## Additional Schemas and Redis Structures

These schemas and Redis key structures complete the data model for the ad system. The SQL tables handle billing records, publisher payouts, and frequency cap configuration in PostgreSQL, while the Redis structures show the in-memory data layout that powers the real-time auction path. Understanding these Redis key patterns is important because each key is designed with a specific TTL and data type (HASH, STRING, SET, ZSET) chosen to match the access pattern. For example, frequency counters use simple STRINGs with INCR for atomic counting, while targeting indexes use SETs for efficient union and intersection operations.

```sql
-- Monetary columns are BIGINT micro-dollars (1 USD = 1,000,000 micros)
CREATE TABLE invoices (id UUID PRIMARY KEY, advertiser_id VARCHAR(36), period VARCHAR(7), total_micros BIGINT, fee_micros BIGINT, grand_micros BIGINT, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW(), paid_at TIMESTAMP);
CREATE TABLE publisher_payouts (id UUID PRIMARY KEY, publisher_id VARCHAR(36), period VARCHAR(7), gross_micros BIGINT, net_micros BIGINT, impressions BIGINT, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
CREATE TABLE frequency_caps (campaign_id VARCHAR(36) PRIMARY KEY, max_per_hour INT DEFAULT 3, max_per_day INT DEFAULT 10, max_per_week INT DEFAULT 30, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE billing_events (id BIGSERIAL PRIMARY KEY, advertiser_id VARCHAR(36), campaign_id VARCHAR(36), publisher_id VARCHAR(36), event_type VARCHAR(20), cost_micros BIGINT, is_fraud BOOLEAN DEFAULT FALSE, period VARCHAR(7), created_at TIMESTAMP DEFAULT NOW());
```

```
Redis structures:
  HASH budget:{campaign_id}:{date}     - daily_budget, remaining, spent
  STRING freq:{uid}:{cid}:h:{hour}     - hourly impression count (TTL 2h)
  STRING freq:{uid}:{cid}:d:{date}     - daily count (TTL 25h)
  SET campaigns:geo:{country}          - campaign IDs targeting this country
  SET campaigns:interest:{interest}    - campaign IDs targeting this interest
  HASH campaign:{id}                   - cpm_bid, creative_id, status
  STRING imp:{auction_id}              - ad_id for click validation (TTL 2h)
  ZSET vel:click:ip:{ip}              - click timestamps for velocity check
  SET fraud:blocked_ips                - blocklisted IPs
```


---
