## 49.10 Interview Questions

### Question 1: When would you choose Kafka over RabbitMQ (and where do NATS JetStream and Redpanda fit)?

**Answer:** The choice depends on your primary access pattern. Kafka is a distributed log optimized for high-throughput event streaming with replay capability, while RabbitMQ is a traditional message broker optimized for complex routing and task queues with per-message acknowledgment. In 2026 the picture has two additional options worth naming explicitly: **Redpanda** is wire-compatible with Kafka (same clients, including `franz-go` and `segmentio/kafka-go`) but ships as a single C++ binary with no JVM or ZooKeeper, so it wins when tail latency and ops simplicity matter more than the Kafka ecosystem breadth. **NATS JetStream** sits between RabbitMQ and Kafka - persistent, replicated, replay-capable, but operationally lighter and a better fit when messages are small and retention is measured in hours-to-days rather than weeks. Also worth knowing: Kafka 4.0 (March 2025) removed ZooKeeper entirely. New clusters are KRaft-only, which removes the "Redpanda has no ZK" argument that held through ~2023. Many production systems use more than one broker on purpose.

**What FAANG expects:** You can compare brokers on the dimensions that actually drive architecture - ordering guarantees, retention model, delivery semantics, partitioning model, rebalance behavior, and operational footprint - rather than listing features. You know that "Kafka vs RabbitMQ" is not a moral choice. A typical large system has Kafka for the event backbone, RabbitMQ or SQS for task queues, and JetStream or Redis Streams for lightweight fan-out. You can name the Go client you would pick (`franz-go` for performance, `segmentio/kafka-go` for readability, `confluent-kafka-go` when you need the full transactional API and accept CGO) and justify it.

**Follow-ups to expect:**
- "What changes in your answer if you need cross-region replication?" (Kafka MirrorMaker 2 / Cluster Linking, RabbitMQ Shovel/Federation, JetStream mirrors - each has very different lag and failover characteristics.)
- "Your team wants exactly-once across Kafka + Postgres. Walk me through the design." (Transactional outbox, Debezium CDC on the WAL, idempotent consumers keyed on event ID - not Kafka transactions alone.)
- "Why not just use Redpanda everywhere?" (Ecosystem: Kafka Connect, ksqlDB, tiered storage maturity, managed offerings. Pick based on workload not brand.)

```go
// pkg/events/interview/broker_choice.go
package interview

/*
KAFKA vs RABBITMQ DECISION GUIDE

Choose KAFKA when:

1. HIGH THROUGHPUT REQUIRED
   - Millions of events per second
   - Log aggregation, metrics collection
   - Stream processing pipelines

2. EVENT REPLAY NEEDED
   - Audit requirements
   - Debugging production issues
   - Building new consumers from history
   - Event sourcing

3. ORDERING MATTERS
   - Per-partition ordering guarantee
   - User activity sequences
   - Financial transactions

4. LONG RETENTION NEEDED
   - Days/weeks of event history
   - Reprocessing capabilities
   - Tiered storage for cost efficiency

5. STREAM PROCESSING
   - Kafka Streams / ksqlDB
   - Real-time analytics
   - Complex event processing

Choose RABBITMQ when:

1. COMPLEX ROUTING REQUIRED
   - Topic exchanges with wildcards
   - Header-based routing
   - Request-reply patterns

2. MESSAGE ACKNOWLEDGMENT IMPORTANT
   - Task queues with explicit ack
   - Dead letter handling
   - Retry with delays

3. LOWER LATENCY NEEDED
   - Sub-millisecond delivery
   - Real-time applications
   - Interactive systems

4. SIMPLER OPERATIONS
   - Smaller team/infrastructure
   - Less operational complexity
   - Plugin ecosystem

5. TRADITIONAL MESSAGING PATTERNS
   - Work queues
   - RPC over messaging
   - Priority queues

HYBRID APPROACH:
Many systems use both:
- Kafka for event streaming (analytics, audit)
- RabbitMQ for task queues (email sending, notifications)
*/
```

### Question 2: How do you ensure exactly-once processing?

**Answer:** True exactly-once delivery is impossible in distributed systems due to network partitions, but you can achieve "effectively exactly-once" by combining at-least-once delivery with idempotent consumers. The standard approach pairs a transactional outbox for publishing with a deduplication table on the consumer side. Scope matters: Kafka's EOS (`enable.idempotence=true` + transactional producer + `SendOffsetsToTransaction`) gives you exactly-once *within Kafka* for consume-transform-produce loops. It does **not** make Kafka and a database atomic. For that dual-write problem the outbox pattern - ideally drained by Debezium CDC from the Postgres WAL rather than application-level polling - is what you want.

**What FAANG expects:** You distinguish "exactly-once delivery" (impossible) from "exactly-once effect" (achievable via idempotency). You can name the two halves: producer-side deduplication (idempotent producer + transactional outbox) and consumer-side deduplication (processed-event table with a dedup window, or natural idempotency via upsert/conditional update). You know when to use Kafka transactions versus the outbox, and why CDC-based outbox draining is better than polling in most production systems.

**Follow-ups to expect:**
- "How big is your dedup window and why?" (Function of max retry age + consumer lag SLO + storage budget. Typically hours-to-days, with a TTL'd index.)
- "Consumer processes in a loop: read Kafka, write Postgres, publish next event. How do you make this atomic?" (Outbox in the same Postgres transaction as the business write, then CDC publishes. Do not try to two-phase-commit Kafka and Postgres.)
- "What's the failure mode if the outbox relay falls behind?" (Lag grows but no loss. Alert on outbox row count and oldest unsent `created_at`.)

```go
// pkg/events/interview/exactly_once.go
package interview

import (
	"context"
	"database/sql"
	"time"
)

/*
EXACTLY-ONCE PROCESSING IN DISTRIBUTED SYSTEMS

True exactly-once is impossible in distributed systems (network partitions),
but we can achieve "effectively exactly-once" through:

1. IDEMPOTENT CONSUMERS
   - Store processed event IDs
   - Check before processing
   - Deduplicate at consumer

2. TRANSACTIONAL OUTBOX
   - Write event + data in same transaction
   - Relay process publishes from outbox
   - At-least-once publishing, idempotent consuming

3. KAFKA EXACTLY-ONCE (EOS)
   - Idempotent producer
   - Transactional API
   - Read-process-write atomicity

4. TWO-PHASE COMMIT (rare)
   - Distributed transaction
   - Performance cost
   - Usually avoided
*/

// IdempotentProcessor demonstrates exactly-once semantics
type IdempotentProcessor struct {
	db     *sql.DB
	window time.Duration // Dedup window
}

func (p *IdempotentProcessor) Process(ctx context.Context, event Event) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Step 1: Check if already processed (within window)
	var processedAt *time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT processed_at FROM processed_events
		WHERE event_id = $1 AND processed_at > $2
	`, event.ID, time.Now().Add(-p.window)).Scan(&processedAt)

	if err == nil && processedAt != nil {
		// Already processed - return success (idempotent)
		return nil
	}

	// Step 2: Process the event
	if err := p.processEvent(ctx, tx, event); err != nil {
		return err
	}

	// Step 3: Record as processed (same transaction)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO processed_events (event_id, processed_at)
		VALUES ($1, NOW())
		ON CONFLICT (event_id) DO UPDATE SET processed_at = NOW()
	`, event.ID)
	if err != nil {
		return err
	}

	return tx.Commit()
}

func (p *IdempotentProcessor) processEvent(ctx context.Context, tx *sql.Tx, event Event) error {
	// Business logic here
	return nil
}

type Event struct {
	ID        string
	Type      string
	Payload   []byte
	Timestamp time.Time
}

// Cleanup old dedup records periodically
func (p *IdempotentProcessor) CleanupOldRecords(ctx context.Context) error {
	_, err := p.db.ExecContext(ctx, `
		DELETE FROM processed_events WHERE processed_at < $1
	`, time.Now().Add(-p.window))
	return err
}
```

### Question 3: Explain event versioning strategies

**Answer:** Event schemas change over time as business requirements evolve. The challenge is that old events already persisted in the event store or still in flight on Kafka cannot be modified, so consumers must handle multiple schema versions simultaneously. Four strategies address this: additive schema evolution (never remove fields), version-tagged event types, explicit version fields with routing, and upcasters that transform old events to the latest format at read time. In a mature system, you also run a **schema registry** (Confluent Schema Registry or Apicurio) enforcing backward/forward compatibility at publish time using Avro or Protobuf, so that an incompatible change is rejected before it ships rather than discovered when a consumer crashes at 3 AM.

**What FAANG expects:** You treat event schemas as API contracts, not implementation details. You know the three compatibility modes (backward, forward, full) and when each is appropriate: backward for systems where consumers upgrade before producers, forward for the opposite, full when deploy order is unpredictable. You can explain why upcasting in the event store is safer than rewriting history, and why you never reuse a deleted field name.

**Follow-ups to expect:**
- "Producer and consumer are deployed by different teams. Which compatibility mode?" (Full compatibility, enforced in CI against the registry.)
- "A field was added as required. What breaks?" (Existing consumers cannot deserialize new messages, or new consumers cannot deserialize old ones, depending on direction. Always add as optional with a default.)
- "How do you test schema evolution?" (Store representative old-format events in a golden corpus, run them through every consumer on every PR.)

```go
// pkg/events/interview/versioning.go
package interview

import (
	"encoding/json"
	"fmt"
)

/*
EVENT VERSIONING STRATEGIES

1. SCHEMA EVOLUTION (Avro/Protobuf style)
   - Add optional fields (backward compatible)
   - Never remove or rename fields
   - Use default values for new fields

2. VERSION IN EVENT TYPE
   - order.created.v1, order.created.v2
   - Consumers subscribe to versions they support
   - Clear migration path

3. VERSION FIELD
   - Include version in payload
   - Single topic, multiple versions
   - Consumer routes by version

4. UPCASTERS
   - Transform old events to new format
   - Applied at read time
   - Keep original event immutable
*/

// Versioned event with upcasting
type VersionedEvent struct {
	Type    string          `json:"type"`
	Version int             `json:"version"`
	Data    json.RawMessage `json:"data"`
}

// OrderCreatedV1 is the original schema
type OrderCreatedV1 struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	TotalCents int64  `json:"total_cents"`
}

// OrderCreatedV2 adds currency field
type OrderCreatedV2 struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	TotalCents int64  `json:"total_cents"`
	Currency   string `json:"currency"` // NEW in V2
}

// OrderCreatedV3 splits total into subtotal and tax
type OrderCreatedV3 struct {
	OrderID    string  `json:"order_id"`
	CustomerID string  `json:"customer_id"`
	SubtotalCents int64 `json:"subtotal_cents"` // Changed from total
	TaxCents      int64 `json:"tax_cents"`      // NEW in V3
	Currency   string  `json:"currency"`
}

// EventUpcaster transforms events to latest version
type EventUpcaster struct {
	upcasters map[string]map[int]Upcaster
}

type Upcaster func(data json.RawMessage) (json.RawMessage, error)

func NewEventUpcaster() *EventUpcaster {
	u := &EventUpcaster{
		upcasters: make(map[string]map[int]Upcaster),
	}

	// Register upcasters for OrderCreated
	u.RegisterUpcaster("OrderCreated", 1, func(data json.RawMessage) (json.RawMessage, error) {
		// V1 -> V2: Add default currency
		var v1 OrderCreatedV1
		if err := json.Unmarshal(data, &v1); err != nil {
			return nil, err
		}
		v2 := OrderCreatedV2{
			OrderID:    v1.OrderID,
			CustomerID: v1.CustomerID,
			TotalCents: v1.TotalCents,
			Currency:   "USD", // Default value
		}
		return json.Marshal(v2)
	})

	u.RegisterUpcaster("OrderCreated", 2, func(data json.RawMessage) (json.RawMessage, error) {
		// V2 -> V3: Split total into subtotal and tax
		var v2 OrderCreatedV2
		if err := json.Unmarshal(data, &v2); err != nil {
			return nil, err
		}
		v3 := OrderCreatedV3{
			OrderID:    v2.OrderID,
			CustomerID: v2.CustomerID,
			SubtotalCents: v2.TotalCents, // Assume total was subtotal
			TaxCents:      0,             // No tax info available
			Currency:   v2.Currency,
		}
		return json.Marshal(v3)
	})

	return u
}

func (u *EventUpcaster) RegisterUpcaster(eventType string, fromVersion int, upcaster Upcaster) {
	if u.upcasters[eventType] == nil {
		u.upcasters[eventType] = make(map[int]Upcaster)
	}
	u.upcasters[eventType][fromVersion] = upcaster
}

// Upcast transforms an event to the latest version
func (u *EventUpcaster) Upcast(event VersionedEvent, targetVersion int) (json.RawMessage, error) {
	data := event.Data
	currentVersion := event.Version

	for currentVersion < targetVersion {
		upcaster, ok := u.upcasters[event.Type][currentVersion]
		if !ok {
			return nil, fmt.Errorf("no upcaster for %s v%d", event.Type, currentVersion)
		}

		var err error
		data, err = upcaster(data)
		if err != nil {
			return nil, fmt.Errorf("upcast from v%d: %w", currentVersion, err)
		}
		currentVersion++
	}

	return data, nil
}
```

### Question 4: How do you handle event ordering in a distributed system?

**Answer:** Global ordering across all events is impractical at scale because it requires a single partition, which limits throughput to one node. Instead, partition events by a business key (user ID, order ID) so that events for the same entity are ordered within a partition. Consumers that receive out-of-order events can buffer them in a min-heap ordered by sequence number and process them once the expected sequence arrives. Note that Kafka's per-partition ordering is only preserved end-to-end if the producer uses `enable.idempotence=true` and `max.in.flight.requests.per.connection <= 5` - without these, retries can reorder within a partition.

**What FAANG expects:** You reject global ordering as an anti-pattern at scale and justify partitioning by the aggregate/entity boundary. You know that "ordered" is a property of a *partition*, not a topic, and you size partitions for the highest-throughput key. You can discuss hot partitions (a celebrity user, a viral product) and mitigations: sub-keying, per-partition parallelism with in-key serialization, or topic compaction for state streams.

**Follow-ups to expect:**
- "Two consumers of the same partition - how do you parallelize without breaking order?" (Single consumer per partition by design. parallelize across keys within the consumer if needed, via worker pools keyed on entity ID.)
- "A hot key drives 40% of traffic. What do you do?" (Sub-key by a secondary dimension if downstream accepts it. Otherwise accept the hot partition and scale its consumer vertically.)
- "Consumer crashes mid-batch. Can it see duplicates? Reordered events?" (Duplicates yes, reorders no if the producer is configured correctly - handle via idempotent processing.)

```go
// pkg/events/interview/ordering.go
package interview

/*
EVENT ORDERING IN DISTRIBUTED SYSTEMS

Challenges:
1. Multiple partitions = no global order
2. Multiple producers = concurrent events
3. Consumer failures = out-of-order processing
4. Network delays = delivery reordering

Strategies:

1. PARTITION BY KEY
   - All events for a key go to same partition
   - Ordering guaranteed within partition
   - Example: partition by user_id for user events

2. SEQUENCE NUMBERS
   - Include sequence in event
   - Consumer tracks expected sequence
   - Buffer/reorder if needed

3. CAUSAL ORDERING
   - Vector clocks track causality
   - Only order causally related events
   - Concurrent events can process in any order

4. SINGLE PARTITION (LIMITED)
   - Guarantees total order
   - But limits throughput
   - Only for critical ordered streams

5. EVENTUAL CONSISTENCY
   - Accept out-of-order processing
   - Design idempotent handlers
   - Reconcile eventually
*/

import (
	"container/heap"
	"sync"
	"time"
)

// SequencedEvent includes ordering metadata
type SequencedEvent struct {
	ID           string
	PartitionKey string
	Sequence     int64
	Timestamp    time.Time
	Payload      []byte
}

// OrderedConsumer ensures in-order processing
type OrderedConsumer struct {
	expectedSeq map[string]int64
	buffers     map[string]*EventHeap
	maxBuffer   int
	maxWait     time.Duration
	mu          sync.Mutex
}

func NewOrderedConsumer(maxBuffer int, maxWait time.Duration) *OrderedConsumer {
	return &OrderedConsumer{
		expectedSeq: make(map[string]int64),
		buffers:     make(map[string]*EventHeap),
		maxBuffer:   maxBuffer,
		maxWait:     maxWait,
	}
}

// Process ensures ordered processing per partition key
func (c *OrderedConsumer) Process(event SequencedEvent, handler func(SequencedEvent) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	key := event.PartitionKey
	expected := c.expectedSeq[key]

	// If event is next in sequence, process it
	if event.Sequence == expected {
		if err := handler(event); err != nil {
			return err
		}
		c.expectedSeq[key] = expected + 1

		// Process any buffered events that are now ready
		return c.processBuffered(key, handler)
	}

	// If event is ahead, buffer it
	if event.Sequence > expected {
		c.bufferEvent(key, event)
		return nil
	}

	// If event is behind, it's a duplicate - ignore
	return nil
}

func (c *OrderedConsumer) bufferEvent(key string, event SequencedEvent) {
	if c.buffers[key] == nil {
		h := &EventHeap{}
		heap.Init(h)
		c.buffers[key] = h
	}

	if c.buffers[key].Len() < c.maxBuffer {
		heap.Push(c.buffers[key], event)
	}
	// If buffer full, drop (or handle differently)
}

func (c *OrderedConsumer) processBuffered(key string, handler func(SequencedEvent) error) error {
	buffer := c.buffers[key]
	if buffer == nil || buffer.Len() == 0 {
		return nil
	}

	expected := c.expectedSeq[key]

	for buffer.Len() > 0 {
		next := (*buffer)[0]
		if next.Sequence != expected {
			break
		}

		heap.Pop(buffer)
		if err := handler(next); err != nil {
			return err
		}
		c.expectedSeq[key] = expected + 1
		expected++
	}

	return nil
}

// EventHeap is a min-heap of events ordered by sequence
type EventHeap []SequencedEvent

func (h EventHeap) Len() int           { return len(h) }
func (h EventHeap) Less(i, j int) bool { return h[i].Sequence < h[j].Sequence }
func (h EventHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *EventHeap) Push(x any) {
	*h = append(*h, x.(SequencedEvent))
}

func (h *EventHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[0 : n-1]
	return x
}
```

### Question 5: How would you implement event-driven saga with compensation?

**Answer:** A choreography-based saga distributes a multi-step business process across services through events: each service listens for triggering events, performs its local transaction, and publishes a success or failure event. When any step fails, previously completed steps must be compensated (e.g., releasing reserved inventory when payment fails). Both the forward and compensation handlers must be idempotent, and a timeout monitor detects stuck sagas that never reached a terminal state. The alternative is **orchestration** - a central coordinator (Temporal, AWS Step Functions, or a custom state machine) drives the saga and issues commands to services. Choreography scales organizationally (no central owner) but is hard to debug. orchestration is easier to reason about and observe but creates a coupling point. Pick based on how often the process changes and how much visibility you need.

**What FAANG expects:** You can compare choreography vs orchestration concretely, not just abstractly. You know that compensations are not transactions - they are new business actions that "apologize" for the previous one (a refund, not a rollback) - and you design them accordingly. You include timeout and stuck-saga detection in the design without being prompted, and you talk about dead-letter queues for poison messages.

**Follow-ups to expect:**
- "Payment succeeds but the PaymentSucceeded event is lost. How does the saga recover?" (Outbox on the payment service guarantees at-least-once publish. orchestrator reconciles via periodic state check against the payment service's API.)
- "When is Temporal the right answer over a hand-rolled choreography?" (Long-running workflows with human-in-the-loop steps, complex compensation trees, or when you need deterministic replay for debugging.)
- "How do you prevent a retry storm when a downstream service is down?" (Exponential backoff with jitter, circuit breaker on the consumer, and a DLQ after N retries so the poison message does not block the partition.)

```go
// pkg/events/interview/saga.go
package interview

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

/*
EVENT-DRIVEN SAGA WITH COMPENSATION

In choreography-based sagas, each service:
1. Listens for events that trigger its work
2. Performs its local transaction
3. Publishes success or failure event
4. Listens for failure events to compensate

Key considerations:
- Idempotent handlers (events may replay)
- Timeout handling (detect stuck sagas)
- Compensation must be idempotent too
*/

// Saga events for order processing
type OrderCreatedEvent struct {
	SagaID     string    `json:"saga_id"`
	OrderID    string    `json:"order_id"`
	CustomerID string    `json:"customer_id"`
	Items      []Item    `json:"items"`
	TotalCents int64     `json:"total_cents"`
	Timestamp  time.Time `json:"timestamp"`
}

type Item struct {
	ProductID  string
	Quantity   int
	PriceCents int64
}

type InventoryReservedEvent struct {
	SagaID        string    `json:"saga_id"`
	OrderID       string    `json:"order_id"`
	ReservationID string    `json:"reservation_id"`
	Timestamp     time.Time `json:"timestamp"`
}

type InventoryReservationFailedEvent struct {
	SagaID    string    `json:"saga_id"`
	OrderID   string    `json:"order_id"`
	Reason    string    `json:"reason"`
	Timestamp time.Time `json:"timestamp"`
}

type PaymentProcessedEvent struct {
	SagaID    string    `json:"saga_id"`
	OrderID   string    `json:"order_id"`
	PaymentID string    `json:"payment_id"`
	Timestamp time.Time `json:"timestamp"`
}

type PaymentFailedEvent struct {
	SagaID    string    `json:"saga_id"`
	OrderID   string    `json:"order_id"`
	Reason    string    `json:"reason"`
	Timestamp time.Time `json:"timestamp"`
}

// InventoryService handles inventory in the saga
type InventoryService struct {
	store     InventoryStore
	publisher EventPublisher
}

type InventoryStore interface {
	Reserve(ctx context.Context, items []Item) (string, error)
	Release(ctx context.Context, reservationID string) error
	GetReservation(ctx context.Context, orderID string) (string, error)
}

type EventPublisher interface {
	Publish(ctx context.Context, topic string, event any) error
}

// HandleOrderCreated reserves inventory when order is created
func (s *InventoryService) HandleOrderCreated(ctx context.Context, event OrderCreatedEvent) error {
	// Check idempotency - already reserved?
	existingRes, err := s.store.GetReservation(ctx, event.OrderID)
	if err == nil && existingRes != "" {
		// Already processed - republish success (idempotent)
		return s.publisher.Publish(ctx, "inventory-events", InventoryReservedEvent{
			SagaID:        event.SagaID,
			OrderID:       event.OrderID,
			ReservationID: existingRes,
			Timestamp:     time.Now(),
		})
	}

	// Reserve inventory
	reservationID, err := s.store.Reserve(ctx, event.Items)
	if err != nil {
		// Publish failure event
		return s.publisher.Publish(ctx, "inventory-events", InventoryReservationFailedEvent{
			SagaID:    event.SagaID,
			OrderID:   event.OrderID,
			Reason:    err.Error(),
			Timestamp: time.Now(),
		})
	}

	// Publish success event
	return s.publisher.Publish(ctx, "inventory-events", InventoryReservedEvent{
		SagaID:        event.SagaID,
		OrderID:       event.OrderID,
		ReservationID: reservationID,
		Timestamp:     time.Now(),
	})
}

// HandlePaymentFailed releases inventory when payment fails (compensation)
func (s *InventoryService) HandlePaymentFailed(ctx context.Context, event PaymentFailedEvent) error {
	reservationID, err := s.store.GetReservation(ctx, event.OrderID)
	if err != nil || reservationID == "" {
		// Nothing to compensate (idempotent)
		return nil
	}

	// Release the reservation (compensation)
	return s.store.Release(ctx, reservationID)
}

// SagaTimeout handles stuck sagas
type SagaTimeoutHandler struct {
	sagaStore SagaStore
	publisher EventPublisher
	timeout   time.Duration
}

type SagaStore interface {
	GetStuckSagas(ctx context.Context, olderThan time.Duration) ([]SagaState, error)
	UpdateStatus(ctx context.Context, sagaID, status string) error
}

type SagaState struct {
	SagaID        string
	Status        string
	LastEvent     string
	LastEventTime time.Time
}

func (h *SagaTimeoutHandler) CheckAndCompensate(ctx context.Context) error {
	stuckSagas, err := h.sagaStore.GetStuckSagas(ctx, h.timeout)
	if err != nil {
		return err
	}

	for _, saga := range stuckSagas {
		// Determine compensation based on last successful event
		switch saga.LastEvent {
		case "InventoryReserved":
			// Inventory reserved but payment didn't complete - release inventory
			h.publisher.Publish(ctx, "compensation-events", CompensateInventoryEvent{
				SagaID: saga.SagaID,
				Reason: "saga_timeout",
			})

		case "PaymentProcessed":
			// Payment completed but order not confirmed - refund
			h.publisher.Publish(ctx, "compensation-events", RefundPaymentEvent{
				SagaID: saga.SagaID,
				Reason: "saga_timeout",
			})
		}

		h.sagaStore.UpdateStatus(ctx, saga.SagaID, "compensating")
	}

	return nil
}

type CompensateInventoryEvent struct {
	SagaID string `json:"saga_id"`
	Reason string `json:"reason"`
}

type RefundPaymentEvent struct {
	SagaID string `json:"saga_id"`
	Reason string `json:"reason"`
}
```

### Junior → FAANG: Using Interview Questions as a Study Framework

The five questions in this section cover the core concepts that show up in 80% of EDA-related interview discussions. Here is how to use them effectively.

For each question, practice answering in two minutes or less without looking at the answer. If you cannot, you do not yet know the material well enough for an interview. The ability to explain a concept clearly in under two minutes, without verbal filler, is itself a signal of mastery.

**Question 1 (Kafka vs RabbitMQ):** Practice the answer by drawing the comparison table without looking at the text, then adding the "when would I pick neither" case. The "neither" case (use NATS JetStream for small payloads with moderate retention requirements, use Redis Streams for very simple fan-out) shows that you have thought beyond the binary choice.

**Question 2 (Exactly-once):** The key distinction to internalize is "exactly-once delivery" (impossible) vs "exactly-once effect" (achievable). An interviewer who hears "you can achieve exactly-once with Kafka transactions" without the qualifier "within Kafka, not across Kafka and a database" will follow up with a scenario that breaks the claim. Anticipate the follow-up and include the qualifier proactively.

**Question 3 (Event versioning):** The four strategies (additive evolution, version-tagged types, version field, upcasters) are not mutually exclusive. A mature system uses all four: additive evolution as the default, version fields for routing, and upcasters for backward-incompatible changes that are unavoidable. Know the interaction between them.

**Question 4 (Event ordering):** The most common wrong answer is "use a single partition." This limits throughput to one node and one consumer. The correct answer is "partition by the business key that defines the ordering requirement," followed by a discussion of what that key is for the specific scenario in the question.

**Question 5 (Saga with compensation):** The distinction between choreography and orchestration is easy to state but harder to apply. Practice by naming a specific scenario where choreography is better (independent teams, loosely coupled services, infrequent process changes) and a specific scenario where orchestration is better (complex compensation logic, visibility requirements, human approval steps).

### Senior @ FAANG: What Bar-Raisers Look For in EDA Interview Answers

The five questions in this section are the entry-level FAANG EDA questions. A bar-raiser at L6/L7 will take each answer further. Here is the depth expected at each level.

**Kafka vs RabbitMQ at L6:** A complete answer addresses not just the technical comparison but the organizational implications. Kafka requires a platform team to operate safely at scale: capacity planning, rack-aware partition assignment, tiered storage configuration, MirrorMaker 2 for cross-DC. RabbitMQ's operational footprint is smaller but still requires expertise in connection tuning, queue mirroring (or quorum queue configuration), and shovel/federation for multi-region. NATS JetStream is the operationally simplest option for teams without dedicated messaging infrastructure expertise. A staff engineer recommends the broker that matches the team's operational maturity, not the broker that has the best benchmark numbers.

**Exactly-once at L6:** A complete answer includes a description of the Debezium CDC alternative to application polling for outbox draining, the deduplication window size tradeoff (shorter window uses less storage but misses late redeliveries, longer window uses more storage but is safer), and the failure mode analysis (what happens if the outbox relay is down for 20 minutes, what happens if a consumer processes an event and crashes before committing but after the side effect completes). A bar-raiser will ask at least one of these follow-ups.

**Event versioning at L6:** A complete answer includes a description of schema registry enforcement in CI, not just runtime version checking. The difference is significant: CI enforcement stops incompatible changes before they ship, runtime version checking discovers them after they affect consumers. A staff engineer advocates for moving compatibility checking as far left (toward code commit) as possible. The answer also includes a description of the consumer census: before deprecating a field, you need to know which consumers read it, which requires either tracking field access in deserialization telemetry or maintaining a manual consumer registry.

**Event ordering at L6:** A complete answer includes a quantitative analysis of the hot partition problem: if 10% of users drive 70% of traffic, partitioning by user ID means 10% of partitions are saturated while 90% are idle. The answer then provides mitigations: sub-keying (append a secondary dimension to the key, accepting reduced ordering granularity), or accepting that ordering is enforced at the consumer level via a sequence number buffer (as shown in this chapter), not at the partition level.

**Saga with compensation at L6:** A complete answer includes an evaluation of Temporal vs hand-rolled choreography for a specific use case. Temporal is the correct answer when: the saga has more than three steps, the compensation logic is conditional on which steps succeeded, human approval is required between steps, or the team needs deterministic replay for debugging production incidents. Hand-rolled choreography is the correct answer when: the saga is simple (two or three steps), the team wants to avoid an external dependency on Temporal, or the steps are owned by independent teams who cannot coordinate on a shared orchestrator. The answer demonstrates that you evaluate tools against requirements rather than defaulting to one or the other.

---
