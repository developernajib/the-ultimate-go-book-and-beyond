## 52F.2 Producers

Producers write all data entering Kafka. Producer configuration determines throughput, latency, durability guarantees, and ordering behavior. This section covers each configuration option and builds production-grade implementations in Go.

### Partitioning Strategies

When a producer sends a message, it must decide which partition to write to. This decision has major implications for ordering, load distribution, and consumer parallelism.

```
Message with key "user-123"
         │
         ▼
┌─────────────────────┐
│   Partitioner       │
│                     │
│  Strategy:          │
│  ┌────────────────┐ │
│  │ 1. Key-based   │ │     hash(key) % numPartitions
│  │    (default)   │─┼──► Partition = hash("user-123") % 6 = 3
│  ├────────────────┤ │
│  │ 2. Round-robin │ │     Sequential: 0, 1, 2, 3, 4, 5, 0, 1...
│  │    (no key)    │─┼──► Ensures even distribution
│  ├────────────────┤ │
│  │ 3. Custom      │ │     Your logic decides
│  │    partitioner │─┼──► e.g., by region, priority, tenant
│  └────────────────┘ │
└─────────────────────┘
```

**Key-based partitioning** ensures that all messages with the same key land on the same partition, guaranteeing ordering per key. This is critical for event sourcing - all events for `user-123` arrive in order.

**Round-robin partitioning** is used when no key is provided. It distributes messages evenly across partitions, maximizing throughput but providing no ordering guarantees.

**Custom partitioning** allows business-logic-driven routing - for example, sending all messages for a geographic region to a specific partition to enable rack-aware consumers.

### Acknowledgment Levels

The `acks` configuration controls durability guarantees:

| Acks Level | Behavior | Latency | Durability |
|------------|----------|---------|------------|
| `acks=0` | Fire and forget - don't wait for any acknowledgment | Lowest | None - messages can be lost |
| `acks=1` | Wait for leader to write to its local log | Medium | Lost if leader crashes before replication |
| `acks=all` (-1) | Wait for all ISR replicas to acknowledge | Highest | No data loss (with min.insync.replicas >= 2) |

```
acks=0 (Fire and Forget):
Producer ──send──► Broker (Leader)
         (no wait)       │
                         ▼
                    Write to log
                    Replicate (async)

acks=1 (Leader Only):
Producer ──send──► Broker (Leader)
         ◄──ack──       │
                         ▼
                    Write to log ✓
                    Replicate (async, may not complete)

acks=all (All ISR):
Producer ──send──► Broker (Leader)
                         │
                    Write to log ✓
                         │
                    ┌────▼────┐
                    │Replicate│
                    │to ISR   │
                    └────┬────┘
                         │
                    All ISR ack ✓
         ◄──ack──       │
```

> **Production Rule**: Always use `acks=all` with `min.insync.replicas=2` for any data you cannot afford to lose. The latency overhead is typically 2-5ms - negligible for most applications.

### Idempotent Producers

Network failures can cause duplicate messages: a producer sends a message, the broker writes it, but the acknowledgment is lost. The producer retries, creating a duplicate. Idempotent producers solve this.

When `enable.idempotence=true`, the broker assigns each producer a **Producer ID (PID)** and each message gets a **sequence number**. The broker tracks the latest sequence number per PID per partition, rejecting duplicates automatically.

```
Without Idempotence:
Producer ──msg(seq=1)──► Broker     (writes, ack lost)
Producer ──msg(seq=1)──► Broker     (writes again = DUPLICATE!)
Result: [msg, msg]  ← Two copies

With Idempotence (enable.idempotence=true):
Producer(PID=5) ──msg(seq=1)──► Broker  (writes, ack lost)
Producer(PID=5) ──msg(seq=1)──► Broker  (detects seq=1 already written)
                 ◄──ack────────          (acks without writing)
Result: [msg]  ← Exactly one copy
```

### Batching and Compression

Producers batch messages to reduce network round trips. Two settings control batching:

- **`batch.size`** (default 16 KB): Maximum bytes per batch. Larger batches improve throughput.
- **`linger.ms`** (default 0): Time to wait for more messages before sending a batch. Setting this to 5-10ms dramatically improves throughput by allowing batches to fill.

Compression reduces network and storage costs:

| Algorithm | Compression Ratio | CPU Cost | Best For |
|-----------|------------------|----------|----------|
| None | 1.0x | None | Very low latency requirements |
| Snappy | ~1.5-2x | Very Low | General purpose, Kafka default at LinkedIn |
| LZ4 | ~2-3x | Low | High throughput with good compression |
| Zstd | ~3-5x | Medium | Best compression ratio, great for logs |
| Gzip | ~3-4x | High | Compatibility (avoid in high-throughput) |

### Go Code: Full Producer with segmentio/kafka-go

A well-structured Kafka producer in Go handles retries, partition assignment, and error reporting without leaking goroutines or blocking indefinitely. The following implementation wraps `kafka-go`'s `Writer` with sensible defaults for production use, including explicit context cancellation, compression, and structured error handling.

```go
// File: kafka-fundamentals/producer/producer.go
package producer

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "hash/fnv"
    "log/slog"
    "sync"
    "sync/atomic"
    "time"

    "github.com/segmentio/kafka-go"
    "github.com/segmentio/kafka-go/compress"
)

// Config holds producer configuration.
type Config struct {
    Brokers      []string
    Topic        string
    Acks         kafka.RequiredAcks // 0, 1, or -1 (all)
    BatchSize    int                // bytes
    BatchTimeout time.Duration      // equivalent to linger.ms
    MaxRetries   int
    Compression  compress.Codec
    Async        bool
    Logger       *slog.Logger
}

// DefaultConfig returns a production-ready producer configuration.
func DefaultConfig(brokers []string, topic string) Config {
    return Config{
        Brokers:      brokers,
        Topic:        topic,
        Acks:         kafka.RequireAll, // acks=all
        BatchSize:    1048576,          // 1 MB batch size
        BatchTimeout: 10 * time.Millisecond,
        MaxRetries:   10,
        Compression:  &compress.Lz4Codec,
        Async:        false,
        Logger:       slog.Default(),
    }
}

// Metrics tracks producer performance.
type Metrics struct {
    MessagesSent  atomic.Int64
    BytesSent     atomic.Int64
    Errors        atomic.Int64
    Retries       atomic.Int64
    AvgLatencyUs  atomic.Int64
    lastLatencies []int64
    mu            sync.Mutex
}

// Snapshot returns a point-in-time copy of the metrics.
func (m *Metrics) Snapshot() MetricsSnapshot {
    return MetricsSnapshot{
        MessagesSent: m.MessagesSent.Load(),
        BytesSent:    m.BytesSent.Load(),
        Errors:       m.Errors.Load(),
        Retries:      m.Retries.Load(),
        AvgLatencyUs: m.AvgLatencyUs.Load(),
    }
}

func (m *Metrics) recordLatency(d time.Duration) {
    us := d.Microseconds()
    m.mu.Lock()
    m.lastLatencies = append(m.lastLatencies, us)
    if len(m.lastLatencies) > 1000 {
        m.lastLatencies = m.lastLatencies[len(m.lastLatencies)-1000:]
    }
    var sum int64
    for _, l := range m.lastLatencies {
        sum += l
    }
    m.mu.Unlock()
    m.AvgLatencyUs.Store(sum / int64(len(m.lastLatencies)))
}

// MetricsSnapshot is a point-in-time copy of producer metrics.
type MetricsSnapshot struct {
    MessagesSent int64
    BytesSent    int64
    Errors       int64
    Retries      int64
    AvgLatencyUs int64
}

// Producer wraps kafka-go Writer with production features.
type Producer struct {
    writer  *kafka.Writer
    config  Config
    metrics Metrics
    logger  *slog.Logger
}

// New creates a new Producer with the given configuration.
func New(config Config) (*Producer, error) {
    if len(config.Brokers) == 0 {
        return nil, errors.New("at least one broker address is required")
    }
    if config.Topic == "" {
        return nil, errors.New("topic is required")
    }
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    // The kafka-go Writer handles batching, retries, and partitioning.
    writer := &kafka.Writer{
        Addr:         kafka.TCP(config.Brokers...),
        Topic:        config.Topic,
        Balancer:     &kafka.Hash{}, // Key-based partitioning by default.
        RequiredAcks: config.Acks,
        BatchSize:    config.BatchSize,
        BatchTimeout: config.BatchTimeout,
        MaxAttempts:  config.MaxRetries,
        Compression:  kafka.Compression(config.Compression.Code()),
        Async:        config.Async,
        // Enable idempotent writes.
        AllowAutoTopicCreation: false,
    }

    return &Producer{
        writer: writer,
        config: config,
        logger: config.Logger,
    }, nil
}

// Send sends a single message to Kafka synchronously.
func (p *Producer) Send(ctx context.Context, key, value []byte) error {
    return p.SendMessage(ctx, kafka.Message{
        Key:   key,
        Value: value,
    })
}

// SendMessage sends a kafka.Message with full control over headers, timestamp, etc.
func (p *Producer) SendMessage(ctx context.Context, msg kafka.Message) error {
    start := time.Now()

    err := p.writer.WriteMessages(ctx, msg)
    if err != nil {
        p.metrics.Errors.Add(1)
        p.logger.Error("failed to send message",
            "topic", p.config.Topic,
            "key", string(msg.Key),
            "error", err,
        )
        return fmt.Errorf("sending message to %s: %w", p.config.Topic, err)
    }

    duration := time.Since(start)
    p.metrics.MessagesSent.Add(1)
    p.metrics.BytesSent.Add(int64(len(msg.Key) + len(msg.Value)))
    p.metrics.recordLatency(duration)

    p.logger.Debug("message sent",
        "topic", p.config.Topic,
        "key", string(msg.Key),
        "latency_us", duration.Microseconds(),
    )
    return nil
}

// SendBatch sends multiple messages in a single batch.
func (p *Producer) SendBatch(ctx context.Context, messages []kafka.Message) error {
    start := time.Now()

    err := p.writer.WriteMessages(ctx, messages...)
    if err != nil {
        p.metrics.Errors.Add(1)
        return fmt.Errorf("sending batch of %d messages: %w", len(messages), err)
    }

    duration := time.Since(start)
    var totalBytes int64
    for _, msg := range messages {
        totalBytes += int64(len(msg.Key) + len(msg.Value))
    }
    p.metrics.MessagesSent.Add(int64(len(messages)))
    p.metrics.BytesSent.Add(totalBytes)
    p.metrics.recordLatency(duration)

    p.logger.Debug("batch sent",
        "topic", p.config.Topic,
        "count", len(messages),
        "latency_us", duration.Microseconds(),
    )
    return nil
}

// SendJSON marshals the value to JSON and sends it with the given key.
func (p *Producer) SendJSON(ctx context.Context, key string, value any) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling JSON: %w", err)
    }
    return p.Send(ctx, []byte(key), data)
}

// Metrics returns the producer's metrics.
func (p *Producer) GetMetrics() *Metrics {
    return &p.metrics
}

// Close flushes pending messages and closes the producer.
func (p *Producer) Close() error {
    p.logger.Info("closing producer",
        "topic", p.config.Topic,
        "messages_sent", p.metrics.MessagesSent.Load(),
        "errors", p.metrics.Errors.Load(),
    )
    return p.writer.Close()
}

// --- Custom Partitioner ---

// RegionPartitioner routes messages to partitions based on a region header.
// This is useful for rack-aware consumers or data locality.
type RegionPartitioner struct {
    RegionToPartition map[string]int
    DefaultPartition  int
}

// Balance implements kafka.Balancer for region-based routing.
func (rp *RegionPartitioner) Balance(msg kafka.Message, partitions ...int) int {
    for _, h := range msg.Headers {
        if h.Key == "region" {
            region := string(h.Value)
            if partition, ok := rp.RegionToPartition[region]; ok {
                // Verify the partition exists.
                for _, p := range partitions {
                    if p == partition {
                        return partition
                    }
                }
            }
        }
    }

    // If the message has a key, fall back to hash partitioning.
    if len(msg.Key) > 0 {
        hasher := fnv.New32a()
        hasher.Write(msg.Key)
        return partitions[int(hasher.Sum32())%len(partitions)]
    }

    return partitions[rp.DefaultPartition%len(partitions)]
}
```

Now let's see a complete producer application:

```go
// File: kafka-fundamentals/cmd/producer-demo/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "math/rand/v2"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    "github.com/example/kafka-fundamentals/producer"
    "github.com/segmentio/kafka-go"
)

// OrderEvent represents an e-commerce order event.
type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    Items      []Item    `json:"items"`
    TotalCents int64     `json:"total_cents"`
    Status     string    `json:"status"`
    Region     string    `json:"region"`
    CreatedAt  time.Time `json:"created_at"`
}

// Item represents a line item in an order.
type Item struct {
    ProductID  string `json:"product_id"`
    Name       string `json:"name"`
    Quantity   int    `json:"quantity"`
    PriceCents int64  `json:"price_cents"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    brokersEnv := os.Getenv("KAFKA_BROKERS")
    if brokersEnv == "" {
        brokersEnv = "localhost:9092,localhost:9093,localhost:9094"
    }
    brokers := strings.Split(brokersEnv, ",")

    // Create producer with production settings.
    config := producer.DefaultConfig(brokers, "orders")
    config.Logger = logger

    p, err := producer.New(config)
    if err != nil {
        logger.Error("failed to create producer", "error", err)
        os.Exit(1)
    }
    defer p.Close()

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    logger.Info("starting order event producer")

    // Produce events at a steady rate.
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    regions := []string{"us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"}
    statuses := []string{"created", "confirmed", "shipped", "delivered"}
    orderCount := 0

    for {
        select {
        case <-ctx.Done():
            logger.Info("shutting down producer",
                "total_sent", p.GetMetrics().MessagesSent.Load(),
                "total_errors", p.GetMetrics().Errors.Load(),
            )
            return
        case <-ticker.C:
            orderCount++
            order := generateOrder(orderCount, regions, statuses)

            data, err := json.Marshal(order)
            if err != nil {
                logger.Error("failed to marshal order", "error", err)
                continue
            }

            msg := kafka.Message{
                // Key ensures all events for the same customer go to the same partition.
                Key:   []byte(order.CustomerID),
                Value: data,
                Headers: []kafka.Header{
                    {Key: "event_type", Value: []byte("order_event")},
                    {Key: "region", Value: []byte(order.Region)},
                    {Key: "schema_version", Value: []byte("1.0.0")},
                },
                Time: order.CreatedAt,
            }

            if err := p.SendMessage(ctx, msg); err != nil {
                logger.Error("failed to send order event",
                    "order_id", order.OrderID,
                    "error", err,
                )
                continue
            }

            if orderCount%100 == 0 {
                snapshot := p.GetMetrics().Snapshot()
                logger.Info("producer metrics",
                    "messages_sent", snapshot.MessagesSent,
                    "bytes_sent", snapshot.BytesSent,
                    "errors", snapshot.Errors,
                    "avg_latency_us", snapshot.AvgLatencyUs,
                )
            }
        }
    }
}

func generateOrder(seq int, regions, statuses []string) OrderEvent {
    numItems := rand.IntN(5) + 1
    items := make([]Item, numItems)
    var totalCents int64

    for i := range numItems {
        priceCents := int64(rand.IntN(10000) + 100) // 100 to 10099 cents ($1.00 to $100.99)
        qty := rand.IntN(3) + 1
        items[i] = Item{
            ProductID:  fmt.Sprintf("prod-%d", rand.IntN(1000)),
            Name:       fmt.Sprintf("Product %d", rand.IntN(1000)),
            Quantity:   qty,
            PriceCents: priceCents,
        }
        totalCents += priceCents * int64(qty)
    }

    return OrderEvent{
        OrderID:    fmt.Sprintf("ord-%06d", seq),
        CustomerID: fmt.Sprintf("cust-%04d", rand.IntN(500)),
        Items:      items,
        TotalCents: totalCents,
        Status:     statuses[rand.IntN(len(statuses))],
        Region:     regions[rand.IntN(len(regions))],
        CreatedAt:  time.Now().UTC(),
    }
}
```

### Go Code: Producer with confluent-kafka-go (Comparison)

The `confluent-kafka-go` library wraps the C library `librdkafka`, offering maximum performance and feature parity with the official Kafka client. Here is the same producer using this library for comparison:

```go
// File: kafka-fundamentals/producer/confluent_producer.go
package producer

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "sync/atomic"
    "time"

    kafkalib "github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// ConfluentConfig holds configuration for the confluent-kafka-go producer.
type ConfluentConfig struct {
    Brokers            string // comma-separated
    Topic              string
    Acks               string // "0", "1", "all"
    EnableIdempotence  bool
    BatchSize          int    // batch.size in bytes
    LingerMs           int    // linger.ms
    CompressionType    string // "none", "snappy", "lz4", "zstd"
    MaxInFlightPerConn int    // max.in.flight.requests.per.connection
    Retries            int
    RetryBackoffMs     int
    Logger             *slog.Logger
}

// DefaultConfluentConfig returns a production-ready confluent producer config.
func DefaultConfluentConfig(brokers, topic string) ConfluentConfig {
    return ConfluentConfig{
        Brokers:            brokers,
        Topic:              topic,
        Acks:               "all",
        EnableIdempotence:  true,
        BatchSize:          1048576,  // 1 MB
        LingerMs:           10,
        CompressionType:    "lz4",
        MaxInFlightPerConn: 5, // Safe with idempotence enabled.
        Retries:            2147483647,
        RetryBackoffMs:     100,
        Logger:             slog.Default(),
    }
}

// ConfluentProducer wraps the confluent-kafka-go producer with metrics.
type ConfluentProducer struct {
    producer *kafkalib.Producer
    topic    string
    logger   *slog.Logger

    messagesSent atomic.Int64
    errors       atomic.Int64
    bytesSent    atomic.Int64
}

// NewConfluentProducer creates a new producer using confluent-kafka-go.
func NewConfluentProducer(config ConfluentConfig) (*ConfluentProducer, error) {
    if config.Brokers == "" {
        return nil, errors.New("brokers is required")
    }
    if config.Topic == "" {
        return nil, errors.New("topic is required")
    }

    kafkaConfig := &kafkalib.ConfigMap{
        "bootstrap.servers":                     config.Brokers,
        "acks":                                  config.Acks,
        "enable.idempotence":                    config.EnableIdempotence,
        "batch.size":                            config.BatchSize,
        "linger.ms":                             config.LingerMs,
        "compression.type":                      config.CompressionType,
        "max.in.flight.requests.per.connection": config.MaxInFlightPerConn,
        "retries":                               config.Retries,
        "retry.backoff.ms":                      config.RetryBackoffMs,
        // Delivery report for every message.
        "go.delivery.reports": true,
    }

    p, err := kafkalib.NewProducer(kafkaConfig)
    if err != nil {
        return nil, fmt.Errorf("creating confluent producer: %w", err)
    }

    cp := &ConfluentProducer{
        producer: p,
        topic:    config.Topic,
        logger:   config.Logger,
    }

    // Start delivery report handler in the background.
    go cp.handleDeliveryReports()

    return cp, nil
}

// handleDeliveryReports processes asynchronous delivery reports.
func (cp *ConfluentProducer) handleDeliveryReports() {
    for e := range cp.producer.Events() {
        switch ev := e.(type) {
        case *kafkalib.Message:
            if ev.TopicPartition.Error != nil {
                cp.errors.Add(1)
                cp.logger.Error("delivery failed",
                    "topic", *ev.TopicPartition.Topic,
                    "partition", ev.TopicPartition.Partition,
                    "error", ev.TopicPartition.Error,
                )
            } else {
                cp.messagesSent.Add(1)
                cp.bytesSent.Add(int64(len(ev.Key) + len(ev.Value)))
                cp.logger.Debug("message delivered",
                    "topic", *ev.TopicPartition.Topic,
                    "partition", ev.TopicPartition.Partition,
                    "offset", ev.TopicPartition.Offset,
                )
            }
        }
    }
}

// Send sends a message with the given key and value.
func (cp *ConfluentProducer) Send(ctx context.Context, key, value []byte) error {
    deliveryChan := make(chan kafkalib.Event, 1)

    err := cp.producer.Produce(&kafkalib.Message{
        TopicPartition: kafkalib.TopicPartition{
            Topic:     &cp.topic,
            Partition: kafkalib.PartitionAny,
        },
        Key:   key,
        Value: value,
        Headers: []kafkalib.Header{
            {Key: "produced_at", Value: []byte(time.Now().UTC().Format(time.RFC3339Nano))},
        },
    }, deliveryChan)
    if err != nil {
        return fmt.Errorf("producing message: %w", err)
    }

    // Wait for delivery report or context cancellation.
    select {
    case <-ctx.Done():
        return ctx.Err()
    case e := <-deliveryChan:
        msg := e.(*kafkalib.Message)
        if msg.TopicPartition.Error != nil {
            return fmt.Errorf("delivery failed: %w", msg.TopicPartition.Error)
        }
        return nil
    }
}

// SendJSON marshals the value to JSON and sends it.
func (cp *ConfluentProducer) SendJSON(ctx context.Context, key string, value any) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling JSON: %w", err)
    }
    return cp.Send(ctx, []byte(key), data)
}

// SendAsync sends a message asynchronously (fire-and-forget to the local buffer).
// Check delivery reports for confirmation.
func (cp *ConfluentProducer) SendAsync(key, value []byte) error {
    return cp.producer.Produce(&kafkalib.Message{
        TopicPartition: kafkalib.TopicPartition{
            Topic:     &cp.topic,
            Partition: kafkalib.PartitionAny,
        },
        Key:   key,
        Value: value,
    }, nil)
}

// Flush waits for all outstanding messages to be delivered.
func (cp *ConfluentProducer) Flush(timeoutMs int) int {
    return cp.producer.Flush(timeoutMs)
}

// Close flushes pending messages and closes the producer.
func (cp *ConfluentProducer) Close() {
    // Flush with a generous timeout.
    remaining := cp.producer.Flush(30 * 1000)
    if remaining > 0 {
        cp.logger.Warn("producer closed with unflushed messages",
            "remaining", remaining,
        )
    }
    cp.producer.Close()

    cp.logger.Info("confluent producer closed",
        "messages_sent", cp.messagesSent.Load(),
        "errors", cp.errors.Load(),
    )
}
```

> **Library Comparison**: `segmentio/kafka-go` is pure Go, easier to cross-compile, and has no CGo dependency. `confluent-kafka-go` wraps `librdkafka` (C library), offering better performance at high throughput and full feature parity with the Java client. For most Go services, `segmentio/kafka-go` is the simpler choice. For latency-critical or very high-throughput workloads, consider `confluent-kafka-go`. A third excellent option is `twmb/franz-go`, a pure Go client with full protocol support - we'll use it in later sections.

### Junior -> FAANG: Producer Configuration as a First Principles Exercise

The producer is the entry point for all data entering Kafka. New engineers often copy a producer configuration from a blog post without understanding the tradeoffs embedded in each setting. Before your first production deploy, be able to answer "what does this config do and what breaks if I change it" for each of the following:

**`acks` and what it really means.** `acks=0` means the producer does not wait for any acknowledgment: fast, but messages can be lost if the broker has not yet written to disk. `acks=1` waits for the leader only: messages survive a follower crash but are lost if the leader crashes before replication. `acks=all` waits for all ISR members: no data loss as long as `min.insync.replicas` is met. The 2-5ms latency difference between `acks=1` and `acks=all` is almost never worth accepting data loss for.

**`batch.size` and `linger.ms` are two sides of the same knob.** `batch.size` is the size limit that triggers an immediate send. `linger.ms` is the time limit. A batch sends when either limit is hit. Setting `linger.ms=0` (the default) means batches are sent immediately and will almost always be small, giving poor throughput. Setting `linger.ms=10` means the producer waits 10ms to accumulate messages, dramatically improving throughput at negligible latency cost for most applications.

**The custom `RegionPartitioner` pattern.** The `RegionPartitioner` in this section looks simple but encodes an important design principle: partition assignment can encode business semantics. Routing all EU messages to specific partitions enables a rack-aware consumer deployed in the EU region to preferentially read those partitions, reducing cross-region egress costs. This is the kind of optimization that separates an engineer who understands Kafka's data model from one who just uses the default partitioner everywhere.

Interview framing: if asked "how would you implement priority processing in Kafka," the partition-as-routing-signal pattern is a strong answer: use separate topics for high/medium/low priority and run more consumer instances against the high-priority topic. This is more reliable than custom partitioning within a single topic because it preserves independent offset management per priority tier.

### Senior @ FAANG: Producer Contract as a Platform API

At the senior level, the producer is not just a library you wrap. It is a contract between your service and every downstream consumer. The configuration choices you make define the durability guarantees, ordering semantics, and throughput characteristics that downstream teams can rely on.

**Idempotence and transactions as a default, not an option.** In modern clients (`franz-go`, `confluent-kafka-go` 2.x, Java 3.0+), `enable.idempotence=true` and `acks=all` are the defaults. You must explicitly opt out. This is the right default: the cost of idempotence is a small producer-side sequence number overhead, and the benefit is eliminating retry-induced duplicates. Any codebase that sets `enable.idempotence=false` should require a documented justification in the ADR or a code comment explaining the accepted risk.

**`transactional.id` stability is a correctness requirement.** The transactional producer uses `transactional.id` to fence zombie producers. If a producer restarts with a new `transactional.id`, the old epoch is not invalidated, and zombie writes can occur during a failover window. The `transactional.id` must be stable across restarts and unique per producer instance. A good convention is `{service-name}-{partition-id}` for consume-transform-produce pipelines, ensuring each partition's producer has a distinct ID.

**Producer metrics as SLO signals.** The `Metrics` struct in this section tracks `AvgLatencyUs`, `Errors`, and `BytesSent`. In a mature platform, these metrics drive SLO dashboards and autoscaling decisions. A producer p99 latency above 100ms indicates broker pressure or network saturation. An error rate above 0.01% sustained for more than five minutes should trigger a PagerDuty alert. Wire these metrics to Prometheus counters and histograms in production code, not just the in-process atomic counters shown here.

**Custom partitioner governance.** The `RegionPartitioner` demonstrates that custom partitioners are possible. At the platform level, the risk is that each team invents its own partitioning strategy, making it impossible to reason about data distribution across the cluster. A platform team should define the allowed partitioning strategies (default hash, round-robin, region-affinity) and require ADR approval for any custom implementation. Custom partitioners that break the Kafka guarantee of "same key goes to same partition" are a common source of consumer ordering bugs that are painful to debug in production.

---
