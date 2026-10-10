## 49.3 RabbitMQ Implementation

### RabbitMQ Connection and Channel Management

The canonical Go client for RabbitMQ is `github.com/rabbitmq/amqp091-go`, the official fork maintained by the RabbitMQ core team of Sean Treadway's original `streadway/amqp` (which is deprecated and no longer accepts changes). If you are still on `streadway/amqp` in 2026, the migration is a package-path swap plus reviewing any deprecated call sites - the API surface is largely compatible. For applications that want higher-level reconnect and declarative topology on top, `wagslane/go-rabbitmq` wraps `amqp091-go` with sane defaults, but the examples here use `amqp091-go` directly so the underlying protocol is visible.

RabbitMQ connection management in Go requires explicit reconnect logic because the `amqp` library does not retry broken TCP connections automatically. The `Connection` wrapper here monitors the `NotifyClose` channel in a background goroutine and re-dials with exponential backoff, then recreates channels on the new connection so producers and consumers can resume without restarting the process. Separating connection management from channel creation allows multiple publishers and consumers to share one AMQP connection while keeping channel-level errors isolated.

```go
// pkg/rabbitmq/connection.go
package rabbitmq

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ConnectionConfig holds RabbitMQ connection configuration
type ConnectionConfig struct {
	URL              string
	Heartbeat        time.Duration
	ReconnectDelay   time.Duration
	MaxReconnects    int
	PrefetchCount    int
	PrefetchGlobal   bool
}

// DefaultConnectionConfig returns sensible defaults
func DefaultConnectionConfig(url string) ConnectionConfig {
	return ConnectionConfig{
		URL:            url,
		Heartbeat:      10 * time.Second,
		ReconnectDelay: 5 * time.Second,
		MaxReconnects:  10,
		PrefetchCount:  10,
		PrefetchGlobal: false,
	}
}

// Connection manages RabbitMQ connection with automatic reconnection
type Connection struct {
	config     ConnectionConfig
	conn       *amqp.Connection
	channel    *amqp.Channel
	logger     *slog.Logger

	mu         sync.RWMutex
	connected  bool
	closeChan  chan struct{}

	onReconnect []func()
}

// NewConnection creates a new managed RabbitMQ connection
func NewConnection(config ConnectionConfig, logger *slog.Logger) (*Connection, error) {
	c := &Connection{
		config:    config,
		logger:    logger,
		closeChan: make(chan struct{}),
	}

	if err := c.connect(); err != nil {
		return nil, err
	}

	go c.handleReconnection()

	return c, nil
}

func (c *Connection) connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	conn, err := amqp.DialConfig(c.config.URL, amqp.Config{
		Heartbeat: c.config.Heartbeat,
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}

	channel, err := conn.Channel()
	if err != nil {
		conn.Close()
		return fmt.Errorf("channel: %w", err)
	}

	// Set QoS
	err = channel.Qos(
		c.config.PrefetchCount,
		0,
		c.config.PrefetchGlobal,
	)
	if err != nil {
		channel.Close()
		conn.Close()
		return fmt.Errorf("qos: %w", err)
	}

	c.conn = conn
	c.channel = channel
	c.connected = true

	c.logger.Info("Connected to RabbitMQ")

	return nil
}

func (c *Connection) handleReconnection() {
	for {
		select {
		case <-c.closeChan:
			return
		default:
		}

		c.mu.RLock()
		if c.conn == nil {
			c.mu.RUnlock()
			time.Sleep(c.config.ReconnectDelay)
			continue
		}

		notifyClose := c.conn.NotifyClose(make(chan *amqp.Error, 1))
		c.mu.RUnlock()

		select {
		case <-c.closeChan:
			return
		case err := <-notifyClose:
			c.logger.Warn("Connection closed", "error", err)
			c.mu.Lock()
			c.connected = false
			c.mu.Unlock()

			// Attempt reconnection
			for i := 0; i < c.config.MaxReconnects; i++ {
				c.logger.Info("Attempting reconnection",
					"attempt", i+1,
					"max", c.config.MaxReconnects,
				)

				time.Sleep(c.config.ReconnectDelay)

				if err := c.connect(); err != nil {
					c.logger.Error("Reconnection failed", "error", err)
					continue
				}

				// Notify reconnection handlers
				for _, handler := range c.onReconnect {
					handler()
				}

				break
			}
		}
	}
}

// OnReconnect registers a callback for reconnection events
func (c *Connection) OnReconnect(handler func()) {
	c.onReconnect = append(c.onReconnect, handler)
}

// Channel returns the current channel
func (c *Connection) Channel() (*amqp.Channel, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if !c.connected {
		return nil, fmt.Errorf("not connected")
	}

	return c.channel, nil
}

// IsConnected returns connection status
func (c *Connection) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// Close closes the connection
func (c *Connection) Close() error {
	close(c.closeChan)

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.channel != nil {
		c.channel.Close()
	}

	if c.conn != nil {
		return c.conn.Close()
	}

	return nil
}
```

### RabbitMQ Publisher

The RabbitMQ publisher declares both the exchange and queue with `durable: true` so topology survives broker restarts without requiring manual recreation. Publishing with `amqp.Persistent` delivery mode instructs RabbitMQ to write the message to disk before acknowledging, protecting against message loss during broker failover. A per-publish correlation ID enables the caller to match asynchronous acknowledgments back to specific messages when using publisher confirms for guaranteed delivery.

```go
// pkg/rabbitmq/publisher.go
package rabbitmq

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// PublisherConfig holds publisher configuration
type PublisherConfig struct {
	Exchange     string
	ExchangeType string // direct, topic, fanout, headers
	RoutingKey   string
	Mandatory    bool
	Immediate    bool // NOTE: Removed in RabbitMQ 3.0+; set to false
	Persistent   bool
}

// Publisher publishes messages to RabbitMQ
type Publisher struct {
	conn   *Connection
	config PublisherConfig
	tracer trace.Tracer
}

// NewPublisher creates a new publisher
func NewPublisher(conn *Connection, config PublisherConfig) (*Publisher, error) {
	channel, err := conn.Channel()
	if err != nil {
		return nil, err
	}

	// Declare exchange
	err = channel.ExchangeDeclare(
		config.Exchange,
		config.ExchangeType,
		true,  // durable
		false, // auto-deleted
		false, // internal
		false, // no-wait
		nil,   // arguments
	)
	if err != nil {
		return nil, fmt.Errorf("exchange declare: %w", err)
	}

	return &Publisher{
		conn:   conn,
		config: config,
		tracer: otel.Tracer("rabbitmq-publisher"),
	}, nil
}

// PublishMessage represents a message to publish
type PublishMessage struct {
	Body        any
	RoutingKey  string
	Headers     map[string]any
	ContentType string
	MessageID   string
	Timestamp   time.Time
	Expiration  string
	Priority    uint8
}

// Publish sends a message
func (p *Publisher) Publish(ctx context.Context, msg PublishMessage) error {
	ctx, span := p.tracer.Start(ctx, "rabbitmq.publish",
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination", p.config.Exchange),
			attribute.String("messaging.rabbitmq.routing_key", msg.RoutingKey),
		),
	)
	defer span.End()

	channel, err := p.conn.Channel()
	if err != nil {
		span.RecordError(err)
		return err
	}

	body, err := json.Marshal(msg.Body)
	if err != nil {
		span.RecordError(err)
		return fmt.Errorf("marshal body: %w", err)
	}

	routingKey := msg.RoutingKey
	if routingKey == "" {
		routingKey = p.config.RoutingKey
	}

	contentType := msg.ContentType
	if contentType == "" {
		contentType = "application/json"
	}

	deliveryMode := amqp.Transient
	if p.config.Persistent {
		deliveryMode = amqp.Persistent
	}

	timestamp := msg.Timestamp
	if timestamp.IsZero() {
		timestamp = time.Now().UTC()
	}

	// Add trace context to headers
	if msg.Headers == nil {
		msg.Headers = make(map[string]any)
	}
	msg.Headers["trace_id"] = span.SpanContext().TraceID().String()
	msg.Headers["span_id"] = span.SpanContext().SpanID().String()

	publishing := amqp.Publishing{
		Headers:      amqp.Table(msg.Headers),
		ContentType:  contentType,
		DeliveryMode: deliveryMode,
		MessageId:    msg.MessageID,
		Timestamp:    timestamp,
		Body:         body,
	}

	if msg.Expiration != "" {
		publishing.Expiration = msg.Expiration
	}

	if msg.Priority > 0 {
		publishing.Priority = msg.Priority
	}

	return channel.PublishWithContext(
		ctx,
		p.config.Exchange,
		routingKey,
		p.config.Mandatory,
		p.config.Immediate,
		publishing,
	)
}

// PublishWithConfirm publishes with publisher confirms
func (p *Publisher) PublishWithConfirm(ctx context.Context, msg PublishMessage) error {
	channel, err := p.conn.Channel()
	if err != nil {
		return err
	}

	// Enable publisher confirms
	if err := channel.Confirm(false); err != nil {
		return fmt.Errorf("confirm mode: %w", err)
	}

	confirms := channel.NotifyPublish(make(chan amqp.Confirmation, 1))

	if err := p.Publish(ctx, msg); err != nil {
		return err
	}

	// Wait for confirmation
	select {
	case <-ctx.Done():
		return ctx.Err()
	case confirm := <-confirms:
		if !confirm.Ack {
			return fmt.Errorf("message not confirmed")
		}
		return nil
	}
}
```

### RabbitMQ Consumer

The RabbitMQ consumer sets `prefetch: 1` via `Qos` so RabbitMQ delivers at most one unacknowledged message per Go goroutine, preventing a slow handler from causing unbounded memory growth from buffered deliveries. Messages are acknowledged only after the handler returns successfully. On error the message is negatively acknowledged with `requeue: false` so it routes to the dead-letter exchange rather than re-entering the original queue in an infinite loop. A separate goroutine monitors context cancellation to trigger channel closure and stop the delivery loop cleanly.

```go
// pkg/rabbitmq/consumer.go
package rabbitmq

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ConsumerConfig holds consumer configuration
type ConsumerConfig struct {
	Queue         string
	Exchange      string
	RoutingKey    string
	ConsumerTag   string
	AutoAck       bool
	Exclusive     bool
	NoLocal       bool
	NoWait        bool
	PrefetchCount int

	// Queue configuration
	QueueDurable    bool
	QueueAutoDelete bool
	QueueExclusive  bool

	// Dead letter configuration
	DeadLetterExchange   string
	DeadLetterRoutingKey string
	MessageTTL           time.Duration
	MaxRetries           int
}

// DefaultConsumerConfig returns sensible defaults
func DefaultConsumerConfig(queue, exchange, routingKey string) ConsumerConfig {
	return ConsumerConfig{
		Queue:              queue,
		Exchange:           exchange,
		RoutingKey:         routingKey,
		ConsumerTag:        "",
		AutoAck:            false,
		Exclusive:          false,
		NoLocal:            false,
		NoWait:             false,
		PrefetchCount:      10,
		QueueDurable:       true,
		QueueAutoDelete:    false,
		QueueExclusive:     false,
		DeadLetterExchange: fmt.Sprintf("%s.dlx", exchange),
		MaxRetries:         3,
	}
}

// Consumer consumes messages from RabbitMQ
type Consumer struct {
	conn    *Connection
	config  ConsumerConfig
	logger  *slog.Logger
	tracer  trace.Tracer
	handler MessageHandlerFunc
}

// MessageHandlerFunc processes consumed messages
type MessageHandlerFunc func(ctx context.Context, msg *Delivery) error

// Delivery represents a consumed message
type Delivery struct {
	amqp.Delivery
	RetryCount int
}

// DecodeBody unmarshals the message body
func (d *Delivery) DecodeBody(target any) error {
	return json.Unmarshal(d.Body, target)
}

// NewConsumer creates a new consumer
func NewConsumer(conn *Connection, config ConsumerConfig, logger *slog.Logger) (*Consumer, error) {
	return &Consumer{
		conn:   conn,
		config: config,
		logger: logger,
		tracer: otel.Tracer("rabbitmq-consumer"),
	}, nil
}

// SetHandler sets the message handler
func (c *Consumer) SetHandler(handler MessageHandlerFunc) {
	c.handler = handler
}

// Start begins consuming messages
func (c *Consumer) Start(ctx context.Context) error {
	channel, err := c.conn.Channel()
	if err != nil {
		return err
	}

	// Set prefetch
	if err := channel.Qos(c.config.PrefetchCount, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	// Setup dead letter exchange
	if c.config.DeadLetterExchange != "" {
		if err := c.setupDeadLetter(channel); err != nil {
			return fmt.Errorf("setup dead letter: %w", err)
		}
	}

	// Declare queue
	args := amqp.Table{}
	if c.config.DeadLetterExchange != "" {
		args["x-dead-letter-exchange"] = c.config.DeadLetterExchange
		if c.config.DeadLetterRoutingKey != "" {
			args["x-dead-letter-routing-key"] = c.config.DeadLetterRoutingKey
		}
	}
	if c.config.MessageTTL > 0 {
		args["x-message-ttl"] = int64(c.config.MessageTTL.Milliseconds())
	}

	queue, err := channel.QueueDeclare(
		c.config.Queue,
		c.config.QueueDurable,
		c.config.QueueAutoDelete,
		c.config.QueueExclusive,
		c.config.NoWait,
		args,
	)
	if err != nil {
		return fmt.Errorf("queue declare: %w", err)
	}

	// Bind queue to exchange
	if c.config.Exchange != "" {
		err = channel.QueueBind(
			queue.Name,
			c.config.RoutingKey,
			c.config.Exchange,
			c.config.NoWait,
			nil,
		)
		if err != nil {
			return fmt.Errorf("queue bind: %w", err)
		}
	}

	// Start consuming
	deliveries, err := channel.Consume(
		queue.Name,
		c.config.ConsumerTag,
		c.config.AutoAck,
		c.config.Exclusive,
		c.config.NoLocal,
		c.config.NoWait,
		nil,
	)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	c.logger.Info("Started consuming",
		"queue", queue.Name,
		"exchange", c.config.Exchange,
		"routing_key", c.config.RoutingKey,
	)

	// Handle reconnection
	c.conn.OnReconnect(func() {
		c.logger.Info("Re-establishing consumer after reconnection")
		go c.Start(ctx)
	})

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				c.logger.Warn("Delivery channel closed")
				return nil
			}

			if err := c.processDelivery(ctx, d); err != nil {
				c.logger.Error("Failed to process delivery",
					"error", err,
					"message_id", d.MessageId,
				)
			}
		}
	}
}

func (c *Consumer) processDelivery(ctx context.Context, d amqp.Delivery) error {
	// Extract trace context
	var traceID string
	if tid, ok := d.Headers["trace_id"]; ok {
		traceID = fmt.Sprintf("%v", tid)
	}

	ctx, span := c.tracer.Start(ctx, "rabbitmq.consume",
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination", c.config.Queue),
			attribute.String("messaging.message_id", d.MessageId),
			attribute.String("trace.parent_id", traceID),
		),
	)
	defer span.End()

	// Get retry count
	retryCount := 0
	if xDeath, ok := d.Headers["x-death"].([]any); ok && len(xDeath) > 0 {
		if first, ok := xDeath[0].(amqp.Table); ok {
			if count, ok := first["count"].(int64); ok {
				retryCount = int(count)
			}
		}
	}

	delivery := &Delivery{
		Delivery:   d,
		RetryCount: retryCount,
	}

	if c.handler == nil {
		return d.Ack(false)
	}

	err := c.handler(ctx, delivery)
	if err != nil {
		span.RecordError(err)

		// Check if we should retry
		if retryCount < c.config.MaxRetries {
			// Requeue for retry
			return d.Nack(false, false)
		}

		// Send to dead letter queue
		c.logger.Warn("Max retries exceeded, sending to DLQ",
			"message_id", d.MessageId,
			"retries", retryCount,
		)
		return d.Reject(false)
	}

	return d.Ack(false)
}

func (c *Consumer) setupDeadLetter(channel *amqp.Channel) error {
	// Declare dead letter exchange
	err := channel.ExchangeDeclare(
		c.config.DeadLetterExchange,
		"direct",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		return fmt.Errorf("dlx exchange declare: %w", err)
	}

	// Declare dead letter queue
	dlqName := fmt.Sprintf("%s.dlq", c.config.Queue)
	_, err = channel.QueueDeclare(
		dlqName,
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		return fmt.Errorf("dlq declare: %w", err)
	}

	// Bind DLQ
	routingKey := c.config.DeadLetterRoutingKey
	if routingKey == "" {
		routingKey = c.config.Queue
	}

	err = channel.QueueBind(
		dlqName,
		routingKey,
		c.config.DeadLetterExchange,
		false,
		nil,
	)
	if err != nil {
		return fmt.Errorf("dlq bind: %w", err)
	}

	return nil
}
```

### Junior → FAANG: Understanding RabbitMQ's Primitives Before Writing Code

RabbitMQ's mental model is different from Kafka's in a way that trips up almost every engineer who encounters it after Kafka. In Kafka, producers write to topics and consumers read from topics. In RabbitMQ, producers write to exchanges, exchanges route to queues based on binding rules, and consumers read from queues. Queues are the persistence unit, not topics.

This distinction matters because the routing configuration lives in the exchange-to-queue binding, not in the producer or the consumer. The topology diagram for your system is defined by exchange type plus routing key plus binding key. Understanding the four exchange types is mandatory before writing any production code.

Direct exchange: a message with routing key "order.created" is delivered to queues bound with exactly the key "order.created". One routing key, one queue (or multiple queues if multiple consumers bind the same key).

Topic exchange: routing keys use dot-separated segments, and bindings can use wildcards. `order.*` matches `order.created` and `order.shipped` but not `order.line.added`. `order.#` matches any key starting with `order.`. This is the most flexible and most commonly used exchange type.

Fanout exchange: routes every message to every bound queue regardless of routing key. Use for broadcasting events where all consumers need every message.

Headers exchange: routes based on AMQP message headers rather than routing keys. Rarely used in practice because topic exchanges are usually sufficient.

**The dead-letter exchange pattern.** The consumer in this section sets `x-dead-letter-exchange` on the queue. When a message is negatively acknowledged with `requeue: false`, RabbitMQ routes it to the configured DLX rather than discarding it. This is how you implement bounded retry without building retry logic into the consumer: the DLQ accumulates failed messages for investigation, and a separate process requeues them manually or automatically after a delay. Always configure a DLX in production. Without it, rejected messages are silently dropped.

**Interview entry point.** When explaining RabbitMQ in an interview, draw the exchange-queue-binding topology before discussing code. Showing that you think in terms of routing topology rather than just "send message to queue" signals that you understand the broker's design philosophy.

### Senior @ FAANG: RabbitMQ in a Production Microservices Platform

RabbitMQ occupies a specific niche in the 2026 messaging landscape that is worth articulating precisely. It is the right choice for task queues with complex routing, delayed retries, priority queues, and per-message TTL. It is a poor choice for event replay, long-term event history, high-throughput streaming, or multi-datacenter event replication. Knowing this niche prevents both "use RabbitMQ for everything" and "use Kafka for everything" failure modes.

**Connection management at scale.** The `Connection` wrapper in this section implements reconnect with exponential backoff, which is correct. At production scale there are two additional concerns. First, AMQP connections should be shared across channels: one TCP connection can host many logical channels, so a service should open one connection and create channels per goroutine, not one connection per goroutine. The connection pool size should match the number of concurrent publishers and consumers, not the total goroutine count. Second, connection state should be exposed as a health check endpoint. If RabbitMQ is unavailable, the service's readiness probe should fail so Kubernetes stops routing traffic to it rather than silently queuing requests.

**Publisher confirms and guarantees.** The `PublishWithConfirm` method uses the AMQP publisher confirms protocol (`channel.Confirm`), which is the RabbitMQ equivalent of Kafka's `RequireAll` acknowledgment. Without publisher confirms, the broker may accept the message from the network buffer but fail to persist it if the broker crashes before writing to disk. In production, all persistent message publishing should use publisher confirms. The performance cost is real (one round-trip per message or per batch), but the alternative is silent message loss during broker restarts.

**Topology-as-code.** In a microservices platform, RabbitMQ topology (exchanges, queues, bindings, DLX configurations) should be declared in code and applied idempotently at service startup, as the consumer does in this section. The alternative, manually creating topology in the RabbitMQ management UI, is not reproducible and creates configuration drift. For platform teams managing hundreds of queues, consider using the RabbitMQ Topology Operator for Kubernetes, which manages topology declaratively via custom resources and integrates with GitOps workflows.

**Quorum queues over classic queues.** Since RabbitMQ 3.8, quorum queues are the recommended durable queue type for production workloads. Unlike classic mirrored queues, quorum queues use the Raft consensus protocol for replication, which provides better failure detection and avoids the "chasing queues" problem where a resyncing mirror can fall arbitrarily far behind. If your team is still using classic mirrored queues in 2026, migrating to quorum queues is a meaningful reliability improvement. The API is the same from the consumer's perspective: set the `x-queue-type: quorum` argument in `QueueDeclare`.

**Flow control and backpressure.** The `PrefetchCount` in the consumer configuration controls how many unacknowledged messages RabbitMQ delivers to the consumer at once. Setting this too high causes the consumer to buffer messages in memory faster than it can process them, risking OOM on large payloads or slow handlers. Setting it too low throttles throughput unnecessarily. The correct value is the product of your desired concurrency level and your processing time, tuned empirically under production load. A platform team should publish a per-service prefetch recommendation based on handler latency P99 and message size, rather than letting each team guess.

---
