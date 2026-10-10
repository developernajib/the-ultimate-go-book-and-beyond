## 27.10 Company Case Studies

### How Stripe Implements Idempotency

Stripe is widely recognized for their benchmark idempotency implementation:

**Key Design Decisions:**

1. **Client-Generated Keys**: Stripe requires clients to generate and provide idempotency keys, giving them control over retry behavior.

2. **24-Hour TTL**: Keys are stored for 24 hours, allowing retries within a reasonable window while preventing storage bloat.

3. **Request Fingerprinting**: Beyond the idempotency key, Stripe hashes the request body to detect when clients reuse keys with different payloads - returning an error rather than the cached response.

4. **Atomic Operations**: Database transactions ensure that both the business operation and idempotency record are created atomically.

```go
// Stripe-style idempotency pattern
type StripeIdempotencyHandler struct {
    store Store
    ttl   time.Duration
}

func (h *StripeIdempotencyHandler) Handle(ctx context.Context, key string, requestHash string, fn func() (*Response, error)) (*Response, error) {
    // Check for existing request
    existing, err := h.store.Get(ctx, key)
    if err == nil {
        // Verify request matches
        if existing.RequestHash != requestHash {
            return nil, ErrRequestMismatch // "Idempotency key reused with different request"
        }
        return existing.Response, nil
    }

    // Execute with locking
    // ... (similar to our implementation)
}
```

**Lessons from Stripe:**
- Clear error messages help developers understand idempotency semantics
- Request fingerprinting catches accidental key reuse
- Thorough documentation is essential for client adoption

### How Uber Handles Idempotency at Scale

Uber processes millions of ride requests and payments daily, requiring strong idempotency guarantees across their microservices:

**Architecture:**

1. **Centralized Idempotency Service**: A dedicated service handles idempotency for all mission-critical operations.

2. **Multi-Region Replication**: Idempotency data is replicated across regions to handle failover scenarios.

3. **Tiered Storage**: Hot data in Redis, warm data in Cassandra, cold data archived to S3.

```go
// Uber-style tiered idempotency
type TieredIdempotencyStore struct {
    hot   *RedisStore      // Redis for <1 hour
    warm  *CassandraStore  // Cassandra for 1 hour - 7 days
    cold  *S3Store         // S3 for >7 days (audit purposes)
}

func (s *TieredIdempotencyStore) Get(ctx context.Context, key string) (*StoredResponse, error) {
    // Check hot cache first
    if resp, err := s.hot.Get(ctx, key); err == nil {
        return resp, nil
    }

    // Check warm storage
    if resp, err := s.warm.Get(ctx, key); err == nil {
        // Promote back to hot cache
        s.hot.Set(ctx, key, resp, time.Hour)
        return resp, nil
    }

    // Check cold storage (only for audit/compliance)
    return s.cold.Get(ctx, key)
}
```

**Lessons from Uber:**
- Scale requires tiered storage strategies
- Regional failures must not cause duplicate operations
- Audit trails are important for financial transactions

### How Square Ensures Payment Idempotency

Square processes billions in payments and has refined their idempotency approach:

**Key Features:**

1. **Idempotency Scope**: Keys are scoped to the merchant account, preventing cross-account key collisions.

2. **Version-Based Responses**: When replaying responses, Square includes version information to help clients understand the data freshness.

3. **Partial Success Handling**: For batch operations, Square tracks individual item results within an idempotent request.

```go
// Square-style scoped idempotency
type ScopedIdempotencyStore struct {
    store Store
}

func (s *ScopedIdempotencyStore) Get(ctx context.Context, merchantID, key string) (*StoredResponse, error) {
    scopedKey := fmt.Sprintf("merchant:%s:key:%s", merchantID, key)
    return s.store.Get(ctx, scopedKey)
}

// Batch operation with partial tracking
type BatchResult struct {
    IdempotencyKey string                    `json:"idempotency_key"`
    Results        map[string]*ItemResult    `json:"results"`
    PartialSuccess bool                      `json:"partial_success"`
}

type ItemResult struct {
    ItemKey string `json:"item_key"`
    Success bool   `json:"success"`
    Error   string `json:"error,omitempty"`
    Result  any    `json:"result,omitempty"`
}
```

**Lessons from Square:**
- Scoping prevents accidental collisions in multi-tenant systems
- Batch operations need granular tracking
- Version information helps clients handle stale data

### Staff Lens: Learn From Payment Systems

Payment systems face idempotency challenges hardest. Their patterns (Stripe's Idempotency-Key, Square's scoped keys) transfer to most domains. Adopt the proven patterns.

---
