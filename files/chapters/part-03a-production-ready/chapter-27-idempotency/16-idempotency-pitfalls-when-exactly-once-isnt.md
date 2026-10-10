## Idempotency Pitfalls: When Exactly-Once Isn't

This section covers the most dangerous idempotency mistakes that cause duplicate charges, lost messages, and data corruption.

### The Double Charge Disaster

**The Incident**: Network timeout during payment. Client retried. Customer charged twice.

```go
// WRONG: Non-idempotent payment processing

func handlePayment(w http.ResponseWriter, r *http.Request) {
    var req PaymentRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Charge the card (NOT IDEMPOTENT!)
    result, err := stripe.Charges.Create(&stripe.ChargeParams{
        Amount:   stripe.Int64(req.Amount),
        Currency: stripe.String("usd"),
        Source:   stripe.String(req.CardToken),
    })

    if err != nil {
        // Client times out here, never sees response
        // Client retries = DOUBLE CHARGE
        http.Error(w, err.Error(), 500)
        return
    }

    json.NewEncoder(w).Encode(result)
}
```

```go
// CORRECT: Idempotent payment with idempotency key

func handlePayment(w http.ResponseWriter, r *http.Request) {
    // 1. Get idempotency key from header (client-provided)
    idempotencyKey := r.Header.Get("Idempotency-Key")
    if idempotencyKey == "" {
        http.Error(w, "Idempotency-Key header required", 400)
        return
    }

    // 2. Fast path only. This lookup is a CACHE, not the guarantee: two
    //    concurrent retries can both miss here. See the note below.
    existing, err := db.GetPaymentByIdempotencyKey(r.Context(), idempotencyKey)
    if err != nil && !errors.Is(err, sql.ErrNoRows) {
        // Cannot tell whether this was already charged. Do not guess.
        http.Error(w, "idempotency lookup failed", http.StatusServiceUnavailable)
        return
    }
    if existing != nil {
        json.NewEncoder(w).Encode(existing)
        return
    }

    var req PaymentRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    // 3. THE GUARANTEE. Stripe dedupes on this key server-side, so even if
    //    two of our goroutines both reach this line, only one charge exists.
    result, err := stripe.Charges.Create(&stripe.ChargeParams{
        Amount:   stripe.Int64(req.Amount),
        Currency: stripe.String("usd"),
        Source:   stripe.String(req.CardToken),
    }, stripe.SetIdempotencyKey(idempotencyKey))

    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }

    // 4. Persist for the fast path. The payments table must have a UNIQUE
    //    constraint on idempotency_key: that, not this call, is what makes
    //    the local record safe under concurrency.
    if err := db.SavePayment(r.Context(), idempotencyKey, result); err != nil {
        // The charge SUCCEEDED. Losing this record only costs us a slower
        // duplicate detection next time, because Stripe still holds the key.
        // Never return an error to the client here: they would retry a
        // charge that already went through.
        log.Error("charge succeeded but local record failed", "key", idempotencyKey, "error", err)
    }

    json.NewEncoder(w).Encode(result)
}
```

> **The local lookup in step 2 is a race, and that is fine here only because of step 3.** Two concurrent retries can both run `GetPaymentByIdempotencyKey`, both see nothing, and both proceed to charge. Nothing in the Go code prevents it: a read followed by a write is never a guarantee, no matter how small the gap looks.
>
> What saves this handler is `stripe.SetIdempotencyKey(idempotencyKey)`. Stripe enforces the key on its side, atomically, so two concurrent creates with the same key produce one charge and both callers get the same charge object back. **The guarantee lives in Stripe's database, not in yours.** The local lookup is a latency optimization that avoids a network round trip on the common retry.
>
> That reframing tells you exactly what breaks it. Delete the `SetIdempotencyKey` line and the code still compiles, still passes every sequential test, and double-charges under concurrent retries, with the local check providing nothing but false confidence. If you take one line from this whole file, take that one: it is the load-bearing wall, and the rest is trim.
>
> The same logic dictates the error handling. If `SavePayment` fails, the money has already moved, so returning a `500` would invite the client to retry a completed charge. Log it and return success, because Stripe's key still protects the retry. But if `GetPaymentByIdempotencyKey` fails, you genuinely do not know whether you charged this key before, and the honest answer is `503`, not a guess.

### The Outbox Race Condition

**The Problem**: Event published before transaction commits. Consumer processes event, but transaction rolls back.

```go
// WRONG: Publish before commit

func createOrder(ctx context.Context, order Order) error {
    tx, _ := db.BeginTx(ctx, nil)

    // Insert order
    _, err := tx.Exec("INSERT INTO orders ...")
    if err != nil {
        tx.Rollback()
        return err
    }

    // Publish event BEFORE commit
    kafka.Publish("order-created", order)  // 🚨 Message sent!

    // What if this fails?
    err = tx.Commit()
    if err != nil {
        // 🚨 DISASTER: Event already published, but order doesn't exist!
        // Consumer tries to process non-existent order
        return err
    }

    return nil
}
```

```go
// CORRECT: Transactional outbox pattern

func createOrder(ctx context.Context, order Order) error {
    tx, _ := db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Insert order
    _, err := tx.ExecContext(ctx, "INSERT INTO orders ...")
    if err != nil {
        return err
    }

    // Insert event into outbox (SAME TRANSACTION)
    eventPayload, _ := json.Marshal(OrderCreatedEvent{OrderID: order.ID})
    _, err = tx.ExecContext(ctx,
        "INSERT INTO outbox (event_type, payload, created_at) VALUES ($1, $2, $3)",
        "order-created", eventPayload, time.Now(),
    )
    if err != nil {
        return err
    }

    // Commit both or neither
    return tx.Commit()
}

// Separate process reads outbox and publishes.
func publishOutbox(ctx context.Context) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // The FOR UPDATE SKIP LOCKED row locks are held for the life of THIS tx.
    // Run this on db instead of tx and the locks evaporate instantly, letting
    // every replica claim the same rows.
    rows, err := tx.QueryContext(ctx, `
        SELECT id, event_type, payload FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at LIMIT 100
        FOR UPDATE SKIP LOCKED
    `)
    if err != nil {
        return err
    }

    // Drain rows fully BEFORE issuing any other statement on this tx. A
    // connection can only have one active result set: calling tx.Exec while
    // rows is still open fails. Collect first, then act.
    type event struct {
        id        int64
        eventType string
        payload   []byte
    }
    var events []event
    for rows.Next() {
        var e event
        if err := rows.Scan(&e.id, &e.eventType, &e.payload); err != nil {
            rows.Close()
            return err
        }
        events = append(events, e)
    }
    rows.Close()
    if err := rows.Err(); err != nil {
        return err
    }

    for _, e := range events {
        if err := kafka.Publish(e.eventType, e.payload); err != nil {
            // Roll back the batch. The rows stay unpublished and are picked
            // up next tick. Do not swallow this.
            return fmt.Errorf("publish %d: %w", e.id, err)
        }
        if _, err := tx.ExecContext(ctx,
            "UPDATE outbox SET published_at = $1 WHERE id = $2", time.Now(), e.id); err != nil {
            return err
        }
    }

    // Crash between the Publish above and this Commit republishes the batch.
    // That is at-least-once, and it is why consumers must dedup.
    return tx.Commit()
}
```

### The Consumer Duplicate

**The Problem**: Consumer processes message, crashes before acknowledging. Message redelivered and processed again.

```go
// WRONG: Process then ack

func consumeMessages() {
    for msg := range kafka.Messages() {
        // Process the message
        err := processOrder(msg.Value)  // 🚨 Takes 30 seconds

        if err != nil {
            // Don't ack, will retry
            continue
        }

        msg.Ack()  // 🚨 Crash before this = duplicate processing
    }
}
```

```go
// CORRECT: Idempotent consumer with deduplication

func consumeMessages() {
    for msg := range kafka.Messages() {
        messageID := msg.Headers["message-id"]

        // Atomically claim the message. `claimed` is true only if WE set it.
        claimed, err := redis.SetNX(ctx,
            "processed:"+messageID,
            "1",
            24*time.Hour,  // TTL for dedup window
        ).Result()

        // Check the error FIRST. On a Redis failure `claimed` is false, which
        // is indistinguishable from "already processed" if you ignore err.
        // Acking there would silently discard an unprocessed message.
        if err != nil {
            log.Error("dedup store unavailable, not acking", "id", messageID, "error", err)
            continue // no ack: let Kafka redeliver once Redis recovers
        }

        if !claimed {
            // Genuinely already processed. Safe to ack.
            msg.Ack()
            continue
        }

        // Process with idempotent operations
        if err := processOrderIdempotent(msg.Value); err != nil {
            // Release the claim, or the redelivery is mistaken for a
            // duplicate and dropped: the message would be lost forever.
            if delErr := redis.Del(ctx, "processed:"+messageID).Err(); delErr != nil {
                log.Error("could not release dedup claim, message may be lost",
                    "id", messageID, "error", delErr)
            }
            continue  // Will be redelivered
        }

        msg.Ack()
    }
}

func processOrderIdempotent(payload []byte) error {
    var order Order
    json.Unmarshal(payload, &order)

    // Use INSERT ... ON CONFLICT DO NOTHING
    // This is naturally idempotent
    _, err := db.Exec(`
        INSERT INTO processed_orders (order_id, status, processed_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (order_id) DO NOTHING
    `, order.ID, order.Status, time.Now())

    return err
}
```

### The Idempotency Key Collision

**The Problem**: Idempotency key too short or predictable. Collisions cause wrong responses.

```go
// WRONG: Weak idempotency keys

func generateKey() string {
    return fmt.Sprintf("%d", time.Now().UnixNano())
    // 🚨 Two requests in same nanosecond = collision
}

func generateKey2() string {
    return fmt.Sprintf("order-%d", orderID)
    // 🚨 Reused for different operations on same order
}

func generateKey3() string {
    return uuid.New().String()[:8]  // Truncated UUID
    // 🚨 Only 32 bits of entropy, collision likely at scale
}
```

```go
// CORRECT: Strong idempotency keys

func generateKey() string {
    // Full UUID v4 = 122 bits of randomness
    return uuid.New().String()
}

// Or deterministic key from request content:
func generateDeterministicKey(userID string, action string, params map[string]string) string {
    // Hash of user + action + params = same input always produces same key
    h := sha256.New()
    h.Write([]byte(userID))
    h.Write([]byte(action))

    // Sort params for consistency
    keys := make([]string, 0, len(params))
    for k := range params {
        keys = append(keys, k)
    }
    slices.Sort(keys)
    for _, k := range keys {
        h.Write([]byte(k))
        h.Write([]byte(params[k]))
    }

    return hex.EncodeToString(h.Sum(nil))
}

// Client generates same key for retry:
// key := generateDeterministicKey("user-123", "charge", map[string]string{
//     "amount": "1000",
//     "currency": "usd",
// })
```

### The Stale Idempotency Response

**The Problem**: Idempotency key cached forever. Old response returned for new request with reused key.

```go
// WRONG: Infinite cache

var idempotencyCache = make(map[string]Response)  // Never expires!

func handleRequest(key string, req Request) Response {
    if cached, ok := idempotencyCache[key]; ok {
        return cached  // Could be months old!
    }
    // ...
}
```

```go
// CORRECT: TTL-based cache with appropriate window

type IdempotencyStore struct {
    redis *redis.Client
    ttl   time.Duration  // Typically 24-72 hours
}

func (s *IdempotencyStore) Get(key string) (*Response, error) {
    data, err := s.redis.Get(ctx, "idem:"+key).Bytes()
    if err == redis.Nil {
        return nil, nil  // Not found
    }
    if err != nil {
        return nil, err
    }

    var resp Response
    json.Unmarshal(data, &resp)
    return &resp, nil
}

func (s *IdempotencyStore) Set(key string, resp Response) error {
    data, _ := json.Marshal(resp)
    return s.redis.Set(ctx, "idem:"+key, data, s.ttl).Err()
}

// TTL Considerations:
// - Too short: Client retries after TTL get different results
// - Too long: Storage costs, stale responses
// - Typical: 24 hours for API requests
// - Payment: 72+ hours (match dispute window)
```

### Production Idempotency State Machine with Redis Auto-Expiring Locks

A common production defect occurs when a worker acquiring an idempotency lock crashes or is terminated by the kernel (OOM) before storing the final response. Without an expiring lease, the key remains permanently locked, returning continuous conflicts to the client.

A production pattern uses a three-state machine (`IN_PROGRESS`, `SUCCESS`, `FAILED`) backed by Redis `SET NX EX`, as analyzed by [Dicky Perdian (July 2026), "Building a Production-Ready Idempotency Helper in Golang with Redis"](https://medium.com/@dickyperdian/building-a-production-ready-idempotency-helper-in-golang-with-redis-c08182ec83c2) and [Feildrix (June 2026), "Idempotency in Go: Stop Charging Your Users Twice"](https://medium.com/@feildrix/idempotency-in-go-stop-charging-your-users-twice-8e31a860b81c).

```go
package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	ErrRequestInProgress = errors.New("request currently in progress")
	ErrPayloadMismatch   = errors.New("idempotency key reused with different payload")
)

type State string

const (
	StateInProgress State = "IN_PROGRESS"
	StateSuccess    State = "SUCCESS"
	StateFailed     State = "FAILED"
)

type Record struct {
	State       State  `json:"state"`
	PayloadHash string `json:"payload_hash"`
	StatusCode  int    `json:"status_code"`
	Response    []byte `json:"response"`
}

type RedisIdempotencyHelper struct {
	client     *redis.Client
	lockTTL    time.Duration
	successTTL time.Duration
}

func NewRedisIdempotencyHelper(client *redis.Client, lockTTL, successTTL time.Duration) *RedisIdempotencyHelper {
	return &RedisIdempotencyHelper{
		client:     client,
		lockTTL:    lockTTL,
		successTTL: successTTL,
	}
}

func (h *RedisIdempotencyHelper) Execute(
	ctx context.Context,
	key string,
	payload []byte,
	fn func(ctx context.Context) (int, []byte, error),
) (int, []byte, error) {
	hash := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(hash[:])
	redisKey := fmt.Sprintf("idempotency:%s", key)

	initialRecord := Record{
		State:       StateInProgress,
		PayloadHash: payloadHash,
	}
	data, _ := json.Marshal(initialRecord)

	// Atomic lock acquisition with automatic expiration
	acquired, err := h.client.SetNX(ctx, redisKey, data, h.lockTTL).Result()
	if err != nil {
		return 0, nil, err
	}

	if !acquired {
		// Key already exists: inspect current state
		val, err := h.client.Get(ctx, redisKey).Bytes()
		if err != nil {
			return 0, nil, err
		}

		var existing Record
		if err := json.Unmarshal(val, &existing); err != nil {
			return 0, nil, err
		}

		if existing.PayloadHash != payloadHash {
			return 0, nil, ErrPayloadMismatch
		}

		if existing.State == StateInProgress {
			return 0, nil, ErrRequestInProgress
		}

		return existing.StatusCode, existing.Response, nil
	}

	// Execute business operation
	statusCode, respBytes, opErr := fn(ctx)
	if opErr != nil {
		// Record failure so subsequent retries can proceed or inspect
		failedRecord := Record{
			State:       StateFailed,
			PayloadHash: payloadHash,
			StatusCode:  statusCode,
		}
		failData, _ := json.Marshal(failedRecord)
		_ = h.client.Set(ctx, redisKey, failData, 1*time.Minute).Err()
		return statusCode, nil, opErr
	}

	// Persist successful terminal state
	successRecord := Record{
		State:       StateSuccess,
		PayloadHash: payloadHash,
		StatusCode:  statusCode,
		Response:    respBytes,
	}
	successData, _ := json.Marshal(successRecord)
	_ = h.client.Set(ctx, redisKey, successData, h.successTTL).Err()

	return statusCode, respBytes, nil
}
```

### Multi-Phase Financial Settlement & Double-Charge Prevention

In distributed banking systems, payment operations cannot rely solely on HTTP request-response cycles due to client timeout disconnections during TCP handshakes, as documented in Revolut's payment architecture by [Vladyslav Kekukh (July 2026), "Idempotency in Payment Systems: How Revolut Prevents Double Charges"](https://medium.com/@vladyslavkekukh/idempotency-in-payment-systems-how-revolut-prevents-double-charges-4ee5ad73105a).

```
Client App                   API Gateway               Core Ledger            Payment Gateway
    │                             │                         │                        │
    ├─── 1. POST /payments ──────►│                         │                        │
    │    (Key: req_uuid_99)       ├── 2. Reserve Intent ───►│                        │
    │                             │   (State: RESERVED)     │                        │
    │                             │                         │                        │
    │                             ├── 3. Dispatch Charge ───────────────────────────►│
    │                             │      (Idempotency: req_uuid_99)                  │
    │                             │                                                  │
    │   [Client disconnects       │                                                  │
    │    network timeout]         │◄── 4. 200 OK Authorized ─────────────────────────┤
    │                             │                                                  │
    │                             ├── 5. Commit Ledger ────►│                        │
    │                             │   (State: COMMITTED)    │                        │
    │                             │                         │                        │
    ├─── 6. RETRY /payments ─────►│                         │                        │
    │    (Key: req_uuid_99)       ├── 7. Lookup Intent ────►│                        │
    │                             │   (Return COMMITTED)    │                        │
    │◄── 8. 200 OK (Replayed) ────┤                         │                        │
```

The protocol separates payment execution into three distinct phases:
1. **Intent Reservation**: Before calling downstream card networks or clearing houses, write an immutable record with state `RESERVED` and a unique constraint on `(account_id, idempotency_key)` in the primary relational database. This claims the funds and blocks concurrent double-clicks.
2. **Deterministic Gateway Dispatch**: Forward the payment intent ID to the external gateway as its client reference. If the payment gateway receives two identical reference IDs, its own deduplication mechanism prevents a secondary card charge.
3. **Ledger Commit & Reconciliation**: Upon receiving gateway authorization, update the local intent to `COMMITTED` within the same transaction that updates double-entry balance journals. If the client dropped connection before step 4, the eventual webhook or client retry discovers the `COMMITTED` intent and returns the stored confirmation without re-initiating bank transfer calls.

### Quick Reference: Idempotency Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| No idempotency key | Duplicate operations on retry | Require client key or generate deterministically |
| Publish before commit | Ghost events | Transactional outbox pattern |
| Process-then-ack | Duplicate processing | Idempotent operations + dedup cache |
| Weak key generation | Collisions | Full UUIDs or strong hashes |
| Infinite cache | Stale responses | TTL-based storage |
| Non-atomic check-and-process | Race conditions | Transactions or atomic operations |
| Permanent lock on crash | Service outage for user | Auto-expiring lease with state machine |
| Gateway retry mismatch | Double card charge | Propagate client idempotency key to external processor |

### Staff Lens: Test Idempotency Explicitly

Every mutation endpoint should have a test: "calling with the same idempotency key twice produces exactly one effect". Without the test, regressions are invisible until production.

---
