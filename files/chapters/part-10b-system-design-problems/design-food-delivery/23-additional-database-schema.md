## Additional Database Schema

Beyond the core tables, a production system needs supporting schemas for auditing, driver session tracking, customer address management, and promotions. The `order_status_history` table is particularly important: it creates an immutable audit trail of every state transition, which is invaluable for debugging customer complaints and resolving disputes. The promotions table supports both platform-wide and restaurant-specific discounts with usage limits and date-based validity windows.

```sql
-- Order status history (audit trail)
CREATE TABLE order_status_history (
    order_id     VARCHAR(36) NOT NULL,
    status       VARCHAR(30) NOT NULL,
    actor_id     VARCHAR(36),
    actor_type   VARCHAR(20),  -- customer, driver, restaurant, system
    metadata     JSONB,
    created_at   TIMESTAMP DEFAULT NOW()
);

-- PostgreSQL requires separate CREATE INDEX statements
CREATE INDEX idx_history_order ON order_status_history (order_id, created_at);

-- Driver sessions (online/offline tracking)
CREATE TABLE driver_sessions (
    driver_id    VARCHAR(36) NOT NULL,
    session_start TIMESTAMP NOT NULL,
    session_end  TIMESTAMP,
    city         VARCHAR(50),
    deliveries   INT DEFAULT 0,
    earnings     BIGINT DEFAULT 0  -- cents
);

CREATE INDEX idx_sessions_driver_time ON driver_sessions (driver_id, session_start DESC);

-- Customer addresses
CREATE TABLE customer_addresses (
    id           VARCHAR(36) PRIMARY KEY,
    customer_id  VARCHAR(36) NOT NULL,
    label        VARCHAR(50),  -- Home, Work, etc.
    street       TEXT NOT NULL,
    city         VARCHAR(100),
    zip_code     VARCHAR(20),
    lat          DECIMAL(10,7),
    lng          DECIMAL(10,7),
    is_default   BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_addresses_customer ON customer_addresses (customer_id);

-- Promotions and coupons
CREATE TABLE promotions (
    id           VARCHAR(36) PRIMARY KEY,
    code         VARCHAR(50) UNIQUE,
    type         VARCHAR(20),  -- percentage, fixed_amount, free_delivery
    value        BIGINT,       -- basis points (e.g. 1500 = 15%) for percentage, cents for fixed_amount
    min_order    BIGINT,       -- cents
    max_discount BIGINT,       -- cents
    valid_from   TIMESTAMP,
    valid_until  TIMESTAMP,
    max_uses     INT,
    used_count   INT DEFAULT 0,
    restaurant_id VARCHAR(36)  -- NULL for platform-wide
);

-- code already has a unique index from its UNIQUE constraint
CREATE INDEX idx_promotions_dates ON promotions (valid_from, valid_until);
```
