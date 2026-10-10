## Additional Schemas

These tables handle the financial and regulatory dimensions of the exchange that sit outside the core order lifecycle. `cash_balances` tracks both settled balance and a `hold_amount`, funds reserved against open orders, so the pre-trade risk check can reject orders that would exceed available buying power without requiring a round-trip to a slow settlement system. `margin_requirements` stores per-symbol margin obligations for each trader, enabling the risk engine to calculate real-time exposure across the entire portfolio. `luld_bands` (Limit Up-Limit Down) stores the circuit-breaker boundaries set by the LULD Plan, a national market system plan filed under Rule 608 of Regulation NMS (approved as a pilot in 2012 and made permanent in 2019): any incoming order priced outside the reference-price-derived band is rejected before reaching the matching engine. `order_audit` is range-partitioned by `occurred_at` so that compliance queries covering a specific trading day read only the relevant partition rather than scanning the full historical table. Its primary key is `(id, occurred_at)` rather than `id` alone for the same reason as the `orders` table: PostgreSQL will not accept a unique constraint on a partitioned table unless it contains the partition key.

All money columns are `BIGINT` cents and `NOT NULL`, with no nullable balances anywhere. A `NULL` balance is not a balance of zero, it is a balance nobody can reason about, and it will surface as a failed scan into `int64` rather than as a clean error.

```sql
CREATE TABLE cash_balances (trader_id VARCHAR(36) PRIMARY KEY, balance BIGINT NOT NULL DEFAULT 0, hold_amount BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE margin_requirements (trader_id VARCHAR(36) NOT NULL, symbol VARCHAR(10) NOT NULL, margin_required BIGINT NOT NULL, margin_type VARCHAR(20) NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (trader_id, symbol));
CREATE TABLE luld_bands (symbol VARCHAR(10) PRIMARY KEY, reference_price BIGINT NOT NULL, upper_band BIGINT NOT NULL, lower_band BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE order_audit (id BIGSERIAL, order_id VARCHAR(36) NOT NULL, event_type VARCHAR(20) NOT NULL, sequence BIGINT NOT NULL, price BIGINT NOT NULL, quantity BIGINT NOT NULL, trader_id VARCHAR(36) NOT NULL, symbol VARCHAR(10) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (id, occurred_at)) PARTITION BY RANGE (occurred_at);
```


---
