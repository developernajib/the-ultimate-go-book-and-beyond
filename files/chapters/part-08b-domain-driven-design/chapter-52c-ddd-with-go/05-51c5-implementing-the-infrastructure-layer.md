## 52C.5 Implementing the Infrastructure Layer

### PostgreSQL Query Repository for Read Models

The read repository is optimized for queries - it can use JOINs, views, or denormalized tables:

```go
// internal/infrastructure/persistence/postgres_order_query_repo.go

package persistence

import (
    "context"
    "database/sql"
    "errors"
    "fmt"

    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// PostgresOrderQueryRepository implements OrderQueryRepository using PostgreSQL.
type PostgresOrderQueryRepository struct {
    db *sql.DB
}

// NewPostgresOrderQueryRepository creates a new read repository.
func NewPostgresOrderQueryRepository(db *sql.DB) *PostgresOrderQueryRepository {
    return &PostgresOrderQueryRepository{db: db}
}

// FindOrderView returns a denormalized order view using a single efficient query.
func (r *PostgresOrderQueryRepository) FindOrderView(
    ctx context.Context,
    id order.OrderID,
) (*orderapp.OrderView, error) {
    // Use a JSON aggregation query to fetch order + lines in a single round trip
    row := r.db.QueryRowContext(ctx, `
        SELECT
            o.id,
            o.customer_id,
            o.status,
            o.placed_at,
            o.created_at,
            o.shipping_recipient,
            o.shipping_street,
            o.shipping_city,
            o.shipping_state,
            o.shipping_postal,
            o.shipping_country,
            COALESCE(
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'id', ol.id,
                        'product_sku', ol.product_sku,
                        'product_name', ol.product_name,
                        'quantity', ol.quantity,
                        'unit_price_amount', ol.unit_price_amount,
                        'unit_price_currency', ol.unit_price_currency
                    ) ORDER BY ol.created_at
                ) FILTER (WHERE ol.id IS NOT NULL),
                '[]'
            ) AS lines
        FROM orders o
        LEFT JOIN order_lines ol ON ol.order_id = o.id
        WHERE o.id = $1
        GROUP BY o.id
    `, string(id))

    var view orderapp.OrderView
    var linesJSON []byte
    var placedAt sql.NullTime

    err := row.Scan(
        &view.ID,
        &view.CustomerID,
        &view.Status,
        &placedAt,
        &view.CreatedAt,
        &view.ShippingAddress.RecipientName,
        &view.ShippingAddress.Street,
        &view.ShippingAddress.City,
        &view.ShippingAddress.State,
        &view.ShippingAddress.PostalCode,
        &view.ShippingAddress.CountryCode,
        &linesJSON,
    )
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, order.ErrOrderNotFound
        }
        return nil, fmt.Errorf("query order view: %w", err)
    }

    if placedAt.Valid {
        view.PlacedAt = &placedAt.Time
    }

    if err := parseOrderLinesJSON(linesJSON, &view); err != nil {
        return nil, fmt.Errorf("parse order lines: %w", err)
    }

    return &view, nil
}

func parseOrderLinesJSON(data []byte, view *orderapp.OrderView) error {
    // json.Unmarshal into []orderapp.OrderLineView
    // ... implementation omitted for brevity
    return nil
}

// ListOrderViewsByCustomer lists orders with cursor-based pagination.
func (r *PostgresOrderQueryRepository) ListOrderViewsByCustomer(
    ctx context.Context,
    customerID order.CustomerID,
    limit int,
    pageToken string,
) ([]*orderapp.OrderView, string, error) {
    if limit <= 0 || limit > 100 {
        limit = 20
    }

    query := `
        SELECT id FROM orders
        WHERE customer_id = $1
        AND ($2 = '' OR created_at < (SELECT created_at FROM orders WHERE id = $2))
        ORDER BY created_at DESC
        LIMIT $3
    `

    rows, err := r.db.QueryContext(ctx, query, string(customerID), pageToken, limit+1)
    if err != nil {
        return nil, "", fmt.Errorf("list orders by customer: %w", err)
    }
    defer rows.Close()

    var ids []string
    for rows.Next() {
        var id string
        if err := rows.Scan(&id); err != nil {
            return nil, "", fmt.Errorf("scan order id: %w", err)
        }
        ids = append(ids, id)
    }
    if err := rows.Err(); err != nil {
        return nil, "", fmt.Errorf("iterate order ids: %w", err)
    }

    var nextPageToken string
    if len(ids) > limit {
        nextPageToken = ids[limit-1]
        ids = ids[:limit]
    }

    views := make([]*orderapp.OrderView, 0, len(ids))
    for _, id := range ids {
        view, err := r.FindOrderView(ctx, order.OrderID(id))
        if err != nil {
            return nil, "", err
        }
        views = append(views, view)
    }

    return views, nextPageToken, nil
}
```

### Transactional Outbox Pattern

Publishing domain events reliably to an external message broker requires the **Outbox Pattern**. Instead of publishing directly from the repository (which can fail after commit), you write events to an outbox table in the same transaction as the aggregate, then a background worker reads and publishes them:

```go
// internal/infrastructure/messaging/outbox.go

package messaging

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// OutboxMessage represents an unpublished domain event in the outbox table.
type OutboxMessage struct {
    ID          string
    EventName   string
    Payload     []byte
    CreatedAt   time.Time
    PublishedAt *time.Time
}

// OutboxWriter writes domain events to the outbox table within a transaction.
type OutboxWriter struct {
    db *sql.DB
}

func NewOutboxWriter(db *sql.DB) *OutboxWriter {
    return &OutboxWriter{db: db}
}

// WriteEvents persists domain events to the outbox within the provided transaction.
func (w *OutboxWriter) WriteEvents(ctx context.Context, tx *sql.Tx, events []order.DomainEvent) error {
    for _, event := range events {
        payload, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("marshal event %s: %w", event.EventName(), err)
        }

        _, err = tx.ExecContext(ctx, `
            INSERT INTO outbox_messages (id, event_name, payload, created_at)
            VALUES (gen_random_uuid(), $1, $2, $3)
        `, event.EventName(), payload, time.Now())
        if err != nil {
            return fmt.Errorf("insert outbox message: %w", err)
        }
    }
    return nil
}

// OutboxPublisher reads from the outbox and publishes to the message broker.
type OutboxPublisher struct {
    db        *sql.DB
    publisher EventPublisher
}

// EventPublisher is the interface for the message broker adapter.
type EventPublisher interface {
    Publish(ctx context.Context, topic string, key string, payload []byte) error
}

func NewOutboxPublisher(db *sql.DB, pub EventPublisher) *OutboxPublisher {
    return &OutboxPublisher{db: db, publisher: pub}
}

// ProcessBatch reads a batch of unpublished messages and publishes them.
// Called by a background worker on a tick (e.g., every 100ms).
func (p *OutboxPublisher) ProcessBatch(ctx context.Context, batchSize int) (int, error) {
    tx, err := p.db.BeginTx(ctx, nil)
    if err != nil {
        return 0, fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    rows, err := tx.QueryContext(ctx, `
        SELECT id, event_name, payload
        FROM outbox_messages
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    `, batchSize)
    if err != nil {
        return 0, fmt.Errorf("query outbox: %w", err)
    }
    defer rows.Close()

    type message struct {
        id        string
        eventName string
        payload   []byte
    }
    var messages []message

    for rows.Next() {
        var m message
        if err := rows.Scan(&m.id, &m.eventName, &m.payload); err != nil {
            return 0, fmt.Errorf("scan outbox row: %w", err)
        }
        messages = append(messages, m)
    }
    rows.Close()

    published := 0
    for _, m := range messages {
        if err := p.publisher.Publish(ctx, m.eventName, m.id, m.payload); err != nil {
            return published, fmt.Errorf("publish message %s: %w", m.id, err)
        }

        _, err = tx.ExecContext(ctx,
            "UPDATE outbox_messages SET published_at = $1 WHERE id = $2",
            time.Now(), m.id,
        )
        if err != nil {
            return published, fmt.Errorf("mark message published: %w", err)
        }
        published++
    }

    return published, tx.Commit()
}
```

---

### Junior → FAANG: Infrastructure as Translation, Not Business Logic

The infrastructure layer is where most junior developers accidentally re-introduce business logic. The temptation is real: you are already in the repository, you have the database row in front of you, and it would be easy to add `if row.Status == "canceled" { return nil, nil }` right there. Do not do this. The repository's only job is to translate between the storage format and the domain aggregate. Business decisions about what to do with a canceled order belong in the domain.

A practical exercise: write a PostgreSQL repository implementation and then count how many `if` statements it contains. Each `if` that is not about error handling or NULL scanning is a potential business rule that leaked into infrastructure. Ask yourself: "If I changed from PostgreSQL to a document database, would this `if` need to move?" If yes, it is business logic. If no (it is about handling `sql.ErrNoRows` vs. a real error), it belongs where it is.

The Outbox Pattern is worth understanding deeply before a FAANG interview, because it is a canonical example of a distributed systems problem that has a clean, well-reasoned solution. Practice explaining it in one minute: "We need atomicity between saving an aggregate and publishing a domain event. We cannot get true atomicity across a database and a message broker, so we write the event to a table in the same transaction as the aggregate. A background worker reads that table and publishes to the broker. At-least-once delivery means consumers must be idempotent." If you can say that clearly, you can answer the most common follow-up questions.

### Senior @ FAANG: Infrastructure Layer Design for Operational Excellence

At the staff level, the infrastructure layer is evaluated not just for correctness but for operational excellence: observability, resilience under partial failure, graceful degradation, and maintainability across database schema evolution.

**Aggregate reconstitution as a first-class concern.** The most expensive infrastructure operation in a DDD application is loading an aggregate. In a naive implementation, loading an `Order` with 30 lines requires 31 database round trips (one for the order, one per line). In the JSON aggregation implementation shown in this chapter, it is one. At scale, the difference is the gap between a 10ms p99 and a 300ms p99. The Staff engineer defines performance budgets for each aggregate load operation (e.g., "loading an Order must complete in under 20ms at p95 with up to 50 order lines") and enforces them with benchmark tests (`go test -bench`) in CI. When a new query is added to the repository, the benchmark suite runs automatically and alerts if the budget is exceeded.

**Outbox worker resilience.** The Outbox Pattern is simple in the happy path. The failure modes are where it gets interesting at scale. What happens when the message broker is down for 30 minutes? The outbox table fills with unpublished events. When the broker comes back, the worker must publish in order without overloading the broker. Rate limiting and backpressure on the outbox worker is a platform concern: the worker should publish at a rate the broker can absorb, using exponential backoff on publish failures, and should be monitored with a metric: `max(now() - created_at) WHERE published_at IS NULL`. This metric represents the maximum event delivery lag. A Staff engineer sets an alert threshold (e.g., alert if lag exceeds 60 seconds) and owns the runbook for when it fires.

**Schema evolution in the repository.** Aggregate schemas change. New fields are added, existing fields are renamed, sub-entities are added. In a DDD Go application, schema evolution happens in three places: the database migration, the reconstitution function in the repository, and the aggregate struct. The Staff engineer establishes a discipline: every database migration is paired with a reconstitution test that verifies old rows (seeded with old-format data) can be correctly loaded into the current aggregate struct. This catches cases where a migration removes a column that the reconstitution code still reads. Without this test, the bug appears only in production when the old data is first accessed after a deployment.

**CDC as an alternative to the outbox.** Change Data Capture (Debezium, PgLogical, AWS DMS) reads the Postgres WAL directly and publishes events to the broker without any application-layer participation. For teams that can operate Debezium, this is operationally superior to the outbox: no polling, no outbox table, sub-second latency, and the WAL captures every committed change regardless of application behavior. The trade-off is operational complexity (a new component to deploy, monitor, and upgrade) and Kafka-specific schema management (Debezium produces Avro or JSON with a specific envelope). The Staff engineer evaluates CDC vs. outbox based on team operational maturity and latency requirements. For most teams, the outbox is the right starting point. CDC becomes justified when event delivery latency requirements drop below 500ms or when the application team cannot own the polling worker reliably.

---
