## 49.4 NATS Implementation

NATS has two layers that are frequently confused: **core NATS** (fire-and-forget pub/sub, at-most-once, zero persistence, microsecond latency) and **JetStream** (persistent streams, at-least-once delivery, consumer acks, replay from any point in time, and a built-in key-value and object store). Core NATS is for telemetry, request/reply RPC, and ephemeral fan-out where loss is acceptable. JetStream is what you reach for when you would otherwise deploy Kafka but do not need multi-MB messages or long-tail retention measured in weeks - it gives you durable subjects, stream replication across a NATS cluster, and exactly-once publish via message deduplication windows, with a single static binary to operate. Both layers share the same `nats-io/nats.go` client and the same subject-based addressing, so you can start with core pub/sub and promote hot subjects to JetStream streams without rewriting publishers.

### NATS Core Pub/Sub

NATS core pub/sub is the lowest-latency option in this chapter. Messages are delivered in microseconds but are not persisted, so a consumer that is offline when a message arrives will miss it permanently - which is exactly the point for ephemeral traffic, and exactly why persistent workloads should use JetStream instead. The Go client connects with `nats.MaxReconnects` and `nats.ReconnectWait` options so the library retries the connection automatically after network interruptions without any application-layer retry logic. Subject-based routing using dot-separated hierarchies (`order.created`, `order.shipped`) lets consumers use wildcard subscriptions to receive related event families from a single `Subscribe` call.

```go
// pkg/nats/client.go
package nats

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ClientConfig holds NATS client configuration
type ClientConfig struct {
	URL              string
	Name             string
	MaxReconnects    int
	ReconnectWait    time.Duration
	PingInterval     time.Duration
	MaxPingsOut      int
	DrainTimeout     time.Duration
}

// DefaultClientConfig returns sensible defaults
func DefaultClientConfig(url, name string) ClientConfig {
	return ClientConfig{
		URL:           url,
		Name:          name,
		MaxReconnects: 10,
		ReconnectWait: 2 * time.Second,
		PingInterval:  2 * time.Minute,
		MaxPingsOut:   2,
		DrainTimeout:  30 * time.Second,
	}
}

// Client wraps NATS connection with additional features
type Client struct {
	conn   *nats.Conn
	config ClientConfig
	logger *slog.Logger
	tracer trace.Tracer
}

// NewClient creates a new NATS client
func NewClient(config ClientConfig, logger *slog.Logger) (*Client, error) {
	opts := []nats.Option{
		nats.Name(config.Name),
		nats.MaxReconnects(config.MaxReconnects),
		nats.ReconnectWait(config.ReconnectWait),
		nats.PingInterval(config.PingInterval),
		nats.MaxPingsOutstanding(config.MaxPingsOut),
		nats.DrainTimeout(config.DrainTimeout),
		nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
			logger.Warn("NATS disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Info("NATS reconnected", "url", nc.ConnectedUrl())
		}),
		nats.ClosedHandler(func(nc *nats.Conn) {
			logger.Info("NATS connection closed")
		}),
	}

	conn, err := nats.Connect(config.URL, opts...)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	return &Client{
		conn:   conn,
		config: config,
		logger: logger,
		tracer: otel.Tracer("nats-client"),
	}, nil
}

// Publish sends a message to a subject
func (c *Client) Publish(ctx context.Context, subject string, data any) error {
	ctx, span := c.tracer.Start(ctx, "nats.publish",
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination", subject),
		),
	)
	defer span.End()

	payload, err := json.Marshal(data)
	if err != nil {
		span.RecordError(err)
		return fmt.Errorf("marshal: %w", err)
	}

	// Create message with headers (NATS 2.2+)
	msg := nats.NewMsg(subject)
	msg.Data = payload
	msg.Header.Set("trace_id", span.SpanContext().TraceID().String())
	msg.Header.Set("span_id", span.SpanContext().SpanID().String())
	msg.Header.Set("timestamp", time.Now().UTC().Format(time.RFC3339Nano))

	return c.conn.PublishMsg(msg)
}

// Request performs a request-reply operation
func (c *Client) Request(ctx context.Context, subject string, data any) (*nats.Msg, error) {
	ctx, span := c.tracer.Start(ctx, "nats.request",
		trace.WithAttributes(
			attribute.String("messaging.system", "nats"),
			attribute.String("messaging.destination", subject),
		),
	)
	defer span.End()

	payload, err := json.Marshal(data)
	if err != nil {
		span.RecordError(err)
		return nil, fmt.Errorf("marshal: %w", err)
	}

	msg := nats.NewMsg(subject)
	msg.Data = payload
	msg.Header.Set("trace_id", span.SpanContext().TraceID().String())

	// Get timeout from context or default
	timeout := 5 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
	}

	reply, err := c.conn.RequestMsg(msg, timeout)
	if err != nil {
		span.RecordError(err)
		return nil, err
	}

	return reply, nil
}

// Subscribe creates a subscription to a subject
func (c *Client) Subscribe(subject string, handler nats.MsgHandler) (*nats.Subscription, error) {
	return c.conn.Subscribe(subject, handler)
}

// QueueSubscribe creates a queue subscription
func (c *Client) QueueSubscribe(subject, queue string, handler nats.MsgHandler) (*nats.Subscription, error) {
	return c.conn.QueueSubscribe(subject, queue, handler)
}

// Drain gracefully drains the connection
func (c *Client) Drain() error {
	return c.conn.Drain()
}

// Close closes the connection
func (c *Client) Close() {
	c.conn.Close()
}
```

### NATS JetStream for Persistence

NATS JetStream adds durability on top of core pub/sub: messages are written to a stream with configurable retention and replay policies, so a consumer that restarts can resume from its last acknowledged sequence number. The Go client creates a push-based consumer with a durable name so that the server tracks acknowledgment state across reconnects, and `MaxDeliver` limits redelivery attempts to avoid poison-pill messages blocking the queue indefinitely. Unlike Kafka partitions, JetStream consumers are ephemeral by default. Specifying `Durable` makes the server persist the consumer position between Go process restarts.

```go
// pkg/nats/jetstream.go
package nats

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// JetStreamConfig holds JetStream configuration
type JetStreamConfig struct {
	StreamName    string
	Subjects      []string
	MaxMsgs       int64
	MaxBytes      int64
	MaxAge        time.Duration
	Storage       jetstream.StorageType
	Replicas      int
	Retention     jetstream.RetentionPolicy
	Discard       jetstream.DiscardPolicy
	MaxConsumers  int
}

// DefaultJetStreamConfig returns sensible defaults
func DefaultJetStreamConfig(streamName string, subjects []string) JetStreamConfig {
	return JetStreamConfig{
		StreamName:   streamName,
		Subjects:     subjects,
		MaxMsgs:      -1,            // Unlimited
		MaxBytes:     -1,            // Unlimited
		MaxAge:       24 * time.Hour,
		Storage:      jetstream.FileStorage,
		Replicas:     1,
		Retention:    jetstream.LimitsPolicy,
		Discard:      jetstream.DiscardOld,
		MaxConsumers: -1,
	}
}

// JetStreamClient provides JetStream functionality
type JetStreamClient struct {
	client *Client
	js     jetstream.JetStream
	logger *slog.Logger
	tracer trace.Tracer
}

// NewJetStreamClient creates a JetStream client
func NewJetStreamClient(client *Client, logger *slog.Logger) (*JetStreamClient, error) {
	js, err := jetstream.New(client.conn)
	if err != nil {
		return nil, fmt.Errorf("jetstream: %w", err)
	}

	return &JetStreamClient{
		client: client,
		js:     js,
		logger: logger,
		tracer: otel.Tracer("jetstream-client"),
	}, nil
}

// CreateStream creates or updates a stream
func (c *JetStreamClient) CreateStream(ctx context.Context, config JetStreamConfig) (jetstream.Stream, error) {
	streamConfig := jetstream.StreamConfig{
		Name:         config.StreamName,
		Subjects:     config.Subjects,
		MaxMsgs:      config.MaxMsgs,
		MaxBytes:     config.MaxBytes,
		MaxAge:       config.MaxAge,
		Storage:      config.Storage,
		Replicas:     config.Replicas,
		Retention:    config.Retention,
		Discard:      config.Discard,
		MaxConsumers: config.MaxConsumers,
	}

	stream, err := c.js.CreateOrUpdateStream(ctx, streamConfig)
	if err != nil {
		return nil, fmt.Errorf("create stream: %w", err)
	}

	c.logger.Info("Stream created/updated",
		"name", config.StreamName,
		"subjects", config.Subjects,
	)

	return stream, nil
}

// Publish publishes a message to JetStream
func (c *JetStreamClient) Publish(ctx context.Context, subject string, data any) (*jetstream.PubAck, error) {
	ctx, span := c.tracer.Start(ctx, "jetstream.publish",
		trace.WithAttributes(
			attribute.String("messaging.system", "nats-jetstream"),
			attribute.String("messaging.destination", subject),
		),
	)
	defer span.End()

	payload, err := json.Marshal(data)
	if err != nil {
		span.RecordError(err)
		return nil, fmt.Errorf("marshal: %w", err)
	}

	msg := nats.NewMsg(subject)
	msg.Data = payload
	msg.Header.Set("trace_id", span.SpanContext().TraceID().String())
	msg.Header.Set("timestamp", time.Now().UTC().Format(time.RFC3339Nano))

	ack, err := c.js.PublishMsg(ctx, msg)
	if err != nil {
		span.RecordError(err)
		return nil, fmt.Errorf("publish: %w", err)
	}

	span.SetAttributes(
		attribute.Int64("messaging.jetstream.sequence", int64(ack.Sequence)),
	)

	return ack, nil
}

// ConsumerConfig holds consumer configuration
type ConsumerConfig struct {
	Name          string
	Durable       string
	FilterSubject string
	DeliverPolicy jetstream.DeliverPolicy
	AckPolicy     jetstream.AckPolicy
	AckWait       time.Duration
	MaxDeliver    int
	MaxAckPending int
	ReplayPolicy  jetstream.ReplayPolicy
}

// DefaultConsumerConfig returns sensible defaults
func DefaultConsumerConfig(name, filterSubject string) ConsumerConfig {
	return ConsumerConfig{
		Name:          name,
		Durable:       name,
		FilterSubject: filterSubject,
		DeliverPolicy: jetstream.DeliverAllPolicy,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxDeliver:    5,
		MaxAckPending: 1000,
		ReplayPolicy:  jetstream.ReplayInstantPolicy,
	}
}

// CreateConsumer creates a durable consumer
func (c *JetStreamClient) CreateConsumer(ctx context.Context, streamName string, config ConsumerConfig) (jetstream.Consumer, error) {
	stream, err := c.js.Stream(ctx, streamName)
	if err != nil {
		return nil, fmt.Errorf("get stream: %w", err)
	}

	consumerConfig := jetstream.ConsumerConfig{
		Name:          config.Name,
		Durable:       config.Durable,
		FilterSubject: config.FilterSubject,
		DeliverPolicy: config.DeliverPolicy,
		AckPolicy:     config.AckPolicy,
		AckWait:       config.AckWait,
		MaxDeliver:    config.MaxDeliver,
		MaxAckPending: config.MaxAckPending,
		ReplayPolicy:  config.ReplayPolicy,
	}

	consumer, err := stream.CreateOrUpdateConsumer(ctx, consumerConfig)
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}

	c.logger.Info("Consumer created/updated",
		"name", config.Name,
		"stream", streamName,
		"filter", config.FilterSubject,
	)

	return consumer, nil
}

// ConsumeHandler processes JetStream messages
type ConsumeHandler func(ctx context.Context, msg jetstream.Msg) error

// Consume starts consuming messages
func (c *JetStreamClient) Consume(ctx context.Context, consumer jetstream.Consumer, handler ConsumeHandler) error {
	cons, err := consumer.Consume(func(msg jetstream.Msg) {
		msgCtx := ctx

		// Extract trace context
		traceID := msg.Headers().Get("trace_id")

		msgCtx, span := c.tracer.Start(msgCtx, "jetstream.consume",
			trace.WithAttributes(
				attribute.String("messaging.system", "nats-jetstream"),
				attribute.String("messaging.destination", msg.Subject()),
				attribute.String("trace.parent_id", traceID),
			),
		)
		defer span.End()

		if err := handler(msgCtx, msg); err != nil {
			span.RecordError(err)
			c.logger.Error("Failed to process message",
				"error", err,
				"subject", msg.Subject(),
			)

			// NAK for redelivery
			metadata, _ := msg.Metadata()
			if metadata != nil && int(metadata.NumDelivered) >= 5 {
				// Max retries reached, term the message
				msg.Term()
				return
			}

			msg.Nak()
			return
		}

		msg.Ack()
	})

	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	// Wait for context cancellation
	<-ctx.Done()
	cons.Stop()

	return ctx.Err()
}

// Pull fetches messages in batches
func (c *JetStreamClient) Pull(ctx context.Context, consumer jetstream.Consumer, batch int, timeout time.Duration) ([]jetstream.Msg, error) {
	msgs, err := consumer.Fetch(batch, jetstream.FetchMaxWait(timeout))
	if err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}

	var result []jetstream.Msg
	for msg := range msgs.Messages() {
		result = append(result, msg)
	}

	if err := msgs.Error(); err != nil {
		return result, err
	}

	return result, nil
}
```

### Junior → FAANG: Choosing Between Core NATS and JetStream

The two-layer model of NATS is genuinely confusing when you first encounter it, because the same client library (`nats-io/nats.go`) and the same server binary handle both layers. The practical decision rule is: if you need to know that a message was received and processed by at least one consumer, use JetStream. If you can tolerate message loss and want the lowest possible latency, use core NATS.

Concrete examples: metrics telemetry from a fleet of sensors where a missed data point is acceptable uses core pub/sub. An order confirmation that must be processed by the notification service at least once uses JetStream with a durable consumer and explicit ack.

The `Durable` field on the consumer configuration is what makes the consumer survive process restarts. Without it, the consumer is ephemeral: NATS forgets its position when the Go process exits, and the next consumer starts from `DeliverAllPolicy` (the beginning of the stream) or `DeliverNewPolicy` (only new messages), depending on configuration. For production services that should resume from where they left off after a restart, always set `Durable`.

**Subject naming conventions matter.** NATS subject names use dots as separators (`order.created`, `payment.processed`). Wildcards work at the subscription level: `*` matches a single segment (`order.*` matches `order.created` but not `order.line.added`) and `>` matches everything remaining (`order.>` matches both). Design your subject hierarchy so that related events share a common prefix, which lets you create JetStream stream filters that capture an entire bounded context with a single subject pattern.

**Interview habit.** When NATS comes up in an interview, lead with the core-vs-JetStream distinction and the concrete tradeoff between sub-millisecond latency and durability. Candidates who say "NATS is for lightweight messaging" without explaining what they mean by lightweight miss the opportunity to demonstrate depth.

### Senior @ FAANG: NATS JetStream as a Kafka Alternative

The decision between NATS JetStream and Kafka is not as simple as "NATS is lighter, Kafka is heavier." Here is the analysis a staff engineer needs.

**Where JetStream wins.** JetStream is a single statically linked binary with no JVM, no ZooKeeper (not relevant post-Kafka 4.0, but still true), and no external dependencies. A three-node NATS cluster with JetStream can be deployed in a Kubernetes namespace in minutes with the NATS Helm chart. The operational surface is significantly smaller than Kafka, which matters enormously for teams without a dedicated platform team to manage the broker. JetStream also has built-in key-value and object store APIs that can replace Redis and S3 for certain access patterns, reducing the number of systems a team needs to operate.

JetStream's message size limit (default 1MB, configurable to 64MB) is sufficient for most event payloads. Kafka's default is also 1MB but is commonly raised to 10MB or more for bulk data pipelines. If your events are small (under 64KB, which is the norm for domain events), JetStream's limits are irrelevant.

**Where Kafka wins.** Kafka's tiered storage (available in community Kafka via Kafka Tiered Storage, mature in Confluent Platform and Redpanda) allows retention measured in months at S3 prices rather than broker disk prices. For audit logs, compliance requirements, or event sourcing systems with long aggregate histories, this cost difference is significant. Kafka also has a much richer ecosystem: Kafka Connect for source and sink connectors to hundreds of data systems, Kafka Streams and ksqlDB for stream processing, and deep integration with Flink, Spark, and other batch and streaming frameworks. If your EDA system is the foundation for a data platform, not just service-to-service communication, Kafka's ecosystem depth is the deciding factor.

**The NATS account and multi-tenancy model.** NATS has a built-in account system that provides namespace isolation between teams. Each account has its own subject namespace and JetStream storage quota. This enables a platform team to provision isolated NATS accounts for each service team from a shared cluster, with subject import/export for cross-team event sharing. This is NATS's answer to Kafka's ACL-based multi-tenancy and is simpler to operate at small-to-medium scale. At the scale of LinkedIn or Netflix, Kafka's ACL and quota model is more mature, but most companies are not at that scale.

**Consumer pull vs push for backpressure.** The JetStream client in this section uses a push-based consumer (the `Consume` method). JetStream also supports pull-based consumers (the `Pull` method). Pull is preferable when the consumer needs explicit backpressure control: the consumer only fetches a new batch when it is ready to process one, preventing the broker from overwhelming a slow consumer with buffered deliveries. Push consumers are simpler to code but require careful tuning of `MaxAckPending` to limit in-flight messages. For production services with variable processing latency, pull consumers with batch fetching are the more predictable option.

**Observability gap.** NATS JetStream's observability tooling is less mature than Kafka's in 2026. Kafka has well-established Prometheus exporters, Grafana dashboards, and consumer lag alerting. NATS has the NATS Exporter for Prometheus, but per-consumer-group lag equivalent is less standardized. If your observability platform is built around Kafka consumer lag as the primary EDA health signal, factor in the cost of building equivalent JetStream monitoring before choosing it as a Kafka replacement.

---
