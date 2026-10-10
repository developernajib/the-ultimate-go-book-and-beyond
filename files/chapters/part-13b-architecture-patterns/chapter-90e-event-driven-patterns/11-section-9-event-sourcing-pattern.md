## 90E.10 Event Sourcing Pattern

Event Sourcing stores the full history of state changes as an immutable event log, rather than storing only the current state. The current state is derived by replaying events from the beginning (or from a snapshot). This gives you: full audit history for free, the ability to rewind to any past state, and a natural stream of events for reactive consumers.

```go
package eventsourcing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Event is the base type for all domain events stored in the event log.
type Event struct {
	ID          string          `json:"id"`
	AggregateID string          `json:"aggregate_id"`
	Type        string          `json:"event_type"`
	Version     int             `json:"version"`        // monotonically increasing per aggregate
	OccurredAt  time.Time       `json:"occurred_at"`
	Data        json.RawMessage `json:"data"`
}

// Aggregate is the root entity that produces and applies events.
type Aggregate interface {
	ID() string
	Version() int
	UncommittedEvents() []Event
	ApplyEvent(event Event) error
}

// EventStore persists and loads events for aggregates.
type EventStore interface {
	// Append stores new events for an aggregate, failing if expectedVersion doesn't match
	// the current aggregate version (optimistic concurrency control).
	Append(ctx context.Context, aggregateID string, events []Event, expectedVersion int) error

	// Load returns all events for an aggregate in version order.
	Load(ctx context.Context, aggregateID string) ([]Event, error)

	// LoadFromVersion returns events after a specific version (for snapshot + replay).
	LoadFromVersion(ctx context.Context, aggregateID string, fromVersion int) ([]Event, error)
}

// ─── Order Aggregate ───

// OrderState is the reconstituted current state of the order.
type OrderState struct {
	id       string
	version  int
	status   string
	items    []OrderItem
	total    int64
	uncommitted []Event
}

type OrderItem struct {
	ProductID  string
	Quantity   int
	PriceCents int64
}

// Concrete domain events.
type OrderCreatedData struct {
	CustomerID string      `json:"customer_id"`
	Items      []OrderItem `json:"items"`
	TotalCents int64       `json:"total_cents"`
}

type OrderCanceledData struct {
	Reason string `json:"reason"`
}

type OrderShippedData struct {
	TrackingNumber string `json:"tracking_number"`
	Carrier        string `json:"carrier"`
}

func NewOrder(id, customerID string, items []OrderItem) (*OrderState, error) {
	if len(items) == 0 {
		return nil, errors.New("order must have at least one item")
	}

	var total int64
	for _, item := range items {
		total += item.PriceCents * int64(item.Quantity)
	}

	order := &OrderState{id: id}

	data, _ := json.Marshal(OrderCreatedData{
		CustomerID: customerID,
		Items:      items,
		TotalCents: total,
	})

	evt := Event{
		ID:          fmt.Sprintf("%s-v1", id),
		AggregateID: id,
		Type:        "OrderCreated",
		Version:     1,
		OccurredAt:  time.Now().UTC(),
		Data:        data,
	}

	if err := order.ApplyEvent(evt); err != nil {
		return nil, err
	}
	order.uncommitted = append(order.uncommitted, evt)
	return order, nil
}

func (o *OrderState) Cancel(reason string) error {
	if o.status == "canceled" {
		return errors.New("order already canceled")
	}
	if o.status == "shipped" {
		return errors.New("cannot cancel a shipped order")
	}

	data, _ := json.Marshal(OrderCanceledData{Reason: reason})
	evt := Event{
		ID:          fmt.Sprintf("%s-v%d", o.id, o.version+1),
		AggregateID: o.id,
		Type:        "OrderCanceled",
		Version:     o.version + 1,
		OccurredAt:  time.Now().UTC(),
		Data:        data,
	}

	if err := o.ApplyEvent(evt); err != nil {
		return err
	}
	o.uncommitted = append(o.uncommitted, evt)
	return nil
}

// ApplyEvent mutates the aggregate state based on an event.
// This is also called during replay - it must be side-effect-free.
func (o *OrderState) ApplyEvent(event Event) error {
	switch event.Type {
	case "OrderCreated":
		var data OrderCreatedData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			return fmt.Errorf("unmarshal OrderCreated: %w", err)
		}
		o.status = "pending"
		o.items = data.Items
		o.total = data.TotalCents

	case "OrderCanceled":
		o.status = "canceled"

	case "OrderShipped":
		o.status = "shipped"

	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}

	o.version = event.Version
	return nil
}

func (o *OrderState) ID() string             { return o.id }
func (o *OrderState) Version() int           { return o.version }
func (o *OrderState) Status() string         { return o.status }
func (o *OrderState) UncommittedEvents() []Event { return o.uncommitted }

// Reconstitute rebuilds an OrderState from its event history.
func Reconstitute(events []Event) (*OrderState, error) {
	if len(events) == 0 {
		return nil, errors.New("no events to reconstitute from")
	}

	order := &OrderState{id: events[0].AggregateID}
	for _, evt := range events {
		if err := order.ApplyEvent(evt); err != nil {
			return nil, fmt.Errorf("apply event %s at version %d: %w", evt.Type, evt.Version, err)
		}
	}
	return order, nil
}

// ─── Repository ───

// OrderRepository provides Load/Save using the EventStore.
type OrderRepository struct {
	store EventStore
}

func NewOrderRepository(store EventStore) *OrderRepository {
	return &OrderRepository{store: store}
}

func (r *OrderRepository) Load(ctx context.Context, orderID string) (*OrderState, error) {
	events, err := r.store.Load(ctx, orderID)
	if err != nil {
		return nil, fmt.Errorf("load events for %s: %w", orderID, err)
	}
	return Reconstitute(events)
}

func (r *OrderRepository) Save(ctx context.Context, order *OrderState) error {
	uncommitted := order.UncommittedEvents()
	if len(uncommitted) == 0 {
		return nil
	}

	// expectedVersion is the version before the new uncommitted events.
	expectedVersion := order.Version() - len(uncommitted)

	if err := r.store.Append(ctx, order.ID(), uncommitted, expectedVersion); err != nil {
		return fmt.Errorf("append events for %s: %w", order.ID(), err)
	}

	// Clear uncommitted events after successful save.
	order.uncommitted = nil
	return nil
}
```

---
