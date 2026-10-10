## 49.2 Apache Kafka Implementation

### Choosing a Go Kafka Client in 2026

Three Go clients are production-viable today, and the choice is less about taste than about what you need to do. `twmb/franz-go` is the modern pure-Go client, feature-complete through Kafka 4.x with full transactional API, idempotent producer, consumer groups, and incremental cooperative rebalance - benchmarks put it at roughly 2-2.5x `segmentio/kafka-go` and `IBM/sarama` on both the produce and consume paths, and it is the right default for new high-throughput services. `segmentio/kafka-go` is the pragmatic choice when you want a small, idiomatic API that mirrors `io.Reader`/`io.Writer` patterns and you do not need Kafka transactions. Its readability wins matter in smaller teams. `confluent-kafka-go` wraps `librdkafka` via CGO, which gives you the reference transactional implementation and tight feature parity with the Java client, but CGO complicates cross-compilation, static builds, and distroless images. `IBM/sarama` (the former `Shopify/sarama`) is still maintained for existing deployments but is effectively in legacy mode - do not start a new service on it. On the broker side, assume KRaft by default: Kafka 3.3 marked KRaft production-ready and Kafka 4.0 removed ZooKeeper outright, so ZK-based clusters are migration targets, not new deployments. Redpanda remains a drop-in Kafka-wire-compatible alternative when you want lower tail latency, ARM efficiency, and single-binary operations without the JVM.

The examples in this section use `segmentio/kafka-go` for readability, but the same code structure works with `franz-go` - the wire concepts (topics, partitions, consumer groups, offsets) are client-agnostic, and migration is mostly a matter of mapping configuration knobs.

### Kafka Producer

The Kafka producer uses the `segmentio/kafka-go` writer with `RequiredAcks: kafka.RequireAll` to ensure the broker replicates each message to all in-sync replicas before acknowledging, preventing data loss on leader failure. Batching is controlled by `BatchSize` and `BatchTimeout` to amortize the per-write TCP round-trip, and context cancellation signals are propagated so in-flight writes abort cleanly during shutdown. Serializing the event payload to JSON before writing makes the message human-readable in Kafka tooling without requiring a schema registry for development - for production, pair this with a schema registry (Confluent Schema Registry or Apicurio) and either Avro or Protobuf encoding so that schema evolution is enforced at publish time rather than discovered at consume time.

```go
// pkg/kafka/producer.go
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ProducerConfig holds Kafka producer configuration
type ProducerConfig struct {
	Brokers       []string
	Topic         string
	BatchSize     int
	BatchTimeout  time.Duration
	RequiredAcks  kafka.RequiredAcks
	MaxRetries    int
	RetryBackoff  time.Duration
	Compression   kafka.Compression
	Async         bool
}

// DefaultProducerConfig returns sensible defaults
func DefaultProducerConfig(brokers []string, topic string) ProducerConfig {
	return ProducerConfig{
		Brokers:       brokers,
		Topic:         topic,
		BatchSize:     100,
		BatchTimeout:  100 * time.Millisecond,
		RequiredAcks:  kafka.RequireAll, // Wait for all ISR
		MaxRetries:    3,
		RetryBackoff:  100 * time.Millisecond,
		Compression:   kafka.Snappy,
		Async:         false,
	}
}

// Producer wraps kafka-go writer with additional features
type Producer struct {
	writer  *kafka.Writer
	config  ProducerConfig
	metrics *ProducerMetrics
	tracer  trace.Tracer
}

// ProducerMetrics tracks producer statistics
type ProducerMetrics struct {
	mu               sync.RWMutex
	MessagesSent     int64
	BytesSent        int64
	Errors           int64
	Retries          int64
	AvgLatencyMs     float64
	latencySum       time.Duration
	latencyCount     int64
}

// NewProducer creates a new Kafka producer
func NewProducer(config ProducerConfig) (*Producer, error) {
	writer := &kafka.Writer{
		Addr:         kafka.TCP(config.Brokers...),
		Topic:        config.Topic,
		Balancer:     &kafka.Hash{}, // Consistent partitioning by key
		BatchSize:    config.BatchSize,
		BatchTimeout: config.BatchTimeout,
		RequiredAcks: config.RequiredAcks,
		MaxAttempts:  config.MaxRetries,
		Compression:  config.Compression,
		Async:        config.Async,
	}

	return &Producer{
		writer:  writer,
		config:  config,
		metrics: &ProducerMetrics{},
		tracer:  otel.Tracer("kafka-producer"),
	}, nil
}

// Message represents a message to be sent
type Message struct {
	Key     string
	Value   any
	Headers map[string]string
}

// Send sends a single message
func (p *Producer) Send(ctx context.Context, msg Message) error {
	ctx, span := p.tracer.Start(ctx, "kafka.produce",
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", p.config.Topic),
			attribute.String("messaging.destination_kind", "topic"),
		),
	)
	defer span.End()

	start := time.Now()

	value, err := json.Marshal(msg.Value)
	if err != nil {
		span.RecordError(err)
		return fmt.Errorf("marshal value: %w", err)
	}

	kafkaMsg := kafka.Message{
		Key:   []byte(msg.Key),
		Value: value,
	}

	// Add headers including trace context
	for k, v := range msg.Headers {
		kafkaMsg.Headers = append(kafkaMsg.Headers, kafka.Header{
			Key:   k,
			Value: []byte(v),
		})
	}

	// Inject trace context
	kafkaMsg.Headers = append(kafkaMsg.Headers, kafka.Header{
		Key:   "trace-id",
		Value: []byte(span.SpanContext().TraceID().String()),
	})

	err = p.writer.WriteMessages(ctx, kafkaMsg)

	// Update metrics
	p.metrics.mu.Lock()
	if err != nil {
		p.metrics.Errors++
		span.RecordError(err)
	} else {
		p.metrics.MessagesSent++
		p.metrics.BytesSent += int64(len(value))
		latency := time.Since(start)
		p.metrics.latencySum += latency
		p.metrics.latencyCount++
		p.metrics.AvgLatencyMs = float64(p.metrics.latencySum.Milliseconds()) / float64(p.metrics.latencyCount)
	}
	p.metrics.mu.Unlock()

	return err
}

// SendBatch sends multiple messages in a batch
func (p *Producer) SendBatch(ctx context.Context, messages []Message) error {
	ctx, span := p.tracer.Start(ctx, "kafka.produce_batch",
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", p.config.Topic),
			attribute.Int("messaging.batch_size", len(messages)),
		),
	)
	defer span.End()

	kafkaMessages := make([]kafka.Message, 0, len(messages))

	for _, msg := range messages {
		value, err := json.Marshal(msg.Value)
		if err != nil {
			span.RecordError(err)
			return fmt.Errorf("marshal value: %w", err)
		}

		kafkaMsg := kafka.Message{
			Key:   []byte(msg.Key),
			Value: value,
		}

		for k, v := range msg.Headers {
			kafkaMsg.Headers = append(kafkaMsg.Headers, kafka.Header{
				Key:   k,
				Value: []byte(v),
			})
		}

		kafkaMessages = append(kafkaMessages, kafkaMsg)
	}

	return p.writer.WriteMessages(ctx, kafkaMessages...)
}

// GetMetrics returns a snapshot of current producer metrics. The fields are
// copied individually: returning *p.metrics would copy the embedded RWMutex
// while it is held, which go vet's copylocks check rightly rejects.
func (p *Producer) GetMetrics() ProducerMetrics {
	p.metrics.mu.RLock()
	defer p.metrics.mu.RUnlock()
	return ProducerMetrics{
		MessagesSent: p.metrics.MessagesSent,
		BytesSent:    p.metrics.BytesSent,
		Errors:       p.metrics.Errors,
		Retries:      p.metrics.Retries,
		AvgLatencyMs: p.metrics.AvgLatencyMs,
	}
}

// Close closes the producer
func (p *Producer) Close() error {
	return p.writer.Close()
}
```

### Kafka Consumer with Consumer Groups

The Kafka consumer joins a named consumer group so that Kafka distributes topic partitions across multiple Go instances automatically, and adding replicas scales throughput without code changes. After each message is successfully processed, the offset is committed explicitly rather than auto-committed, guaranteeing at-least-once delivery even if the process crashes mid-batch. A `select` on `ctx.Done()` inside the fetch loop ensures the goroutine exits cleanly when the server shuts down, avoiding the indefinite block that would delay a graceful Kubernetes pod termination.

```go
// pkg/kafka/consumer.go
package kafka

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ConsumerConfig holds Kafka consumer configuration
type ConsumerConfig struct {
	Brokers         []string
	Topic           string
	GroupID         string
	MinBytes        int
	MaxBytes        int
	MaxWait         time.Duration
	StartOffset     int64
	CommitInterval  time.Duration
	HeartbeatInterval time.Duration
	SessionTimeout  time.Duration
	RebalanceTimeout time.Duration
	RetentionTime   time.Duration
}

// DefaultConsumerConfig returns sensible defaults
func DefaultConsumerConfig(brokers []string, topic, groupID string) ConsumerConfig {
	return ConsumerConfig{
		Brokers:           brokers,
		Topic:             topic,
		GroupID:           groupID,
		MinBytes:          10e3, // 10KB
		MaxBytes:          10e6, // 10MB
		MaxWait:           3 * time.Second,
		StartOffset:       kafka.FirstOffset,
		CommitInterval:    time.Second,
		HeartbeatInterval: 3 * time.Second,
		SessionTimeout:    30 * time.Second,
		RebalanceTimeout:  30 * time.Second,
		RetentionTime:     24 * time.Hour,
	}
}

// MessageHandler processes consumed messages
type MessageHandler func(ctx context.Context, msg *ConsumedMessage) error

// ConsumedMessage represents a consumed Kafka message
type ConsumedMessage struct {
	Key       []byte
	Value     []byte
	Headers   map[string]string
	Topic     string
	Partition int
	Offset    int64
	Time      time.Time
}

// Decode unmarshals the message value
func (m *ConsumedMessage) Decode(target any) error {
	return json.Unmarshal(m.Value, target)
}

// Consumer wraps kafka-go reader with additional features
type Consumer struct {
	reader  *kafka.Reader
	config  ConsumerConfig
	logger  *slog.Logger
	tracer  trace.Tracer
	metrics *ConsumerMetrics

	handlers map[string]MessageHandler
	mu       sync.RWMutex
}

// ConsumerMetrics tracks consumer statistics
type ConsumerMetrics struct {
	mu                sync.RWMutex
	MessagesReceived  int64
	BytesReceived     int64
	Errors            int64
	Lag               int64
	ProcessingTimeMs  float64
}

// NewConsumer creates a new Kafka consumer
func NewConsumer(config ConsumerConfig, logger *slog.Logger) (*Consumer, error) {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:           config.Brokers,
		Topic:             config.Topic,
		GroupID:           config.GroupID,
		MinBytes:          config.MinBytes,
		MaxBytes:          config.MaxBytes,
		MaxWait:           config.MaxWait,
		StartOffset:       config.StartOffset,
		CommitInterval:    config.CommitInterval,
		HeartbeatInterval: config.HeartbeatInterval,
		SessionTimeout:    config.SessionTimeout,
		RebalanceTimeout:  config.RebalanceTimeout,
		RetentionTime:     config.RetentionTime,
	})

	return &Consumer{
		reader:   reader,
		config:   config,
		logger:   logger,
		tracer:   otel.Tracer("kafka-consumer"),
		metrics:  &ConsumerMetrics{},
		handlers: make(map[string]MessageHandler),
	}, nil
}

// RegisterHandler registers a handler for a specific event type
func (c *Consumer) RegisterHandler(eventType string, handler MessageHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[eventType] = handler
}

// Start begins consuming messages
func (c *Consumer) Start(ctx context.Context) error {
	c.logger.Info("Starting consumer",
		"topic", c.config.Topic,
		"group", c.config.GroupID,
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			c.logger.Error("Failed to fetch message", "error", err)
			c.metrics.mu.Lock()
			c.metrics.Errors++
			c.metrics.mu.Unlock()
			continue
		}

		if err := c.processMessage(ctx, msg); err != nil {
			c.logger.Error("Failed to process message",
				"error", err,
				"topic", msg.Topic,
				"partition", msg.Partition,
				"offset", msg.Offset,
			)
			// Don't commit on error - message will be reprocessed
			continue
		}

		// Commit the message offset
		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			c.logger.Error("Failed to commit message", "error", err)
		}
	}
}

func (c *Consumer) processMessage(ctx context.Context, msg kafka.Message) error {
	start := time.Now()

	// Extract trace context from headers
	var traceID string
	headers := make(map[string]string)
	for _, h := range msg.Headers {
		headers[h.Key] = string(h.Value)
		if h.Key == "trace-id" {
			traceID = string(h.Value)
		}
	}

	ctx, span := c.tracer.Start(ctx, "kafka.consume",
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", msg.Topic),
			attribute.Int("messaging.kafka.partition", msg.Partition),
			attribute.Int64("messaging.kafka.offset", msg.Offset),
			attribute.String("trace.parent_id", traceID),
		),
	)
	defer span.End()

	consumed := &ConsumedMessage{
		Key:       msg.Key,
		Value:     msg.Value,
		Headers:   headers,
		Topic:     msg.Topic,
		Partition: msg.Partition,
		Offset:    msg.Offset,
		Time:      msg.Time,
	}

	// Determine event type from headers or message content
	eventType := headers["event_type"]
	if eventType == "" {
		// Try to extract from message
		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(msg.Value, &envelope); err == nil {
			eventType = envelope.Type
		}
	}

	// Find and execute handler
	c.mu.RLock()
	handler, exists := c.handlers[eventType]
	if !exists {
		// Try default handler
		handler = c.handlers["*"]
	}
	c.mu.RUnlock()

	if handler == nil {
		c.logger.Warn("No handler for event type",
			"event_type", eventType,
			"topic", msg.Topic,
		)
		return nil
	}

	err := handler(ctx, consumed)

	// Update metrics
	c.metrics.mu.Lock()
	c.metrics.MessagesReceived++
	c.metrics.BytesReceived += int64(len(msg.Value))
	c.metrics.ProcessingTimeMs = float64(time.Since(start).Milliseconds())
	if err != nil {
		c.metrics.Errors++
	}
	c.metrics.mu.Unlock()

	return err
}

// GetLag returns the current consumer lag
func (c *Consumer) GetLag(ctx context.Context) (int64, error) {
	lag := c.reader.Lag()

	c.metrics.mu.Lock()
	c.metrics.Lag = lag
	c.metrics.mu.Unlock()

	return lag, nil
}

// GetMetrics returns a snapshot of current consumer metrics, copied field by
// field so the embedded RWMutex is not copied (vet copylocks).
func (c *Consumer) GetMetrics() ConsumerMetrics {
	c.metrics.mu.RLock()
	defer c.metrics.mu.RUnlock()
	return ConsumerMetrics{
		MessagesReceived: c.metrics.MessagesReceived,
		BytesReceived:    c.metrics.BytesReceived,
		Errors:           c.metrics.Errors,
		Lag:              c.metrics.Lag,
		ProcessingTimeMs: c.metrics.ProcessingTimeMs,
	}
}

// Close closes the consumer
func (c *Consumer) Close() error {
	return c.reader.Close()
}
```

### Exactly-Once Semantics: Scope, Options, and the Outbox Pattern

First, scope the claim honestly. Kafka's "exactly-once semantics" (EOS) covers exactly-once *within Kafka* - a consume-transform-produce loop where input offsets and output records commit atomically to the same Kafka cluster. It does not cover exactly-once between Kafka and an external database. Nothing in the broker protocol can make a SQL commit and a Kafka append atomic. If your service reads from Kafka, writes to Postgres, and publishes a downstream event, you have a dual-write problem and EOS does not solve it on its own.

For the Go client choice specifically: `confluent-kafka-go` (via `librdkafka`) and `twmb/franz-go` both expose the full transactional producer API (`InitTransactions`, `BeginTransaction`, `SendOffsetsToTransaction`, `CommitTransaction`). `segmentio/kafka-go` does not, which is why the outbox pattern below is the pragmatic default for segmentio-based services - and a fine default even with franz-go, because it generalizes to systems where the source of truth is the database, not Kafka. The outbox writes the event and the business record to the same database in a single SQL transaction, and a relay process (polling, or better, Debezium CDC reading the Postgres WAL) publishes to Kafka. You get atomic write-then-publish without two-phase commit, and consumers handle redelivery through idempotency checks keyed on the event ID. Pair this with Kafka's idempotent producer (`enable.idempotence=true`, on by default in recent brokers) so that producer-side retries do not duplicate within a partition.

```go
// pkg/kafka/transactional.go
package kafka

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// TransactionalProducer provides exactly-once semantics
type TransactionalProducer struct {
	writer        *kafka.Writer
	transactionID string
}

// TransactionalConfig for exactly-once processing
type TransactionalConfig struct {
	Brokers           []string
	TransactionalID   string
	TransactionTimeout time.Duration
}

// NewTransactionalProducer creates a producer with transactional guarantees
func NewTransactionalProducer(config TransactionalConfig) (*TransactionalProducer, error) {
	writer := &kafka.Writer{
		Addr:         kafka.TCP(config.Brokers...),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
		// Note: segmentio/kafka-go does not expose the transactional API.
		// For full Kafka EOS, use twmb/franz-go (pure Go) or confluent-kafka-go (CGO/librdkafka).
		// For cross-system exactly-once (Kafka + DB), prefer the transactional outbox below.
	}

	return &TransactionalProducer{
		writer:        writer,
		transactionID: config.TransactionalID,
	}, nil
}

// Outbox pattern for exactly-once with databases
// This is the recommended approach for Go applications

// OutboxMessage represents a message in the outbox table
type OutboxMessage struct {
	ID          string          `json:"id" db:"id"`
	Topic       string          `json:"topic" db:"topic"`
	Key         string          `json:"key" db:"key"`
	Value       json.RawMessage `json:"value" db:"value"`
	Headers     json.RawMessage `json:"headers" db:"headers"`
	CreatedAt   time.Time       `json:"created_at" db:"created_at"`
	ProcessedAt *time.Time      `json:"processed_at" db:"processed_at"`
}

// OutboxRepository manages the outbox table
type OutboxRepository struct {
	db *sql.DB
}

// NewOutboxRepository creates an outbox repository
func NewOutboxRepository(db *sql.DB) *OutboxRepository {
	return &OutboxRepository{db: db}
}

// CreateTable creates the outbox table
func (r *OutboxRepository) CreateTable(ctx context.Context) error {
	query := `
		CREATE TABLE IF NOT EXISTS outbox (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			topic VARCHAR(255) NOT NULL,
			key VARCHAR(255),
			value JSONB NOT NULL,
			headers JSONB,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			processed_at TIMESTAMP WITH TIME ZONE
		);

		CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
		ON outbox (created_at)
		WHERE processed_at IS NULL;
	`

	_, err := r.db.ExecContext(ctx, query)
	return err
}

// Insert adds a message to the outbox within a transaction
func (r *OutboxRepository) Insert(ctx context.Context, tx *sql.Tx, msg OutboxMessage) error {
	query := `
		INSERT INTO outbox (topic, key, value, headers)
		VALUES ($1, $2, $3, $4)
	`

	_, err := tx.ExecContext(ctx, query,
		msg.Topic,
		msg.Key,
		msg.Value,
		msg.Headers,
	)

	return err
}

// GetUnprocessed claims unprocessed messages. It MUST run inside the
// caller's transaction: FOR UPDATE SKIP LOCKED holds its row locks only for
// the life of the enclosing transaction, so running it on the bare *sql.DB
// releases the locks the moment the SELECT returns and two relay replicas
// would claim and publish the same rows.
func (r *OutboxRepository) GetUnprocessed(ctx context.Context, tx *sql.Tx, limit int) ([]OutboxMessage, error) {
	query := `
		SELECT id, topic, key, value, headers, created_at, processed_at
		FROM outbox
		WHERE processed_at IS NULL
		ORDER BY created_at
		LIMIT $1
		FOR UPDATE SKIP LOCKED
	`

	rows, err := tx.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []OutboxMessage
	for rows.Next() {
		var msg OutboxMessage
		err := rows.Scan(
			&msg.ID,
			&msg.Topic,
			&msg.Key,
			&msg.Value,
			&msg.Headers,
			&msg.CreatedAt,
			&msg.ProcessedAt,
		)
		if err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}

	return messages, rows.Err()
}

// MarkProcessed marks a message as processed inside the same transaction
// that claimed it, so the row lock is still held.
func (r *OutboxRepository) MarkProcessed(ctx context.Context, tx *sql.Tx, id string) error {
	query := `
		UPDATE outbox
		SET processed_at = NOW()
		WHERE id = $1
	`

	_, err := tx.ExecContext(ctx, query, id)
	return err
}

// OutboxProcessor polls and processes outbox messages
type OutboxProcessor struct {
	repo     *OutboxRepository
	producer *Producer
	interval time.Duration
}

// NewOutboxProcessor creates an outbox processor
func NewOutboxProcessor(repo *OutboxRepository, producer *Producer, interval time.Duration) *OutboxProcessor {
	return &OutboxProcessor{
		repo:     repo,
		producer: producer,
		interval: interval,
	}
}

// Start begins processing the outbox
func (p *OutboxProcessor) Start(ctx context.Context) error {
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := p.processOutbox(ctx); err != nil {
				// Log error but continue processing
				fmt.Printf("Outbox processing error: %v\n", err)
			}
		}
	}
}

func (p *OutboxProcessor) processOutbox(ctx context.Context) error {
	// One transaction spans claim, publish, and mark, so the SKIP LOCKED row
	// locks are held for the whole cycle. A crash after publish but before
	// commit re-delivers those events, which is why consumers dedupe on ID.
	tx, err := p.repo.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin outbox tx: %w", err)
	}
	defer tx.Rollback()

	messages, err := p.repo.GetUnprocessed(ctx, tx, 100)
	if err != nil {
		return fmt.Errorf("get unprocessed: %w", err)
	}

	for _, msg := range messages {
		// Produce to Kafka
		var headers map[string]string
		if err := json.Unmarshal(msg.Headers, &headers); err != nil {
			headers = make(map[string]string)
		}

		var value any
		if err := json.Unmarshal(msg.Value, &value); err != nil {
			value = msg.Value
		}

		kafkaMsg := Message{
			Key:     msg.Key,
			Value:   value,
			Headers: headers,
		}

		// Create topic-specific producer or use existing
		if err := p.producer.Send(ctx, kafkaMsg); err != nil {
			return fmt.Errorf("send message %s: %w", msg.ID, err)
		}

		// Mark as processed inside the claiming transaction
		if err := p.repo.MarkProcessed(ctx, tx, msg.ID); err != nil {
			return fmt.Errorf("mark processed %s: %w", msg.ID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbox tx: %w", err)
	}
	return nil
}

// Example: Using outbox pattern in a service
type OrderService struct {
	db     *sql.DB
	outbox *OutboxRepository
}

func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Insert order into database
	orderQuery := `
		INSERT INTO orders (id, customer_id, total, status)
		VALUES ($1, $2, $3, $4)
	`
	_, err = tx.ExecContext(ctx, orderQuery,
		order.ID, order.CustomerID, order.TotalCents, "pending",
	)
	if err != nil {
		return fmt.Errorf("insert order: %w", err)
	}

	// 2. Insert event into outbox (same transaction)
	event := OrderCreatedEvent{
		OrderID:    order.ID,
		CustomerID: order.CustomerID,
		TotalCents: order.TotalCents,
		Items:      order.Items,
		CreatedAt:  time.Now().UTC(),
	}

	eventJSON, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	headers, _ := json.Marshal(map[string]string{
		"event_type": "order.created",
	})

	outboxMsg := OutboxMessage{
		Topic:   "orders",
		Key:     order.ID,
		Value:   eventJSON,
		Headers: headers,
	}

	if err := s.outbox.Insert(ctx, tx, outboxMsg); err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}

	// 3. Commit transaction - both order and outbox message are persisted atomically
	return tx.Commit()
}

type Order struct {
	ID         string
	CustomerID string
	TotalCents int64
	Items      []OrderItem
}

type OrderItem struct {
	ProductID  string
	Quantity   int
	PriceCents int64
}

type OrderCreatedEvent struct {
	OrderID    string      `json:"order_id"`
	CustomerID string      `json:"customer_id"`
	TotalCents int64       `json:"total_cents"`
	Items      []OrderItem `json:"items"`
	CreatedAt  time.Time   `json:"created_at"`
}
```

### Junior → FAANG: Understanding What You Are Actually Configuring

The producer and consumer configuration structs in this section have many fields, and it is tempting to copy the defaults without understanding what they control. Here are the three most consequential settings for a junior engineer to internalize.

`RequiredAcks: kafka.RequireAll` (also written as `acks=all`) means the broker leader waits for all in-sync replicas (ISRs) to confirm the write before acknowledging the producer. With a replication factor of 3 and `min.insync.replicas=2`, you can lose one broker and the write still succeeds. Without this, a broker crash before replication can silently lose messages. Set this to `RequireAll` in any production service that cares about data.

`CommitInterval` in the consumer controls how often the consumer commits its offset back to Kafka. The default in many clients is periodic auto-commit. The code in this section uses explicit manual commit after each successful `processMessage` call, which is the correct approach for at-least-once semantics. If the process crashes between processing a message and committing, the message is redelivered, which is why the handler must be idempotent.

`FOR UPDATE SKIP LOCKED` in the outbox query is critical for multi-instance deployments. Without it, multiple relay process instances race to process the same outbox rows, causing duplicate publishes. `SKIP LOCKED` makes each instance take only the rows not currently locked by another instance, distributing the work without collisions.

**Client selection checklist for a first job.** When your team asks you to pick a Kafka Go client, ask three questions: do we need the full Kafka transactional API (if yes, use `franz-go` or `confluent-kafka-go`), do we have a CGO constraint in our build (distroless containers, cross-compilation, static binaries all require pure Go, so use `franz-go` or `segmentio/kafka-go`), and does the team value API readability over raw throughput (if yes, `segmentio/kafka-go` is the most idiomatic). Document the answer in the repo's ADR directory.

**Interview habit.** When you describe a Kafka integration in an interview, mention whether you used manual or automatic offset commit and explain why. This single detail signals that you understand the at-least-once vs at-most-once tradeoff at the protocol level.

### Senior @ FAANG: Kafka Client Selection and Operational Excellence

The section introduction gives accurate client guidance for 2026. Here is the deeper analysis a staff engineer needs for an architecture decision.

**`twmb/franz-go` as the modern default.** The performance gap between franz-go and segmentio/kafka-go is real and measurable: benchmarks consistently show 2x or more on producer throughput and similar gains on the consumer path. For a service that produces 50,000 messages per second this gap matters. For a service that produces 500 messages per second it does not. The more important reason to prefer franz-go in 2026 is feature completeness: it has the full transactional API, incremental cooperative rebalancing, sticky partition assignment, and support for Kafka 4.x protocol features without CGO. segmentio/kafka-go lacks the transactional API, which means any service using it must use the outbox pattern for cross-system atomicity regardless of whether Kafka EOS would otherwise have been sufficient.

**The outbox vs Kafka EOS decision.** Kafka's exactly-once semantics (EOS) are correct for a specific topology: a Kafka consumer reads events, transforms them, and writes the results back to Kafka. This consume-transform-produce loop can be made atomic using the transactional API. It does not apply when the consumer also writes to a database, because there is no protocol-level coordination between Kafka and Postgres. For any service that reads from Kafka and writes to a database, the outbox is the right answer regardless of which Kafka client you use. Document this constraint in the team's event-driven system design guide so that engineers do not waste time trying to configure Kafka EOS to solve a problem it cannot solve.

**Debezium CDC vs application polling for outbox draining.** The `OutboxProcessor` in this section polls the outbox table on a timer. This is correct for getting started, but it has two weaknesses at production scale: polling introduces latency proportional to the poll interval (100ms in the example), and polling at high frequency generates database load even when the outbox is empty. Debezium with the Postgres logical replication WAL eliminates both: it receives row changes in real time from the Postgres WAL stream, with sub-millisecond latency and zero polling overhead. The operational cost is a Debezium connector deployment, which is significant but justified at volumes above roughly 10,000 messages per second or when sub-second delivery latency is a requirement.

**Partition sizing and the hot partition problem.** Partitioning by `msg.Key` with a `Hash` balancer distributes messages across partitions based on key hash. This is correct for most cases, but it creates a hot partition problem when one key drives a disproportionate fraction of traffic (a viral product, a celebrity user, a high-frequency trading account). A hot partition saturates the single consumer assigned to it while other partitions are idle. Mitigations include: adding a random suffix to the partition key for topics where per-key ordering is not required, pre-partitioning large producers into multiple sub-topics, or using sticky partitioning with a max-bytes cap. The right mitigation depends on whether the consumer requires strict per-key ordering, which should be a documented requirement for each topic.

**Consumer group rebalance during deployment.** Every rolling Kubernetes deployment causes Kafka consumer group rebalances as pods restart one by one. Each rebalance pauses all consumers in the group for the duration of the rebalance. With the default range or round-robin assignment strategy, this pause can be 30 seconds or more for large partition counts. Incremental cooperative rebalancing (available in franz-go natively and in sarama via `NewBalanceStrategyCooperativeSticky`) avoids the full stop-the-world pause by transferring partitions incrementally. Setting this as the default strategy for all consumer groups is a staff-level platform configuration that reduces deployment impact significantly.

---
