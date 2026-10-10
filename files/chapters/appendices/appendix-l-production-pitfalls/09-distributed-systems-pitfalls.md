## Distributed Systems Pitfalls

When building distributed Go services across multiple nodes and microservices, partial network partitions, non-deterministic clock drift, and non-idempotent retries become routine occurrences. Architecting for failure requires defensive concurrency patterns.

---

### 1. Non-Idempotent Retries & Duplicate Billing

#### Root Cause Mechanics
Network timeouts are ambiguous: when a client times out waiting for an HTTP response, the server may have successfully processed the transaction, failed before processing, or crashed while writing the response. If the client retries the request without an **Idempotency Key**, the server executes the mutation a second time, resulting in double-charging credit cards or duplicate database entries.

#### Production-Grade Solution
```go
// Enforce idempotency using atomic Redis set-if-not-exists (SETNX)
func ProcessPayment(ctx context.Context, rdb *redis.Client, idempotencyKey string, payment Payment) error {
    lockKey := "idemp:" + idempotencyKey

    // 1. Try to acquire lock with 24-hour expiration
    acquired, err := rdb.SetNX(ctx, lockKey, "PROCESSING", 24*time.Hour).Result()
    if err != nil {
        return fmt.Errorf("redis error: %w", err)
    }
    if !acquired {
        // Idempotency key already exists: return cached status or reject duplicate
        status, _ := rdb.Get(ctx, lockKey).Result()
        return fmt.Errorf("duplicate request: current state %s", status)
    }

    // 2. Execute mutation
    if err := executeStripeCharge(ctx, payment); err != nil {
        _ = rdb.Del(ctx, lockKey) // Clear lock on failure so retry can proceed
        return err
    }

    // 3. Mark completed
    _ = rdb.Set(ctx, lockKey, "COMPLETED", 24*time.Hour)
    return nil
}
```

---

### 2. Context Cancellation Across Goroutine Boundaries

#### Root Cause Mechanics
Passing an HTTP request context (`r.Context()`) to an asynchronous background worker goroutine causes the worker to terminate abruptly if the user cancels the request or closes their browser tab. If the worker was writing an audit log or updating an analytics counter, the operation is lost mid-flight.

#### Production-Grade Solution
```go
// Use context.WithoutCancel (introduced in Go 1.21) to retain trace values while detaching cancellation:
func HandleOrder(w http.ResponseWriter, r *http.Request) {
    order := parseOrder(r)
    
    // Detach context cancellation but preserve OpenTelemetry trace spans and baggage
    bgCtx := context.WithoutCancel(r.Context())
    
    go func() {
        // Safe: will complete even if client browser terminates connection
        auditLogger.LogOrder(bgCtx, order)
    }()
    
    w.WriteHeader(http.StatusAccepted)
}
```
