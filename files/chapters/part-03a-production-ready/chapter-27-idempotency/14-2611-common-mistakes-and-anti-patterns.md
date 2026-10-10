## 27.11 Common Mistakes and Anti-Patterns

### Mistake 1: Using Sequential IDs as Idempotency Keys

Sequential counters are not safe idempotency keys because they reset on restart and diverge across multiple server instances, causing key collisions between operations that are not retries of each other. UUIDs or client-generated keys that incorporate stable business identifiers, user ID, order reference, date, provide global uniqueness without coordination.

**Problem:**
```go
// WRONG: Using sequential IDs
counter++
idempotencyKey := fmt.Sprintf("payment-%d", counter)

// If the application restarts, counter resets
// Different servers have different counters
```

**Solution:**
```go
// CORRECT: Use UUIDs or client-generated unique keys
idempotencyKey := uuid.New().String()

// Or for user-facing operations, let clients provide keys
// Key: "user-123-order-2024-01-15-001"
```

### Mistake 2: Storing Only Success Responses

Storing only successful responses means that if an operation fails and the response is lost in transit, the client's retry will execute the operation again, potentially succeeding a second time and creating a duplicate. Storing both success and error outcomes allows a retry to receive the same error response and decide whether to retry with a new key or treat the original error as final.

**Problem:**
```go
// WRONG: Only caching successful responses
func (h *Handler) Process(ctx context.Context, key string, fn func() error) error {
    result, err := fn()
    if err == nil {
        h.store.Set(ctx, key, result) // Only store on success
    }
    return err
}

// Client retries on error, operation might succeed but response failed
// Retry executes operation again = duplicate
```

**Solution:**
```go
// CORRECT: Store all terminal states
func (h *Handler) Process(ctx context.Context, key string, fn func() (*Result, error)) (*Result, error) {
    result, err := fn()

    // Store response regardless of success/failure
    stored := &StoredResponse{
        Result:    result,
        Error:     errToString(err),
        Success:   err == nil,
        CreatedAt: time.Now(),
    }
    h.store.Set(ctx, key, stored)

    return result, err
}
```

### Mistake 3: Ignoring Request Body Changes

Clients sometimes accidentally reuse an idempotency key with a different request body, a copy-paste error or a bug that sends the wrong amount. Comparing a hash of the request body against the stored hash for that key detects this mismatch and returns a `400`, preventing the client from silently getting back a cached response for an entirely different operation.

**Problem:**
```go
// WRONG: Using only the idempotency key
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
    key := r.Header.Get("Idempotency-Key")

    // Same key with different amounts = same response
    // Client might accidentally reuse a key
}
```

**Solution:**
```go
// CORRECT: look up by KEY, compare the fingerprint separately.
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
    key := r.Header.Get("Idempotency-Key")
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "cannot read body", http.StatusBadRequest)
        return
    }

    requestHash := hashRequest(r.Method, r.URL.Path, body)

    // Do NOT discard this error. If the store is unreachable we cannot know
    // whether the key was reused, and proceeding would risk a double effect.
    existing, err := h.store.Get(r.Context(), key)
    if err != nil {
        http.Error(w, "idempotency store unavailable", http.StatusServiceUnavailable)
        return
    }
    if existing != nil && existing.RequestHash != requestHash {
        // 400, not 422: the request is malformed, and no amount of retrying
        // will make it valid. See the note below.
        http.Error(w, "Idempotency-Key was already used with different request parameters",
            http.StatusBadRequest)
        return
    }
    // ... existing != nil && hashes match: replay existing.Response
}
```

> **Two details in that snippet carry the lesson.**
>
> **The status is `400`, not `422`.** This chapter uses `400` throughout because that is Stripe's published contract for key reuse with different parameters, and clients are already written against it. The reasoning behind the choice is what matters: `422` conventionally means "well-formed but semantically rejected", which invites a client to treat it as a business-rule failure it might retry or surface to a user. Key reuse is neither. It is a client-side programming error that will produce the identical response on every retry until the code is fixed. Reserve `409` for a genuinely concurrent in-flight request, which *is* retryable, and use `400` here.
>
> **`existing, _ := h.store.Get(ctx, key)` fails open, in the worst direction.** Discarding that error means a Redis timeout yields `existing == nil`, which reads as "no prior request with this key", which means the handler happily executes the operation again. The one moment your idempotency store is unhealthy is the moment it is most likely to be lying to you about what has already happened, and this code chooses that moment to trust it. If you cannot determine whether a key was used, you cannot safely act. Return `503`, let the client retry, and keep the guarantee.

### The rule underneath all of this

Look at what the fixed code does *not* do: it does not decide whether to execute based on a read. The fingerprint check rejects a bad request, and that is a validation step. The thing that actually prevents double execution has to be an atomic claim, a unique constraint, or a conditional write, as in the sections above. If you take one habit from this chapter, make it this reflex: **whenever you see a read that decides whether a write happens, ask what stops a second caller from reading the same thing before you write.** In a distributed system, the answer is never "nothing much, it's fast".

### Mistake 4: Not Handling Lock Contention

When multiple retries of the same request arrive concurrently, they contend for the idempotency lock. A naive implementation that acquires the lock without a timeout and lacks proper cleanup on panics can leave orphaned locks that block all subsequent requests for that key until the lock's TTL expires.

**Problem:**
```go
// WRONG: Simple lock without timeout
acquired := h.store.Lock(ctx, key)
if !acquired {
    http.Error(w, "Conflict", http.StatusConflict)
    return
}
// No unlock on panic, no timeout consideration
```

**Solution:**
```go
// CORRECT: Proper lock handling with timeout and cleanup
func (h *Handler) Handle(ctx context.Context, key string) error {
    // Try to acquire with timeout
    lockCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    acquired, err := h.store.Lock(lockCtx, key, h.lockTTL)
    if err != nil {
        return fmt.Errorf("lock error: %w", err)
    }
    if !acquired {
        return ErrRequestInProgress
    }

    // Ensure unlock happens
    defer func() {
        unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        h.store.Unlock(unlockCtx, key)
    }()

    // Process request
    return h.process(ctx)
}
```

### Mistake 5: Forgetting Database Transaction Boundaries

Inserting the business record and the outbox event in separate statements creates a window where one can succeed and the other can fail, leaving the system in an inconsistent state, an order without a corresponding event, or an event without an order. Wrapping both inserts in a single database transaction makes the pair atomic: either both commit or both roll back.

**Problem:**
```go
// WRONG: Non-atomic operations
func (s *Service) CreateOrder(ctx context.Context, order *Order) error {
    // Insert order
    s.db.Insert(order)

    // Create outbox message
    s.outbox.Insert(OrderCreatedEvent{...})

    // If outbox insert fails, order exists without event
}
```

**Solution:**
```go
// CORRECT: Use transactions
func (s *Service) CreateOrder(ctx context.Context, order *Order) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Insert order in transaction
    if err := tx.Insert(order); err != nil {
        return err
    }

    // Create outbox message in same transaction
    if err := tx.Insert(OrderCreatedEvent{...}); err != nil {
        return err
    }

    // Both succeed or both fail
    return tx.Commit()
}
```

### Staff Lens: Idempotency Mistakes Cause Data Corruption

A duplicate charge is a real money loss. A duplicate order creates operational chaos. Idempotency mistakes are high-severity. Review carefully.

---
