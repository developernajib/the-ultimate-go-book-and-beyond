## 52F.3 Consumers & Consumer Groups

Consumers read messages from Kafka topics. While a single consumer is straightforward, production systems use **consumer groups** - Kafka's mechanism for distributing partitions across multiple consumer instances for parallel processing, fault tolerance, and horizontal scaling.

### Consumer Group Protocol

A **consumer group** is identified by a `group.id` string. When multiple consumers share the same `group.id`, Kafka distributes the topic's partitions among them. Each partition is assigned to exactly one consumer within the group.

```
Topic "orders" - 6 partitions
Consumer Group: "order-processor"

                    ┌──────────────────────────────────────────┐
                    │        Group Coordinator (Broker)        │
                    │   Manages membership & partition         │
                    │   assignment for this group              │
                    └──────────┬───────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │  Consumer 1     │ │  Consumer 2     │ │  Consumer 3     │
    │  (Group Leader) │ │                 │ │                 │
    │                 │ │                 │ │                 │
    │  Partition 0 ───│ │  Partition 2 ───│ │  Partition 4 ───│
    │  Partition 1 ───│ │  Partition 3 ───│ │  Partition 5 ───│
    └─────────────────┘ └─────────────────┘ └─────────────────┘

If Consumer 3 crashes:

    ┌─────────────────┐ ┌─────────────────┐
    │  Consumer 1     │ │  Consumer 2     │   Consumer 3: DEAD
    │  (Group Leader) │ │                 │
    │                 │ │                 │   Rebalance!
    │  Partition 0 ───│ │  Partition 2 ───│   Partitions 4,5
    │  Partition 1 ───│ │  Partition 3 ───│   reassigned
    │  Partition 4 ───│ │  Partition 5 ───│   ← redistributed
    └─────────────────┘ └─────────────────┘
```

**Key Rule**: The number of active consumers in a group should not exceed the number of partitions. Extra consumers will be idle. For maximum parallelism, set partitions equal to or greater than the expected consumer count.

### Assignment Strategies

When a consumer group rebalances (due to member join/leave/crash), the group leader decides how to assign partitions:

| Strategy | How It Works | Best For |
|----------|-------------|----------|
| **Range** | Assigns contiguous partition ranges to consumers | Co-partitioned topics (join across topics) |
| **Round-Robin** | Distributes partitions one at a time in round-robin | Even distribution across consumers |
| **Sticky** | Minimizes partition movement during rebalancing | Reducing rebalance disruption |
| **Cooperative-Sticky** | Incremental rebalance - only moves affected partitions | Production systems (avoids stop-the-world) |

```
Range Assignment (2 consumers, 6 partitions):
  Consumer 1: [P0, P1, P2]    ← contiguous range
  Consumer 2: [P3, P4, P5]    ← contiguous range

Round-Robin Assignment (2 consumers, 6 partitions):
  Consumer 1: [P0, P2, P4]    ← every other partition
  Consumer 2: [P1, P3, P5]    ← every other partition

Sticky (after Consumer 3 leaves a 3-consumer group):
  Before: C1=[P0,P1] C2=[P2,P3] C3=[P4,P5]
  After:  C1=[P0,P1,P4] C2=[P2,P3,P5]    ← minimal movement

Cooperative-Sticky (incremental rebalance):
  Step 1: Revoke only P4,P5 from dead C3 (C1,C2 keep processing!)
  Step 2: Assign P4→C1, P5→C2
  Result: No stop-the-world pause
```

### Offset Management

Kafka consumers track their position in each partition using **offsets**. Two strategies exist:

**Auto-commit** (default): The client periodically commits offsets in the background (`auto.commit.interval.ms`, default 5 seconds). Simple but risky - if the consumer crashes after processing but before the next auto-commit, messages are reprocessed.

**Manual commit**: The application explicitly commits offsets after processing. This gives you control over exactly-once or at-least-once semantics.

```
Auto-commit (risky):
  Read msg offset=5 → Process → (crash before auto-commit)
  Restart → Reads from offset=3 (last committed) → Reprocesses 3,4,5

Manual commit (safe):
  Read msg offset=5 → Process → CommitSync(offset=6)
  Restart → Reads from offset=6 → No reprocessing
```

### Rebalancing: Eager vs Cooperative

**Eager rebalancing** (traditional): All consumers stop processing, revoke all partitions, then reassign. This creates a "stop-the-world" pause that can last seconds to minutes on large groups.

**Cooperative (incremental) rebalancing**: Only affected partitions are revoked and reassigned. Other consumers continue processing uninterrupted. This is the recommended approach for production systems.

```
Eager Rebalance (Stop-the-World):
  Time ─────────────────────────────────────────────►
  C1: [Processing]──STOP──[Revoke All]──[Reassign]──[Resume]
  C2: [Processing]──STOP──[Revoke All]──[Reassign]──[Resume]
  C3:                     [Join]────────[Assign]─────[Start]
                     ◄─── Downtime ───►
                     (all consumers paused)

Cooperative Rebalance (Incremental):
  Time ─────────────────────────────────────────────►
  C1: [Processing P0,P1]──[Revoke P1]──[Processing P0]───►
  C2: [Processing P2,P3]──[Processing P2,P3]─────────────►
  C3:                      [Join]──────[Assign P1]──[Start]
                     No full stop - only P1 briefly paused
```

### Consumer Lag Monitoring

**Consumer lag** is the difference between the latest offset in a partition (log-end offset) and the consumer group's committed offset. High lag means consumers are falling behind.

```
Partition 0:
  Log End Offset:      1,000,000
  Consumer Committed:    950,000
  Lag:                    50,000 messages

  If producing at 10,000 msg/s and consuming at 8,000 msg/s:
  Lag grows by 2,000 msg/s → Need to add consumers or optimize processing
```

### Go Code: Full Consumer Group with Manual Offset Commit

Consumer group membership and offset management are the primary levers for controlling at-least-once delivery guarantees in Kafka. The manual-commit consumer calls `CommitMessages` only after the message has been successfully processed and any downstream side effects have been persisted, so that a crash between processing and commit causes the broker to re-deliver the message to the next consumer rather than silently dropping it.

```go
// File: kafka-fundamentals/consumer/consumer.go
package consumer

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "sync"
    "sync/atomic"
    "time"

    "github.com/segmentio/kafka-go"
)

// MessageHandler processes a single Kafka message.
// Return nil to commit the offset, or an error to skip committing.
type MessageHandler func(ctx context.Context, msg kafka.Message) error

// Config holds consumer configuration.
type Config struct {
    Brokers        []string
    Topic          string
    GroupID        string
    MinBytes       int           // Minimum batch size (bytes) to fetch.
    MaxBytes       int           // Maximum batch size (bytes) to fetch.
    MaxWait        time.Duration // Maximum time to wait for MinBytes.
    CommitInterval time.Duration // How often to commit offsets (0 = every message).
    StartOffset    int64         // kafka.FirstOffset or kafka.LastOffset.
    Logger         *slog.Logger
}

// DefaultConfig returns a production-ready consumer configuration.
func DefaultConfig(brokers []string, topic, groupID string) Config {
    return Config{
        Brokers:        brokers,
        Topic:          topic,
        GroupID:        groupID,
        MinBytes:       1,         // 1 byte - don't wait for large batches.
        MaxBytes:       10 << 20,  // 10 MB max fetch size.
        MaxWait:        500 * time.Millisecond,
        CommitInterval: 0,         // Manual commit after each message.
        StartOffset:    kafka.LastOffset,
        Logger:         slog.Default(),
    }
}

// ConsumerMetrics tracks consumer performance.
type ConsumerMetrics struct {
    MessagesProcessed atomic.Int64
    Errors            atomic.Int64
    BytesRead         atomic.Int64
    CommitCount       atomic.Int64
    ProcessingTimeUs  atomic.Int64 // rolling average
}

// Consumer wraps kafka-go Reader with production features.
type Consumer struct {
    reader  *kafka.Reader
    config  Config
    handler MessageHandler
    metrics ConsumerMetrics
    logger  *slog.Logger

    // For batched offset commits.
    pendingCommits map[string]map[int]int64 // topic -> partition -> offset
    commitMu       sync.Mutex
}

// New creates a new Consumer with the given configuration.
func New(config Config, handler MessageHandler) (*Consumer, error) {
    if len(config.Brokers) == 0 {
        return nil, errors.New("at least one broker address is required")
    }
    if config.Topic == "" {
        return nil, errors.New("topic is required")
    }
    if config.GroupID == "" {
        return nil, errors.New("group ID is required")
    }
    if handler == nil {
        return nil, errors.New("message handler is required")
    }
    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:        config.Brokers,
        Topic:          config.Topic,
        GroupID:        config.GroupID,
        MinBytes:       config.MinBytes,
        MaxBytes:       config.MaxBytes,
        MaxWait:        config.MaxWait,
        CommitInterval: config.CommitInterval,
        StartOffset:    config.StartOffset,
        // Important: disable auto-commit for manual offset management.
        // When CommitInterval is 0, we must call CommitMessages explicitly.
    })

    return &Consumer{
        reader:         reader,
        config:         config,
        handler:        handler,
        logger:         config.Logger,
        pendingCommits: make(map[string]map[int]int64),
    }, nil
}

// Run starts consuming messages and blocks until the context is canceled.
// This is the main event loop for the consumer.
func (c *Consumer) Run(ctx context.Context) error {
    c.logger.Info("consumer started",
        "topic", c.config.Topic,
        "group", c.config.GroupID,
        "brokers", c.config.Brokers,
    )

    for {
        // FetchMessage does NOT auto-commit. We must call CommitMessages.
        msg, err := c.reader.FetchMessage(ctx)
        if err != nil {
            if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
                c.logger.Info("consumer shutting down",
                    "processed", c.metrics.MessagesProcessed.Load(),
                    "errors", c.metrics.Errors.Load(),
                )
                return nil
            }
            c.metrics.Errors.Add(1)
            c.logger.Error("failed to fetch message",
                "topic", c.config.Topic,
                "group", c.config.GroupID,
                "error", err,
            )
            // Brief pause before retrying to avoid tight error loops.
            select {
            case <-ctx.Done():
                return nil
            case <-time.After(time.Second):
                continue
            }
        }

        // Process the message.
        start := time.Now()
        if err := c.handler(ctx, msg); err != nil {
            c.metrics.Errors.Add(1)
            c.logger.Error("failed to process message",
                "topic", msg.Topic,
                "partition", msg.Partition,
                "offset", msg.Offset,
                "key", string(msg.Key),
                "error", err,
            )
            // Depending on your error strategy:
            // Option A: Skip and commit (at-most-once for this message).
            // Option B: Don't commit, retry on next fetch (at-least-once).
            // Option C: Send to dead-letter topic, then commit.
            // We implement Option B here - message will be redelivered.
            continue
        }

        processingTime := time.Since(start)
        c.metrics.MessagesProcessed.Add(1)
        c.metrics.BytesRead.Add(int64(len(msg.Key) + len(msg.Value)))
        c.metrics.ProcessingTimeUs.Store(processingTime.Microseconds())

        // Commit the offset after successful processing.
        if err := c.reader.CommitMessages(ctx, msg); err != nil {
            c.logger.Error("failed to commit offset",
                "topic", msg.Topic,
                "partition", msg.Partition,
                "offset", msg.Offset,
                "error", err,
            )
            // The message was processed but offset not committed.
            // On restart, it will be reprocessed - consumer must be idempotent.
        } else {
            c.metrics.CommitCount.Add(1)
        }

        c.logger.Debug("message processed",
            "topic", msg.Topic,
            "partition", msg.Partition,
            "offset", msg.Offset,
            "key", string(msg.Key),
            "processing_us", processingTime.Microseconds(),
        )

        // Log metrics periodically.
        if c.metrics.MessagesProcessed.Load()%1000 == 0 {
            c.logMetrics()
        }
    }
}

// GetLag returns the consumer lag for each partition.
func (c *Consumer) GetLag() kafka.ReaderStats {
    return c.reader.Stats()
}

func (c *Consumer) logMetrics() {
    stats := c.reader.Stats()
    c.logger.Info("consumer metrics",
        "messages_processed", c.metrics.MessagesProcessed.Load(),
        "errors", c.metrics.Errors.Load(),
        "bytes_read", c.metrics.BytesRead.Load(),
        "commits", c.metrics.CommitCount.Load(),
        "lag", stats.Lag,
        "dial_time_avg", stats.DialTime.Avg,
        "read_time_avg", stats.ReadTime.Avg,
    )
}

// Close closes the consumer, committing any pending offsets.
func (c *Consumer) Close() error {
    c.logger.Info("closing consumer",
        "topic", c.config.Topic,
        "group", c.config.GroupID,
        "total_processed", c.metrics.MessagesProcessed.Load(),
    )
    return c.reader.Close()
}
```

### Go Code: Consumer with Graceful Shutdown

Graceful shutdown is non-negotiable in production Kafka consumers: an abrupt exit leaves offsets uncommitted and may force reprocessing on restart. The following implementation listens for OS signals and drains in-flight messages before closing the reader, ensuring clean partition rebalancing.

```go
// File: kafka-fundamentals/cmd/consumer-demo/main.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "strings"
    "sync"
    "syscall"
    "time"

    "github.com/example/kafka-fundamentals/consumer"
    "github.com/segmentio/kafka-go"
)

// OrderEvent matches the producer's OrderEvent struct.
type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    Items      []Item    `json:"items"`
    TotalCents int64     `json:"total_cents"`
    Status     string    `json:"status"`
    Region     string    `json:"region"`
    CreatedAt  time.Time `json:"created_at"`
}

// Item represents a line item.
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

    // Number of concurrent consumer instances in this process.
    numConsumers := 3

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM,
    )
    defer cancel()

    var wg sync.WaitGroup

    // Launch multiple consumers in the same group for parallel processing.
    for i := range numConsumers {
        wg.Add(1)
        go func(instanceID int) {
            defer wg.Done()

            config := consumer.DefaultConfig(brokers, "orders", "order-processor")
            config.Logger = logger.With("instance", instanceID)
            config.StartOffset = kafka.FirstOffset // Read from beginning for demo.

            handler := createOrderHandler(logger.With("instance", instanceID))

            c, err := consumer.New(config, handler)
            if err != nil {
                logger.Error("failed to create consumer",
                    "instance", instanceID,
                    "error", err,
                )
                return
            }
            defer c.Close()

            logger.Info("consumer instance started", "instance", instanceID)

            if err := c.Run(ctx); err != nil {
                logger.Error("consumer error",
                    "instance", instanceID,
                    "error", err,
                )
            }

            logger.Info("consumer instance stopped", "instance", instanceID)
        }(i)
    }

    // Start a goroutine for periodic lag monitoring.
    wg.Add(1)
    go func() {
        defer wg.Done()
        monitorLag(ctx, logger, brokers)
    }()

    logger.Info("all consumers started, waiting for shutdown signal",
        "consumers", numConsumers,
    )

    // Wait for all consumers to finish.
    wg.Wait()
    logger.Info("all consumers stopped cleanly")
}

// createOrderHandler returns a MessageHandler that processes order events.
func createOrderHandler(logger *slog.Logger) consumer.MessageHandler {
    return func(ctx context.Context, msg kafka.Message) error {
        var order OrderEvent
        if err := json.Unmarshal(msg.Value, &order); err != nil {
            logger.Error("failed to unmarshal order",
                "partition", msg.Partition,
                "offset", msg.Offset,
                "error", err,
            )
            // Return nil to commit the offset - bad data should be skipped
            // and sent to a dead-letter topic in production.
            return nil
        }

        // Simulate business logic processing.
        logger.Info("processing order",
            "order_id", order.OrderID,
            "customer", order.CustomerID,
            "status", order.Status,
            "total_cents", order.TotalCents,
            "region", order.Region,
            "partition", msg.Partition,
            "offset", msg.Offset,
        )

        // Simulate processing time.
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(10 * time.Millisecond):
        }

        return nil
    }
}

// monitorLag periodically queries consumer lag and logs it.
func monitorLag(ctx context.Context, logger *slog.Logger, brokers []string) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Use kafka-go's client to query consumer group lag.
            client := &kafka.Client{
                Addr: kafka.TCP(brokers...),
            }

            // Describe the consumer group to get member assignments.
            descResp, err := client.DescribeGroups(ctx, &kafka.DescribeGroupsRequest{
                Groups: []string{"order-processor"},
            })
            if err != nil {
                logger.Error("failed to describe group", "error", err)
                continue
            }

            for _, group := range descResp.Groups {
                logger.Info("consumer group status",
                    "group", group.GroupID,
                    "state", group.GroupState,
                    "protocol", group.ProtocolType,
                    "members", len(group.Members),
                )

                for _, member := range group.Members {
                    logger.Info("group member",
                        "member_id", member.MemberID,
                        "client_id", member.ClientID,
                        "host", member.ClientHost,
                    )
                }
            }

            // Fetch committed offsets for the group.
            offsetResp, err := client.OffsetFetch(ctx, &kafka.OffsetFetchRequest{
                GroupID: "order-processor",
                Topics:  map[string][]int{"orders": {0, 1, 2, 3, 4, 5}},
            })
            if err != nil {
                logger.Error("failed to fetch offsets", "error", err)
                continue
            }

            for topic, partitions := range offsetResp.Topics {
                for _, p := range partitions {
                    if p.Error != nil {
                        continue
                    }
                    logger.Info("partition offset",
                        "topic", topic,
                        "partition", p.Partition,
                        "committed_offset", p.CommittedOffset,
                    )
                }
            }
        }
    }
}

// --- Batch Consumer Alternative ---

// BatchConsumer processes messages in batches for higher throughput.
// Use this when individual message processing has high fixed overhead
// (e.g., database batch inserts).
type BatchConsumer struct {
    reader    *kafka.Reader
    batchSize int
    timeout   time.Duration
    logger    *slog.Logger
}

// BatchHandler processes a batch of messages atomically.
type BatchHandler func(ctx context.Context, msgs []kafka.Message) error

// NewBatchConsumer creates a consumer that accumulates messages into batches.
func NewBatchConsumer(brokers []string, topic, groupID string, batchSize int, logger *slog.Logger) *BatchConsumer {
    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:  brokers,
        Topic:    topic,
        GroupID:  groupID,
        MinBytes: 1,
        MaxBytes: 10 << 20,
    })

    return &BatchConsumer{
        reader:    reader,
        batchSize: batchSize,
        timeout:   5 * time.Second,
        logger:    logger,
    }
}

// Run processes messages in batches.
func (bc *BatchConsumer) Run(ctx context.Context, handler BatchHandler) error {
    batch := make([]kafka.Message, 0, bc.batchSize)
    timer := time.NewTimer(bc.timeout)
    defer timer.Stop()

    for {
        select {
        case <-ctx.Done():
            // Process remaining batch before exiting.
            if len(batch) > 0 {
                if err := bc.processBatch(ctx, handler, batch); err != nil {
                    bc.logger.Error("failed to process final batch", "error", err)
                }
            }
            return nil
        default:
        }

        // Use a short timeout for fetching to allow batch timer to fire.
        fetchCtx, fetchCancel := context.WithTimeout(ctx, time.Second)
        msg, err := bc.reader.FetchMessage(fetchCtx)
        fetchCancel()

        if err != nil {
            if ctx.Err() != nil {
                // Main context canceled - exit.
                if len(batch) > 0 {
                    _ = bc.processBatch(context.Background(), handler, batch)
                }
                return nil
            }
            // Timeout on fetch - check if we should flush the batch.
            select {
            case <-timer.C:
                if len(batch) > 0 {
                    if err := bc.processBatch(ctx, handler, batch); err != nil {
                        bc.logger.Error("failed to process batch on timeout", "error", err)
                    }
                    batch = batch[:0]
                }
                timer.Reset(bc.timeout)
            default:
            }
            continue
        }

        batch = append(batch, msg)

        // Flush when batch is full.
        if len(batch) >= bc.batchSize {
            if err := bc.processBatch(ctx, handler, batch); err != nil {
                bc.logger.Error("failed to process batch", "error", err)
                // Don't commit - messages will be redelivered.
                batch = batch[:0]
                continue
            }
            batch = batch[:0]
            timer.Reset(bc.timeout)
        }
    }
}

func (bc *BatchConsumer) processBatch(ctx context.Context, handler BatchHandler, batch []kafka.Message) error {
    bc.logger.Info("processing batch", "size", len(batch))

    if err := handler(ctx, batch); err != nil {
        return fmt.Errorf("batch handler: %w", err)
    }

    // Commit all messages in the batch.
    if err := bc.reader.CommitMessages(ctx, batch...); err != nil {
        return fmt.Errorf("committing batch: %w", err)
    }

    bc.logger.Debug("batch committed", "size", len(batch))
    return nil
}

// Close closes the batch consumer.
func (bc *BatchConsumer) Close() error {
    return bc.reader.Close()
}
```

> **Production Insight**: Uber's consumer groups process over 50 million messages per second. They use cooperative-sticky rebalancing to minimize disruption during deployments and batch consumers for database sink operations. Consumer lag is monitored via Burrow (LinkedIn's open-source lag monitoring tool) with alerts when lag exceeds SLA thresholds.

### Junior -> FAANG: Building the Right Error Handling Intuition for Consumers

Consumer error handling is where most new Kafka engineers make their most costly mistakes. The code in this section shows three options when a message fails: skip and commit, do not commit and retry, or route to a dead-letter topic. Understanding when to use each option is more important than memorizing the API.

**Option A (skip and commit) is dangerous by default.** Returning `nil` to commit the offset after a processing failure means you accept data loss for that message. This is correct only when the message is malformed or unparseable and will never succeed regardless of retries. Even then, the right behavior is to route to a dead-letter topic before committing, not silently discard.

**Option B (do not commit) is the safest default, but requires idempotent handlers.** If your handler fails and you do not commit, the message is re-delivered on the next fetch. If your handler is not idempotent (not safe to run twice), you will corrupt state. Before choosing this option, make your handler idempotent: use `ON CONFLICT DO NOTHING` in database inserts, check-and-set for cache updates, or message deduplication via the DedupStore pattern in section 52F.4.

**The `BatchConsumer` pattern deserves more attention than it gets in interviews.** When you write a consumer that inserts one row per message, your throughput is bounded by the round-trip cost of individual database inserts. The `BatchConsumer` accumulates 100-1000 messages and inserts them in a single batch statement, improving throughput by 10-100x. Know the pattern, know the tradeoff (increased worst-case duplicate processing on crash), and know when to use it.

Common interview question: "A consumer is falling behind. How do you debug and fix it?" Expected answer: check consumer lag per partition for skew (one partition much higher than others indicates a hot key or processing bottleneck), check handler processing time, add consumers up to the partition count, then either optimize the handler or scale the partition count.

### Senior @ FAANG: Consumer Group Design as an Operational Contract

Consumer group design is one of the single most useful decisions in a Kafka-based system. A poorly designed consumer group creates operational problems that are expensive to fix after the system is in production.

**Static membership as a required pattern for production fleets.** The `group.instance.id` configuration (static membership, KIP-345) was introduced specifically for containerized and auto-scaling deployments. Without it, every pod restart or rolling deploy triggers a full eager rebalance. With static membership, a pod that restarts within `session.timeout.ms` is recognized as the same member and resumes its partition assignments without triggering rebalance. For a consumer fleet of 50 instances with a 60-second session timeout, a rolling deploy that restarts 5 instances per minute completes without any rebalance if `group.instance.id` is set per pod (e.g., using the Kubernetes pod name).

**Cooperative-sticky is required at scale, not optional.** The stop-the-world eager rebalance is a correctness hazard at scale, not just a performance issue. During a rebalance, all consumers stop fetching. Consumer lag grows. If lag grows faster than consumers can recover after the rebalance, you can enter a cycle: rebalance, lag spike, consumers fall behind, next rebalance triggered before recovery completes. Cooperative rebalancing breaks this cycle by limiting revocation to only the partitions that must move.

**Consumer group isolation as a blast radius reduction strategy.** Do not share consumer groups across unrelated services. A consumer group is a coordination unit: all members participate in rebalances together. A slow consumer from one service delays rebalance completion for every other service in the same group. Use one consumer group per service per topic. If two services need to process the same topic independently, they each get their own consumer group with their own committed offsets.

**Autoscaling consumer fleets with KEDA.** At the staff level, consumer groups should be scaled automatically based on lag. KEDA (Kubernetes Event-Driven Autoscaler) integrates with Kafka consumer group lag via the `kafka` trigger. Configure a target lag threshold per consumer group, and KEDA adds or removes pod replicas to keep lag within bounds. The maximum replicas must not exceed the partition count, or the excess pods will be idle. Document this limit in the Helm chart as a validation rule.

**Per-partition processing goroutines vs single-goroutine consumers.** The consumer in this section uses a single goroutine per consumer instance. For CPU-bound handlers, this bottlenecks throughput at one goroutine. A common pattern is to dispatch each fetched message to a worker pool: `workerPool <- msg`. This increases throughput but breaks per-partition ordering: two messages from the same partition can be processed concurrently. Only use this pattern when your handler is idempotent and ordering within a partition is not required by your business logic.

---
