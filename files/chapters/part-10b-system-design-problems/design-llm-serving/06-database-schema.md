## Database Schema

The database schema tracks three core concerns: inference requests for billing and audit trails, a model registry for pricing and availability, and user quotas for enforcing rate limits. The request log is partitioned by timestamp because LLM platforms generate millions of records daily, and time-range queries (for billing periods and usage dashboards) must remain fast. Indexes on user_id and model ensure that per-customer usage lookups and per-model analytics queries perform efficiently.

```sql
-- Request log (for billing, audit, rate limiting)
CREATE TABLE inference_requests (
    id              VARCHAR(36) NOT NULL,
    user_id         VARCHAR(36) NOT NULL,
    model           VARCHAR(50),
    prompt_tokens   INT,
    completion_tokens INT,
    cached_tokens   INT,
    total_tokens    INT,
    ttft_ms         INT,         -- time-to-first-token
    duration_ms     INT,
    status          VARCHAR(20), -- completed, error, canceled
    created_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (id, created_at) -- partition key must be part of the PK
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_requests_user  ON inference_requests (user_id, created_at DESC);
CREATE INDEX idx_requests_model ON inference_requests (model, created_at DESC);

-- Models registry
CREATE TABLE models (
    id              VARCHAR(50) PRIMARY KEY,  -- e.g., gpt-4, claude-3-sonnet
    display_name    VARCHAR(100),
    parameters      BIGINT,      -- parameter count
    context_length  INT,         -- max tokens
    price_per_1k_prompt_tokens_micros    BIGINT NOT NULL, -- microdollars (1 USD = 1_000_000)
    price_per_1k_completion_tokens_micros BIGINT NOT NULL, -- microdollars (1 USD = 1_000_000)
    is_available    BOOLEAN DEFAULT TRUE
);

-- User quotas and rate limits
CREATE TABLE user_quotas (
    user_id         VARCHAR(36) PRIMARY KEY,
    tier            VARCHAR(20),  -- free, starter, pro, enterprise
    tokens_per_min  INT,
    tokens_per_day  BIGINT,
    tokens_used_today BIGINT DEFAULT 0,
    reset_at        TIMESTAMP
);
```

---
