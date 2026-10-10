## 49.5 Event Sourcing Implementation

### Event Store

The event store is the persistence layer for event sourcing: it appends events atomically with optimistic concurrency control (rejecting writes when the expected aggregate version does not match the stored version), and loads events in version order for replay. A separate snapshots table stores periodic aggregate state checkpoints so that loading a long-lived aggregate does not require replaying thousands of events from the beginning. The PostgreSQL implementation below uses a `UNIQUE(aggregate_id, version)` constraint as the concurrency check, making the database enforce the invariant rather than relying on application-level locking.

```go
// pkg/eventsourcing/store.go
package eventsourcing

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Event represents a domain event
type Event struct {
	ID            string          `json:"id"`
	AggregateID   string          `json:"aggregate_id"`
	AggregateType string          `json:"aggregate_type"`
	Type          string          `json:"type"`
	Version       int             `json:"version"`
	Data          json.RawMessage `json:"data"`
	Metadata      json.RawMessage `json:"metadata"`
	Timestamp     time.Time       `json:"timestamp"`
}

// EventStore manages event persistence
type EventStore struct {
	db *sql.DB
}

// NewEventStore creates a new event store
func NewEventStore(db *sql.DB) (*EventStore, error) {
	store := &EventStore{db: db}
	if err := store.createSchema(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *EventStore) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS events (
			id UUID PRIMARY KEY,
			aggregate_id UUID NOT NULL,
			aggregate_type VARCHAR(255) NOT NULL,
			type VARCHAR(255) NOT NULL,
			version INT NOT NULL,
			data JSONB NOT NULL,
			metadata JSONB,
			timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
			UNIQUE(aggregate_id, version)
		);

		CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, version);
		CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
		CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

		CREATE TABLE IF NOT EXISTS snapshots (
			aggregate_id UUID PRIMARY KEY,
			aggregate_type VARCHAR(255) NOT NULL,
			version INT NOT NULL,
			data JSONB NOT NULL,
			timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
		);
	`

	_, err := s.db.Exec(query)
	return err
}

// AppendEvents atomically appends events for an aggregate
func (s *EventStore) AppendEvents(ctx context.Context, aggregateID, aggregateType string, expectedVersion int, events []Event) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check current version (optimistic locking)
	var currentVersion int
	err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 0) FROM events WHERE aggregate_id = $1`,
		aggregateID,
	).Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("get version: %w", err)
	}

	if currentVersion != expectedVersion {
		return fmt.Errorf("concurrency conflict: expected version %d, got %d", expectedVersion, currentVersion)
	}

	// Insert events
	for i, event := range events {
		event.ID = uuid.New().String()
		event.AggregateID = aggregateID
		event.AggregateType = aggregateType
		event.Version = expectedVersion + i + 1
		event.Timestamp = time.Now().UTC()

		_, err := tx.ExecContext(ctx,
			`INSERT INTO events (id, aggregate_id, aggregate_type, type, version, data, metadata, timestamp)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			event.ID, event.AggregateID, event.AggregateType, event.Type,
			event.Version, event.Data, event.Metadata, event.Timestamp,
		)
		if err != nil {
			return fmt.Errorf("insert event: %w", err)
		}
	}

	return tx.Commit()
}

// LoadEvents loads all events for an aggregate
func (s *EventStore) LoadEvents(ctx context.Context, aggregateID string) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, aggregate_id, aggregate_type, type, version, data, metadata, timestamp
		 FROM events
		 WHERE aggregate_id = $1
		 ORDER BY version`,
		aggregateID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var event Event
		err := rows.Scan(
			&event.ID, &event.AggregateID, &event.AggregateType, &event.Type,
			&event.Version, &event.Data, &event.Metadata, &event.Timestamp,
		)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}

	return events, rows.Err()
}

// LoadEventsFromVersion loads events starting from a version
func (s *EventStore) LoadEventsFromVersion(ctx context.Context, aggregateID string, fromVersion int) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, aggregate_id, aggregate_type, type, version, data, metadata, timestamp
		 FROM events
		 WHERE aggregate_id = $1 AND version > $2
		 ORDER BY version`,
		aggregateID, fromVersion,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var event Event
		err := rows.Scan(
			&event.ID, &event.AggregateID, &event.AggregateType, &event.Type,
			&event.Version, &event.Data, &event.Metadata, &event.Timestamp,
		)
		if err != nil {
			return nil, err
		}
		events = append(events, event)
	}

	return events, rows.Err()
}

// SaveSnapshot saves an aggregate snapshot
func (s *EventStore) SaveSnapshot(ctx context.Context, aggregateID, aggregateType string, version int, data any) error {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO snapshots (aggregate_id, aggregate_type, version, data, timestamp)
		 VALUES ($1, $2, $3, $4, NOW())
		 ON CONFLICT (aggregate_id) DO UPDATE
		 SET aggregate_type = $2, version = $3, data = $4, timestamp = NOW()`,
		aggregateID, aggregateType, version, dataJSON,
	)

	return err
}

// LoadSnapshot loads an aggregate snapshot
func (s *EventStore) LoadSnapshot(ctx context.Context, aggregateID string) (*Snapshot, error) {
	var snapshot Snapshot
	err := s.db.QueryRowContext(ctx,
		`SELECT aggregate_id, aggregate_type, version, data, timestamp
		 FROM snapshots
		 WHERE aggregate_id = $1`,
		aggregateID,
	).Scan(&snapshot.AggregateID, &snapshot.AggregateType, &snapshot.Version, &snapshot.Data, &snapshot.Timestamp)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &snapshot, nil
}

// Snapshot represents an aggregate snapshot
type Snapshot struct {
	AggregateID   string          `json:"aggregate_id"`
	AggregateType string          `json:"aggregate_type"`
	Version       int             `json:"version"`
	Data          json.RawMessage `json:"data"`
	Timestamp     time.Time       `json:"timestamp"`
}
```

### Aggregate Implementation

In event sourcing an aggregate never mutates its state directly. Instead it appends a domain event to its uncommitted list, and the `apply` method reconstructs current state by replaying those events in order. The Go `Aggregate` interface enforces this contract: `Apply` is the only path to state mutation, and `GetUncommittedEvents` exposes the batch to be persisted atomically before the aggregate is returned to the caller. Optimistic concurrency is handled by comparing the aggregate's current version against the stored version before appending, preventing lost-update races between concurrent command handlers.

```go
// pkg/eventsourcing/aggregate.go
package eventsourcing

import (
	"encoding/json"
	"fmt"
)

// Aggregate is the base interface for event-sourced aggregates
type Aggregate interface {
	AggregateID() string
	AggregateType() string
	Version() int
	ApplyEvent(event Event) error
	GetUncommittedEvents() []Event
	ClearUncommittedEvents()
}

// BaseAggregate provides common aggregate functionality
type BaseAggregate struct {
	id                string
	aggregateType     string
	version           int
	uncommittedEvents []Event
}

// NewBaseAggregate creates a new base aggregate
func NewBaseAggregate(id, aggregateType string) *BaseAggregate {
	return &BaseAggregate{
		id:            id,
		aggregateType: aggregateType,
		version:       0,
	}
}

func (a *BaseAggregate) AggregateID() string   { return a.id }
func (a *BaseAggregate) AggregateType() string { return a.aggregateType }
func (a *BaseAggregate) Version() int          { return a.version }

func (a *BaseAggregate) GetUncommittedEvents() []Event {
	return a.uncommittedEvents
}

func (a *BaseAggregate) ClearUncommittedEvents() {
	a.uncommittedEvents = nil
}

// RaiseEvent adds an event to uncommitted events
func (a *BaseAggregate) RaiseEvent(eventType string, data any) error {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return err
	}

	event := Event{
		Type: eventType,
		Data: dataJSON,
	}

	a.uncommittedEvents = append(a.uncommittedEvents, event)
	a.version++

	return nil
}

// SetVersion sets the aggregate version (used when loading)
func (a *BaseAggregate) SetVersion(version int) {
	a.version = version
}

// Example: Order Aggregate
type OrderAggregate struct {
	*BaseAggregate

	customerID string
	items      []OrderItem
	totalCents int64
	status     string
}

// OrderItem represents an item in an order
type OrderItem struct {
	ProductID  string `json:"product_id"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// Order Events
const (
	OrderCreatedEvent    = "OrderCreated"
	OrderItemAddedEvent  = "OrderItemAdded"
	OrderConfirmedEvent  = "OrderConfirmed"
	OrderShippedEvent    = "OrderShipped"
	OrderCanceledEvent  = "OrderCanceled"
)

// Event Data Types
type OrderCreatedData struct {
	CustomerID string `json:"customer_id"`
}

type OrderItemAddedData struct {
	ProductID  string `json:"product_id"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

type OrderConfirmedData struct {
	ConfirmedAt string `json:"confirmed_at"`
}

type OrderShippedData struct {
	ShippedAt  string `json:"shipped_at"`
	TrackingID string `json:"tracking_id"`
}

type OrderCanceledData struct {
	CanceledAt string `json:"canceled_at"`
	Reason      string `json:"reason"`
}

// NewOrderAggregate creates a new order aggregate
func NewOrderAggregate(id string) *OrderAggregate {
	return &OrderAggregate{
		BaseAggregate: NewBaseAggregate(id, "Order"),
		items:         make([]OrderItem, 0),
		status:        "draft",
	}
}

// Command handlers

// Create creates a new order
func (o *OrderAggregate) Create(customerID string) error {
	if o.status != "draft" {
		return fmt.Errorf("order already created")
	}

	return o.RaiseEvent(OrderCreatedEvent, OrderCreatedData{
		CustomerID: customerID,
	})
}

// AddItem adds an item to the order
func (o *OrderAggregate) AddItem(productID string, quantity int, priceCents int64) error {
	if o.status != "draft" && o.status != "pending" {
		return fmt.Errorf("cannot add items to order in status %s", o.status)
	}

	return o.RaiseEvent(OrderItemAddedEvent, OrderItemAddedData{
		ProductID:  productID,
		Quantity:   quantity,
		PriceCents: priceCents,
	})
}

// Confirm confirms the order
func (o *OrderAggregate) Confirm() error {
	if o.status != "pending" {
		return fmt.Errorf("order must be pending to confirm")
	}

	if len(o.items) == 0 {
		return fmt.Errorf("order must have items to confirm")
	}

	return o.RaiseEvent(OrderConfirmedEvent, OrderConfirmedData{
		ConfirmedAt: "now", // Would use time.Now() in production
	})
}

// Ship ships the order
func (o *OrderAggregate) Ship(trackingID string) error {
	if o.status != "confirmed" {
		return fmt.Errorf("order must be confirmed to ship")
	}

	return o.RaiseEvent(OrderShippedEvent, OrderShippedData{
		ShippedAt:  "now",
		TrackingID: trackingID,
	})
}

// Cancel cancels the order
func (o *OrderAggregate) Cancel(reason string) error {
	if o.status == "shipped" || o.status == "delivered" {
		return fmt.Errorf("cannot cancel order in status %s", o.status)
	}

	return o.RaiseEvent(OrderCanceledEvent, OrderCanceledData{
		CanceledAt: "now",
		Reason:      reason,
	})
}

// ApplyEvent applies an event to update aggregate state
func (o *OrderAggregate) ApplyEvent(event Event) error {
	switch event.Type {
	case OrderCreatedEvent:
		var data OrderCreatedData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return err
		}
		o.customerID = data.CustomerID
		o.status = "pending"

	case OrderItemAddedEvent:
		var data OrderItemAddedData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return err
		}
		o.items = append(o.items, OrderItem{
			ProductID:  data.ProductID,
			Quantity:   data.Quantity,
			PriceCents: data.PriceCents,
		})
		o.totalCents += data.PriceCents * int64(data.Quantity)

	case OrderConfirmedEvent:
		o.status = "confirmed"

	case OrderShippedEvent:
		o.status = "shipped"

	case OrderCanceledEvent:
		o.status = "canceled"

	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}

	o.SetVersion(event.Version)
	return nil
}

// Getters
func (o *OrderAggregate) CustomerID() string   { return o.customerID }
func (o *OrderAggregate) Items() []OrderItem   { return o.items }
func (o *OrderAggregate) TotalCents() int64    { return o.totalCents }
func (o *OrderAggregate) Status() string       { return o.status }
```

### Repository Pattern for Event-Sourced Aggregates

The generic `Repository[T]` wraps the event store with aggregate-specific load and save logic: loading first checks for a snapshot, then replays only the events after the snapshot version, and saving appends uncommitted events with the expected version for optimistic concurrency. The `snapshotEvery` parameter controls how often the repository writes a snapshot. Set it to 0 to disable snapshots entirely, or to a value like 100 for aggregates with long event histories.

```go
// pkg/eventsourcing/repository.go
package eventsourcing

import (
	"context"
	"fmt"
)

// Repository manages aggregate persistence
type Repository[T Aggregate] struct {
	store         *EventStore
	factory       func(id string) T
	snapshotEvery int
}

// NewRepository creates a new repository
func NewRepository[T Aggregate](store *EventStore, factory func(id string) T, snapshotEvery int) *Repository[T] {
	return &Repository[T]{
		store:         store,
		factory:       factory,
		snapshotEvery: snapshotEvery,
	}
}

// Load loads an aggregate from the event store
func (r *Repository[T]) Load(ctx context.Context, id string) (T, error) {
	aggregate := r.factory(id)

	// Try to load snapshot first
	snapshot, err := r.store.LoadSnapshot(ctx, id)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("load snapshot: %w", err)
	}

	var fromVersion int
	if snapshot != nil {
		// Apply snapshot
		if err := r.applySnapshot(aggregate, snapshot); err != nil {
			var zero T
			return zero, fmt.Errorf("apply snapshot: %w", err)
		}
		fromVersion = snapshot.Version
	}

	// Load events since snapshot
	events, err := r.store.LoadEventsFromVersion(ctx, id, fromVersion)
	if err != nil {
		var zero T
		return zero, fmt.Errorf("load events: %w", err)
	}

	// Apply events
	for _, event := range events {
		if err := aggregate.ApplyEvent(event); err != nil {
			var zero T
			return zero, fmt.Errorf("apply event: %w", err)
		}
	}

	return aggregate, nil
}

// Save saves an aggregate to the event store
func (r *Repository[T]) Save(ctx context.Context, aggregate T) error {
	events := aggregate.GetUncommittedEvents()
	if len(events) == 0 {
		return nil
	}

	expectedVersion := aggregate.Version() - len(events)

	err := r.store.AppendEvents(
		ctx,
		aggregate.AggregateID(),
		aggregate.AggregateType(),
		expectedVersion,
		events,
	)
	if err != nil {
		return fmt.Errorf("append events: %w", err)
	}

	// Create snapshot if needed
	if r.snapshotEvery > 0 && aggregate.Version()%r.snapshotEvery == 0 {
		if err := r.createSnapshot(ctx, aggregate); err != nil {
			// Log but don't fail - snapshot is optimization
			fmt.Printf("Failed to create snapshot: %v\n", err)
		}
	}

	aggregate.ClearUncommittedEvents()

	return nil
}

func (r *Repository[T]) applySnapshot(aggregate T, snapshot *Snapshot) error {
	// This is aggregate-type specific
	// In a real implementation, you'd have a snapshot deserializer
	return nil
}

func (r *Repository[T]) createSnapshot(ctx context.Context, aggregate T) error {
	return r.store.SaveSnapshot(
		ctx,
		aggregate.AggregateID(),
		aggregate.AggregateType(),
		aggregate.Version(),
		aggregate,
	)
}

// Example usage
func ExampleOrderRepository() {
	// Create event store and repository
	// store, _ := NewEventStore(db)
	// repo := NewRepository(store, NewOrderAggregate, 100)

	// // Create new order
	// order := NewOrderAggregate("order-123")
	// order.Create("customer-456")
	// order.AddItem("product-789", 2, 29.99)
	// order.Confirm()

	// // Save to event store
	// repo.Save(ctx, order)

	// // Load from event store
	// loadedOrder, _ := repo.Load(ctx, "order-123")
	// fmt.Printf("Order status: %s\n", loadedOrder.Status())
}
```

### Junior → FAANG: Building Intuition for Event Sourcing

Event sourcing inverts the normal data persistence model. In a typical service you store the current state and overwrite it on every update. In an event-sourced service you store every change as a separate row and reconstruct current state by replaying those rows. This inversion has consequences that take time to internalize.

**The apply method is pure.** `ApplyEvent` in `OrderAggregate` must never make database calls, send HTTP requests, or produce any side effect other than mutating the aggregate's in-memory fields. It will be called thousands of times during replay, and any side effect would execute thousands of times. This is the most common bug in event-sourced systems written by engineers new to the pattern. Write a test that loads an aggregate from one hundred events and verifies that no database queries were executed during the load.

**`RaiseEvent` vs `ApplyEvent` are two steps.** `RaiseEvent` adds an event to `uncommittedEvents` and increments the version. It does not change the aggregate state yet. After the repository persists the uncommitted events, `ApplyEvent` is called to update the in-memory state. The order matters: if you update state in `RaiseEvent` and then fail to persist, your in-memory aggregate is ahead of the database. Always update state only in `ApplyEvent`.

**Optimistic concurrency is your safety net.** The `UNIQUE(aggregate_id, version)` constraint in the events table is not just a performance optimization. It is the mechanism that prevents two concurrent command handlers from both succeeding when they should conflict. If two goroutines load an order at version 5, both process a command, and both try to append at version 6, the database rejects the second insert with a unique constraint violation. The caller gets a `concurrency conflict` error and retries. Always test this case explicitly.

**Snapshot strategy.** The `snapshotEvery` parameter in the repository defaults to 100 events. For most aggregates this is fine. For aggregates with very long histories (an account with ten years of transactions), you may want a lower threshold. For aggregates with short histories (an order that never exceeds 20 events), snapshots add write overhead without benefit. Profile your aggregate event distribution before setting this value.

### Senior @ FAANG: Event Sourcing at Platform Scale

Event sourcing is a powerful pattern but one of the highest-cost patterns in the EDA toolkit. Before advocating for it in a design review, be prepared to answer these questions.

**When is event sourcing the right choice?** The canonical justification is audit: if you need a complete, tamper-evident history of every state change, event sourcing provides that by definition. Financial systems, compliance-sensitive workflows, and systems that need to "rewind" to any point in time are strong candidates. General CRUD services with no audit requirement are not. The mistake is applying event sourcing because it is architecturally interesting rather than because it solves a concrete business problem.

**The event store schema is an immutable contract.** Once events are written to the event store, they cannot be modified or deleted. This is a feature (the audit log is trustworthy) and a constraint (schema mistakes are very expensive to fix). Invest heavily in event schema design before writing the first event to production. Use a schema registry to enforce compatibility. Run the event schema through a full design review with the team before shipping.

**Snapshot strategy at scale.** The generic `Repository` snapshot implementation in this section stores the aggregate as JSON in a `snapshots` table. This is correct for most cases, but at high event rates the snapshot write can become a write bottleneck. Alternative strategies: snapshot asynchronously (a background job writes snapshots, the main path never blocks on them), snapshot on a separate column store (e.g., a Redis hash per aggregate for fast reconstruction), or use Postgres JSONB with GIN indexes for efficient aggregate state queries without full event replay. The choice depends on your aggregate size, event rate, and read-to-write ratio.

**Projection lag and read-after-write consistency.** In a CQRS system built on event sourcing, there is a gap between when an event is committed to the event store and when the projection reflects it in the read model. This gap is normally milliseconds but can grow under load. APIs that return read-model data immediately after a command will return stale data during this window. Three strategies address this: accept eventual consistency and document it explicitly in the API contract, poll the projection until it reflects the new event (with a timeout), or return the command result directly from the write model without going through the projection. The correct choice depends on whether the caller needs the post-command state immediately. Document this decision per endpoint.

**Event store partitioning at scale.** A single `events` table per-database works well up to tens of millions of events. Beyond that, consider partitioning by `aggregate_type` (a Postgres table partition per aggregate type), by time range (monthly or yearly partitions to enable efficient pruning of old events), or by sharding aggregate IDs across multiple database instances. EventStoreDB and Marten (Postgres-backed) provide these capabilities with higher-level APIs. For a greenfield system expecting high event volume, evaluate purpose-built event store databases before committing to a hand-rolled Postgres schema.

---
