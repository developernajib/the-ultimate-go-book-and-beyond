## 52I.5 Outbox Pattern

> **Senior track**: The outbox gives at-least-once, not exactly-once. Consumers must be idempotent (keyed on aggregate ID + version or on the outbox row ID). Two relay styles: (a) polling relay with `FOR UPDATE SKIP LOCKED` (simple, fits most workloads, trivial ops), (b) Debezium-on-outbox using the `EventRouter` SMT (sub-second latency, zero app-level polling, but you run a Connect cluster). Start with (a). Migrate to (b) only when polling latency becomes the bottleneck or when you already run Debezium for other CDC workloads.

### The Dual-Write Problem

Writing to a database and publishing an event to a message queue in the same operation without transactions creates a window where one succeeds and the other fails, causing data inconsistency. The Outbox pattern solves this by writing the event to an `outbox` table inside the same database transaction, then having a separate relay process forward committed outbox rows to the message broker.

```
Problem: Write to DB and Kafka in the "same operation"

Naive approach (BROKEN):
  1. UPDATE orders SET status='shipped' WHERE id=123
  2. kafka.Publish("order-shipped", {id: 123})  ← can fail after step 1

  If step 2 fails: DB updated but event never published
  If you retry step 2: might publish duplicate if step 1 already committed

The outbox pattern solution:
  1. BEGIN TRANSACTION
  2. UPDATE orders SET status='shipped' WHERE id=123
  3. INSERT INTO outbox (event_type, payload) VALUES ('OrderShipped', {...})
  4. COMMIT   ← both writes succeed or both fail (atomicity)

  Separate relay process:
  5. SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at
  6. kafka.Publish(event)
  7. UPDATE outbox SET published_at=NOW() WHERE id=?
```

### Outbox Implementation

The Outbox relay reads unprocessed rows from the outbox table, publishes them to Kafka, and marks them as processed, all while handling failures so that no event is skipped or double-published. The following Go implementation uses a polling loop with a configurable batch size and relies on Kafka's idempotent producer to prevent duplicates on retry.

```go
package outbox

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/twmb/franz-go/pkg/kgo"
)

// OutboxEvent represents a row in the outbox table
type OutboxEvent struct {
    ID            int64
    AggregateType string
    AggregateID   string
    EventType     string
    Payload       json.RawMessage
    CreatedAt     time.Time
}

// OutboxStore writes events to the outbox table within a transaction
type OutboxStore struct {
    db *sql.DB
}

func NewOutboxStore(db *sql.DB) *OutboxStore {
    return &OutboxStore{db: db}
}

// Save inserts an outbox event within an existing transaction
func (s *OutboxStore) Save(ctx context.Context, tx *sql.Tx, aggregateType, aggregateID, eventType string, payload any) error {
    data, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("marshal payload: %w", err)
    }

    _, err = tx.ExecContext(ctx, `
        INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_at)
        VALUES ($1, $2, $3, $4, NOW())
    `, aggregateType, aggregateID, eventType, data)
    return err
}

// OrderService demonstrates transactional outbox usage
type OrderService struct {
    db     *sql.DB
    outbox *OutboxStore
}

type ShipOrderCommand struct {
    OrderID    int64
    TrackingID string
}

type OrderShippedEvent struct {
    OrderID    int64   `json:"order_id"`
    TrackingID string  `json:"tracking_id"`
    ShippedAt  string  `json:"shipped_at"`
}

func (s *OrderService) ShipOrder(ctx context.Context, cmd ShipOrderCommand) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    // Business logic: update order status
    result, err := tx.ExecContext(ctx, `
        UPDATE orders SET status='shipped', tracking_id=$1, shipped_at=NOW()
        WHERE id=$2 AND status='processing'
    `, cmd.TrackingID, cmd.OrderID)
    if err != nil {
        return fmt.Errorf("update order: %w", err)
    }
    if n, _ := result.RowsAffected(); n == 0 {
        return fmt.Errorf("order %d not found or not in processing state", cmd.OrderID)
    }

    // Write event to outbox in the SAME transaction
    event := OrderShippedEvent{
        OrderID:    cmd.OrderID,
        TrackingID: cmd.TrackingID,
        ShippedAt:  time.Now().UTC().Format(time.RFC3339),
    }
    if err := s.outbox.Save(ctx, tx, "Order", fmt.Sprintf("%d", cmd.OrderID), "OrderShipped", event); err != nil {
        return fmt.Errorf("save outbox event: %w", err)
    }

    return tx.Commit()
}

// OutboxRelay polls the outbox table and publishes to Kafka
type OutboxRelay struct {
    db     *sql.DB
    kafka  *kgo.Client
    logger *slog.Logger
}

func NewOutboxRelay(db *sql.DB, kafka *kgo.Client, logger *slog.Logger) *OutboxRelay {
    return &OutboxRelay{db: db, kafka: kafka, logger: logger}
}

func (r *OutboxRelay) Run(ctx context.Context) error {
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case <-ticker.C:
            if err := r.publishBatch(ctx); err != nil {
                r.logger.Error("outbox relay error", "err", err)
            }
        }
    }
}

func (r *OutboxRelay) publishBatch(ctx context.Context) error {
    // The whole claim, publish, mark cycle shares one transaction: FOR
    // UPDATE SKIP LOCKED only holds its row locks for the life of the
    // enclosing transaction, so a bare db.QueryContext would release them
    // as soon as the SELECT returned and two relay replicas would
    // double-publish the same rows.
    tx, err := r.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin outbox tx: %w", err)
    }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx, `
        SELECT id, aggregate_type, aggregate_id, event_type, payload, created_at
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    `)
    if err != nil {
        return fmt.Errorf("query outbox: %w", err)
    }
    defer rows.Close()

    var events []OutboxEvent
    for rows.Next() {
        var e OutboxEvent
        if err := rows.Scan(&e.ID, &e.AggregateType, &e.AggregateID, &e.EventType, &e.Payload, &e.CreatedAt); err != nil {
            return fmt.Errorf("scan row: %w", err)
        }
        events = append(events, e)
    }
    if err := rows.Err(); err != nil {
        return err
    }
    if len(events) == 0 {
        return nil
    }

    // Publish to Kafka
    var records []*kgo.Record
    for _, e := range events {
        topic := fmt.Sprintf("events.%s.%s", e.AggregateType, e.EventType)
        records = append(records, &kgo.Record{
            Topic: topic,
            Key:   []byte(e.AggregateID),
            Value: e.Payload,
            Headers: []kgo.RecordHeader{
                {Key: "event_type", Value: []byte(e.EventType)},
                {Key: "aggregate_type", Value: []byte(e.AggregateType)},
            },
        })
    }

    if err := r.kafka.ProduceSync(ctx, records...).FirstErr(); err != nil {
        return fmt.Errorf("produce to kafka: %w", err)
    }

    // Mark as published
    ids := make([]int64, len(events))
    for i, e := range events {
        ids[i] = e.ID
    }

    _, err = tx.ExecContext(ctx, `
        UPDATE outbox SET published_at=NOW() WHERE id = ANY($1)
    `, ids)
    if err != nil {
        return fmt.Errorf("mark published: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit outbox tx: %w", err)
    }

    r.logger.Info("outbox relay published", "count", len(events))
    return nil
}
```

### Junior -> FAANG: Understanding Why the Outbox Pattern Exists

The outbox pattern solves a specific, concrete problem: you cannot write to a database and publish to a message broker atomically without distributed transactions. Before you can explain the solution, you need to be able to explain the problem clearly.

The naive dual-write approach does this: write to the database, then publish to Kafka. The failure scenario is: the database write succeeds, then the process crashes before the Kafka publish. On restart, the business state is correct (the order is marked shipped), but the event was never published. Downstream systems that depend on the event to take action (email service, fulfillment service, analytics pipeline) never see the state change. The database and the event stream are now inconsistent.

The outbox pattern collapses the two writes into one database transaction. The business update and the outbox row are written atomically. If the transaction commits, both are written. If it rolls back, neither is written. The relay then reads committed outbox rows and publishes them. If the relay crashes after publishing but before marking the row as sent, the row is republished on restart. Downstream consumers must be idempotent to handle this.

The `FOR UPDATE SKIP LOCKED` clause in the relay query deserves explanation. It allows multiple relay replicas to run concurrently without blocking each other. Each replica locks the rows it has selected and skips rows that are already locked by another replica. Without `SKIP LOCKED`, multiple replicas would block waiting for each other's locks, serializing the relay and negating the benefit of running multiple replicas.

A practical first-job question: how do you prune the outbox table? Rows with `published_at` set more than N days ago can be deleted by a background job. Keep enough history to support consumer re-bootstrap (if a consumer resets its offset back N days, the relay must not re-publish events that were already published). The retention period should match the Kafka topic retention setting.

### Senior @ FAANG: Outbox Pattern Governance and the Relay Architecture Decision

The outbox pattern looks simple from the outside but has several architectural decisions that compound at scale.

**Polling relay versus CDC relay: the right default.** The polling relay (the implementation above) is operationally simple, requires no additional infrastructure beyond the existing database and Kafka, and is trivial to debug. The CDC relay (Debezium watching the outbox table, routing via the `EventRouter` SMT) adds sub-second publish latency and eliminates the polling overhead, but requires running a Kafka Connect cluster and configuring an additional connector. The correct default for most teams is the polling relay. The signal to migrate is when the poll interval becomes the SLO bottleneck. At that point, you already run Debezium for other CDC workloads, so adding a connector for the outbox table is incremental cost, not a new infrastructure dependency.

**The outbox schema as a contract.** The outbox table schema is a contract between the service that writes events and the relay that publishes them. The fields `aggregate_type`, `aggregate_id`, `event_type`, and `payload` are the minimum. Additional fields that improve operability: `schema_version` (so the relay can route different payload versions to different topics), `idempotency_key` (explicit key for the Kafka record key, separate from `aggregate_id`), and `topic_override` (allows individual events to specify a non-default target topic). A senior engineer designs this schema once and enforces it across all services that use the outbox, because ad-hoc per-service schemas make the relay impossible to generalize.

**Payload format in the outbox row.** The payload column should contain a fully serialized event, not a reference to application domain objects. The relay must not depend on the service's domain types to deserialize and re-serialize the payload. Pre-serialized JSON or Avro with an embedded schema ID allows the relay to forward the payload to Kafka as-is, without deserialization. This is especially important for multi-language environments where the relay may be written in a different language than the service.

**At-scale outbox table management.** On a high-write service, the outbox table accumulates rows at the same rate as business transactions. The relay must drain this table faster than rows accumulate, or the table grows unbounded and the relay falls behind. Key tuning parameters: batch size (100-1000 rows per poll), poll interval (100ms-1s depending on latency SLO), and indexing (an index on `(published_at, created_at)` is required for the relay query to be efficient). At very high write rates, the outbox table becomes a bottleneck because all writes and relay reads contend on the same table. Mitigations include partitioning the outbox table by `created_at` (range partitioning allows old partitions to be dropped without a slow `DELETE`) or sharding the outbox across multiple physical tables keyed by `aggregate_type`.

**Idempotency key design.** The outbox row ID (a database sequence) is a natural idempotency key for the Kafka record key. Using it as the Kafka record key means that all events for the same outbox row land on the same Kafka partition (determined by the key hash), which is fine. But it also means that two events for the same aggregate (the same order, the same user) may land on different partitions, because different outbox rows have different IDs. If downstream consumers require per-aggregate ordering (all events for order 123 must be processed in order), the Kafka record key should be `aggregate_id`, not `outbox_id`. This trades idempotent routing for per-aggregate ordering, and both are valid depending on the consumer's requirements. A senior engineer decides this explicitly and documents it in the outbox schema.

---
