## 52D.4 Read Model Projections

### What Projections Are

A **projection** is the process of transforming a stream of domain events into a read model. The projection listens for domain events and updates one or more denormalized read stores.

```
Domain Events Stream:
  OrderPlaced    →  creates a record in order_views table
  OrderConfirmed →  updates status in order_views table
  OrderFulfilled →  updates status + tracking in order_views table
  OrderCanceled →  updates status + reason in order_views table
```

The power of projections: you can build as many different read models as you need from the same event stream. If you need a new view - say, a "customer lifetime value" dashboard - you write a new projection against the historical event stream, backfill the read model, and deploy it. No schema migration on the write side required.

### Implementing an Order View Projection

Read model projections subscribe to domain events and maintain denormalized views purpose-built for specific queries, eliminating JOIN overhead at query time. The projection below listens on an `OrderPlaced` event stream and maintains a `customer_order_summary` table that supports dashboard queries with a single indexed lookup.

```go
// internal/infrastructure/projection/order_view_projector.go

package projection

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// OrderViewProjector maintains the order_views read model by
// processing domain events.
type OrderViewProjector struct {
    db *sql.DB
}

// NewOrderViewProjector creates a new order view projector.
func NewOrderViewProjector(db *sql.DB) *OrderViewProjector {
    return &OrderViewProjector{db: db}
}

// Project processes a single domain event and updates the read model.
// This is called by the event consumer for each event from the event bus.
func (p *OrderViewProjector) Project(ctx context.Context, event order.DomainEvent) error {
    switch e := event.(type) {
    case order.OrderPlaced:
        return p.onOrderPlaced(ctx, e)
    case order.OrderConfirmed:
        return p.onOrderConfirmed(ctx, e)
    case order.OrderFulfilled:
        return p.onOrderFulfilled(ctx, e)
    case order.OrderCanceled:
        return p.onOrderCanceled(ctx, e)
    default:
        // Unknown event type - log and continue (don't fail)
        return nil
    }
}

func (p *OrderViewProjector) onOrderPlaced(ctx context.Context, e order.OrderPlaced) error {
    linesJSON, err := json.Marshal(e.Lines)
    if err != nil {
        return fmt.Errorf("marshal lines for projection: %w", err)
    }

    _, err = p.db.ExecContext(ctx, `
        INSERT INTO order_views (
            id, customer_id, status, total_amount, currency,
            lines, placed_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
    `,
        string(e.OrderID),
        string(e.CustomerID),
        "pending",
        e.TotalAmount.Amount,
        e.TotalAmount.Currency,
        linesJSON,
        e.PlacedAt,
        time.Now(),
    )
    return err
}

func (p *OrderViewProjector) onOrderConfirmed(ctx context.Context, e order.OrderConfirmed) error {
    _, err := p.db.ExecContext(ctx, `
        UPDATE order_views
        SET status = 'confirmed', confirmed_at = $1, updated_at = $2
        WHERE id = $3
    `, e.ConfirmedAt, time.Now(), string(e.OrderID))
    return err
}

func (p *OrderViewProjector) onOrderFulfilled(ctx context.Context, e order.OrderFulfilled) error {
    _, err := p.db.ExecContext(ctx, `
        UPDATE order_views
        SET status = 'fulfilled', tracking_number = $1, fulfilled_at = $2, updated_at = $3
        WHERE id = $4
    `, e.TrackingNumber, e.FulfilledAt, time.Now(), string(e.OrderID))
    return err
}

func (p *OrderViewProjector) onOrderCanceled(ctx context.Context, e order.OrderCanceled) error {
    _, err := p.db.ExecContext(ctx, `
        UPDATE order_views
        SET status = 'canceled', cancellation_reason = $1, canceled_at = $2, updated_at = $3
        WHERE id = $4
    `, e.Reason, e.CanceledAt, time.Now(), string(e.OrderID))
    return err
}
```

### Rebuilding Projections

Because projections are derived from events, you can rebuild them at any time:

```go
// internal/infrastructure/projection/rebuilder.go

package projection

import (
    "context"
    "fmt"
    "log/slog"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// EventStore is the interface for reading all events (used for rebuilding).
type EventStore interface {
    LoadAll(ctx context.Context, afterPosition int64) (<-chan StoredEvent, <-chan error)
}

// StoredEvent is a persisted event with its stream position.
type StoredEvent struct {
    Position  int64
    EventName string
    Payload   []byte
}

// ProjectionRebuilder replays all events to rebuild a projection from scratch.
type ProjectionRebuilder struct {
    store     EventStore
    projector *OrderViewProjector
    decoder   EventDecoder
    logger    *slog.Logger
}

// EventDecoder decodes raw event payloads into domain events.
type EventDecoder interface {
    Decode(eventName string, payload []byte) (order.DomainEvent, error)
}

// Rebuild drops and rebuilds the order_views table from the event store.
func (r *ProjectionRebuilder) Rebuild(ctx context.Context) error {
    r.logger.Info("starting projection rebuild")

    // Reset the read model
    if err := r.projector.Reset(ctx); err != nil {
        return fmt.Errorf("reset projection: %w", err)
    }

    events, errs := r.store.LoadAll(ctx, 0)
    processed := int64(0)

    for {
        select {
        case stored, ok := <-events:
            if !ok {
                r.logger.Info("projection rebuild complete", "events_processed", processed)
                return nil
            }
            event, err := r.decoder.Decode(stored.EventName, stored.Payload)
            if err != nil {
                r.logger.Warn("skip undecodable event",
                    "event_name", stored.EventName,
                    "position", stored.Position,
                    "error", err,
                )
                continue
            }
            if err := r.projector.Project(ctx, event); err != nil {
                return fmt.Errorf("project event at position %d: %w", stored.Position, err)
            }
            processed++

        case err := <-errs:
            if err != nil {
                return fmt.Errorf("read events: %w", err)
            }
            return nil

        case <-ctx.Done():
            return ctx.Err()
        }
    }
}
```

### Junior → FAANG: The Mental Model for Projections

Projections have one job: transform a stream of events into a read-optimized table. Every method on a projector handles one event type and performs one or more SQL operations. The shape of the SQL (insert, update, upsert) depends on what the event represents.

The `ON CONFLICT (id) DO NOTHING` pattern on the `onOrderPlaced` insert is idempotency: if the event is delivered twice (at-least-once delivery is the norm for event-driven systems), the second insert silently skips. This is correct for inserts, but it needs careful thought for updates. If `onOrderConfirmed` runs twice, the `UPDATE` is idempotent as long as it sets the same values both times. If it increments a counter, it is not idempotent. Always ask: "what happens if this event is processed twice?" before writing a projection method.

The `ProjectionRebuilder` is the "undo button" for projection bugs. You fix the bug in the projector code, call `Reset()` to truncate the read table, and call `Rebuild()` to replay all events through the fixed code. The rebuild may take minutes or hours for large event stores. During that time, the read side serves stale or empty data. This is why blue/green projection tables (two versions running simultaneously, traffic flipped when the new one catches up) are the production pattern.

For your first job: every time you write a new projector, also write a rebuild test. The test should load a fixed set of events, call `Rebuild`, and assert the final state of the read table. This test catches the category of projection bugs that only surface after a rebuild.

### Senior @ FAANG: Projection Checkpointing, Parallelism, and Schema Evolution

The `ProjectionRebuilder` in this section replays all events in a single goroutine through a single channel. That is fine for small event stores. At production scale with hundreds of millions of events, the rebuild strategy needs significant elaboration.

Checkpointing is mandatory. The rebuilder must record `(projection_name, last_processed_position)` after each batch, in the same database transaction as the projection writes. If the rebuilder crashes at position 50 million of 200 million, the restart should resume from 50 million, not from 0. Without this, a 10-hour rebuild that crashes at hour 9 restarts from scratch. Implement the checkpoint as a `projection_checkpoints` table with a row per projector, updated atomically with each batch commit.

Parallelism for rebuilds: the naive approach is one goroutine per projector. The better approach is to partition the event stream by stream ID and assign partitions to worker goroutines within each projector. This works because projection for one aggregate is independent of projection for another. For a projector that aggregates across aggregates (e.g., a leaderboard), partitioning is not safe and you must process sequentially. Document which category each projector falls into.

Schema evolution for projections requires a versioning strategy. The projection table schema changes when the projection logic changes. The choices are: in-place migration (risky under load), blue/green table swap (safest, adds deployment complexity), or additive-only changes (new nullable columns, new tables, no column removal). The blue/green swap is the only approach that guarantees zero read-side downtime. The procedure is: create `order_views_v2`, start a new projector writing to it, wait for it to pass the current position of `order_views_v1`, swap the read pointer, decommission `v1`. The "wait for catch-up" step needs a lag measurement: compare `order_views_v2.last_position` to the event store's current global position. Expose this as a metric.

The `EventDecoder` interface in the rebuilder is the extension point for upcasting. When deserializing a historical `OrderPlaced` event that was written before a schema change, the decoder upgrades the payload to the current shape before passing it to the projector. This is the correct layering: the event store is immutable, the decoder bridges past and present, the projector never sees old schemas. Testing this requires a fixture of old-format event payloads and assertions that the projector produces the same result as if the events had been written in the new format.

---
