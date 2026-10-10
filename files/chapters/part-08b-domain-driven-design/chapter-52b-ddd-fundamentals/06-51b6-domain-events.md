## 52B.6 Domain Events

### What Domain Events Are

A **Domain Event** is a record of something significant that happened in the domain. Domain events are:

- Named in the **past tense**: `OrderPlaced`, `PaymentProcessed`, `InventoryReserved`
- **Immutable**: They record history and never change
- **Factual**: They describe what happened, not what should happen

Domain events serve two purposes:

1. **Within the aggregate**: Driving state transitions in event-sourced systems and providing a hook for side effects
2. **Across bounded contexts**: Broadcasting changes to other parts of the system (integration events)

### Domain Events vs Integration Events

A **Domain Event** is internal to a bounded context. It represents a domain fact from the rich domain model.

An **Integration Event** is a message published to an external message bus for other services to consume. It is a simplified, stable representation of the fact that is safe to expose across service boundaries.

```go
// domain/order/events.go

package order

import "time"

// DomainEvent is the marker interface for all domain events in this bounded context.
type DomainEvent interface {
    EventName() string
    OccurredAt() time.Time
}

// OrderPlaced is raised when a customer successfully places an order.
type OrderPlaced struct {
    OrderID     OrderID
    CustomerID  CustomerID
    TotalAmount Money
    PlacedAt    time.Time
}

func (e OrderPlaced) EventName() string    { return "order.placed" }
func (e OrderPlaced) OccurredAt() time.Time { return e.PlacedAt }

// OrderConfirmed is raised when payment succeeds and the order is confirmed.
type OrderConfirmed struct {
    OrderID     OrderID
    ConfirmedAt time.Time
}

func (e OrderConfirmed) EventName() string    { return "order.confirmed" }
func (e OrderConfirmed) OccurredAt() time.Time { return e.ConfirmedAt }

// OrderFulfilled is raised when the order is shipped.
type OrderFulfilled struct {
    OrderID        OrderID
    TrackingNumber string
    FulfilledAt    time.Time
}

func (e OrderFulfilled) EventName() string    { return "order.fulfilled" }
func (e OrderFulfilled) OccurredAt() time.Time { return e.FulfilledAt }

// OrderCanceled is raised when an order is canceled.
type OrderCanceled struct {
    OrderID     OrderID
    Reason      string
    CanceledAt time.Time
}

func (e OrderCanceled) EventName() string    { return "order.canceled" }
func (e OrderCanceled) OccurredAt() time.Time { return e.CanceledAt }
```

### Implementing a Domain Event Bus in Go

Domain events record significant state transitions in the domain in the past tense, enabling decoupled reactions from other aggregates or external systems. The event types and dispatcher below follow the collect-and-dispatch pattern: aggregates accumulate events during a unit of work, and the repository publishes them after a successful commit.

```go
// domain/order/event_bus.go

package order

import (
    "context"
    "sync"
)

// EventHandler is a function that handles a domain event.
type EventHandler func(ctx context.Context, event DomainEvent) error

// EventBus dispatches domain events to registered handlers.
// This is an in-process event bus - for cross-service events, use a message broker.
type EventBus struct {
    mu       sync.RWMutex
    handlers map[string][]EventHandler
}

// NewEventBus creates a new in-process event bus.
func NewEventBus() *EventBus {
    return &EventBus{
        handlers: make(map[string][]EventHandler),
    }
}

// Subscribe registers a handler for a specific event name.
func (b *EventBus) Subscribe(eventName string, handler EventHandler) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers[eventName] = append(b.handlers[eventName], handler)
}

// Publish dispatches an event to all registered handlers.
// Handlers are called sequentially in registration order.
// Returns the first error encountered.
func (b *EventBus) Publish(ctx context.Context, event DomainEvent) error {
    b.mu.RLock()
    handlers := b.handlers[event.EventName()]
    b.mu.RUnlock()

    for _, handler := range handlers {
        if err := handler(ctx, event); err != nil {
            return err
        }
    }
    return nil
}

// PublishAll publishes a slice of events, stopping on first error.
func (b *EventBus) PublishAll(ctx context.Context, events []DomainEvent) error {
    for _, event := range events {
        if err := b.Publish(ctx, event); err != nil {
            return err
        }
    }
    return nil
}
```

### Junior → FAANG: Writing Domain Events That Tell the Full Story

The first mistake with domain events is naming them in the present or future tense: `OrderPlacing`, `PaymentPending`, `ShipmentScheduled`. Domain events record facts that already happened. They are always past tense: `OrderPlaced`, `PaymentProcessed`, `ShipmentDispatched`. This is not a style preference. It reflects a conceptual distinction: a command is a request that might fail, while an event is a fact that cannot be undone.

The second mistake is putting too little information in the event. `OrderCanceled{OrderID: id}` forces every handler to reload the order from the database to find out who the customer was, what the total was, and what items were in it. This re-load under load becomes a read amplification problem. A well-designed domain event carries enough information for its primary consumers to act without an extra round-trip: `OrderCanceled{OrderID, CustomerID, Reason, TotalAmount, CanceledAt}`.

For interviews, the question "how do you prevent event handlers from coupling back to the aggregate?" is common. The answer: event handlers that need to act on a canceled order should receive the event with enough context fields that they do not need to call back into the order service. If they do need more data, they query their own read model or materialized view, not the source aggregate.

The collect-and-dispatch pattern (accumulate events inside the aggregate during the unit of work, publish them after the commit) is the correct sequence. Interviewers at mid-level check that you know this: events published before commit can be observed by handlers even if the commit subsequently fails, producing phantom events.

### Senior @ FAANG: Event Design for Reliability, Schema Evolution, and Observability

Domain events are simple to implement naively and surprisingly difficult to implement correctly in a distributed system under failure conditions.

**The Outbox pattern as a reliability requirement.** Publishing domain events after a database commit introduces a two-phase operation: write to the database, then publish to the message bus. If the process dies between these two steps, the event is lost. The Outbox pattern eliminates this gap: the aggregate's events are written to an `outbox` table in the same transaction as the aggregate state. A separate, idempotent relay process reads the outbox table and publishes events to the message bus, then marks them as published. This guarantees at-least-once delivery. At FAANG-scale companies, any system that processes financial transactions, updates user state, or triggers compliance-relevant actions must use the Outbox pattern. Treating event publication as best-effort in these contexts is an incident waiting to happen.

**Idempotency as a consumer responsibility.** At-least-once delivery means handlers receive duplicate events. Every event handler must be idempotent: processing the same event twice must produce the same result as processing it once. In Go, the standard approach is to store a `processed_event_ids` set (or use a unique constraint on `(handler_name, event_id)` in the database) and check before applying the event's effects. At the L6 bar, designing an event-driven system without addressing idempotency is a disqualifying omission.

**Event schema evolution governance.** Domain events that cross bounded context boundaries are integration contracts. Senior engineers establish three rules for event schema evolution: (1) new fields are always optional, with a default value that preserves backward compatibility. (2) fields are never removed or renamed in a published schema. (3) breaking changes require a new event type with a parallel-publish period and a consumer migration timeline. The schema registry enforces rules 1 and 2 at CI time. Rule 3 is enforced through architecture review.

**Correlation and causation IDs for distributed tracing.** Every domain event in a production system should carry a `CorrelationID` (the ID that links all events in a single business transaction, typically the original request ID) and a `CausationID` (the ID of the event or command that caused this event to be emitted). These two fields enable distributed tracing across event chains: given a customer support ticket, you can reconstruct the exact sequence of events that produced the observable state. At the platform level, enforcing correlation and causation ID propagation across all services is a principal engineer's responsibility. It is implemented once in a shared event envelope type and is non-negotiable for any event that may trigger compliance audits.

**Dead-letter queue design and operational readiness.** Every event bus integration needs a dead-letter queue strategy: what happens to events that fail processing after N retries? The production answer is: route to a DLQ, alert on DLQ depth, and provide a replay mechanism that allows events to be reprocessed after the underlying failure is fixed. At the L6 bar, you are expected to design the DLQ strategy alongside the happy-path event flow, not as an afterthought. The absence of a DLQ design in a system design interview is a signal that the candidate has not operated event-driven systems in production at scale.

---
