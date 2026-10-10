## Section 3: Event Sourcing + CQRS

### 3.1 When to use this, and when not to

Event Sourcing is misapplied more often than any other pattern in this chapter. Greg Young (who coined the term) and Oskar Dudycz (event-driven.io) have both spent years walking practitioners back from maximalist interpretations. The honest rule of thumb in 2026:

- **Use Event Sourcing when** the full history of how state changed is itself a business requirement: regulated finance, ledger systems, audit-heavy healthcare, e-commerce carts that must be reconstructible at any past moment, collaborative editing, temporal analytics.
- **Do not use Event Sourcing when** you want it because it looks modern, or because "immutability is good". You will pay for projection maintenance, event schema versioning, storage growth (events never get deleted, only snapshotted), and a class of temporal bugs where queries at time T see a state that never actually existed because a late event landed after projection caught up.

CQRS (Command Query Responsibility Segregation) often travels with Event Sourcing but is independent of it. CQRS says: the write model and the read model do not need to share a schema. You can adopt CQRS over a plain CRUD database by projecting writes to a denormalized read table, with zero event sourcing. Dudycz's pragmatic writing repeatedly makes this point: start with CRUD, slice vertically by feature, move to CQRS when read patterns diverge from write patterns, and only then consider event sourcing if temporal queries are core.

> **Senior track**: The trap in CQRS is reconciliation. The write model says the order is placed, but the read projection is three seconds behind because it updates asynchronously on the event. A user who just submitted an order and hits refresh sees no order. Solve this with read-your-own-writes (cache the write result in the session for the projection lag window) or by making the projection update synchronous on the write path for specific queries. Do not pretend eventual consistency is free.

### 3.2 Event Store

`DomainEvent` uses `json.RawMessage` for its `Payload` field so the event store can persist events without knowing their concrete type, deferring deserialization to the projection or command handler that understands the specific event. The `Version` field on each event enables optimistic concurrency control. The event store rejects an append if the aggregate's current version does not match the expected version, preventing lost-update races without distributed locks.

```go
package eventsourcing

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// DomainEvent is the base type for all domain events.
type DomainEvent struct {
	ID          string          `json:"id"`
	AggregateID string          `json:"aggregate_id"`
	AggregateType string        `json:"aggregate_type"`
	EventType   string          `json:"event_type"`
	Version     int64           `json:"version"`
	Payload     json.RawMessage `json:"payload"`
	OccurredAt  time.Time       `json:"occurred_at"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}

// Aggregate is the base for domain aggregates.
type Aggregate interface {
	ID() string
	Version() int64
	Apply(event DomainEvent) error
	UncommittedEvents() []DomainEvent
	ClearUncommittedEvents()
}

// EventStore persists and retrieves domain events.
type EventStore interface {
	// Append appends events to the stream, with optimistic concurrency check.
	// expectedVersion is the version the caller expects - fails if actual version differs.
	Append(ctx context.Context, aggregateID string, events []DomainEvent, expectedVersion int64) error
	// Load retrieves all events for an aggregate.
	Load(ctx context.Context, aggregateID string) ([]DomainEvent, error)
	// LoadFrom retrieves events after a version.
	LoadFrom(ctx context.Context, aggregateID string, afterVersion int64) ([]DomainEvent, error)
	// Subscribe delivers new events to a handler.
	Subscribe(ctx context.Context, eventTypes []string, handler func(DomainEvent)) error
}

// PostgresEventStore implements EventStore using Postgres.
type PostgresEventStore struct {
	db          *sql.DB
	subscribers sync.Map // eventType → []chan DomainEvent
}

func NewPostgresEventStore(db *sql.DB) *PostgresEventStore {
	store := &PostgresEventStore{db: db}
	store.createSchema(context.Background())
	return store
}

func (s *PostgresEventStore) createSchema(ctx context.Context) {
	s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS events (
			id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			aggregate_id    TEXT NOT NULL,
			aggregate_type  TEXT NOT NULL,
			event_type      TEXT NOT NULL,
			version         BIGINT NOT NULL,
			payload         JSONB NOT NULL,
			occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			metadata        JSONB,
			UNIQUE (aggregate_id, version)
		);
		CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id, version);
		CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, occurred_at);
	`)
}

func (s *PostgresEventStore) Append(ctx context.Context, aggregateID string, events []DomainEvent, expectedVersion int64) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check optimistic concurrency
	var currentVersion sql.NullInt64
	row := tx.QueryRowContext(ctx,
		`SELECT MAX(version) FROM events WHERE aggregate_id = $1`, aggregateID)
	if err := row.Scan(&currentVersion); err != nil {
		return err
	}

	actual := int64(0)
	if currentVersion.Valid {
		actual = currentVersion.Int64
	}

	if actual != expectedVersion {
		return fmt.Errorf("optimistic concurrency: expected version %d, got %d", expectedVersion, actual)
	}

	// Insert all events
	for _, event := range events {
		payloadJSON, _ := json.Marshal(event.Payload)
		metaJSON, _ := json.Marshal(event.Metadata)

		_, err := tx.ExecContext(ctx,
			`INSERT INTO events (id, aggregate_id, aggregate_type, event_type, version, payload, occurred_at, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			event.ID, aggregateID, event.AggregateType, event.EventType,
			event.Version, payloadJSON, event.OccurredAt, metaJSON,
		)
		if err != nil {
			return fmt.Errorf("insert event: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	// Notify subscribers (async)
	for _, event := range events {
		s.notifySubscribers(event)
	}

	return nil
}

func (s *PostgresEventStore) Load(ctx context.Context, aggregateID string) ([]DomainEvent, error) {
	return s.LoadFrom(ctx, aggregateID, 0)
}

func (s *PostgresEventStore) LoadFrom(ctx context.Context, aggregateID string, afterVersion int64) ([]DomainEvent, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, aggregate_id, aggregate_type, event_type, version, payload, occurred_at, metadata
		 FROM events
		 WHERE aggregate_id = $1 AND version > $2
		 ORDER BY version ASC`,
		aggregateID, afterVersion,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []DomainEvent
	for rows.Next() {
		var e DomainEvent
		var payloadJSON, metaJSON []byte
		err := rows.Scan(&e.ID, &e.AggregateID, &e.AggregateType, &e.EventType,
			&e.Version, &payloadJSON, &e.OccurredAt, &metaJSON)
		if err != nil {
			return nil, err
		}
		e.Payload = payloadJSON
		if metaJSON != nil {
			json.Unmarshal(metaJSON, &e.Metadata)
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

func (s *PostgresEventStore) Subscribe(ctx context.Context, eventTypes []string, handler func(DomainEvent)) error {
	ch := make(chan DomainEvent, 256)
	for _, et := range eventTypes {
		v, _ := s.subscribers.LoadOrStore(et, &sync.Mutex{})
		_ = v
		// Store channel for this event type
		s.subscribers.Store(et+":ch", ch)
	}
	go func() {
		for {
			select {
			case e := <-ch:
				handler(e)
			case <-ctx.Done():
				return
			}
		}
	}()
	return nil
}

func (s *PostgresEventStore) notifySubscribers(event DomainEvent) {
	if v, ok := s.subscribers.Load(event.EventType + ":ch"); ok {
		ch := v.(chan DomainEvent)
		select {
		case ch <- event:
		default:
			// Don't block if subscriber is slow
		}
	}
}
```

### 3.3 CQRS Read Model Projections

Read model projections subscribe to domain events and maintain denormalized views purpose-built for specific queries, eliminating JOIN overhead at query time. The projection below listens on an `OrderPlaced` event stream and maintains a `customer_order_summary` table that supports dashboard queries with a single indexed lookup.

```go
package eventsourcing

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Projection builds and maintains a read model from events.
type Projection interface {
	Name() string
	// EventTypes returns which events this projection cares about.
	EventTypes() []string
	// Handle applies an event to the read model.
	Handle(ctx context.Context, event DomainEvent) error
	// Reset clears the read model (for full recomputation).
	Reset(ctx context.Context) error
}

// OrderReadModel is a CQRS read model for orders.
// Money is int64 minor units (cents), never float64: binary floating point
// cannot represent most decimal fractions, and the read model is a ledger.
type OrderReadModel struct {
	ID          string    `json:"id"`
	CustomerID  string    `json:"customer_id"`
	Status      string    `json:"status"`
	Items       []OrderItem `json:"items"`
	TotalAmountCents int64   `json:"total_amount_cents"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type OrderItem struct {
	SKU      string  `json:"sku"`
	Qty      int     `json:"qty"`
	PriceCents int64 `json:"price_cents"`
}

// OrderProjection builds the order read model from events.
type OrderProjection struct {
	db *sql.DB
}

func NewOrderProjection(db *sql.DB) *OrderProjection {
	p := &OrderProjection{db: db}
	p.createSchema(context.Background())
	return p
}

func (p *OrderProjection) createSchema(ctx context.Context) {
	p.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS order_read_models (
			id          TEXT PRIMARY KEY,
			customer_id TEXT NOT NULL,
			status      TEXT NOT NULL,
			items       JSONB NOT NULL DEFAULT '[]',
			total_amount_cents BIGINT NOT NULL DEFAULT 0,
			created_at  TIMESTAMPTZ,
			updated_at  TIMESTAMPTZ
		);
		CREATE INDEX IF NOT EXISTS idx_orders_customer ON order_read_models(customer_id);
		CREATE INDEX IF NOT EXISTS idx_orders_status ON order_read_models(status);
	`)
}

func (p *OrderProjection) Name() string { return "order_projection" }

func (p *OrderProjection) EventTypes() []string {
	return []string{
		"OrderPlaced",
		"OrderItemAdded",
		"OrderConfirmed",
		"OrderShipped",
		"OrderCanceled",
	}
}

func (p *OrderProjection) Handle(ctx context.Context, event DomainEvent) error {
	switch event.EventType {
	case "OrderPlaced":
		return p.handleOrderPlaced(ctx, event)
	case "OrderItemAdded":
		return p.handleOrderItemAdded(ctx, event)
	case "OrderConfirmed":
		return p.handleStatusChange(ctx, event.AggregateID, "confirmed")
	case "OrderShipped":
		return p.handleStatusChange(ctx, event.AggregateID, "shipped")
	case "OrderCanceled":
		return p.handleStatusChange(ctx, event.AggregateID, "canceled")
	}
	return nil
}

func (p *OrderProjection) handleOrderPlaced(ctx context.Context, event DomainEvent) error {
	var payload struct {
		CustomerID string    `json:"customer_id"`
		OccurredAt time.Time `json:"occurred_at"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return err
	}
	_, err := p.db.ExecContext(ctx,
		`INSERT INTO order_read_models (id, customer_id, status, created_at, updated_at)
		 VALUES ($1, $2, 'pending', $3, $3)
		 ON CONFLICT (id) DO NOTHING`,
		event.AggregateID, payload.CustomerID, event.OccurredAt,
	)
	return err
}

func (p *OrderProjection) handleOrderItemAdded(ctx context.Context, event DomainEvent) error {
	var item OrderItem
	if err := json.Unmarshal(event.Payload, &item); err != nil {
		return err
	}
	// Append item and recompute total using Postgres JSON operations
	_, err := p.db.ExecContext(ctx,
		`UPDATE order_read_models
		 SET items = items || $1::jsonb,
		     total_amount_cents = total_amount_cents + $2,
		     updated_at = NOW()
		 WHERE id = $3`,
		fmt.Sprintf(`[{"sku":%q,"qty":%d,"price_cents":%d}]`, item.SKU, item.Qty, item.PriceCents),
		item.PriceCents*int64(item.Qty),
		event.AggregateID,
	)
	return err
}

func (p *OrderProjection) handleStatusChange(ctx context.Context, orderID, status string) error {
	_, err := p.db.ExecContext(ctx,
		`UPDATE order_read_models SET status = $1, updated_at = NOW() WHERE id = $2`,
		status, orderID,
	)
	return err
}

func (p *OrderProjection) Reset(ctx context.Context) error {
	_, err := p.db.ExecContext(ctx, `TRUNCATE order_read_models`)
	return err
}

// ProjectionManager runs projections and tracks their positions.
type ProjectionManager struct {
	store       EventStore
	projections []Projection
	db          *sql.DB
}

func NewProjectionManager(store EventStore, db *sql.DB) *ProjectionManager {
	pm := &ProjectionManager{store: store, db: db}
	pm.createCheckpointTable(context.Background())
	return pm
}

func (pm *ProjectionManager) createCheckpointTable(ctx context.Context) {
	pm.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS projection_checkpoints (
			projection_name TEXT PRIMARY KEY,
			last_event_id   TEXT,
			processed_at    TIMESTAMPTZ DEFAULT NOW()
		)
	`)
}

func (pm *ProjectionManager) Register(p Projection) {
	pm.projections = append(pm.projections, p)
}

// Rebuild resets and recomputes all projections from scratch.
func (pm *ProjectionManager) Rebuild(ctx context.Context) error {
	for _, p := range pm.projections {
		if err := p.Reset(ctx); err != nil {
			return fmt.Errorf("reset %s: %w", p.Name(), err)
		}
	}

	// Subscribe to all event types across all projections
	allTypes := make(map[string]bool)
	for _, p := range pm.projections {
		for _, et := range p.EventTypes() {
			allTypes[et] = true
		}
	}

	return pm.store.Subscribe(ctx, mapKeys(allTypes), func(event DomainEvent) {
		for _, p := range pm.projections {
			for _, et := range p.EventTypes() {
				if et == event.EventType {
					if err := p.Handle(ctx, event); err != nil {
						fmt.Printf("projection %s error: %v\n", p.Name(), err)
					}
				}
			}
		}
	})
}

func mapKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
```

### Junior → FAANG: Event Sourcing and CQRS for First-Job Engineers

If you are landing your first backend role in 2026, most of what you will ship is CRUD. A REST endpoint writes a row, another reads it back. That is fine. Event sourcing is a specialized pattern, and interviewers at FAANG will probe whether you understand it well enough to recognize when it does and does not apply, not whether you have shipped it in production. The prerequisite gap most juniors carry is conflating three things that are actually independent.

First, the event log idea. An event is an immutable fact that already happened, named in the past tense: `OrderPlaced`, `PaymentCaptured`, `ShipmentDispatched`. The event store appends these records and never updates them. Current state is derived by folding events from the left. If this sounds like Kafka, that is because the core idea is the same, but a proper event store (EventStoreDB, Marten on Postgres, Axon Server) adds per-aggregate streams and optimistic concurrency, which Kafka does not give you directly.

Second, the write-model versus read-model split. This is CQRS, and it predates event sourcing. You can adopt CQRS on top of a plain Postgres row by projecting writes into a denormalized read table. Greg Young's 2010 CQRS paper and Udi Dahan's essays are still the clearest starting point. Oskar Dudycz at event-driven.io has the most pragmatic current writing, and he repeatedly reminds readers that CQRS without event sourcing is often the right starting point.

Third, projections. A projection is a read-only function from the event log into a query-friendly shape. In the code above, `OrderProjection` is exactly this. The write side appends `OrderPlaced`, and the read side subscribes and maintains a summary row. When product asks for a new dashboard, you add a new projection and replay events into it. You do not migrate a schema.

Worked example for an interview warmup. Imagine a bank account aggregate. Commands are `OpenAccount`, `Deposit`, `Withdraw`. Events are `AccountOpened`, `AmountDeposited`, `AmountWithdrawn`. The aggregate rebuilds its balance by folding events. A `Withdraw` command loads the aggregate, applies the current events, checks the balance, and if sufficient appends `AmountWithdrawn` with the expected version. If two concurrent withdrawals race, the second one fails the optimistic version check and the client retries. Write this out on a whiteboard. If you can, you have the entry-point concept. The interview signal they want is that you can distinguish an event (something that happened) from a command (a request that may be rejected) from a state (a fold of events).

First-job context. When you join a FAANG team that uses event sourcing, it is almost never a greenfield choice. It is usually a domain where audit is regulatory (payments, ads billing, identity), where the business asks temporal questions ("what was the state on March 12 at 09:14"), or where the service needs to rebuild read views without asking upstream for historical data. Your first tickets will be adding a new event type, writing an upcaster so older serialized events deserialize cleanly into the new schema, or authoring a new projection. Focus on those three skills and you will ship real work in the first quarter.

### Senior @ FAANG: Event Sourcing, CQRS, and the Long Tail of Operational Reality

At staff and principal level the question is never "should we use event sourcing" in isolation. It is "what is the cost curve of this pattern across five years of team turnover, and what failure modes will bite us at the 95th percentile." The canonical texts are Martin Fowler's 2005 event sourcing essay, Greg Young's CQRS documents, Vaughn Vernon's Implementing Domain-Driven Design (2013) for aggregate boundaries, and Young's own Versioning in an Event Sourced System (2017) for schema evolution. In 2026 the live discussion has moved to Dudycz's writing on event-driven.io, the EventStoreDB 24.x docs, the Marten project for teams on Postgres, and Axon Framework 4.10 for JVM shops. Pat Helland's Immutability Changes Everything (2015) is still the best strategic framing.

The event store as system of record is the single architectural decision that cascades through everything else. If the event log is the source of truth, then projections are disposable, rebuildable caches. This has two concrete consequences. First, projection storage must be treated as transient, which means you need rebuild tooling that can replay the full log into a fresh read store without downtime (dual-write, shadow read, cutover). Second, no downstream consumer is allowed to mutate projection state directly, because the next rebuild will erase those mutations. Enforce this with database permissions at the projection role level, not by convention.

Snapshots are not optional at scale. An aggregate with ten thousand events costs too much to rehydrate on every command. The usual pattern is a snapshot every N events (N around 100 to 500 depending on event size) stored in a separate table keyed by aggregate ID and snapshot version. The load path reads the latest snapshot, then loads events with version greater than the snapshot's version, and folds forward. Snapshots are still derived state, so they can be discarded and regenerated. Never persist only a snapshot and throw away events, because that defeats the entire pattern.

Schema evolution is where teams that did not plan ahead get destroyed. Events are immutable, which means an event written in 2021 will still be replayed in 2028. You cannot run a migration script over the event log because that rewrites history. The correct mechanism is upcasters: a pipeline of functions that transform older event versions to newer ones at deserialization time. Axon formalizes this, EventStoreDB leaves it to the client, and the Marten team documents it as event upcasting. An upcaster takes `{"version":1,"payload":...}` and returns `{"version":2,"payload":...}`. Version every event schema from day one, even if you think you never will change it. You will.

Replay discipline is an operational skill, not a coding skill. When a projection is wrong (bug, missed event type, wrong aggregation) the fix is to redeploy the projection code and replay. Replay has three failure modes worth rehearsing in game days. One, downstream side effects: if a projection triggered a notification email on `OrderPlaced`, a replay will send those emails again unless you idempotency-gate side effects, which means projections should write to read stores and nothing else, with side effects handled by a separate consumer that tracks its own offset. Two, non-deterministic events: any event that embedded "now" or a random ID outside the aggregate will diverge on replay. Ban this in code review. Three, replay duration: a log with a hundred million events takes hours to replay serially. Parallelise by aggregate ID partition and accept that cross-aggregate ordering is lost. If cross-aggregate ordering matters for a specific read model, that projection cannot be parallelised and you must budget the serial replay time.

Tool selection in 2026. EventStoreDB 24.x is the purest event store, with per-stream optimistic concurrency, built-in subscriptions, and projections in the engine. It is the right pick when event sourcing is the dominant pattern. Marten on Postgres is the pragmatic default for teams already on Postgres who want transactional guarantees between the event append and a synchronous projection in the same transaction, which solves the read-your-own-writes problem directly. Axon Server and Axon Framework are the JVM incumbents with the deepest CQRS tooling and saga support, though the licensing is now commercial for production use. Kafka as event store remains a popular choice and a frequent mistake. Kafka gives you an append-only log and ordering within a partition, but it does not give you per-aggregate optimistic concurrency, compaction does not preserve history, and rebuilds require external tooling. Use Kafka as the event bus between the event store and projection consumers, not as the event store itself.

CQRS separates the command side from the query side, and the split buys you two things that matter at scale. First, independent data models: the write model optimizes for invariants and validation, the read model optimizes for query latency, and neither compromises the other. A write model can be a normalized 3NF schema while the read model is a wide denormalized view, a search index, or a materialized graph. Second, independent scaling: read replicas, caches, and query engines scale horizontally without touching the command path. The cost is operational complexity and eventual consistency on the query side. Teams that cannot articulate their consistency budget in concrete terms (P99 projection lag under 250 ms, read-your-own-writes guaranteed for the authoring user in the same session) should not adopt CQRS, because they will ship bugs they cannot classify.

When event sourcing wins. Audit-heavy domains where regulators will ask "what did the system show on a specific date" and the answer must be reproducible without log archaeology. Ledger and accounting systems where double-entry semantics are native to the event log. Compliance workflows where every state transition must be attributable to an actor and retained for seven years. Temporal analytics where analysts reconstruct historical state to evaluate a proposed rule change. Collaborative editing where the operational transform or CRDT history is the product.

When event sourcing loses. CRUD apps where the audit requirement is satisfied by a change log table. Teams that lack the operational maturity to run replays, manage upcasters, and reason about eventual consistency. Greenfield projects adopted on architectural enthusiasm before a single command has been modeled. High-write-rate domains where the event volume exceeds the cost envelope and snapshots alone cannot recover the unit economics. Domains with frequent hard deletions (GDPR right-to-erasure) where the event log must be crypto-shredded, which is feasible but adds operational tax.

The final senior discipline is the boundary between the aggregate and the rest of the system. An aggregate is a consistency boundary, not an entity. Commands that must be atomic belong inside one aggregate. Commands that span aggregates must be choreographed through sagas or process managers, with compensating events on failure. If a junior on your team is reaching across aggregates inside a single command handler, the design is broken and the first replay with a partial failure will prove it.

---
