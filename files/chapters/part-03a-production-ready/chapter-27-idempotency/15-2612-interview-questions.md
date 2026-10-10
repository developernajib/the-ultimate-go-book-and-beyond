## 27.12 Interview Questions

### Question 1: What is idempotency and why is it important in distributed systems?

**What FAANG expects:** A precise definition that separates idempotency from safety and from determinism, followed by concrete network-failure scenarios. Candidates who conflate "same input, same output" (determinism) with "same effect" (idempotency) get marked down. Mention the three failure modes retries protect against: (1) request lost before server, (2) request processed but response lost, (3) client timeout with unknown server state.

**Answer:**
Idempotency means that performing an operation multiple times has the same effect as performing it once. It's crucial in distributed systems because:

1. **Network Uncertainty**: Networks can fail at any point - after sending a request but before receiving a response. Without idempotency, retrying could cause duplicate operations.

2. **At-Least-Once Delivery**: Most message queues provide at-least-once delivery, meaning messages may be delivered multiple times. Idempotent consumers prevent duplicate processing.

3. **Retry Safety**: Clients need to retry failed requests without fear of duplicate side effects (like double-charging a credit card).

**Example:**
```http
// Naturally idempotent: GET, DELETE (on same resource), PUT (full replacement)
// NOT naturally idempotent: POST (creates new resources), PATCH (incremental updates)

// Making a non-idempotent operation idempotent:
POST /payments
Idempotency-Key: abc123
{ "amount_cents": 10000, "currency": "USD" }

// First call: Creates payment, stores result with key "abc123"
// Retry call: Returns cached result, no new payment created
```

**Follow-ups:**
- *Is PUT idempotent? Is DELETE?* PUT yes (full replacement, repeated calls converge to the same state). DELETE is idempotent in terms of end state (resource is gone), but often returns 404 on the second call, the state is idempotent even if the response code differs.
- *Is POST ever idempotent?* Only with an idempotency key layer, or when the server derives a natural key from the payload (see Q6).
- *What's the difference between idempotency and safety?* Safe = no side effects at all (GET, HEAD). Idempotent = side effects don't compound on retry. All safe methods are idempotent, not vice versa.

### Question 2: How would you design an idempotency system for a payment service?

**What FAANG expects:** A layered design that references Stripe's public contract (24h key retention, same-body requirement, 409 on concurrent same-key, key scoped to account+endpoint). Interviewers want to hear about the race between two concurrent retries (the double-checked lock), what happens if the worker crashes mid-charge (two-phase state: started, then completed), and how you detect "same key, different body" abuse. Bonus points for discussing key storage tradeoffs (Redis for speed vs Postgres for durability, most production systems use both).

**Answer:**
I would implement a three-phase approach:

**Phase 1: Request Interception**
- Extract idempotency key from header
- Hash the request body for fingerprinting
- Check if key exists in cache

**Phase 2: Execution with Locking**
- Acquire distributed lock on the key
- Double-check cache (race condition protection)
- Execute the payment operation
- Store result before releasing lock

**Phase 3: Response Handling**
- Cache both success and failure responses
- Set appropriate TTL (24-48 hours typical)
- Return cached response on retries

```go
type PaymentIdempotency struct {
    redis     *redis.Client
    lockTTL   time.Duration
    cacheTTL  time.Duration
}

func (p *PaymentIdempotency) Process(ctx context.Context, key string, payment *PaymentRequest) (*PaymentResult, error) {
    // Check cache
    if cached := p.getCache(ctx, key); cached != nil {
        if cached.RequestHash != hash(payment) {
            return nil, ErrKeyReusedWithDifferentRequest
        }
        return cached.Result, nil
    }

    // Acquire lock
    if !p.acquireLock(ctx, key) {
        return nil, ErrRequestInProgress
    }
    defer p.releaseLock(ctx, key)

    // Double-check
    if cached := p.getCache(ctx, key); cached != nil {
        return cached.Result, nil
    }

    // Execute
    result, err := p.processPayment(ctx, payment)

    // Store (even errors)
    p.storeResult(ctx, key, result, err)

    return result, err
}
```

**Follow-ups:**
- *What if the client sends the same key with a different body?* Return 400/422 with a clear "idempotency key reused with different parameters" error. Never execute the second call, that's a client bug and silently serving the cached response masks it.
- *What if two requests with the same key arrive concurrently?* First acquires the distributed lock and executes, second sees the lock and returns 409 Conflict (retryable). The second client retries after backoff, by then the result is cached.
- *Where do you store keys, Redis or Postgres?* Redis for the hot lock and recent-response cache (sub-millisecond), Postgres for durability past the TTL and for audit. Many designs write to both: Redis first for speed, async flush to Postgres. Losing Redis should degrade latency, not correctness.
- *What's the TTL?* 24 hours matches Stripe and covers realistic retry windows. Longer (7 days) for high-value operations where a late duplicate would be catastrophic. The cost is storage, key volume is roughly (requests/day x retention).

### Question 3: Explain the Transactional Outbox Pattern

**What FAANG expects:** A clear framing of the **dual-write problem** (can't atomically write to DB and Kafka) and why 2PC/XA isn't the answer (performance, operational complexity, unsupported by Kafka). Then the two relay variants: polling (simple, higher latency) vs log-based CDC via Debezium (sub-second, operationally heavier). Mention that downstream consumers still need to be idempotent, outbox gives at-least-once, not exactly-once.

**Answer:**
The Transactional Outbox pattern ensures reliable message publishing alongside database operations:

**Problem it solves:**
- Can't atomically write to database AND publish to message queue
- Two-phase commit is slow and complex
- Without it: database write succeeds but message publish fails = inconsistency

**How it works:**
1. Business operation and outbox message written in same database transaction
2. Background worker polls outbox table for new messages
3. Worker publishes to message queue and marks as processed
4. Downstream consumers may receive duplicates (need to be idempotent)

```go
func (s *Service) CreateOrder(ctx context.Context, order *Order) error {
    return s.db.Transaction(func(tx *sql.Tx) error {
        // Write order
        if err := tx.Insert(order); err != nil {
            return err
        }

        // Write to outbox (same transaction)
        event := &OutboxMessage{
            ID:        uuid.New(),
            EventType: "order.created",
            Payload:   marshal(order),
        }
        return tx.Insert(event)
    })
}

// Background worker
func (w *Worker) Run() {
    for {
        messages := w.db.GetUnprocessed(100)
        for _, msg := range messages {
            if err := w.kafka.Publish(msg); err == nil {
                w.db.MarkProcessed(msg.ID)
            }
        }
        time.Sleep(1 * time.Second)
    }
}
```

**Follow-ups:**
- *Polling vs CDC, when do you pick which?* Polling for new services, one database, low event volume. CDC (Debezium reading Postgres WAL or MySQL binlog into Kafka Connect) when you need sub-second fanout, multiple consumers, or can't afford the polling load. CDC requires a Kafka Connect cluster and careful replication-slot management.
- *What about Temporal.io as an alternative?* Temporal's durable workflows remove the outbox table entirely, the workflow state IS the durable log. Good for complex multi-step flows, overkill for "commit one event per transaction."
- *How do you prevent the relay from publishing the same message twice?* Mark-as-processed must be atomic with the publish ack. If the relay crashes after publishing but before marking, the message republishes, consumers must dedupe by message ID.

### Question 4: What's the difference between optimistic and pessimistic locking?

**What FAANG expects:** Correct definitions plus the ability to pick between them based on contention profile. Bonus: mention database row locks (`SELECT ... FOR UPDATE`), advisory locks (`pg_advisory_xact_lock`), and how ORMs typically implement optimistic locking via a `version` column with `UPDATE ... WHERE version = ?`.

**Answer:**

**Pessimistic Locking:**
- Locks the resource before reading/modifying
- Prevents other transactions from accessing
- Higher contention, lower throughput
- Use when: conflicts are frequent

```go
// SELECT ... FOR UPDATE acquires lock
row := tx.QueryRow("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", id)
// Other transactions block until we commit
account.Balance -= amount
tx.Update(account)
tx.Commit() // Lock released
```

**Optimistic Locking:**
- No lock during read
- Checks version/timestamp during write
- Fails if data changed
- Use when: conflicts are rare

```go
// Read with version
account := db.Get(id) // version = 5

// Modify
account.Balance -= amount

// Write with version check
result := db.Exec("UPDATE accounts SET balance = $1, version = $2 WHERE id = $3 AND version = $4",
    account.Balance, account.Version+1, id, account.Version)

if result.RowsAffected() == 0 {
    return ErrConcurrentModification // Retry the whole operation
}
```

**Comparison:**
| Aspect | Pessimistic | Optimistic |
|--------|-------------|------------|
| Conflicts | Prevents | Detects |
| Throughput | Lower | Higher |
| Complexity | Simpler | Retry logic needed |
| Best for | High contention | Low contention |

**Follow-ups:**
- *What's a deadlock and how do locking strategies avoid it?* Two transactions hold a lock the other needs. Pessimistic: acquire locks in a deterministic order (e.g., always lock account with lower ID first). Optimistic: no deadlocks, but livelock is possible if retries keep colliding (add jittered backoff).
- *When is optimistic locking wrong?* High contention (inventory counter on a flash sale), retries thrash and throughput collapses. Use a queue or pessimistic lock or atomic DB-side decrement.

### Question 5: How would you implement exactly-once processing in a distributed system?

**What FAANG expects:** The first sentence must acknowledge that physical exactly-once delivery is impossible in an async network. Then describe **effectively-once**: at-least-once delivery + idempotent consumer + atomic dedup. Mention Kafka's EOS (idempotent producer + transactions, default in 3.0+) and note it only applies within Kafka, not to external side effects. If the candidate says "I'd use Kafka exactly-once" without qualifying, that's a red flag.

**Answer:**
True exactly-once is impossible, but we can achieve effectively-exactly-once:

**Strategy: Idempotent Consumer + At-Least-Once Delivery**

```go
type ExactlyOnceProcessor struct {
    db    *sql.DB
    kafka *kafka.Consumer
}

func (p *ExactlyOnceProcessor) Process(msg *kafka.Message) error {
    return p.db.Transaction(func(tx *sql.Tx) error {
        // Check if already processed (idempotency check)
        processed, _ := tx.Query(
            "SELECT 1 FROM processed_messages WHERE id = $1",
            msg.ID,
        )
        if processed {
            return nil // Already done, skip
        }

        // Process the message
        if err := p.handleMessage(tx, msg); err != nil {
            return err
        }

        // Record as processed (same transaction)
        tx.Exec(
            "INSERT INTO processed_messages (id, processed_at) VALUES ($1, $2)",
            msg.ID, time.Now(),
        )

        // Commit offset (or use transactional outbox)
        return nil
    })
}
```

**Key Points:**
1. Messages have unique IDs
2. Processing and deduplication record in same transaction
3. Consumer tracks processed IDs with TTL
4. At-least-once delivery from queue is fine
5. Result: each message is processed exactly once despite retries

**Follow-ups:**
- *Kafka claims exactly-once semantics. Is it real?* Within Kafka, yes: the idempotent producer (default in 3.0+) dedupes by producer ID + sequence number, and transactions make read-process-write atomic across partitions. The moment a side effect crosses Kafka's boundary (HTTP call, DB outside the transaction, email), you need application-level idempotency again.
- *What's the dedup table's retention policy?* Keep IDs for at least the maximum retry window of upstream producers (commonly 7 days). TTL them after, or partition the table by day and drop old partitions. Unbounded growth is a classic production bug.
- *What if dedup insert and handler both succeed but offset commit fails?* On restart, the message replays, the handler sees the dedup row, and skips. This is why the dedup record and business write must be in the same DB transaction, if you split them, you reintroduce the dual-write problem.

### Question 6: Idempotency key vs natural key, when do you use each?

**What FAANG expects:** Recognition that idempotency keys are a **retry protocol** between client and server, while natural keys are a **uniqueness constraint** in the domain model. The best designs use both: the natural key prevents semantic duplicates (two orders for the same cart), the idempotency key prevents network-retry duplicates (same order submitted twice in 3 seconds).

**Answer:**

**Idempotency key** (client-generated UUID, opaque to server):
- Scope: one logical request attempt + its retries
- Lifetime: short (24h typical)
- Prevents: duplicate side effects from network retries
- Example: `Idempotency-Key: 7f3a-b2c4-...` on `POST /payments`

**Natural key** (derived from domain: cart_id + user_id, order_id, external reference):
- Scope: entire business concept lifetime
- Lifetime: forever (unique index in DB)
- Prevents: semantic duplicates regardless of retry origin
- Example: `UNIQUE (user_id, cart_id, checkout_session_id)` on orders

Use **both**. The idempotency key catches the millisecond-window retry with no body parsing. The natural key catches the case where the client lost its idempotency key and retried with a new one but the same business intent.

**Follow-ups:**
- *What if the same key arrives with a different body?* Return 400 with `idempotency_key_in_use_with_different_body`. This is almost always a client bug (reusing a key across unrelated calls). Never execute, never overwrite.
- *What if two different keys arrive with the same body?* Execute both unless a natural key blocks it. The server can't know intent, two users buying the same product at the same price is legitimate.
- *Can you use a hash of the request body as the idempotency key?* Works for pure functions, dangerous for payments (two legitimate same-amount charges get collapsed). Client-generated UUID is safer.

### Question 7: Design a retry-safe payment API from scratch.

**What FAANG expects:** A whiteboard design that mirrors Stripe's model. Interviewer is looking for: client-generated idempotency key, server-side atomic "insert or fetch" by key, state machine (pending, succeeded, failed), webhook delivery via outbox, and compensating refunds (not rollbacks). Mention that the payment PSP itself (Stripe, Adyen) also accepts an idempotency key, pass the same key through, don't generate a new one at each hop.

**Answer:**

1. **Client** generates UUID v4, sends `POST /payments` with `Idempotency-Key: <uuid>` and body `{amount_cents, currency, source, metadata}`.

2. **Gateway** validates idempotency key format, forwards to payment service.

3. **Payment service** runs atomic SQL:
   ```sql
   INSERT INTO payments (idempotency_key, request_hash, state, ...)
   VALUES ($1, sha256($body), 'pending', ...)
   ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
   RETURNING state, response, request_hash, (xmax = 0) AS inserted
   ```
   - **If `inserted` is true, this row is ours: proceed to call the PSP.** Do not skip this. Without `xmax = 0` you cannot tell your own fresh insert from someone else's in-flight row, so the next rule fires on your own row and the request rejects itself with a 409. Every request. Forever. Nothing is ever charged. Saying this out loud is a strong signal in an interview, because it is the detail almost everyone misses.

   Otherwise the row already existed, so branch on what it says:
   - If `request_hash` differs from the stored row, return 400. The key was reused with different parameters, which is a client bug that no retry can fix. (Stripe's contract returns a 400-level error here, and matching it means callers' existing retry logic behaves correctly against your API.)
   - If state is `succeeded` or `failed`, return the cached response.
   - If state is `pending` and the row is fresh (< lock TTL), return 409. This one *is* retryable: an identical request is genuinely in flight.
   - If state is `pending` and stale, take over (zombie recovery), and reset `started_at` so a second taker cannot also claim it.

4. **Call PSP** with the same idempotency key passed through. PSP also dedupes, defense in depth.

5. **On PSP response**, update row to `succeeded`/`failed` with response body, write an outbox row (`payment.succeeded` event) in the same transaction.

6. **Outbox relay** publishes to Kafka. Downstream consumers (email, ledger, fraud) dedupe by `payment_id`.

7. **Refunds** are a separate `POST /payments/:id/refunds` with their own idempotency key. Never "undo" a payment row, issue a compensating refund row.

**Follow-ups:**
- *What if the PSP call times out with no response?* Mark the row as `unknown`, do NOT retry synchronously. A reconciliation job polls the PSP by idempotency key, the PSP returns the original result if it exists. This is the single most common source of double charges.
- *How do you handle partial failures in a multi-step checkout (charge + inventory + shipping)?* Saga with compensations. Each step idempotent, each compensation idempotent. Use Temporal if the flow is complex.
- *What's your database schema?* `payments(id, idempotency_key UNIQUE, user_id, amount_cents, currency, state, request_hash, response, psp_id, created_at, updated_at)` plus a partial index on `(state) WHERE state = 'pending'` for the reconciliation job.

### Question 8: Explain compensating transactions and why "rollback" is the wrong word.

**What FAANG expects:** Understanding that in a saga, you cannot ACID-rollback a committed transaction in another service, you can only issue a semantically-equivalent reverse operation. That reverse operation may fail, may be delayed, may itself need retries, and must be idempotent. Bonus: the system is in an inconsistent state during the compensation window, the domain must tolerate this.

**Answer:**

A compensating transaction is a **new forward transaction** that semantically reverses a previously committed one. It is not a rollback:
- A rollback undoes uncommitted work, zero observers saw the intermediate state.
- A compensation undoes **committed** work that other services, logs, and users already observed.

Examples:

| Forward action | Compensation |
|----------------|--------------|
| Charge card | Refund (new ledger entry, not a delete) |
| Reserve inventory | Release reservation |
| Send email | Send "please disregard" email (you cannot un-send) |
| Generate invoice | Issue credit note |

**Key properties:**
1. **Idempotent**: compensation will be retried on failure, issuing two refunds is as bad as double charging.
2. **Commutative where possible**: if compensations run out of order, the end state should be correct.
3. **Observable**: log every compensation, auditors will ask.
4. **May not fully restore state**: a sent email cannot be unsent. The domain design must accept this.

**Follow-ups:**
- *What if the compensation itself fails?* Retry with backoff, escalate to human after N attempts, expose in an ops dashboard. Never silently drop, a missed compensation is a ledger leak.
- *When can you NOT compensate?* Actions with external real-world effects: cash dispensed from an ATM, rocket launched, email sent to a customer. Design the forward transaction to delay the irreversible step until all prerequisites are confirmed (the "semantic lock" or "pivot transaction" pattern).
- *How does this differ from 2PC?* 2PC holds locks across services until commit, blocking, slow, unavailable under partition (CAP). Sagas release locks per step, remain available during partition, accept temporary inconsistency, which is the right tradeoff for most business workflows.

### Q (Staff track): How do you roll out idempotency across 50 services?

**Answer**: Ship shared middleware. Add to service template. Require for all new mutation endpoints at production readiness review. Audit existing endpoints, prioritized by risk (payment > billing > other mutations > reads).

---
