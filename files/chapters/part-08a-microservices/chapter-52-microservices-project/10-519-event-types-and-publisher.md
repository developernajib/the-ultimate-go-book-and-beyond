## 52.9 Event Types and Publisher

Centralizing event type constants and the publisher in a shared `events` package gives all services a single authoritative source for topic names and event struct definitions, preventing typo-driven misrouting. The publisher interface abstracts the underlying broker (Kafka, NATS, or an in-memory fake for tests) behind a `Publish(ctx, eventType, payload)` method, so services can be tested with a no-op publisher that records emitted events for assertion. Typed payload structs for each event constant (`UserRegistered`, `OrderCreated`) enforce schema discipline at compile time rather than relying on runtime JSON key checks.

**From a shared Go package to a real published language.** A Go struct only enforces the schema among services that import this module. The moment a Python analytics consumer or a Java fraud-detection service subscribes to the same topic, you need an out-of-band contract. In 2026 the mainstream answers are:

- **Protobuf + Confluent Schema Registry**, every event serialized as a protobuf message, the schema registry enforces backward/forward compatibility on each new version, and consumers in any language get generated types.
- **Avro + Schema Registry**, the original Kafka pairing, still common. Avro's dynamic schema resolution is nice for analytics pipelines landing in a data warehouse.
- **CloudEvents envelope + JSON Schema**, lighter-weight, HTTP-friendly, good fit for NATS or when events cross organization boundaries.

Whichever you pick, treat your topic names and schemas as a *published language* (Evans), they are a public API that must be versioned. The event structs below are the Go view of that contract. The source of truth in production is whatever lives in the schema registry.

```go
// pkg/events/types.go
package events

import (
	"time"
)

// Event types
const (
	UserRegistered    = "user.registered"
	UserUpdated       = "user.updated"

	OrderCreated      = "order.created"
	OrderPaid         = "order.paid"
	OrderCanceled    = "order.canceled"
	OrderShipped      = "order.shipped"
	OrderDelivered    = "order.delivered"

	PaymentProcessed  = "payment.processed"
	PaymentFailed     = "payment.failed"
	PaymentRefunded   = "payment.refunded"

	InventoryReserved = "inventory.reserved"
	InventoryReleased = "inventory.released"
)

// Event data types

type UserRegisteredEvent struct {
	UserID    string `json:"user_id"`
	Email     string `json:"email"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type UserUpdatedEvent struct {
	UserID    string `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

// OrderItemLite is the event-carried view of an order line.
// We intentionally embed enough data (product_id, name, price, quantity)
// for downstream consumers -- notification, analytics -- to render their
// own views without synchronously calling back into the order service.
// This is the "event-carried state transfer" pattern.
type OrderItemLite struct {
	ProductID string  `json:"product_id"`
	Name      string  `json:"name"`
	PriceCents int64  `json:"price_cents"`
	Quantity  int     `json:"quantity"`
}

type OrderCreatedEvent struct {
	OrderID     string          `json:"order_id"`
	UserID      string          `json:"user_id"`
	TotalAmountCents int64         `json:"total_amount_cents"`
	Items       []OrderItemLite `json:"items"`
}

type OrderPaidEvent struct {
	OrderID   string `json:"order_id"`
	PaymentID string `json:"payment_id"`
}

type OrderCanceledEvent struct {
	OrderID string `json:"order_id"`
	Reason  string `json:"reason"`
}

type PaymentProcessedEvent struct {
	PaymentID string  `json:"payment_id"`
	OrderID   string  `json:"order_id"`
	AmountCents int64 `json:"amount_cents"`
}

type PaymentFailedEvent struct {
	PaymentID string `json:"payment_id"`
	OrderID   string `json:"order_id"`
	Reason    string `json:"reason"`
}

type PaymentRefundedEvent struct {
	PaymentID string  `json:"payment_id"`
	OrderID   string  `json:"order_id"`
	AmountCents int64 `json:"amount_cents"`
}

// ReservationLite is the event-carried view of a stock reservation.
type ReservationLite struct {
	ReservationID string `json:"reservation_id"`
	ProductID     string `json:"product_id"`
	Quantity      int    `json:"quantity"`
}

type InventoryReservedEvent struct {
	OrderID      string            `json:"order_id"`
	Reservations []ReservationLite `json:"reservations"`
}

type InventoryReleasedEvent struct {
	OrderID string `json:"order_id"`
}
```

### Junior → FAANG: Thinking About Events as Published Contracts

The `events` package looks simple: constants and structs. Its significance is organizational, not technical. Understanding why this matters will help you answer design questions about event-driven systems in interviews.

**A topic name is a public API.** Once a service publishes to `order.created`, every consumer that subscribes to that topic depends on the name never changing. Renaming a topic requires a migration period where both the old and new names are published simultaneously, all consumers migrate to the new name, and then the old name is retired. This is the same lifecycle as renaming an HTTP endpoint. Get in the habit of treating topic names with the same care as API endpoints: name them semantically (what happened, not what triggered it), use a consistent naming convention (`{domain}.{entity}.{event}` or `{domain}.{past_tense_verb}`), and do not rename without a documented migration plan.

**Event-carried state transfer in `OrderItemLite`.** The comment on `OrderItemLite` explains why it embeds `name`, `price_cents`, and `quantity` rather than just `product_id`. This is the "event-carried state transfer" pattern: the event carries enough data for consumers to act without calling back into the producer service. For the notification service, this means it can render "You ordered 2x Blue T-Shirt at $29.99" without an HTTP call to the product service. This reduces coupling and makes the consumer more resilient to product service outages.

**The Go struct is not the schema.** The struct works as the schema only for services written in Go and importing this module. The moment a Python analytics service subscribes to `order.created`, you need a schema definition that both producers and consumers can use regardless of language. For your first project, using JSON with documented fields is acceptable. As the system grows, migrate to a schema registry.

**First-job habit.** When you add a new event type, write a consumer test in the same PR. A test that decodes a JSON payload into the event struct catches schema drift (a field was renamed in the struct but the payload still uses the old name) before the consumer breaks in production.

### Senior @ FAANG: Schema Registry, Event Versioning, and the Published Language Problem

The `pkg/events` package is a shared Go module. At FAANG scale, the problem it solves, keeping producers and consumers aligned on event schema, is solved by a schema registry. Understanding the difference and when to migrate is a staff-level architectural judgment.

**Schema compatibility modes and their operational implications.** A Confluent Schema Registry enforces schema compatibility on each new schema version. The three modes are: backward (new schema can read old data, add optional fields only), forward (old consumers can read new data, remove fields only), and full (both). Choosing backward compatibility as the default means consumers can always lag behind producers by one schema version, which is the correct policy for a Kafka-based system where consumers may be temporarily offline during deployments.

**Event versioning strategies.** Three patterns are common: schema versioning in the topic name (`order.created.v2`), a version field in the envelope (`{"version": 2, "data": {...}}`), and schema evolution with optional fields (add new fields as optional, never remove or rename). The topic-per-version approach is the most operationally clear but requires consumers to subscribe to multiple topics during migration. The optional field approach is the most transparent but requires disciplined backward-compatible schema evolution. At FAANG, the platform team documents the chosen strategy and enforces it through the schema registry's compatibility settings.

**The `Publisher` interface and at-least-once delivery guarantees.** The current `Publisher` interface has no delivery guarantee contract. A service that calls `publisher.Publish` and continues does not know whether the event was durably written to Kafka. A fire-and-forget publisher can lose events if Kafka is temporarily unavailable. The production alternative is the transactional outbox: the event is written to a database table in the same transaction as the state change, and a relay process publishes from the outbox to Kafka. This guarantees that every state change is eventually published, even after crashes. The `Publisher` interface should be documented with its delivery guarantee: "at-least-once via transactional outbox" or "best-effort, may lose events on crash." Consumers must handle at-least-once delivery by being idempotent.

**Event schema as an organizational boundary.** When the order team changes `OrderCreatedEvent` to add a `coupon_code` field, every consumer team must be notified, and the migration must be coordinated. At FAANG, event schema changes go through an RFC process: propose the change, list all known consumers, provide a migration timeline, and get sign-off from consumer teams before the producer ships. The `pkg/events` package in this project is where that governance would be anchored: every PR that changes an event struct requires review from the consuming service owners.

---
