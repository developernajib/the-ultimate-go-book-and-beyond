## Additional Database Schemas

These schemas extend the core database design to cover billing, fine-tuning, and per-customer model customization. The usage_records table is partitioned by timestamp for the same reason as inference_requests: millions of rows per day require efficient time-range queries for monthly invoicing. The fine_tuning_jobs and lora_adapters tables track the lifecycle of customer model customizations, from training job submission through to the deployed LoRA adapter that gets loaded at inference time.

```sql
-- Usage records (per-request billing)
-- Cost columns are integer micro-dollars (1e-6 USD) to match the
-- billing service and avoid floating-point money
CREATE TABLE usage_records (
    request_id        VARCHAR(36) NOT NULL,
    user_id           VARCHAR(36) NOT NULL,
    model             VARCHAR(50),
    prompt_tokens     INT,
    completion_tokens INT,
    cached_tokens     INT,
    total_tokens      INT,
    prompt_cost       BIGINT,      -- micro-dollars
    completion_cost   BIGINT,      -- micro-dollars
    total_cost        BIGINT,      -- micro-dollars
    ttft_ms           INT,
    duration_ms       INT,
    status            VARCHAR(20), -- completed, error, canceled
    created_at        TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (request_id, created_at) -- partition key must be part of the PK
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_usage_user  ON usage_records (user_id, created_at DESC);
CREATE INDEX idx_usage_model ON usage_records (model, created_at DESC);

-- Monthly invoices
CREATE TABLE invoices (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id           VARCHAR(36) NOT NULL,
    period            VARCHAR(7),
    total_requests    INT,
    total_tokens      BIGINT,
    total_cost        BIGINT,      -- micro-dollars
    status            VARCHAR(20) DEFAULT 'pending',
    created_at        TIMESTAMP DEFAULT NOW(),
    paid_at           TIMESTAMP
);

-- Fine-tuning jobs
CREATE TABLE fine_tuning_jobs (
    id                VARCHAR(50) PRIMARY KEY,
    user_id           VARCHAR(36),
    base_model        VARCHAR(50),
    training_file     TEXT,         -- S3 key
    validation_file   TEXT,
    hyperparameters   JSONB,
    status            VARCHAR(20),  -- pending, running, completed, failed
    trained_tokens    BIGINT,
    result_model_id   VARCHAR(50),  -- ID of the fine-tuned model
    error_message     TEXT,
    created_at        TIMESTAMP DEFAULT NOW(),
    completed_at      TIMESTAMP
);

-- LoRA adapters (per-customer model customizations)
CREATE TABLE lora_adapters (
    id                VARCHAR(50) PRIMARY KEY,
    user_id           VARCHAR(36),
    base_model        VARCHAR(50),
    adapter_s3_key    TEXT,
    adapter_size_mb   INT,
    created_from      VARCHAR(50),  -- fine_tuning_job_id
    is_active         BOOLEAN DEFAULT TRUE,
    created_at        TIMESTAMP DEFAULT NOW()
);
```

---
