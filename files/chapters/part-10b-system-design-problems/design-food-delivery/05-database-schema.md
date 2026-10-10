## Database Schema

The database schema reflects the three core entities in the system: orders, restaurants, and drivers. Orders are the most write-heavy table and will need sharding as the platform scales. Notice the strategic use of indexes on foreign keys and status columns, which support the most common query patterns such as fetching a customer's active orders or listing a restaurant's pending orders. The `order_items` table uses a composite primary key to avoid duplicate items within a single order.

```sql
-- Orders
CREATE TABLE orders (
    id                   VARCHAR(36) PRIMARY KEY,
    customer_id          VARCHAR(36) NOT NULL,
    restaurant_id        VARCHAR(36) NOT NULL,
    driver_id            VARCHAR(36),
    status               VARCHAR(30) NOT NULL,
    subtotal             BIGINT,  -- cents
    delivery_fee         BIGINT,  -- cents
    service_fee          BIGINT,  -- cents
    tax                  BIGINT,  -- cents
    total_price          BIGINT,  -- cents
    delivery_lat         DECIMAL(10,7),
    delivery_lng         DECIMAL(10,7),
    delivery_address     TEXT,
    estimated_pickup     TIMESTAMP,
    estimated_delivery   TIMESTAMP,
    actual_delivery      TIMESTAMP,
    created_at           TIMESTAMP DEFAULT NOW(),
    updated_at           TIMESTAMP DEFAULT NOW()
);

-- PostgreSQL requires separate CREATE INDEX statements
CREATE INDEX idx_orders_customer   ON orders (customer_id, created_at DESC);
CREATE INDEX idx_orders_restaurant ON orders (restaurant_id, created_at DESC);
CREATE INDEX idx_orders_driver     ON orders (driver_id, created_at DESC);
CREATE INDEX idx_orders_status     ON orders (status, created_at);

-- Order items
CREATE TABLE order_items (
    order_id        VARCHAR(36) REFERENCES orders(id),
    menu_item_id    VARCHAR(36),
    name            VARCHAR(200),
    quantity        SMALLINT,
    price           BIGINT,  -- cents
    customizations  TEXT[],
    PRIMARY KEY (order_id, menu_item_id)
);

-- Restaurants
CREATE TABLE restaurants (
    id              VARCHAR(36) PRIMARY KEY,
    name            VARCHAR(200),
    cuisine_type    VARCHAR(50),
    lat             DECIMAL(10,7),
    lng             DECIMAL(10,7),
    address         TEXT,
    rating          DECIMAL(3,2),
    is_open         BOOLEAN,
    prep_time_min   SMALLINT DEFAULT 20,
    delivery_radius_km DECIMAL(5,2) DEFAULT 5.0
);

-- Drivers
CREATE TABLE drivers (
    id           VARCHAR(36) PRIMARY KEY,
    name         VARCHAR(100),
    phone        VARCHAR(20),
    vehicle_type VARCHAR(20),
    rating       DECIMAL(3,2) DEFAULT 5.0,
    total_deliveries INT DEFAULT 0,
    acceptance_rate DECIMAL(5,2) DEFAULT 1.0
);
```

---
