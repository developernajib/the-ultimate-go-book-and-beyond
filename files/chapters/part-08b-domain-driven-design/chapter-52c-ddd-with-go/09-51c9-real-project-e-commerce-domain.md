## 52C.9 Real Project: E-Commerce Domain

### Three Bounded Contexts, One Platform

This section ties the previous patterns together into a concrete e-commerce platform with four bounded contexts communicating through domain events. Each context owns its own database and deploys independently.

```
┌───────────────────────────────────────────────────────────────────────┐
│                      E-Commerce Platform                              │
│                                                                       │
│  ┌─────────────────┐   events   ┌──────────────────┐                  │
│  │  Order Context  │ ─────────► │ Inventory        │                  │
│  │                 │            │ Context          │                  │
│  │  Order          │ ◄───────── │                  │                  │
│  │  OrderLine      │   events   │ StockItem        │                  │
│  │  ShippingAddr   │            │ Warehouse        │                  │
│  └────────┬────────┘            └────────┬─────────┘                  │
│           │ events                       │ events                     │
│           ▼                              ▼                            │
│  ┌─────────────────────────────────────────────────────────────┐      │
│  │                   Message Bus (Kafka)                       │      │
│  └─────────────────────────────────────────────────────────────┘      │
│           │                              │                            │
│           ▼                              ▼                            │
│  ┌─────────────────┐            ┌─────────────────┐                   │
│  │ Payment Context │            │Notification     │                   │
│  │                 │            │Context          │                   │
│  │ Transaction     │            │                 │                   │
│  │ Refund          │            │ EmailNotif      │                   │
│  │ PaymentMethod   │            │ SMSNotif        │                   │
│  └─────────────────┘            └─────────────────┘                   │
└───────────────────────────────────────────────────────────────────────┘
```

**Cross-context communication via domain events:**

1. Order places → publishes `OrderPlaced` to Kafka
2. Inventory context consumes `OrderPlaced` → reserves stock → publishes `StockReserved`
3. Order context consumes `StockReserved` → initiates payment → publishes `PaymentInitiated`
4. Payment context processes payment → publishes `PaymentSucceeded` or `PaymentFailed`
5. Order context consumes `PaymentSucceeded` → confirms order → publishes `OrderConfirmed`
6. Notification context consumes `OrderConfirmed` → sends confirmation email

This choreography-based saga ensures each context remains independent while the overall workflow completes.

**Integration event schema (shared kernel):**

```go
// shared/events/order_events.go

package events

import "time"

// OrderPlacedEvent is the integration event published when an order is placed.
// This is the stable, public schema for cross-service communication.
// Changes to this require coordination with all consuming services.
type OrderPlacedEvent struct {
    EventID     string    `json:"event_id"`
    EventType   string    `json:"event_type"`
    OrderID     string    `json:"order_id"`
    CustomerID  string    `json:"customer_id"`
    TotalAmount int64     `json:"total_amount"`
    Currency    string    `json:"currency"`
    Lines       []OrderPlacedLine `json:"lines"`
    OccurredAt  time.Time `json:"occurred_at"`
    Version     int       `json:"version"` // schema version for evolution
}

// OrderPlacedLine represents a line item in the OrderPlacedEvent.
type OrderPlacedLine struct {
    ProductSKU  string `json:"product_sku"`
    Quantity    int    `json:"quantity"`
}
```

### Why Integration Events Differ From Domain Events

Inside the Order context, `OrderPlaced` is a rich domain event - it may reference `Money` value objects, `CustomerID`, internal entity IDs. When it crosses a context boundary onto Kafka, it becomes an **integration event** and needs a stable, versioned, language-neutral schema. The mistake is to publish the domain event verbatim: now every consumer depends on your internal type system, and you cannot rename a field without coordinating releases across five teams.

The translation happens in the outbox writer or a dedicated event publisher in the infrastructure layer:

```go
// internal/infrastructure/messaging/event_mapper.go
func ToIntegrationEvent(de order.OrderPlaced) events.OrderPlacedEvent {
    return events.OrderPlacedEvent{
        EventID:     uuid.NewString(),
        EventType:   "order.placed.v1",
        OrderID:     string(de.OrderID),
        CustomerID:  string(de.CustomerID),
        TotalAmount: de.Total.Amount,
        Currency:    de.Total.Currency,
        OccurredAt:  de.OccurredAt,
        Version:     1,
    }
}
```

Note the `.v1` suffix in the event type and the explicit `Version` field. When the schema needs to change, publish `order.placed.v2` alongside `v1` and deprecate `v1` over a planned window. This is the only honest way to evolve cross-service contracts.

### Saga Choreography vs. Orchestration

The sequence described above is a **choreographed saga** - each context reacts to events autonomously, no central coordinator. This is the Go-native, microservice-friendly choice and works well when the workflow is linear and error recovery is local (inventory rejection -> Order emits `OrderCanceled`).

When workflows fan out, compensation becomes complex, or business rules need central visibility, switch to an **orchestrated saga** with an explicit state machine. In Go, implement the orchestrator as its own bounded context with its own aggregate (`OrderSaga`) tracking saga state. Temporal (`go.temporal.io/sdk`) is the common industrial choice. For smaller systems, a state-machine aggregate persisted via the same repository pattern works fine.

Rule of thumb: choreography until compensation gets hairy or you need to answer "where is this order right now?" from a dashboard, then orchestration.

---

### Junior → FAANG: Understanding Cross-Context Communication Before You Need It

The e-commerce platform described in this section is a common system design interview topic. The interviewer might ask you to design an order fulfillment system and expect you to identify the natural bounded context boundaries, describe how they communicate, and explain what happens when one context fails.

The flow described here (Order places, Inventory reserves, Payment charges, Order confirms, Notification sends) is a choreographed saga. Practice drawing this sequence diagram from memory and labeling each event. Then practice answering: "What happens if the Inventory service is down when an order is placed?" The correct answer is: the `OrderPlaced` event sits in the Inventory service's consumer lag. When the service comes back up, it processes the event and reserves stock. The order stays in "placed" state until stock is reserved. The user may see a delay, but no data is lost. This is the value of the event-driven, at-least-once delivery model.

For the FAANG interview, the follow-up will often be: "What if the payment fails after stock is reserved?" This requires a compensating transaction: the Order context publishes an `OrderCanceled` event, the Inventory context consumes it and releases the reserved stock. Drawing this compensation flow on the whiteboard, with explicit event names and the aggregate state at each step, demonstrates that you understand saga compensation, not just the happy path.

Integration event versioning is worth understanding at the junior level even if you will not own it immediately. When you see `"event_type": "order.placed.v1"` in production, that `v1` means someone thought carefully about what happens when this schema needs to change. Know the rule: additive changes (new optional fields) are backward-compatible. Removing fields, renaming fields, or changing field types are breaking changes that require a new version.

### Senior @ FAANG: Saga Architecture as a Platform Governance Problem

At the staff level, saga design is not a per-service decision: it is a platform architecture decision that defines the consistency model for your entire system. Getting it wrong is expensive to fix because saga choreography is embedded in event schemas and consumer behavior across multiple services.

**Choreography vs. orchestration: the real trade-off.** The standard advice (choreography for simple flows, orchestration for complex flows) understates the operational difference. Choreography distributes business logic across multiple services, which means understanding the full flow requires reading code in multiple repositories. When a saga gets stuck (order has been placed but never confirmed after 48 hours), diagnosing which step failed requires correlating events across multiple Kafka topics and multiple service logs. A correlation ID embedded in every event is necessary but not sufficient. Orchestrated sagas centralize the flow in one place (the `OrderSaga` aggregate), making it possible to query "where is this saga?" directly from the orchestrator's database. For a customer support team or an operations dashboard, this observability difference is enormous. The Staff engineer evaluates orchestration not just on technical complexity but on support cost and operational visibility.

**Temporal as a platform primitive.** Temporal (`go.temporal.io/sdk`) implements distributed saga orchestration using a durable workflow engine. The workflow code looks like synchronous Go, but Temporal ensures durability: if the process restarts mid-workflow, Temporal replays the history and continues from where it left off. For a FAANG-scale platform with complex fulfillment flows, chargebacks, and multi-step refunds, Temporal is often the correct platform investment. The Staff engineer evaluating Temporal must weigh: (a) operational cost (a Temporal cluster to manage), (b) learning curve (workflow history and replay semantics require mental model investment), (c) observability benefit (Temporal's UI shows every running workflow, its current state, and its history). The break-even point is roughly when you have three or more multi-step sagas with non-trivial compensation logic.

**Integration event schema governance.** The `OrderPlacedEvent` in the shared kernel is the most sensitive file in the e-commerce platform. Every service that consumes it must be updated when it changes. A Staff engineer establishes: (a) a schema registry (Confluent Schema Registry, AWS Glue Schema Registry) that enforces backward-compatibility rules on every new schema version before it reaches production, (b) a consumer compatibility test suite that each consuming service runs against the registry, and (c) a deprecation process (publish v2, notify consumers, set a sunset date for v1, monitor consumer lag on v1 to detect unconverted consumers). Without this process, schema changes become deployment coordination nightmares and are avoided out of fear, leading to increasingly anaemic event schemas that cannot carry the information consumers need.

**The Shared Kernel size constraint.** The `shared/` module in the e-commerce platform starts small and grows under pressure. Every team has a reason to add to it: "we need a common `Address` type," "all services need the `CustomerID` type," "the Money type should include exchange rate methods." A Staff engineer applies a strict size constraint: the shared kernel is reviewed quarterly, anything that has not been accessed by at least three services in the last quarter is a candidate for removal, and anything new requires sign-off from all consuming team leads. The constraint is not about bytes: it is about coupling. Every type in the shared kernel is a coupling point. Smaller is better.

---
