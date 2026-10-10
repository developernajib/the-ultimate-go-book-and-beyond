## 64.5 Producer Implementation

The producer is responsible for selecting the target partition, batching messages for efficient network utilization, and confirming durability based on the configured acknowledgment level. Key-based partitioning (hash of the message key modulo partition count) ensures messages with the same key always land in the same partition, preserving ordering for related events. Producer batching accumulates messages up to a size or time threshold before sending a single network request, dramatically improving throughput at the cost of small increases in latency.

```go
// producer/producer.go
package producer

import (
    "context"
    "hash/fnv"
    "sync"
    "sync/atomic"
    "time"

    "yourproject/message"
)

// BrokerClient defines broker operations used by the producer
type BrokerClient interface {
    GetPartitionCount(ctx context.Context, topic string) (int32, error)
    Produce(ctx context.Context, topic string, partition int32, messages []*message.Message) ([]int64, error)
}

// Producer sends messages to topics
type Producer struct {
    mu          sync.Mutex
    client      BrokerClient
    partitioner Partitioner
    config      ProducerConfig
    batchers    map[string]*Batcher // topic -> batcher
}

// ProducerConfig holds producer configuration
type ProducerConfig struct {
    BatchSize       int
    BatchTimeout    time.Duration
    MaxRetries      int
    RetryBackoff    time.Duration
    Acks            int // 0=none, 1=leader, -1=all
    Compression     string
    IdempotencyEnabled bool
}

// Partitioner determines target partition
type Partitioner interface {
    Partition(msg *message.Message, numPartitions int32) int32
}

// DefaultPartitioner uses key hash or round-robin
type DefaultPartitioner struct {
    counter atomic.Uint64
}

func (p *DefaultPartitioner) Partition(msg *message.Message, numPartitions int32) int32 {
    if len(msg.Key) > 0 {
        h := fnv.New32a()
        h.Write(msg.Key)
        return int32(h.Sum32() % uint32(numPartitions))
    }
    // Partition is called concurrently from every Send, so the
    // round-robin counter must be incremented atomically.
    n := p.counter.Add(1)
    return int32(n % uint64(numPartitions))
}

// NewProducer creates a new producer
func NewProducer(client BrokerClient, config ProducerConfig) *Producer {
    return &Producer{
        client:      client,
        partitioner: &DefaultPartitioner{},
        config:      config,
        batchers:    make(map[string]*Batcher),
    }
}

// Send sends a message to a topic
func (p *Producer) Send(ctx context.Context, topic string, msg *message.Message) (int64, error) {
    // Get partition count
    numPartitions, err := p.client.GetPartitionCount(ctx, topic)
    if err != nil {
        return 0, err
    }

    // Determine partition
    partition := p.partitioner.Partition(msg, numPartitions)
    msg.Partition = partition
    msg.Timestamp = time.Now()

    // Get or create batcher
    p.mu.Lock()
    batcher, ok := p.batchers[topic]
    if !ok {
        batcher = NewBatcher(p.client, topic, p.config)
        p.batchers[topic] = batcher
        go batcher.Run()
    }
    p.mu.Unlock()

    // Add to batch
    return batcher.Add(ctx, msg)
}

// SendBatch sends multiple messages
func (p *Producer) SendBatch(ctx context.Context, topic string, messages []*message.Message) ([]int64, error) {
    offsets := make([]int64, len(messages))

    for i, msg := range messages {
        offset, err := p.Send(ctx, topic, msg)
        if err != nil {
            return nil, err
        }
        offsets[i] = offset
    }

    return offsets, nil
}

// Close closes the producer
func (p *Producer) Close() error {
    p.mu.Lock()
    defer p.mu.Unlock()

    for _, batcher := range p.batchers {
        batcher.Close()
    }

    return nil
}

// Batcher batches messages for efficient sending
type Batcher struct {
    mu         sync.Mutex
    client     BrokerClient
    topic      string
    config     ProducerConfig
    batches    map[int32]*messageBatch
    resultChs  map[int64]chan BatchResult
    nextID     int64
    quit       chan struct{}
}

type messageBatch struct {
    messages []*message.Message
    ids      []int64
}

type BatchResult struct {
    Offset int64
    Error  error
}

// NewBatcher creates a new batcher
func NewBatcher(client BrokerClient, topic string, config ProducerConfig) *Batcher {
    return &Batcher{
        client:    client,
        topic:     topic,
        config:    config,
        batches:   make(map[int32]*messageBatch),
        resultChs: make(map[int64]chan BatchResult),
        quit:      make(chan struct{}),
    }
}

// Add adds a message to the batch
func (b *Batcher) Add(ctx context.Context, msg *message.Message) (int64, error) {
    b.mu.Lock()

    batch, ok := b.batches[msg.Partition]
    if !ok {
        batch = &messageBatch{
            messages: make([]*message.Message, 0, b.config.BatchSize),
            ids:      make([]int64, 0, b.config.BatchSize),
        }
        b.batches[msg.Partition] = batch
    }

    b.nextID++
    id := b.nextID
    batch.messages = append(batch.messages, msg)
    batch.ids = append(batch.ids, id)

    resultCh := make(chan BatchResult, 1)
    b.resultChs[id] = resultCh

    shouldFlush := len(batch.messages) >= b.config.BatchSize
    b.mu.Unlock()

    if shouldFlush {
        b.flush(msg.Partition)
    }

    // Wait for result
    select {
    case result := <-resultCh:
        return result.Offset, result.Error
    case <-ctx.Done():
        return 0, ctx.Err()
    }
}

// Run runs the batcher
func (b *Batcher) Run() {
    ticker := time.NewTicker(b.config.BatchTimeout)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            b.flushAll()
        case <-b.quit:
            b.flushAll()
            return
        }
    }
}

func (b *Batcher) flush(partition int32) {
    b.mu.Lock()
    batch, ok := b.batches[partition]
    if !ok || len(batch.messages) == 0 {
        b.mu.Unlock()
        return
    }

    messages := batch.messages
    ids := batch.ids
    batch.messages = make([]*message.Message, 0, b.config.BatchSize)
    batch.ids = make([]int64, 0, b.config.BatchSize)
    b.mu.Unlock()

    // Send to broker
    ctx := context.Background()
    offsets, err := b.client.Produce(ctx, b.topic, partition, messages)

    // Notify waiters
    b.mu.Lock()
    for i, id := range ids {
        if ch, ok := b.resultChs[id]; ok {
            var result BatchResult
            if err != nil {
                result.Error = err
            } else if i < len(offsets) {
                result.Offset = offsets[i]
            }
            ch <- result
            close(ch)
            delete(b.resultChs, id)
        }
    }
    b.mu.Unlock()
}

func (b *Batcher) flushAll() {
    b.mu.Lock()
    partitions := make([]int32, 0, len(b.batches))
    for p := range b.batches {
        partitions = append(partitions, p)
    }
    b.mu.Unlock()

    for _, p := range partitions {
        b.flush(p)
    }
}

// Close closes the batcher
func (b *Batcher) Close() {
    close(b.quit)
}
```

---

### Junior -> FAANG: Producer Configuration Decisions and Their Interview Answers

Three producer configuration parameters come up in almost every message queue interview: `acks`, `batch.size`, and `linger.ms`. Understand each one in terms of the trade-off it controls.

`acks=0` is fire-and-forget: the producer sends and never waits for a response. Highest throughput, no durability guarantee. `acks=1` waits for the leader to write to its local log but not for follower replication. Fast, but messages can be lost if the leader fails before replication. `acks=-1` (all) waits for all in-sync replicas to confirm the write. Slowest, highest durability. For most production use cases, `acks=-1` with a replication factor of 3 and `min.insync.replicas=2` is the right choice.

`batch.size` and `linger.ms` control the throughput-latency trade-off. A larger batch size means more messages per network round trip, which increases throughput but also increases the memory the producer holds waiting for the batch to fill. `linger.ms` sets a maximum wait time before a partially-filled batch is sent. Setting `linger.ms=5` allows the producer to collect more messages for up to 5 milliseconds before sending, often doubling throughput with negligible latency impact for non-interactive workloads.

Key partitioning is the mechanism for per-key ordering. Messages with the same key always hash to the same partition, so they are processed in order by the consumer assigned that partition. Messages without a key are round-robined across partitions. Use keys for any entity where ordering matters (order events keyed by `order_id`, user events keyed by `user_id`).

### Senior @ FAANG: Idempotent Producers and Exactly-Once Semantics at the Infrastructure Level

The `IdempotencyEnabled` field in `ProducerConfig` represents a significant architectural choice. An idempotent producer assigns a monotonically increasing sequence number to each message and includes a producer ID (PID) assigned by the broker at initialization. The broker tracks the highest sequence number it has acknowledged per PID per partition. If a producer retries a message (due to a network timeout where the broker may or may not have received the original), the broker deduplicates based on the sequence number and returns the original acknowledgment without re-writing the message.

This mechanism eliminates producer-side duplicates but does not provide exactly-once across consumer processing. For end-to-end exactly-once, you need Kafka transactions (`producer.InitTransactions`, `producer.BeginTransaction`, `producer.SendOffsetsToTransaction`, `producer.CommitTransaction`). Kafka transactions are correct but carry a 3-5% throughput overhead from the two-phase commit protocol, and they only guarantee exactly-once delivery within the Kafka ecosystem. Any external sink (database, HTTP API) requires additional idempotency handling.

The batcher's `resultChs` map is a subtle memory management concern. Each pending send allocates a channel and registers it in the map. If the broker is slow and batches pile up, this map can grow unbounded. A production batcher must implement a maximum pending request limit (bounded by a semaphore) and reject new sends with a backpressure error when the limit is reached. This propagates backpressure from the broker through the producer to the calling code, preventing unbounded memory growth. The Kafka producer client (`segmentio/kafka-go`, `IBM/sarama`) handles this internally. Custom batchers must handle it explicitly.