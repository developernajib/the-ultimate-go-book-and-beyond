## 103.9 Cache and Message Queue Instrumentation

### Redis Instrumentation

The `redisotel` package that ships with go-redis hooks into the client's command pipeline: `InstrumentTracing` creates a span per Redis command and `InstrumentMetrics` records command latency and pool statistics. The `Cache` wrapper below adds business-level spans with hit/miss attributes on top of that per-command instrumentation.

```go
package cache

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/extra/redisotel/v9"
    "github.com/redis/go-redis/v9"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("redis-cache")

// NewRedisClient creates an instrumented Redis client
func NewRedisClient(addr, password string, db int) *redis.Client {
    client := redis.NewClient(&redis.Options{
        Addr:     addr,
        Password: password,
        DB:       db,
        PoolSize: 100,
    })

    // Enable OpenTelemetry instrumentation
    if err := redisotel.InstrumentTracing(client); err != nil {
        panic(err)
    }
    if err := redisotel.InstrumentMetrics(client); err != nil {
        panic(err)
    }

    return client
}

// Cache provides traced caching operations
type Cache struct {
    client *redis.Client
    prefix string
}

func NewCache(client *redis.Client, prefix string) *Cache {
    return &Cache{client: client, prefix: prefix}
}

// Get retrieves a value with cache hit/miss tracking
func (c *Cache) Get(ctx context.Context, key string, dest any) error {
    ctx, span := tracer.Start(ctx, "Cache.Get",
        trace.WithAttributes(
            attribute.String("cache.key", c.prefix+key),
        ),
    )
    defer span.End()

    data, err := c.client.Get(ctx, c.prefix+key).Bytes()
    if err != nil {
        if err == redis.Nil {
            span.SetAttributes(attribute.Bool("cache.hit", false))
            return ErrCacheMiss
        }
        span.RecordError(err)
        return err
    }

    span.SetAttributes(
        attribute.Bool("cache.hit", true),
        attribute.Int("cache.value_size", len(data)),
    )

    if err := json.Unmarshal(data, dest); err != nil {
        span.RecordError(err)
        return err
    }

    return nil
}

// Set stores a value with TTL
func (c *Cache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    ctx, span := tracer.Start(ctx, "Cache.Set",
        trace.WithAttributes(
            attribute.String("cache.key", c.prefix+key),
            attribute.Float64("cache.ttl_seconds", ttl.Seconds()),
        ),
    )
    defer span.End()

    data, err := json.Marshal(value)
    if err != nil {
        span.RecordError(err)
        return err
    }

    span.SetAttributes(attribute.Int("cache.value_size", len(data)))

    if err := c.client.Set(ctx, c.prefix+key, data, ttl).Err(); err != nil {
        span.RecordError(err)
        return err
    }

    return nil
}

// GetOrSet implements cache-aside pattern with tracing
func (c *Cache) GetOrSet(ctx context.Context, key string, dest any, ttl time.Duration, fetchFn func(context.Context) (any, error)) error {
    ctx, span := tracer.Start(ctx, "Cache.GetOrSet",
        trace.WithAttributes(
            attribute.String("cache.key", c.prefix+key),
        ),
    )
    defer span.End()

    // Try cache first
    err := c.Get(ctx, key, dest)
    if err == nil {
        span.SetAttributes(attribute.String("cache.strategy", "hit"))
        return nil
    }
    if err != ErrCacheMiss {
        span.RecordError(err)
        return err
    }

    // Cache miss - fetch from source
    span.SetAttributes(attribute.String("cache.strategy", "miss_then_fetch"))
    span.AddEvent("fetching from source")

    value, err := fetchFn(ctx)
    if err != nil {
        span.RecordError(err)
        return err
    }

    // Store in cache (don't fail if cache write fails)
    if setErr := c.Set(ctx, key, value, ttl); setErr != nil {
        span.AddEvent("cache write failed", trace.WithAttributes(
            attribute.String("error", setErr.Error()),
        ))
    }

    // Copy to destination
    data, _ := json.Marshal(value)
    return json.Unmarshal(data, dest)
}

// Delete removes a key
func (c *Cache) Delete(ctx context.Context, keys ...string) error {
    ctx, span := tracer.Start(ctx, "Cache.Delete",
        trace.WithAttributes(
            attribute.Int("cache.keys_count", len(keys)),
        ),
    )
    defer span.End()

    prefixedKeys := make([]string, len(keys))
    for i, k := range keys {
        prefixedKeys[i] = c.prefix + k
    }

    deleted, err := c.client.Del(ctx, prefixedKeys...).Result()
    if err != nil {
        span.RecordError(err)
        return err
    }

    span.SetAttributes(attribute.Int64("cache.deleted", deleted))
    return nil
}
```

### Kafka Instrumentation

Kafka tracing requires carrying the trace context inside message headers, since no live connection links producer and consumer. The `otelsarama` wrapper handles the injection and extraction. Note the import path: the original contrib module targeted `github.com/Shopify/sarama` and was abandoned when the project moved to IBM, so the maintained community fork `github.com/dnwe/otelsarama` is the one that works with `github.com/IBM/sarama`.

```go
package messaging

import (
    "context"
    "encoding/json"

    "github.com/IBM/sarama"
    "github.com/dnwe/otelsarama"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("kafka")

// Producer wraps Sarama producer with tracing
type Producer struct {
    producer sarama.SyncProducer
    topic    string
}

// NewProducer creates an instrumented Kafka producer
func NewProducer(brokers []string, topic string) (*Producer, error) {
    config := sarama.NewConfig()
    config.Producer.RequiredAcks = sarama.WaitForAll
    config.Producer.Retry.Max = 3
    config.Producer.Return.Successes = true

    producer, err := sarama.NewSyncProducer(brokers, config)
    if err != nil {
        return nil, err
    }

    // Wrap with OpenTelemetry instrumentation
    producer = otelsarama.WrapSyncProducer(config, producer,
        otelsarama.WithTracerProvider(otel.GetTracerProvider()),
        otelsarama.WithPropagators(otel.GetTextMapPropagator()),
    )

    return &Producer{
        producer: producer,
        topic:    topic,
    }, nil
}

// Send publishes a message with tracing
func (p *Producer) Send(ctx context.Context, key string, value any) error {
    ctx, span := tracer.Start(ctx, "Producer.Send",
        trace.WithSpanKind(trace.SpanKindProducer),
        trace.WithAttributes(
            attribute.String("messaging.system", "kafka"),
            attribute.String("messaging.destination", p.topic),
            attribute.String("messaging.destination_kind", "topic"),
            attribute.String("messaging.message_key", key),
        ),
    )
    defer span.End()

    data, err := json.Marshal(value)
    if err != nil {
        span.RecordError(err)
        return err
    }

    msg := &sarama.ProducerMessage{
        Topic: p.topic,
        Key:   sarama.StringEncoder(key),
        Value: sarama.ByteEncoder(data),
    }

    // Inject trace context into message headers
    otel.GetTextMapPropagator().Inject(ctx, otelsarama.NewProducerMessageCarrier(msg))

    partition, offset, err := p.producer.SendMessage(msg)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }

    span.SetAttributes(
        attribute.Int("messaging.kafka.partition", int(partition)),
        attribute.Int64("messaging.kafka.message_offset", offset),
        attribute.Int("messaging.message_payload_size_bytes", len(data)),
    )

    return nil
}

func (p *Producer) Close() error {
    return p.producer.Close()
}

// Consumer wraps Sarama consumer with tracing
type Consumer struct {
    consumer sarama.ConsumerGroup
    topics   []string
    handler  MessageHandler
}

type MessageHandler func(ctx context.Context, msg *Message) error

type Message struct {
    Key       string
    Value     []byte
    Topic     string
    Partition int32
    Offset    int64
    Headers   map[string]string
}

// NewConsumer creates an instrumented Kafka consumer
func NewConsumer(brokers []string, groupID string, topics []string, handler MessageHandler) (*Consumer, error) {
    config := sarama.NewConfig()
    config.Consumer.Group.Rebalance.Strategy = sarama.BalanceStrategyRoundRobin
    config.Consumer.Offsets.Initial = sarama.OffsetNewest

    consumer, err := sarama.NewConsumerGroup(brokers, groupID, config)
    if err != nil {
        return nil, err
    }

    return &Consumer{
        consumer: consumer,
        topics:   topics,
        handler:  handler,
    }, nil
}

// Start begins consuming messages
func (c *Consumer) Start(ctx context.Context) error {
    handler := &consumerGroupHandler{
        handler: c.handler,
    }

    // Wrap handler with OpenTelemetry
    wrappedHandler := otelsarama.WrapConsumerGroupHandler(handler,
        otelsarama.WithTracerProvider(otel.GetTracerProvider()),
        otelsarama.WithPropagators(otel.GetTextMapPropagator()),
    )

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := c.consumer.Consume(ctx, c.topics, wrappedHandler); err != nil {
                return err
            }
        }
    }
}

type consumerGroupHandler struct {
    handler MessageHandler
}

func (h *consumerGroupHandler) Setup(sarama.ConsumerGroupSession) error   { return nil }
func (h *consumerGroupHandler) Cleanup(sarama.ConsumerGroupSession) error { return nil }

func (h *consumerGroupHandler) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
    for msg := range claim.Messages() {
        // Extract trace context from message headers
        ctx := otel.GetTextMapPropagator().Extract(
            context.Background(),
            otelsarama.NewConsumerMessageCarrier(msg),
        )

        ctx, span := tracer.Start(ctx, "Consumer.ProcessMessage",
            trace.WithSpanKind(trace.SpanKindConsumer),
            trace.WithAttributes(
                attribute.String("messaging.system", "kafka"),
                attribute.String("messaging.source", msg.Topic),
                attribute.Int("messaging.kafka.partition", int(msg.Partition)),
                attribute.Int64("messaging.kafka.message_offset", msg.Offset),
            ),
        )

        headers := make(map[string]string)
        for _, h := range msg.Headers {
            headers[string(h.Key)] = string(h.Value)
        }

        m := &Message{
            Key:       string(msg.Key),
            Value:     msg.Value,
            Topic:     msg.Topic,
            Partition: msg.Partition,
            Offset:    msg.Offset,
            Headers:   headers,
        }

        if err := h.handler(ctx, m); err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        } else {
            span.SetStatus(codes.Ok, "message processed")
            session.MarkMessage(msg, "")
        }

        span.End()
    }

    return nil
}

func (c *Consumer) Close() error {
    return c.consumer.Close()
}
```

### Junior → FAANG: Tracing Across Async Boundaries

Cache and message queue instrumentation is harder than HTTP or gRPC because the trace context must survive an asynchronous boundary. When service A publishes a message to Kafka and service B consumes it later, there is no active HTTP connection carrying the `traceparent` header. The trace context must be serialized into the message headers (Kafka headers, SQS message attributes, Redis key metadata) at publish time and deserialized at consume time.

The consumer side can be modeled two ways. Extracting the propagated context and starting a child span, as the code above does, keeps producer and consumer in one trace. Alternatively, the consumer can start a new trace that records a span link to the producer span using `trace.WithLinks()`, which better represents long publish-to-consume delays without implying synchronous causality. The OTel messaging conventions favor links when the delay is significant.

First-job habit: always add cache hit/miss as a span attribute (`cache.hit: true/false`) and record cache errors as span events. Without this, a cache layer that silently fails and falls through to the database is invisible in traces, making the latency increase appear to come from the database rather than the cache.

### Senior @ FAANG: Message Queue Observability, Fan-Out Attribution, and Replay Safety

**Fan-out attribution.** When one producer message triggers processing in multiple consumer services, each consumer creates a new trace linked to the producer span. In a fan-out architecture with 20 downstream consumers, a single producer span has 20 linked traces. The tracing backend must support querying "all traces linked to producer span X" to understand the full impact of a single message. Not all backends handle span links well: Jaeger UI shows links but Grafana Tempo's search handles them better. Platform backend selection should account for this.

**Cache instrumentation and SLO impact.** A Redis or Memcached layer typically serves requests at sub-millisecond latency. When it fails or is slow, latency spikes cascade immediately to the upstream service's p99. Instrumenting cache operations with spans and a `cache.hit` attribute enables SLO alerting that specifically targets cache degradation, rather than waiting for the upstream service's error budget to burn. An L6 engineer defines cache availability as a separate SLI from the service-level SLI, enabling independent alerting and capacity planning.

**Replay safety and idempotency tracing.** Message queue consumers must handle duplicate delivery. When a message is replayed (due to Kafka rebalance or SQS visibility timeout), the consumer should emit a span attribute `messaging.replayed: true` and verify that the operation is idempotent before processing. Tracing replay events separately enables a dashboard that tracks replay frequency as a leading indicator of consumer instability, before duplicate processing causes data inconsistency.

**Backpressure and queue depth as leading indicators.** Message queue consumer lag (the difference between the latest offset and the consumer's current offset) is a critical leading indicator of consumer overload. Instrumenting consumer lag as a gauge metric, alongside span duration for message processing, enables correlation between rising lag and increasing processing latency. An L6 engineer defines a lag-based SLO that fires before the queue grows large enough to cause message expiry or business impact.

---
