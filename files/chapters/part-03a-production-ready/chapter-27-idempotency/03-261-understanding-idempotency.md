## 27.1 Understanding Idempotency

### Why Idempotency Matters

Network failures create ambiguity: when a TCP connection drops after a payment request is sent but before the response arrives, the client cannot tell whether the charge succeeded. Without idempotency, every retry risks executing the operation again, double-charging a customer, creating duplicate orders, or sending duplicate notifications. Idempotency keys give the server a way to recognize a repeated request and return the cached outcome instead of re-executing it.

```
Network timeout scenarios:
1. Request sent, response never received
2. Did the operation succeed or fail?
3. Is it safe to retry?

Without idempotency: Retry might double-charge customer
With idempotency: Retry is always safe
```

### Types of Idempotency

HTTP semantics already define idempotency for several methods: `GET`, `PUT`, and `DELETE` are safe to repeat because they either read state or replace it entirely. `POST` has no such guarantee, each call typically creates a new resource. `PATCH` is especially dangerous because an increment-style patch (`balance += 10`) applied twice corrupts data, even though a replace-style patch is safe. Knowing which operations are naturally idempotent determines where you need to add explicit key-based deduplication.

```http
// Naturally idempotent operations
GET /users/123           // Reading is idempotent
DELETE /users/123        // Delete same resource = same result
PUT /users/123 {data}    // Replace with same data = same result

// NOT naturally idempotent
POST /payments           // Creates new payment each time
POST /orders             // Creates new order each time
PATCH /users/123         // Incremental changes may not be idempotent
```

### Staff Lens: Design for Retry Safety

When designing new APIs, start with "what happens on retry?". Design idempotency in. Adding it later is more expensive.

---
