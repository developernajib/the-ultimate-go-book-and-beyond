## 42D.5 AsyncAPI Specification

### What AsyncAPI Solves

OpenAPI documents synchronous (request/response) APIs. AsyncAPI documents asynchronous (event-driven) APIs using the same philosophy: schema-first, with code generation and documentation tooling. AsyncAPI 3.0 (released December 2023, 3.1 followed) decoupled the `operation` from the `channel`, added first-class request/reply support (for protocols like NATS and AMQP that carry it natively), and introduced reusable `messages` independent of channels. In practice: 3.0 is the version to write new specs in, 2.x specs still work but most 2026 tooling (asyncapi-codegen, Studio, generator templates) targets 3.x. Treat AsyncAPI as the Kafka/NATS/MQTT-side complement to OpenAPI, not a replacement.

```yaml
# asyncapi.yaml
asyncapi: "3.0.0"
info:
  title: Order Service Events
  version: "1.0.0"
  description: |
    Events published by the Order Service.
    Consumers must handle all events idempotently.

servers:
  production:
    host: kafka.internal:9092
    protocol: kafka
    security:
      - sasl-ssl: []

channels:
  order.created:
    address: "orders.created"
    messages:
      OrderCreated:
        $ref: "#/components/messages/OrderCreated"

  order.status-changed:
    address: "orders.status-changed"
    messages:
      OrderStatusChanged:
        $ref: "#/components/messages/OrderStatusChanged"

operations:
  publishOrderCreated:
    action: send
    channel:
      $ref: "#/channels/order.created"

  consumeOrderCreated:
    action: receive
    channel:
      $ref: "#/channels/order.created"

components:
  messages:
    OrderCreated:
      name: OrderCreated
      contentType: application/json
      headers:
        type: object
        properties:
          correlationId:
            type: string
      payload:
        $ref: "#/components/schemas/Order"

  schemas:
    Order:
      type: object
      required: [id, customerId, items, totalCents, status]
      properties:
        id:
          type: string
          format: uuid
        customerId:
          type: string
        totalCents:
          type: integer
          format: int64
        status:
          type: string
          enum: [pending, confirmed, shipped, delivered, canceled]
        createdAt:
          type: string
          format: date-time
        items:
          type: array
          items:
            $ref: "#/components/schemas/OrderItem"

    OrderItem:
      type: object
      required: [sku, quantity, priceCents]
      properties:
        sku:
          type: string
        quantity:
          type: integer
          minimum: 1
        priceCents:
          type: integer
          format: int64

  securitySchemes:
    sasl-ssl:
      type: scramSha256
```

### AsyncAPI-Driven Consumer in Go

`OrderEventConsumer` checks the `CorrelationId` header against an idempotency store before processing, so Kafka redeliveries after a consumer crash do not double-reserve inventory or send duplicate notifications. Each event type maps to a dedicated handler method whose signature is generated from the AsyncAPI schema, giving the compiler visibility into whether the consumer handles every message channel in the spec.

```go
// Generated types from AsyncAPI spec (asyncapi-codegen)
// go install github.com/lerenn/asyncapi-codegen/cmd/asyncapi-codegen@latest
// asyncapi-codegen -i asyncapi.yaml -p orderevents -o ./orderevents

// OrderEventConsumer processes order events from Kafka
type OrderEventConsumer struct {
	inventoryService InventoryService
	notifService     NotificationService
	db               *sql.DB
	idempotency      IdempotencyStore
}

func (c *OrderEventConsumer) HandleOrderCreated(ctx context.Context, evt orderevents.OrderCreated) error {
	// Idempotency: check if already processed
	processed, err := c.idempotency.IsProcessed(ctx, evt.Headers.CorrelationId)
	if err != nil {
		return fmt.Errorf("checking idempotency: %w", err)
	}
	if processed {
		return nil // Already handled this event
	}

	// Reserve inventory for all items
	if err := c.inventoryService.Reserve(ctx, evt.Payload.Id, evt.Payload.Items); err != nil {
		return fmt.Errorf("reserving inventory for order %s: %w", evt.Payload.Id, err)
	}

	// Send confirmation email (non-critical, don't fail on email error)
	if err := c.notifService.SendOrderConfirmation(ctx, evt.Payload); err != nil {
		slog.Error("sending order confirmation", "order_id", evt.Payload.Id, "error", err)
	}

	// Mark processed after successful handling
	return c.idempotency.MarkProcessed(ctx, evt.Headers.CorrelationId)
}

func (c *OrderEventConsumer) HandleOrderStatusChanged(ctx context.Context, evt orderevents.OrderStatusChanged) error {
	// Update local read model
	_, err := c.db.ExecContext(ctx,
		`UPDATE order_projections SET status = $1, updated_at = NOW() WHERE id = $2`,
		evt.Payload.Status, evt.Payload.Id,
	)
	return err
}

// Kafka consumer setup
func startConsumer(ctx context.Context, consumer *OrderEventConsumer) error {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:  []string{"kafka.internal:9092"},
		GroupID:  "inventory-service",
		Topic:    "orders.created",
		MaxBytes: 10e6,
	})
	defer r.Close()

	for {
		msg, err := r.ReadMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("reading message: %w", err)
		}

		var evt orderevents.OrderCreated
		if err := json.Unmarshal(msg.Value, &evt); err != nil {
			slog.Error("unmarshaling event", "error", err)
			continue // Skip malformed messages
		}

		if err := consumer.HandleOrderCreated(ctx, evt); err != nil {
			slog.Error("handling order created", "order_id", evt.Payload.Id, "error", err)
			// Depending on error type: retry, DLQ, or skip
		}
	}
}
```

---

### Junior → FAANG: Treating AsyncAPI as the Contract, Not the Afterthought

Most engineers encounter async messaging as undocumented Kafka topics discovered by reading producer code. AsyncAPI breaks that habit by making the schema the source of truth and generating code from it, the same way OpenAPI works for REST.

**The schema-first mindset.** Write the AsyncAPI spec before writing the producer or consumer. This forces you to think about the message shape, required fields, and header conventions (like `correlationId`) before any code exists. Teams that write the spec after the code usually find the generated types lag behind the real messages.

**Idempotency is not optional for consumers.** Kafka delivers at-least-once by default. Any handler that writes to a database or calls an external service must check whether the event was already processed. The `correlationId` in the message headers combined with a simple idempotency table (correlation_id, processed_at) covers the vast majority of cases. Without this, consumer restarts after a crash cause duplicate operations.

**Understanding consumer group semantics.** A single consumer group processes each partition's messages in order but can process multiple partitions in parallel. If you have 3 partitions and 5 consumer instances, 2 instances will be idle. Scaling consumers beyond the partition count does nothing. Know your partition count before sizing your fleet.

**Interview entry point.** "How do you document and evolve async event contracts?" is a senior-screen question. Mentioning AsyncAPI, schema registries, and backward/forward compatibility rules (field additions are safe, field removals are breaking) separates candidates who have operated event-driven systems from those who have only read about them.

**First-job habits.** Always include a `correlationId` in message headers from day one. Retrofitting distributed tracing across a Kafka topology without correlation IDs is one of the more painful debugging exercises you will encounter.

---

### Senior @ FAANG: AsyncAPI as the Foundation of an Event Governance Program

At scale, uncoordinated event schema changes across dozens of microservices are one of the leading causes of silent data corruption and hard-to-debug production incidents. AsyncAPI combined with a schema registry and a compatibility enforcement pipeline turns event contracts into governed artifacts.

**Architectural Decision Record: AsyncAPI + schema registry vs. Protobuf + Buf schema registry.**
Both approaches enforce compatibility and generate typed code. The trade-off is tooling maturity versus flexibility. Protobuf with the Buf schema registry gives you binary serialization (smaller payloads, faster parsing), strict backward/forward compatibility checking in CI via `buf breaking`, and strong gRPC interop. AsyncAPI with Confluent Schema Registry gives you JSON schemas (human-readable, easier debugging), a richer channel/operation model for documenting multi-protocol systems, and the 3.0 spec's native request/reply support. For organizations already running Kafka with JSON payloads and multiple consuming languages, AsyncAPI is lower adoption friction. For greenfield systems or teams willing to pay the Protobuf onboarding cost, Buf+Proto delivers better runtime performance and a stronger compatibility story. Document this decision in an ADR because it shapes tooling choices for years.

**Schema compatibility enforcement in CI.** Every merged schema change should run through a compatibility check before the producer is deployed. For Confluent Schema Registry: `BACKWARD` compatibility means new consumers can read old messages, `FORWARD` means old consumers can read new messages, and `FULL` requires both. Set `BACKWARD` as the default for most topics. Enforce this with a CI step that registers the new schema against the registry in dry-run mode and fails the build on incompatibility. This catches breaking changes before they reach production.

**AsyncAPI as the platform contract surface.** At L6/L7, the AsyncAPI spec is not a developer convenience. It is a contract between platform teams and consuming teams that is governed the same way an OpenAPI spec is: reviewed in pull requests, versioned semantically, published to an internal developer portal, and subject to a deprecation policy. Unreviewed schema changes that silently break downstream consumers are a platform reliability failure, not an upstream team's problem.

**Consumer group topology and ordering guarantees.** Senior engineers understand that Kafka ordering is per-partition, not per-topic. If your event model requires that `order.created` is always processed before `order.status-changed` for a given order, you must partition by order ID and ensure both event types live in the same topic or share a partition key strategy. Mixing topics with different partition counts and different consumer groups breaks ordering guarantees in non-obvious ways that only surface under load.

**Event schema maturity model.** A useful framing for staff-level conversations: Level 1 is undocumented ad-hoc messages. Level 2 is a written schema with no enforcement. Level 3 is schema registry with compatibility rules enforced in CI. Level 4 adds consumer contract tests (Pact-style) so producers know which consumers read which fields. Level 5 adds event catalog governance with ownership, SLOs on delivery latency, and automated deprecation tracking. Most organizations operate at Level 2. Moving to Level 3 is a one-quarter investment. Levels 4 and 5 require platform team sponsorship.

**Dead letter queue strategy for event consumers.** A consumer that encounters a message it cannot parse or process must not block partition progress indefinitely. The pattern is: attempt processing, on failure route to a per-topic DLQ (`orders.created.dlq`), emit a metric on DLQ ingestion, and alert when DLQ depth crosses a threshold. A separate DLQ processor retries with human or automated intervention. Without this pattern, a single malformed message in a partition can halt an entire consumer group for hours before anyone notices.
