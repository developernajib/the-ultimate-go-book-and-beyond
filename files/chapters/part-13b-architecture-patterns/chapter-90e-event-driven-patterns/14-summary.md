## Exercises

### Exercise 1: CloudEvents Schema Validation & Version Upcasting
- **Context:** An order processing pipeline where events have migrated from legacy format (v1 with raw strings and floating-point dollars) to modern v2 CloudEvents (structured attributes with integer cents).
- **Task:** Build an event deserializer and upcaster engine in Go:
  1. Define `CloudEvent[T any]` generic envelope conforming to the CloudEvents 1.0 specification with `ID`, `Source`, `Type`, `SpecVersion`, `Time`, and `Data`.
  2. Implement an `Upcaster` registry that detects `com.example.order.v1` events and transparently upcasts them to `com.example.order.v2`, converting legacy fields (e.g., converting legacy dollar floats to `int64` minor units / cents).
  3. Validate incoming payloads against strict schema rules before forwarding to domain handlers, rejecting malformed events with structured validation errors.
  4. Write unit tests demonstrating that consumers written for v2 can consume both native v2 events and upcasted legacy v1 events seamlessly.

### Exercise 2: Idempotent Kafka Consumer with Dead-Letter Queue (DLQ) & Exponential Backoff
- **Context:** High-throughput Kafka consumer that must process financial ledger events with exactly-once side effects and zero partition stalling upon poison pills.
- **Task:** Implement a resilient consumer loop in Go:
  1. Build an in-memory `IdempotencyStore` with sliding TTL and thread-safe sync primitives (`sync.Mutex` or concurrent sharded maps) tracking processed `partition:offset` tokens.
  2. Implement a retry loop with exponential backoff and jitter that retries transient downstream failures up to a configurable maximum attempt count.
  3. If all retries fail, construct a DLQ record containing original headers, error diagnostics, and timestamps, dispatch it synchronously to `{topic}.dlq`, and commit the parent partition offset so the partition does not stall.
  4. Write integration-style test cases verifying that duplicate messages are ignored and poison pills route cleanly to the DLQ without blocking subsequent valid messages.

### Exercise 3: In-Process High-Throughput Event Bus with Actor Backpressure
- **Context:** Monolithic modular application needing asynchronous decoupled dispatch between domain modules without an external broker cluster.
- **Task:** Implement a typed in-process event bus in Go:
  1. Define a generic `EventBus` supporting synchronous (in-band transactional) and asynchronous (bounded channel worker pool) subscribers.
  2. Implement reflection-free subscriber registration using type assertion closures (`RegisterHandler[T any](bus *EventBus, handler func(ctx context.Context, event T) error)`).
  3. Add bounded worker queues with drop-tail or backpressure signaling: if a subscriber's channel buffer exceeds 80% capacity, throttle upstream publishers using a configurable backpressure strategy (block, shed, or return `ErrQueueFull`).
  4. Benchmark message delivery throughput across 10,000 events dispatched to 5 concurrent subscribers.

### Exercise 4: Event-Carried State Transfer Cache with Strict Per-Entity Sequencing
- **Context:** Downstream search indexing service maintaining a materialized read cache from out-of-order event streams.
- **Task:** Build an Event-Carried State Transfer (ECST) projection in Go:
  1. Define entity events (`UserCreated`, `UserUpdated`, `UserDeactivated`) containing version sequence numbers and monotonic UTC timestamps.
  2. Implement a `SequencedEntityCache` that stores user profiles in memory.
  3. Implement conflict resolution: if an incoming event arrives with a version number lower than or equal to the currently stored entity version, discard it as a stale duplicate; if a gap is detected, buffer the event in a temporary holding queue pending earlier versions.
  4. Verify concurrent arrival of scrambled events produces the identical final deterministic state as strictly ordered ingestion.

### Exercise 5: NATS JetStream Durable Pull Consumer with Heartbeats & Flow Control
- **Context:** Sub-millisecond latency telemetry ingestion pipeline running on NATS JetStream.
- **Task:** Implement a production NATS JetStream consumer in Go:
  1. Configure a durable pull consumer on stream `TELEMETRY` with explicit acknowledgments (`AckExplicit`), max deliveries (`MaxDeliver = 3`), and ack wait (`AckWait = 5 * time.Second`).
  2. Implement batch fetching using `Fetch(batchSize, nats.MaxWait(timeout))` with consumer heartbeat monitoring to detect network disconnects.
  3. Handle poison pill messages by issuing `msg.Term()` (terminate delivery) when payload validation fails, ensuring NATS ceases redelivery immediately.
  4. Verify that restarting the consumer resumes exactly at the unacknowledged sequence without skipping unread telemetry records.

---

## Summary

Event-driven architecture decouples producers from consumers using a durable event log as the integration point:

- **CloudEvents specification**: Standardizes event envelope format (id, source, type, specversion, datacontenttype) across languages and brokers. Use it as the outer envelope, with a domain-specific payload in the `data` field.

- **Kafka producers**: `RequiredAcks(AllISRAcks())` plus `Async: false` (synchronous publish) gives at-least-once durability. Idempotent mode (`idempotent: true`) prevents duplicates from network retries. Partition by entity ID for per-entity ordering.

- **Kafka consumers**: Commit offsets only after successful processing. Dead-letter queues prevent poison pills from stalling partitions. Consumer group lag metrics detect processing backlog before it becomes an SLA violation.

- **NATS JetStream**: Pull consumers with explicit ack give sub-millisecond latency and explicit backpressure. `WithMsgID` for idempotent publish, `BackOff` for exponential retry delays, `MaxDeliver` + `Term()` for DLQ routing.

- **Event-Carried State Transfer**: Embed full entity state in events so consumers don't need to query back. Requires ordering guarantees per entity (partition by entity ID) to prevent stale-state from out-of-order events.

- **Event Sourcing**: Store immutable events rather than mutable state. Replay produces current state. Provides free audit trail and temporal queries. High operational cost - only appropriate when audit history or temporal queries have business value.

- **Outbox pattern**: Write domain state and event record in the same DB transaction. A relay publishes events from the outbox. Guarantees at-least-once event delivery without dual-write risk.

- **Schema evolution**: Only add optional fields (backward compatible), use a schema registry with compatibility enforcement, implement upcasters for major version changes, and use consumer-driven contract tests to catch breaking changes before deployment.

- **Idempotency is mandatory**: Any event can be delivered more than once. Every consumer must be designed to handle duplicates - via deduplication store (event ID → bool), database unique constraints, or idempotent business operations.

*Next: [Chapter 91: Building Your Foundation - CV, LinkedIn, GitHub, Portfolio](../../part-14a-career-guide/chapter-91-building-your-foundation/00-introduction.md)*

