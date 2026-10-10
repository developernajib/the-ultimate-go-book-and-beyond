## 49.6 CQRS Implementation

### Command and Query Separation

CQRS separates the write model (commands that mutate state) from the read model (queries that project read-optimized views), allowing them to scale independently and use different storage technologies. The Go implementation uses reflection to route commands and queries to their registered handlers by type, making the bus extensible without modifying the dispatcher. Read projections are updated asynchronously by consuming domain events, so the query side can use a denormalized schema optimized for the specific access patterns of each view without impacting write throughput.

```go
// pkg/cqrs/cqrs.go
package cqrs

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
)

// Command represents an intent to change state
type Command interface {
	CommandName() string
}

// Query represents a request for data
type Query interface {
	QueryName() string
}

// CommandHandler handles a specific command type
type CommandHandler interface {
	Handle(ctx context.Context, cmd Command) error
}

// QueryHandler handles a specific query type
type QueryHandler interface {
	Handle(ctx context.Context, query Query) (any, error)
}

// CommandBus routes commands to handlers
type CommandBus struct {
	handlers map[string]CommandHandler
	mu       sync.RWMutex
}

// NewCommandBus creates a new command bus
func NewCommandBus() *CommandBus {
	return &CommandBus{
		handlers: make(map[string]CommandHandler),
	}
}

// Register registers a handler for a command type
func (b *CommandBus) Register(commandName string, handler CommandHandler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[commandName] = handler
}

// Dispatch dispatches a command to its handler
func (b *CommandBus) Dispatch(ctx context.Context, cmd Command) error {
	b.mu.RLock()
	handler, exists := b.handlers[cmd.CommandName()]
	b.mu.RUnlock()

	if !exists {
		return fmt.Errorf("no handler for command: %s", cmd.CommandName())
	}

	return handler.Handle(ctx, cmd)
}

// QueryBus routes queries to handlers
type QueryBus struct {
	handlers map[string]QueryHandler
	mu       sync.RWMutex
}

// NewQueryBus creates a new query bus
func NewQueryBus() *QueryBus {
	return &QueryBus{
		handlers: make(map[string]QueryHandler),
	}
}

// Register registers a handler for a query type
func (b *QueryBus) Register(queryName string, handler QueryHandler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[queryName] = handler
}

// Dispatch dispatches a query to its handler
func (b *QueryBus) Dispatch(ctx context.Context, query Query) (any, error) {
	b.mu.RLock()
	handler, exists := b.handlers[query.QueryName()]
	b.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("no handler for query: %s", query.QueryName())
	}

	return handler.Handle(ctx, query)
}
```

### Read Model Projections

A projection consumes domain events and materializes them into denormalized read models optimized for specific query patterns. The `ProjectionManager` tracks the last processed event version per projection so it can resume from where it left off after a restart, and provides a `Rebuild` method that resets a projection and replays all events from the beginning, which is useful after fixing a projection bug or adding a new view.

```go
// pkg/cqrs/projection.go
package cqrs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Projection builds read models from events
type Projection interface {
	Name() string
	Handle(ctx context.Context, event Event) error
	Reset(ctx context.Context) error
}

// ProjectionManager manages multiple projections
type ProjectionManager struct {
	projections map[string]Projection
	db          *sql.DB
	logger      *slog.Logger
	mu          sync.RWMutex
}

// Event represents a domain event for projections
type Event struct {
	ID            string          `json:"id"`
	AggregateID   string          `json:"aggregate_id"`
	AggregateType string          `json:"aggregate_type"`
	Type          string          `json:"type"`
	Version       int             `json:"version"`
	Data          json.RawMessage `json:"data"`
	Timestamp     time.Time       `json:"timestamp"`
}

// NewProjectionManager creates a new projection manager
func NewProjectionManager(db *sql.DB, logger *slog.Logger) (*ProjectionManager, error) {
	pm := &ProjectionManager{
		projections: make(map[string]Projection),
		db:          db,
		logger:      logger,
	}

	if err := pm.createSchema(); err != nil {
		return nil, err
	}

	return pm, nil
}

func (pm *ProjectionManager) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS projection_positions (
			projection_name VARCHAR(255) PRIMARY KEY,
			last_event_id VARCHAR(255) NOT NULL,
			last_event_version BIGINT NOT NULL,
			updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
		)
	`

	_, err := pm.db.Exec(query)
	return err
}

// Register registers a projection
func (pm *ProjectionManager) Register(projection Projection) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.projections[projection.Name()] = projection
}

// ProcessEvent processes an event through all projections
func (pm *ProjectionManager) ProcessEvent(ctx context.Context, event Event) error {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	for name, projection := range pm.projections {
		if err := projection.Handle(ctx, event); err != nil {
			pm.logger.Error("Projection failed",
				"projection", name,
				"event_type", event.Type,
				"error", err,
			)
			return fmt.Errorf("projection %s: %w", name, err)
		}

		// Update position
		if err := pm.updatePosition(ctx, name, event.ID, event.Version); err != nil {
			pm.logger.Error("Failed to update projection position",
				"projection", name,
				"error", err,
			)
		}
	}

	return nil
}

func (pm *ProjectionManager) updatePosition(ctx context.Context, projectionName, eventID string, version int) error {
	query := `
		INSERT INTO projection_positions (projection_name, last_event_id, last_event_version, updated_at)
		VALUES ($1, $2, $3, NOW())
		ON CONFLICT (projection_name) DO UPDATE
		SET last_event_id = $2, last_event_version = $3, updated_at = NOW()
	`

	_, err := pm.db.ExecContext(ctx, query, projectionName, eventID, version)
	return err
}

// GetPosition gets the last processed event for a projection
func (pm *ProjectionManager) GetPosition(ctx context.Context, projectionName string) (string, int, error) {
	var eventID string
	var version int

	err := pm.db.QueryRowContext(ctx,
		`SELECT last_event_id, last_event_version FROM projection_positions WHERE projection_name = $1`,
		projectionName,
	).Scan(&eventID, &version)

	if err == sql.ErrNoRows {
		return "", 0, nil
	}

	return eventID, version, err
}

// Rebuild rebuilds a projection from scratch
func (pm *ProjectionManager) Rebuild(ctx context.Context, projectionName string, eventLoader func(ctx context.Context, fromVersion int) ([]Event, error)) error {
	pm.mu.RLock()
	projection, exists := pm.projections[projectionName]
	pm.mu.RUnlock()

	if !exists {
		return fmt.Errorf("projection not found: %s", projectionName)
	}

	pm.logger.Info("Rebuilding projection", "name", projectionName)

	// Reset the projection
	if err := projection.Reset(ctx); err != nil {
		return fmt.Errorf("reset projection: %w", err)
	}

	// Load and replay all events
	events, err := eventLoader(ctx, 0)
	if err != nil {
		return fmt.Errorf("load events: %w", err)
	}

	for _, event := range events {
		if err := projection.Handle(ctx, event); err != nil {
			return fmt.Errorf("handle event %s: %w", event.ID, err)
		}

		if err := pm.updatePosition(ctx, projectionName, event.ID, event.Version); err != nil {
			pm.logger.Warn("Failed to update position", "error", err)
		}
	}

	pm.logger.Info("Projection rebuilt",
		"name", projectionName,
		"events_processed", len(events),
	)

	return nil
}

// Example: Order Summary Projection
type OrderSummaryProjection struct {
	db *sql.DB
}

func NewOrderSummaryProjection(db *sql.DB) (*OrderSummaryProjection, error) {
	p := &OrderSummaryProjection{db: db}
	if err := p.createSchema(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *OrderSummaryProjection) Name() string { return "order_summary" }

func (p *OrderSummaryProjection) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS order_summaries (
			order_id UUID PRIMARY KEY,
			customer_id UUID NOT NULL,
			status VARCHAR(50) NOT NULL,
			item_count INT NOT NULL DEFAULT 0,
			total_cents BIGINT NOT NULL DEFAULT 0,
			created_at TIMESTAMP WITH TIME ZONE,
			updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_order_summaries_customer ON order_summaries(customer_id);
		CREATE INDEX IF NOT EXISTS idx_order_summaries_status ON order_summaries(status);
	`

	_, err := p.db.Exec(query)
	return err
}

func (p *OrderSummaryProjection) Handle(ctx context.Context, event Event) error {
	switch event.Type {
	case "OrderCreated":
		var data struct {
			CustomerID string `json:"customer_id"`
		}
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return err
		}

		_, err := p.db.ExecContext(ctx,
			`INSERT INTO order_summaries (order_id, customer_id, status, created_at)
			 VALUES ($1, $2, 'pending', $3)`,
			event.AggregateID, data.CustomerID, event.Timestamp,
		)
		return err

	case "OrderItemAdded":
		var data struct {
			Quantity   int   `json:"quantity"`
			PriceCents int64 `json:"price_cents"`
		}
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return err
		}

		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries
			 SET item_count = item_count + $1, total_cents = total_cents + $2, updated_at = NOW()
			 WHERE order_id = $3`,
			data.Quantity, data.PriceCents*int64(data.Quantity), event.AggregateID,
		)
		return err

	case "OrderConfirmed":
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries SET status = 'confirmed', updated_at = NOW() WHERE order_id = $1`,
			event.AggregateID,
		)
		return err

	case "OrderShipped":
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries SET status = 'shipped', updated_at = NOW() WHERE order_id = $1`,
			event.AggregateID,
		)
		return err

	case "OrderCanceled":
		_, err := p.db.ExecContext(ctx,
			`UPDATE order_summaries SET status = 'canceled', updated_at = NOW() WHERE order_id = $1`,
			event.AggregateID,
		)
		return err
	}

	return nil
}

func (p *OrderSummaryProjection) Reset(ctx context.Context) error {
	_, err := p.db.ExecContext(ctx, `TRUNCATE order_summaries`)
	return err
}

// OrderSummary represents the read model
type OrderSummary struct {
	OrderID    string    `json:"order_id" db:"order_id"`
	CustomerID string    `json:"customer_id" db:"customer_id"`
	Status     string    `json:"status" db:"status"`
	ItemCount  int       `json:"item_count" db:"item_count"`
	TotalCents int64     `json:"total_cents" db:"total_cents"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
	UpdatedAt  time.Time `json:"updated_at" db:"updated_at"`
}

// OrderSummaryQuery queries the read model
type OrderSummaryQuery struct {
	db *sql.DB
}

func NewOrderSummaryQuery(db *sql.DB) *OrderSummaryQuery {
	return &OrderSummaryQuery{db: db}
}

func (q *OrderSummaryQuery) GetByID(ctx context.Context, orderID string) (*OrderSummary, error) {
	var summary OrderSummary
	err := q.db.QueryRowContext(ctx,
		`SELECT order_id, customer_id, status, item_count, total_cents, created_at, updated_at
		 FROM order_summaries WHERE order_id = $1`,
		orderID,
	).Scan(
		&summary.OrderID, &summary.CustomerID, &summary.Status,
		&summary.ItemCount, &summary.TotalCents, &summary.CreatedAt, &summary.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &summary, err
}

func (q *OrderSummaryQuery) GetByCustomer(ctx context.Context, customerID string, limit, offset int) ([]OrderSummary, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT order_id, customer_id, status, item_count, total_cents, created_at, updated_at
		 FROM order_summaries
		 WHERE customer_id = $1
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`,
		customerID, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var summaries []OrderSummary
	for rows.Next() {
		var summary OrderSummary
		err := rows.Scan(
			&summary.OrderID, &summary.CustomerID, &summary.Status,
			&summary.ItemCount, &summary.TotalCents, &summary.CreatedAt, &summary.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, summary)
	}

	return summaries, rows.Err()
}

func (q *OrderSummaryQuery) GetStatsByStatus(ctx context.Context) (map[string]int, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT status, COUNT(*) FROM order_summaries GROUP BY status`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := make(map[string]int)
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		stats[status] = count
	}

	return stats, rows.Err()
}
```

### Junior → FAANG: Understanding Why CQRS Exists and When to Apply It

CQRS solves a specific problem: the data model that is best for writing (normalized, with constraints, optimized for consistency) is often not the data model that is best for reading (denormalized, pre-joined, optimized for the specific query patterns of a UI or API). CQRS separates these two models explicitly.

The most important mental model for a junior engineer: the read model is a cache. It is derived from the write model (via event projections), it may be stale, and it can always be rebuilt from the event store if it becomes corrupted. This means you can apply optimizations to the read model that would be dangerous in the write model, such as denormalization, precomputed aggregates, and index-heavy schemas.

**When CQRS is overkill.** Do not apply CQRS to every service. A CRUD service with simple list and detail queries does not need a separate read model. CQRS adds complexity: it introduces two data stores, a projection process, eventual consistency between write and read, and a projection rebuilder. Accept this complexity only when the query patterns for a service are substantially different from the write patterns, or when the read and write loads differ by an order of magnitude and must scale independently.

**The `CommandBus` in this section uses a string name to look up handlers.** This is a valid approach but loses compile-time safety: a typo in the command name produces a runtime error, not a build error. An alternative is to use Go generics or the concrete command type as the map key. For a first implementation the string-based bus is fine. Upgrade to a type-safe dispatch mechanism when the number of command types grows beyond a handful.

**Projection position tracking is mandatory.** The `projection_positions` table records the last event ID processed by each projection. Without this, every service restart replays all events from the beginning, which is slow for large event stores and produces duplicate side effects in projections that trigger external calls. Always implement position tracking from the beginning, even in development.

### Senior @ FAANG: CQRS Governance in a Multi-Team Platform

At staff level, CQRS is not a pattern you implement once. It is a set of architectural decisions that cascade through your platform and require ongoing governance.

**Projection ownership.** In a single-team system, one team owns both the projection writer (which consumes events and updates read models) and the query handler (which reads from the read model). In a multi-team system, the projection writer is often owned by the team that produces the events, while the query handler is owned by the team that consumes the read model. This organizational seam requires explicit contracts: what events does the projection consume, what schema does the read model expose, and who is responsible for keeping the read model healthy when the event schema changes.

**Projection rebuilding as an operational procedure.** The `Rebuild` method in the `ProjectionManager` is a one-line invocation in code but a multi-step operational procedure in production. Before a rebuild, you need to: estimate the volume of events to replay and the time it will take (affects how long the read model will be in a "rebuilding" state), decide whether to serve stale data or take the read model offline during the rebuild, ensure the projection logic does not trigger external calls during replay (see the pitfalls section on replay side effects), and have a rollback plan if the rebuild introduces a regression. Document this procedure and practice it in staging before you need it in production.

**Multiple read models for the same event stream.** A single event stream can feed multiple projections, each optimized for a different query pattern. The order event stream in this chapter could feed: an `order_summaries` table for the order list API, an `order_line_items` table for the line-item detail API, a `revenue_by_day` materialized view for the analytics dashboard, and a `customer_order_count` Redis hash for the recommendation engine. Each projection is a separate process with independent scaling and independent rebuild procedures. A platform team builds the projection framework and event delivery infrastructure, and each product team builds the specific projection logic for their query patterns.

**The eventually consistent API contract.** CQRS with event-sourced projections is eventually consistent. The time between command execution and read model update is typically milliseconds but can be seconds or minutes under heavy load. Your API contract must document this explicitly. Common patterns: add an `X-Command-ID` header to command responses, add a query parameter `?after_command=<id>` that tells the query endpoint to wait until the projection has processed that command before returning, or use WebSocket or SSE to push the updated read model to the client when the projection catches up. The "wait for projection" pattern is the simplest UX but the most expensive in terms of server resources. Choose based on the UX requirements of the specific endpoint.

**CQRS and the CAP theorem.** In a distributed CQRS system, the write model can be CP (strongly consistent within a single database, rejecting writes if the database is unavailable) while the read model is AP (serving stale data from the last known state if the projection process is behind). This is often the right tradeoff: commands must be strongly consistent because they enforce business rules, while queries can tolerate stale data because they are read-only. Make this explicit in your architecture documentation so that downstream consumers know which consistency model they are getting from each endpoint.

---
