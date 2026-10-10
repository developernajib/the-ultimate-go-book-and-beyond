## 49.9 Common Mistakes

### Mistake 1: Not Using Idempotent Consumers

Message brokers guarantee at-least-once delivery, so a consumer that processes a message without idempotency guards will double-charge customers or double-ship orders when the broker redelivers after a transient failure. The fix uses a database table to record each processed event ID before applying business logic. If the INSERT conflicts on the unique constraint the handler returns immediately without re-executing side effects. This idempotency check should be performed inside the same database transaction as the business logic to prevent a race between the check and the action.

```go
// pkg/events/mistakes/idempotency.go
package mistakes

import (
	"context"
	"database/sql"
	"fmt"
)

// BAD: Non-idempotent event handler
type BadInventoryHandler struct {
	db *sql.DB
}

func (h *BadInventoryHandler) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
	// Problem: If event is delivered twice, inventory is deducted twice!
	for _, item := range event.Items {
		_, err := h.db.ExecContext(ctx, `
			UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2
		`, item.Quantity, item.ProductID)
		if err != nil {
			return err
		}
	}
	return nil
}

type OrderCreatedEvent struct {
	EventID string
	OrderID string
	Items   []OrderItem
}

type OrderItem struct {
	ProductID string
	Quantity  int
}

// GOOD: Idempotent event handler with deduplication
type GoodInventoryHandler struct {
	db *sql.DB
}

func (h *GoodInventoryHandler) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check if event was already processed (idempotency key)
	var exists bool
	err = tx.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1)
	`, event.EventID).Scan(&exists)
	if err != nil {
		return err
	}

	if exists {
		// Already processed - idempotent no-op
		return nil
	}

	// Process the event
	for _, item := range event.Items {
		_, err := tx.ExecContext(ctx, `
			UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2
		`, item.Quantity, item.ProductID)
		if err != nil {
			return err
		}
	}

	// Record event as processed
	_, err = tx.ExecContext(ctx, `
		INSERT INTO processed_events (event_id, processed_at) VALUES ($1, NOW())
	`, event.EventID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

type OrderCreatedEventWithID struct {
	EventID string
	OrderID string
	Items   []OrderItem
}
```

### Mistake 2: Publishing Events Before Committing Transaction

Publishing an event before the database transaction commits creates a window where consumers act on an order that may never actually be persisted. If the commit fails after publishing, downstream services process a phantom order. The transactional outbox pattern resolves this: events are written to an `outbox` table inside the same database transaction as the business record, and a separate relay process polls the outbox and publishes to the broker only after the row has been durably committed. This guarantees exactly-once write to the database and at-least-once delivery to the broker without distributed two-phase commit.

```go
// pkg/events/mistakes/publish_order.go
package mistakes

import (
	"context"
	"database/sql"
	"encoding/json"
)

// BAD: Publishing before commit
type BadOrderService struct {
	db       *sql.DB
	producer EventProducer
}

type EventProducer interface {
	Publish(ctx context.Context, topic string, data []byte) error
}

func (s *BadOrderService) CreateOrder(ctx context.Context, order *Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Insert order
	_, err = tx.ExecContext(ctx, `INSERT INTO orders (id, ...) VALUES ($1, ...)`, order.ID)
	if err != nil {
		return err
	}

	// BAD: Publishing BEFORE commit!
	// If commit fails, event is already published - inconsistency!
	eventData, _ := json.Marshal(OrderCreatedEvent{OrderID: order.ID})
	if err := s.producer.Publish(ctx, "orders", eventData); err != nil {
		return err
	}

	return tx.Commit() // This might fail!
}

type Order struct {
	ID string
}

// GOOD: Using transactional outbox pattern
type GoodOrderService struct {
	db *sql.DB
}

func (s *GoodOrderService) CreateOrder(ctx context.Context, order *Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Insert order
	_, err = tx.ExecContext(ctx, `INSERT INTO orders (id, ...) VALUES ($1, ...)`, order.ID)
	if err != nil {
		return err
	}

	// Insert event into outbox table (same transaction!)
	event := OutboxEvent{
		ID:        generateID(),
		EventType: "OrderCreated",
		Payload:   order,
	}
	eventData, _ := json.Marshal(event.Payload)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO outbox (id, event_type, payload, created_at)
		VALUES ($1, $2, $3, NOW())
	`, event.ID, event.EventType, eventData)
	if err != nil {
		return err
	}

	// Commit both order AND event atomically
	return tx.Commit()
	// A separate process polls the outbox and publishes events
}

type OutboxEvent struct {
	ID        string
	EventType string
	Payload   any
}

func generateID() string { return "generated-id" }
```

### Mistake 3: Large Payloads in Events

Embedding large blobs (full product catalogs, user profile photos, PDF documents) in event payloads strains broker memory, slows consumer deserialization, and bloats the event store with data that changes independently of domain logic. The claim-check pattern keeps events small: store the large object in S3 or a blob store, then publish only a reference (bucket + key) in the event envelope. Consumers that need the payload fetch it on demand, while consumers that only need the event metadata (for routing, auditing, or filtering) never incur the deserialization cost.

```go
// pkg/events/mistakes/payload_size.go
package mistakes

import "time"

// BAD: Event with large payload
type BadProductEvent struct {
	EventType    string
	ProductID    string
	// Problem: Including entire product catalog in every event
	FullCatalog  []Product     // Could be megabytes!
	Images       [][]byte      // Binary data in events!
	Description  string        // Long text
	AllReviews   []Review      // Unbounded list
	AuditHistory []AuditEntry  // Growing history
}

type Product struct {
	ID          string
	Name        string
	PriceCents  int64
	Description string
	Images      [][]byte
}

type Review struct {
	ID      string
	Rating  int
	Comment string
}

type AuditEntry struct {
	Timestamp time.Time
	Action    string
	Details   string
}

// GOOD: Event with minimal payload (reference pattern)
type GoodProductEvent struct {
	EventType string    `json:"event_type"`
	ProductID string    `json:"product_id"` // Reference only
	Timestamp time.Time `json:"timestamp"`

	// Only include data that changed
	Changes []FieldChange `json:"changes"`
}

type FieldChange struct {
	Field    string      `json:"field"`
	OldValue any `json:"old_value,omitempty"`
	NewValue any `json:"new_value"`
}

/*
Guidelines for event payloads:
1. Include IDs, not full objects (consumers can look up if needed)
2. Include only changed fields, not entire state
3. Never include binary data - use URLs/references
4. Set maximum event size limit (e.g., 1MB)
5. Consider event compression for larger payloads
6. Use schema registry for structured payloads
*/
```

### Mistake 4: Not Handling Consumer Lag

Consumer lag, the gap between the latest broker offset and the last committed consumer offset, is the primary early-warning signal for event-driven systems under load. When lag grows unbounded it means the consumer is processing slower than the producer publishes, which will eventually cause memory pressure on the broker and delayed downstream side effects. The Go metrics collection here exposes lag as a Prometheus gauge per consumer group and topic, enabling alerting rules that page the on-call team before lag becomes a customer-visible incident.

```go
// pkg/events/mistakes/consumer_lag.go
package mistakes

import (
	"context"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// BAD: Ignoring consumer lag
type BadConsumer struct {
	// No lag monitoring
	// No backpressure handling
	// No alerting
}

func (c *BadConsumer) Consume(ctx context.Context, handler func([]byte) error) error {
	// Just processes messages without any lag awareness
	// Could fall hours behind without anyone knowing
	for {
		// msg := getNextMessage()
		// handler(msg)
	}
}

// GOOD: Consumer with lag monitoring and handling
type GoodConsumer struct {
	logger       *slog.Logger
	lagGauge     prometheus.Gauge
	lagThreshold time.Duration
	alerter      Alerter
}

type Alerter interface {
	Alert(ctx context.Context, severity, message string) error
}

type ConsumerMetrics struct {
	CurrentOffset   int64
	HighWatermark   int64
	Lag             int64
	LastMessageTime time.Time
	ProcessingRate  float64 // messages per second
}

func (c *GoodConsumer) MonitorLag(ctx context.Context, metrics ConsumerMetrics) {
	lag := metrics.HighWatermark - metrics.CurrentOffset
	c.lagGauge.Set(float64(lag))

	// Calculate time lag (if we know message rate)
	var timeLag time.Duration
	if metrics.ProcessingRate > 0 {
		timeLag = time.Duration(float64(lag)/metrics.ProcessingRate) * time.Second
	}

	if timeLag > c.lagThreshold {
		c.logger.Warn("consumer lag threshold exceeded",
			"lagMessages", lag,
			"lagTime", timeLag,
			"threshold", c.lagThreshold,
		)

		// Alert if significantly behind
		if timeLag > c.lagThreshold*2 {
			c.alerter.Alert(ctx, "warning",
				"Consumer lag critical - consider scaling consumers")
		}
	}
}

func (c *GoodConsumer) HandleBackpressure(ctx context.Context, lag int64) {
	// Strategies for handling lag:

	// 1. Scale up consumers
	if lag > 100000 {
		c.logger.Info("triggering consumer scale-up due to lag")
		// triggerAutoScaling()
	}

	// 2. Drop old events (if acceptable)
	// if event.Timestamp.Before(time.Now().Add(-1 * time.Hour)) {
	//     return // Skip stale events
	// }

	// 3. Batch processing for catch-up
	// batchSize := min(lag/10, 1000)
	// processBatch(batchSize)

	// 4. Rate limit producers (backpressure)
	// rateLimiter.SetRate(currentRate * 0.8)
}
```

### Mistake 5: Tight Coupling Through Event Schema

When producers and consumers share a Go struct definition directly (via a shared module), any field rename or type change in the producer requires all consumers to update simultaneously, recreating the tight coupling that event-driven architecture is designed to avoid. The solution is to define a stable, versioned JSON schema for each event type, use `json.RawMessage` in the consumer to defer deserialization, and evolve the schema additively (new optional fields only). This lets producers and consumers deploy on independent schedules while maintaining backward compatibility.

```go
// pkg/events/mistakes/coupling.go
package mistakes

import "time"

// BAD: Event schema tightly coupled to internal domain model
type BadOrderCreatedEvent struct {
	// Problem: Internal implementation details exposed
	Order struct {
		ID           string
		InternalCode string // Internal field leaked!

		// Direct reference to another service's model
		Customer CustomerDTO // Coupling to customer service

		// Database-specific fields
		CreatedAt    time.Time
		UpdatedAt    time.Time
		Version      int64
		DBRowID      int64 // Database implementation leaked!
	}
}

type CustomerDTO struct {
	ID    string
	Email string
	// All customer fields duplicated here
}

// GOOD: Event schema as a stable contract
type GoodOrderCreatedEvent struct {
	// Event metadata
	EventID   string    `json:"event_id"`
	EventType string    `json:"event_type"` // "order.created.v1"
	Timestamp time.Time `json:"timestamp"`

	// Business data only - stable contract
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"` // Reference only, not full object
	TotalAmountCents int64  `json:"total_amount_cents"`
	Currency         string `json:"currency"`

	// Explicit versioning for evolution
	SchemaVersion int `json:"schema_version"`
}

/*
Schema design principles:
1. Events are contracts - treat them like public APIs
2. Include only business-relevant data
3. Use references (IDs) not embedded objects
4. Version schemas explicitly
5. Support backward compatibility
6. Document breaking changes clearly
7. Use schema registry for validation
*/
```

### Junior → FAANG: Avoiding the Five Mistakes in Your First Event-Driven Service

Each mistake in this section has a root cause that, once understood, prevents a whole class of bugs.

**Idempotency is not optional.** The "bad" inventory handler deducts stock twice if the event is delivered twice. At-least-once delivery is a property of every production broker, not an edge case. The fix is a unique constraint on `processed_events(event_id)` and a check before processing. Write this from day one. Do not plan to add it later. The first time you forget to add it, you will have a production incident.

**Publish-then-commit is the most common dual-write bug.** The moment an event is published to Kafka before the transaction commits, you have a race condition. If the commit fails, the event is live in Kafka but the order does not exist in the database. This window is real and will be hit in production if you leave it open. The fix is the outbox pattern: publish to a table in the same transaction, and let a relay process publish to Kafka after the commit is durable.

**Event size has practical limits.** Kafka's default max message size is 1MB. RabbitMQ's default is 128MB but with performance degradation for large messages. Even if the broker accepts large events, the consumer deserializes the full payload into memory for every message, regardless of how many fields it actually needs. The claim-check pattern (store large objects in S3, publish only a reference) is the correct solution. A size limit of 64KB per event body is a reasonable default for domain events.

**Consumer lag is a leading indicator, not a lagging one.** Lag growing means the consumer is slower than the producer. This will eventually cause the broker to fill its retention limit and start dropping messages (depending on configuration) or cause unbounded memory growth on the broker. Alert on lag before it becomes a problem, not after. A lag alert threshold of five minutes of backlog (lag in messages divided by consumer throughput in messages per second) is a reasonable starting point.

**Coupling through shared struct packages breaks independent deployment.** If the `OrderCreatedEvent` struct is defined in a shared Go module imported by both the producer and every consumer, a struct change requires all consumers to update simultaneously. This recreates the tight coupling that EDA was introduced to avoid. Define the event schema as a JSON contract, not a Go struct, and let each service define its own struct that maps to the contract.

### Senior @ FAANG: Preventing These Mistakes at the Platform Level

The five mistakes in this section are not individual developer failures. They are architectural failure modes that a platform can prevent systematically.

**Idempotency as a platform primitive.** Rather than requiring each team to implement their own `processed_events` table and deduplication logic, a platform team provides an idempotency middleware that wraps any event handler. The middleware handles the deduplication check, the transaction boundary, and the commit, and the team provides only the pure business logic. This ensures consistent deduplication behavior across all services and removes a class of bugs entirely.

**Outbox relay as a shared service.** Similarly, rather than each service implementing its own outbox polling relay, a platform team provides a shared relay service (or a Debezium connector template) that any service can opt into by creating an `outbox` table with a standard schema. The relay is operated, monitored, and scaled by the platform team. Service teams write to the outbox and get reliable Kafka delivery without building or operating the relay themselves.

**Event size enforcement in CI.** Add a lint step to CI that serializes representative event instances and fails the build if any event type exceeds the size limit (e.g., 64KB). This catches the "embedded full catalog" mistake before it ships, rather than discovering it when the broker starts rejecting messages.

**Lag alerting as a platform default.** Every consumer group registered in the platform's service registry should automatically get a consumer lag alert with a default threshold. Teams can tune the threshold for their specific workload, but the default ensures that no new service goes dark without lag monitoring.

**Schema governance as a deployment gate.** Schema compatibility checking should be a required step in the CI/CD pipeline for any service that publishes events. The check fetches the current schema from the registry, compares the proposed change against the compatibility mode, and fails the pipeline if the change is incompatible. This makes schema breakage a build failure rather than a production incident, which is the correct place to catch it. This is one of the most valuable platform investments for an organization with more than ten event-producing services.

---
