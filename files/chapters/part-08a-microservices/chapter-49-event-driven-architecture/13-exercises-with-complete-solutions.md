## 49.11 Exercises with Complete Solutions

### Exercise 1: Build a Complete Event Pipeline with Kafka

**Challenge:** Create a Kafka producer and consumer with exactly-once semantics.

This solution implements the three components of a reliable event pipeline: an `OutboxProducer` that writes orders and events atomically in one database transaction, an `OutboxRelay` that polls the outbox table and publishes to Kafka, and an `IdempotentConsumer` that deduplicates events before processing. Together, these guarantee that every order produces exactly one processed event, even under broker or consumer restarts.

A note on the client: this solution uses `IBM/sarama` deliberately, because its explicit `ConsumerGroupHandler` interface makes the rebalance lifecycle visible, which is the learning goal here. For a new production service, follow this chapter's client guidance and prefer `twmb/franz-go`. The outbox and idempotency logic transfer unchanged.

```go
// exercises/eda/kafka_pipeline/solution/main.go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/IBM/sarama"
	_ "github.com/lib/pq"
)

// Order represents an order
type Order struct {
	ID         string      `json:"id"`
	CustomerID string      `json:"customer_id"`
	Items      []OrderItem `json:"items"`
	TotalCents int64       `json:"total_cents"`
	Status     string      `json:"status"`
	CreatedAt  time.Time   `json:"created_at"`
}

type OrderItem struct {
	ProductID  string `json:"product_id"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// OrderEvent represents an order event
type OrderEvent struct {
	EventID   string    `json:"event_id"`
	EventType string    `json:"event_type"`
	Order     Order     `json:"order"`
	Timestamp time.Time `json:"timestamp"`
}

// OutboxProducer publishes events via transactional outbox
type OutboxProducer struct {
	db     *sql.DB
	logger *slog.Logger
}

func NewOutboxProducer(db *sql.DB) *OutboxProducer {
	return &OutboxProducer{
		db:     db,
		logger: slog.Default(),
	}
}

// CreateOrderWithEvent creates order and event in same transaction
func (p *OutboxProducer) CreateOrderWithEvent(ctx context.Context, order *Order) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Insert order
	order.ID = uuid.New().String()
	order.Status = "created"
	order.CreatedAt = time.Now()

	_, err = tx.ExecContext(ctx, `
		INSERT INTO orders (id, customer_id, total_cents, status, created_at)
		VALUES ($1, $2, $3, $4, $5)
	`, order.ID, order.CustomerID, order.TotalCents, order.Status, order.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert order: %w", err)
	}

	// Insert order items
	for _, item := range order.Items {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO order_items (order_id, product_id, quantity, price_cents)
			VALUES ($1, $2, $3, $4)
		`, order.ID, item.ProductID, item.Quantity, item.PriceCents)
		if err != nil {
			return fmt.Errorf("insert item: %w", err)
		}
	}

	// Create event
	event := OrderEvent{
		EventID:   uuid.New().String(),
		EventType: "order.created",
		Order:     *order,
		Timestamp: time.Now(),
	}

	eventData, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	// Insert into outbox (same transaction!)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO outbox (id, event_type, aggregate_id, payload, created_at)
		VALUES ($1, $2, $3, $4, $5)
	`, event.EventID, event.EventType, order.ID, eventData, event.Timestamp)
	if err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}

	return tx.Commit()
}

// OutboxRelay polls outbox and publishes to Kafka
type OutboxRelay struct {
	db       *sql.DB
	producer sarama.SyncProducer
	topic    string
	logger   *slog.Logger
}

func NewOutboxRelay(db *sql.DB, producer sarama.SyncProducer, topic string) *OutboxRelay {
	return &OutboxRelay{
		db:       db,
		producer: producer,
		topic:    topic,
		logger:   slog.Default(),
	}
}

// Run continuously polls and publishes events
func (r *OutboxRelay) Run(ctx context.Context) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := r.pollAndPublish(ctx); err != nil {
				r.logger.Error("poll failed", "error", err)
			}
		}
	}
}

func (r *OutboxRelay) pollAndPublish(ctx context.Context) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get unpublished events with row lock
	rows, err := tx.QueryContext(ctx, `
		SELECT id, event_type, aggregate_id, payload
		FROM outbox
		WHERE published_at IS NULL
		ORDER BY created_at
		LIMIT 100
		FOR UPDATE SKIP LOCKED
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var publishedIDs []string

	for rows.Next() {
		var id, eventType, aggregateID string
		var payload []byte

		if err := rows.Scan(&id, &eventType, &aggregateID, &payload); err != nil {
			return err
		}

		// Publish to Kafka
		msg := &sarama.ProducerMessage{
			Topic: r.topic,
			Key:   sarama.StringEncoder(aggregateID),
			Value: sarama.ByteEncoder(payload),
			Headers: []sarama.RecordHeader{
				{Key: []byte("event-type"), Value: []byte(eventType)},
				{Key: []byte("event-id"), Value: []byte(id)},
			},
		}

		partition, offset, err := r.producer.SendMessage(msg)
		if err != nil {
			r.logger.Error("publish failed", "eventId", id, "error", err)
			continue
		}

		r.logger.Debug("event published",
			"eventId", id,
			"partition", partition,
			"offset", offset,
		)

		publishedIDs = append(publishedIDs, id)
	}

	// Mark as published
	if len(publishedIDs) > 0 {
		for _, id := range publishedIDs {
			_, err = tx.ExecContext(ctx, `
				UPDATE outbox SET published_at = NOW() WHERE id = $1
			`, id)
			if err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

// IdempotentConsumer consumes events with deduplication
type IdempotentConsumer struct {
	db       *sql.DB
	handlers map[string]EventHandler
	logger   *slog.Logger
}

type EventHandler func(ctx context.Context, event OrderEvent) error

func NewIdempotentConsumer(db *sql.DB) *IdempotentConsumer {
	return &IdempotentConsumer{
		db:       db,
		handlers: make(map[string]EventHandler),
		logger:   slog.Default(),
	}
}

func (c *IdempotentConsumer) RegisterHandler(eventType string, handler EventHandler) {
	c.handlers[eventType] = handler
}

// Process handles an event idempotently
func (c *IdempotentConsumer) Process(ctx context.Context, msg *sarama.ConsumerMessage) error {
	var event OrderEvent
	if err := json.Unmarshal(msg.Value, &event); err != nil {
		return fmt.Errorf("unmarshal event: %w", err)
	}

	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check if already processed
	var exists bool
	err = tx.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1)
	`, event.EventID).Scan(&exists)
	if err != nil {
		return err
	}

	if exists {
		c.logger.Debug("event already processed", "eventId", event.EventID)
		return nil
	}

	// Find handler
	handler, ok := c.handlers[event.EventType]
	if !ok {
		c.logger.Warn("no handler for event type", "type", event.EventType)
		return nil
	}

	// Process event
	if err := handler(ctx, event); err != nil {
		return fmt.Errorf("handle event: %w", err)
	}

	// Mark as processed
	_, err = tx.ExecContext(ctx, `
		INSERT INTO processed_events (event_id, event_type, processed_at)
		VALUES ($1, $2, NOW())
	`, event.EventID, event.EventType)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// Setup implements sarama.ConsumerGroupHandler
func (c *IdempotentConsumer) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (c *IdempotentConsumer) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }

func (c *IdempotentConsumer) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		if err := c.Process(session.Context(), msg); err != nil {
			c.logger.Error("process failed", "error", err)
			continue
		}
		session.MarkMessage(msg, "")
	}
	return nil
}

func main() {
	// Database connection
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Create schema
	if err := createSchema(db); err != nil {
		slog.Error("schema creation failed", "error", err)
		os.Exit(1)
	}

	// Kafka producer
	kafkaConfig := sarama.NewConfig()
	kafkaConfig.Producer.RequiredAcks = sarama.WaitForAll
	kafkaConfig.Producer.Return.Successes = true

	producer, err := sarama.NewSyncProducer([]string{"localhost:9092"}, kafkaConfig)
	if err != nil {
		slog.Error("producer creation failed", "error", err)
		os.Exit(1)
	}
	defer producer.Close()

	ctx, cancel := context.WithCancel(context.Background())

	// Start outbox relay
	relay := NewOutboxRelay(db, producer, "orders")
	go relay.Run(ctx)

	// Start consumer
	consumerConfig := sarama.NewConfig()
	consumerConfig.Consumer.Group.Rebalance.Strategy = sarama.BalanceStrategyRoundRobin
	consumerConfig.Consumer.Offsets.Initial = sarama.OffsetOldest

	consumerGroup, err := sarama.NewConsumerGroup([]string{"localhost:9092"}, "order-processor", consumerConfig)
	if err != nil {
		slog.Error("consumer group creation failed", "error", err)
		os.Exit(1)
	}

	consumer := NewIdempotentConsumer(db)
	consumer.RegisterHandler("order.created", func(ctx context.Context, event OrderEvent) error {
		slog.Info("processing order", "orderId", event.Order.ID)
		// Business logic here
		return nil
	})

	go func() {
		for {
			if err := consumerGroup.Consume(ctx, []string{"orders"}, consumer); err != nil {
				slog.Error("consume error", "error", err)
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()

	// Create test order
	orderProducer := NewOutboxProducer(db)
	testOrder := &Order{
		CustomerID: "customer-123",
		Items: []OrderItem{
			{ProductID: "prod-1", Quantity: 2, PriceCents: 2999},
		},
		TotalCents: 5998,
	}

	if err := orderProducer.CreateOrderWithEvent(ctx, testOrder); err != nil {
		slog.Error("create order failed", "error", err)
	} else {
		slog.Info("order created", "orderId", testOrder.ID)
	}

	// Wait for shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	cancel()
	consumerGroup.Close()
}

func createSchema(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS orders (
			id TEXT PRIMARY KEY,
			customer_id TEXT NOT NULL,
			total_cents BIGINT NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL
		);

		CREATE TABLE IF NOT EXISTS order_items (
			id SERIAL PRIMARY KEY,
			order_id TEXT REFERENCES orders(id),
			product_id TEXT NOT NULL,
			quantity INT NOT NULL,
			price_cents BIGINT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS outbox (
			id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			aggregate_id TEXT NOT NULL,
			payload JSONB NOT NULL,
			created_at TIMESTAMP NOT NULL,
			published_at TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox(created_at) WHERE published_at IS NULL;

		CREATE TABLE IF NOT EXISTS processed_events (
			event_id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			processed_at TIMESTAMP NOT NULL
		);
	`)
	return err
}
```

### Junior → FAANG: How to Get the Most Out of This Exercise

The exercise in this section is a complete, runnable example, which means you can observe its behavior rather than just reading it. Here is a study plan that turns the code into genuine learning.

**Step 1: Run it.** Set up a local Postgres and Kafka (a `docker-compose.yml` with both is the fastest path). Run the `main.go` and observe an order being created, the outbox being polled, and the Kafka consumer processing the event. Watch the logs.

**Step 2: Inject a fault.** After the order is inserted into the `orders` table but before the outbox row is committed, kill the process (use `os.Exit` temporarily). Restart the process. Verify that no event was published to Kafka (the outbox row was never committed). This is the outbox pattern working correctly.

**Step 3: Test idempotency.** After an event is processed, manually re-insert the same event into the Kafka topic using `kafka-console-producer`. Watch the consumer log the "already processed" message and skip the handler. This confirms your deduplication logic works.

**Step 4: Measure lag.** Use `kafka-consumer-groups --describe` to check the consumer lag. Introduce an artificial slow handler (`time.Sleep(500 * time.Millisecond)`) and observe lag growing. This is what a real lag incident looks like from the outside.

**Step 5: Extend the exercise.** Add a second event type (`order.paid`), register a second handler, and verify that idempotency works independently for each event type. This is the pattern you will use in every production service.

**Interview value.** Being able to say "I ran this exercise, injected a fault at step X, and observed behavior Y" is far more credible than "I read about the outbox pattern." Concrete operational experience is what FAANG interviewers probe for in systems design discussions.

### Senior @ FAANG: Extending the Exercise to Production-Grade Requirements

The exercise as written is correct and complete for demonstrating the patterns. Here are the extensions that would make it production-grade, which you might propose in a design review or a principal engineer interview.

**Replace application polling with Debezium CDC.** The `OutboxRelay` polls the `outbox` table every 100ms. In production, replace this with a Debezium Postgres connector reading from the logical replication WAL. The WAL approach delivers changes in real time (sub-millisecond), eliminates polling overhead on the database, and is more reliable under high write volume because it does not require a `FOR UPDATE SKIP LOCKED` query that can cause lock contention.

**Add a relay lag metric.** The relay should expose a Prometheus gauge measuring the oldest unprocessed outbox row age (current timestamp minus `MIN(created_at) WHERE published_at IS NULL`). Alert if this value exceeds 30 seconds, which indicates the relay has fallen behind or is failing silently. This metric is more actionable than Kafka consumer lag for diagnosing outbox relay failures because it measures the time-to-publish directly.

**Add a `processed_events` TTL cleanup job.** The `processed_events` table grows indefinitely. A background job should delete rows older than the deduplication window (typically 24 hours to 7 days, depending on the maximum broker redelivery window). Without this cleanup, the table becomes a performance bottleneck as deduplication queries scan an ever-growing index. Schedule the cleanup as a cron job in Kubernetes and alert if the table exceeds a row count threshold.

**Add structured log fields for observability.** Every log line in the relay and consumer should include: `event_id`, `event_type`, `aggregate_id`, `processing_duration_ms`, and `attempt_count`. This enables filtering and aggregating in your observability platform to answer questions like "what is the P99 processing time for `order.created` events" and "which events have the highest retry count this week."

**Parameterize and test the concurrent relay.** The `FOR UPDATE SKIP LOCKED` pattern allows multiple relay instances to process different outbox rows concurrently. Write a test that starts three relay instances and 1000 outbox rows simultaneously and verifies that each row is published exactly once. This is the correctness guarantee of the SKIP LOCKED pattern, and it should be a test in the repository.

---
