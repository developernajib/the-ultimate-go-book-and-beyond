## Exercises with Complete Solutions

### Exercise 1: Build a Simple Message Queue

Implement a basic in-memory message queue with topics and consumer groups. The solution models the core Kafka abstractions, topics partitioned into append-only message lists, consumer groups that track offsets per partition, and a publish/subscribe API, without the complexity of disk persistence or network protocol. This stripped-down implementation makes the partition assignment and offset management logic visible without infrastructure dependencies.

**Solution:**

```go
package messagequeue

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "time"
)

var ErrTopicNotFound = errors.New("topic not found")

func generateID() string {
    return fmt.Sprintf("id-%d", time.Now().UnixNano())
}

type Message struct {
    ID        string
    Topic     string
    Partition int
    Offset    int64
    Key       []byte
    Value     []byte
    Timestamp time.Time
}

type MessageQueue struct {
    topics map[string]*Topic
    mu     sync.RWMutex
}

type Topic struct {
    name       string
    partitions []*Partition
    groups     map[string]*ConsumerGroup
    mu         sync.RWMutex
}

type Partition struct {
    id       int
    messages []*Message
    offset   int64
    mu       sync.RWMutex
}

type ConsumerGroup struct {
    id         string
    topic      *Topic
    offsets    map[int]int64 // partition -> committed offset
    members    map[string]*Consumer
    assignment map[string][]int // consumer -> partitions
    mu         sync.RWMutex
}

type Consumer struct {
    id       string
    group    *ConsumerGroup
    messages chan *Message
}

func NewMessageQueue() *MessageQueue {
    return &MessageQueue{
        topics: make(map[string]*Topic),
    }
}

func (mq *MessageQueue) CreateTopic(name string, partitions int) *Topic {
    mq.mu.Lock()
    defer mq.mu.Unlock()

    if topic, exists := mq.topics[name]; exists {
        return topic
    }

    topic := &Topic{
        name:       name,
        partitions: make([]*Partition, partitions),
        groups:     make(map[string]*ConsumerGroup),
    }

    for i := 0; i < partitions; i++ {
        topic.partitions[i] = &Partition{
            id:       i,
            messages: make([]*Message, 0),
            offset:   0,
        }
    }

    mq.topics[name] = topic
    return topic
}

func (mq *MessageQueue) Publish(ctx context.Context, topicName string, key, value []byte) (*Message, error) {
    mq.mu.RLock()
    topic, exists := mq.topics[topicName]
    mq.mu.RUnlock()

    if !exists {
        return nil, ErrTopicNotFound
    }

    // Determine partition from key
    partition := hashKey(key) % len(topic.partitions)

    p := topic.partitions[partition]
    p.mu.Lock()
    defer p.mu.Unlock()

    msg := &Message{
        ID:        generateID(),
        Topic:     topicName,
        Partition: partition,
        Offset:    p.offset,
        Key:       key,
        Value:     value,
        Timestamp: time.Now(),
    }

    p.messages = append(p.messages, msg)
    p.offset++

    // Notify waiting consumers
    topic.mu.RLock()
    for _, group := range topic.groups {
        group.notifyNewMessage(partition, msg)
    }
    topic.mu.RUnlock()

    return msg, nil
}

func (mq *MessageQueue) Subscribe(topicName, groupID, consumerID string) (*Consumer, error) {
    mq.mu.RLock()
    topic, exists := mq.topics[topicName]
    mq.mu.RUnlock()

    if !exists {
        return nil, ErrTopicNotFound
    }

    topic.mu.Lock()
    defer topic.mu.Unlock()

    group, exists := topic.groups[groupID]
    if !exists {
        group = &ConsumerGroup{
            id:         groupID,
            topic:      topic,
            offsets:    make(map[int]int64),
            members:    make(map[string]*Consumer),
            assignment: make(map[string][]int),
        }
        topic.groups[groupID] = group
    }

    consumer := &Consumer{
        id:       consumerID,
        group:    group,
        messages: make(chan *Message, 100),
    }

    group.mu.Lock()
    group.members[consumerID] = consumer
    group.rebalance()
    group.mu.Unlock()

    return consumer, nil
}

func (c *Consumer) Receive(ctx context.Context) (*Message, error) {
    select {
    case msg := <-c.messages:
        return msg, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

func (c *Consumer) Commit(partition int, offset int64) {
    c.group.mu.Lock()
    defer c.group.mu.Unlock()
    c.group.offsets[partition] = offset
}

func (g *ConsumerGroup) rebalance() {
    members := make([]string, 0, len(g.members))
    for id := range g.members {
        members = append(members, id)
    }

    partitions := len(g.topic.partitions)
    g.assignment = make(map[string][]int)

    for i := 0; i < partitions; i++ {
        member := members[i%len(members)]
        g.assignment[member] = append(g.assignment[member], i)
    }
}

func (g *ConsumerGroup) notifyNewMessage(partition int, msg *Message) {
    g.mu.RLock()
    defer g.mu.RUnlock()

    for consumerID, partitions := range g.assignment {
        for _, p := range partitions {
            if p == partition {
                consumer := g.members[consumerID]
                select {
                case consumer.messages <- msg:
                default:
                    // Channel full, message will be read on next poll
                }
                return
            }
        }
    }
}

func hashKey(key []byte) int {
    var hash int
    for _, b := range key {
        hash = hash*31 + int(b)
    }
    if hash < 0 {
        hash = -hash
    }
    return hash
}
```

### Exercise 2: Implement Reliable Message Processing

Build a message processor with retry logic and dead letter queue. The solution implements exponential backoff retries (1s, 2s, 4s) with a configurable maximum attempt count, distinguishes between retryable errors (timeouts, temporary failures) and permanent errors (invalid payload, business rule violations), and routes exhausted messages to a dead-letter topic with their full failure history for manual investigation.

**Solution:**

```go
package reliable

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

type ReliableProcessor struct {
    source       MessageSource
    dlq          MessageSink
    handler      MessageHandler
    maxRetries   int
    retryBackoff []time.Duration
    metrics      *ProcessorMetrics
}

type MessageSource interface {
    Receive(ctx context.Context) (*Message, error)
    Commit(ctx context.Context, msg *Message) error
}

type MessageSink interface {
    Send(ctx context.Context, msg *Message) error
}

type MessageHandler interface {
    Handle(ctx context.Context, msg *Message) error
}

type ProcessorMetrics struct {
    processed  int64
    failed     int64
    retried    int64
    dlqSent    int64
    mu         sync.Mutex
}

func NewReliableProcessor(source MessageSource, dlq MessageSink, handler MessageHandler) *ReliableProcessor {
    return &ReliableProcessor{
        source:       source,
        dlq:          dlq,
        handler:      handler,
        maxRetries:   3,
        retryBackoff: []time.Duration{time.Second, 5 * time.Second, 30 * time.Second},
        metrics:      &ProcessorMetrics{},
    }
}

func (p *ReliableProcessor) Process(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        msg, err := p.source.Receive(ctx)
        if err != nil {
            continue
        }

        p.processWithRetry(ctx, msg)
    }
}

func (p *ReliableProcessor) processWithRetry(ctx context.Context, msg *Message) {
    retryCount := getRetryCount(msg)

    for attempt := retryCount; attempt <= p.maxRetries; attempt++ {
        err := p.handler.Handle(ctx, msg)

        if err == nil {
            p.source.Commit(ctx, msg)
            p.metrics.mu.Lock()
            p.metrics.processed++
            p.metrics.mu.Unlock()
            return
        }

        if attempt < p.maxRetries {
            p.metrics.mu.Lock()
            p.metrics.retried++
            p.metrics.mu.Unlock()

            // Wait before retry
            select {
            case <-time.After(p.retryBackoff[attempt]):
            case <-ctx.Done():
                return
            }
            continue
        }

        // Max retries exceeded, send to DLQ
        p.sendToDLQ(ctx, msg, err, attempt)
        p.source.Commit(ctx, msg)
    }
}

func (p *ReliableProcessor) sendToDLQ(ctx context.Context, msg *Message, lastErr error, retryCount int) {
    dlqMsg := &Message{
        ID:    msg.ID,
        Key:   msg.Key,
        Value: msg.Value,
        Headers: map[string]string{
            "original_topic":  msg.Topic,
            "error":           lastErr.Error(),
            "retry_count":     fmt.Sprintf("%d", retryCount),
            "failed_at":       time.Now().Format(time.RFC3339),
        },
    }

    if err := p.dlq.Send(ctx, dlqMsg); err != nil {
        // Log error but don't fail - message is committed anyway
        fmt.Printf("Failed to send to DLQ: %v\n", err)
    }

    p.metrics.mu.Lock()
    p.metrics.failed++
    p.metrics.dlqSent++
    p.metrics.mu.Unlock()
}

func (p *ReliableProcessor) Stats() ProcessorStats {
    p.metrics.mu.Lock()
    defer p.metrics.mu.Unlock()

    return ProcessorStats{
        Processed: p.metrics.processed,
        Failed:    p.metrics.failed,
        Retried:   p.metrics.retried,
        DLQSent:   p.metrics.dlqSent,
    }
}

type ProcessorStats struct {
    Processed int64
    Failed    int64
    Retried   int64
    DLQSent   int64
}

func getRetryCount(msg *Message) int {
    if count, ok := msg.Headers["retry_count"]; ok {
        var c int
        fmt.Sscanf(count, "%d", &c)
        return c
    }
    return 0
}
```

---

### Junior -> FAANG: What to Take Away From Each Exercise

Exercise 1 (simple message queue) teaches the core data structure decisions: messages stored in an append-only slice per partition, consumer groups tracking offsets per partition, and rebalancing triggered on membership change. Build this implementation yourself without looking at the solution, then compare. The gaps between your version and the solution reveal which concepts you understand structurally versus which you only understand narratively.

Exercise 2 (reliable processing) teaches the retry policy as a first-class design concern. The key insight is that the retry policy belongs to the processor, not to the handler. A handler should return an error and let the processor decide whether to retry, park to DLQ, or skip. This separation is what makes the `MessageHandler` interface pluggable across different processing contexts.

The most valuable habit to develop while solving these exercises: write the test before the implementation. For exercise 1, the test should verify that after a consumer commits offset 5, a restart returns messages starting at offset 6 (not 0). For exercise 2, the test should verify that a handler that fails 3 times results in exactly one DLQ message with the correct retry count.

### Senior @ FAANG: Production Hardening Points for Each Exercise

Exercise 1's in-memory offset store is the first thing to replace in a production version. Redis with TTL is the minimum viable persistent offset store. But the correct production choice for Kafka-compatible systems is to commit offsets to the `__consumer_offsets` Kafka topic, which co-locates the offset state with the message state and eliminates the external dependency.

Exercise 2's `ReliableProcessor` has a subtle correctness issue: `processWithRetry` calls `source.Commit` after sending to the DLQ. If the DLQ send fails (DLQ topic is unavailable), the method logs the error and commits the original message anyway. This means the message is lost: it failed processing, was not durably recorded in the DLQ, and its offset is committed so it will not be redelivered. The production fix is to use a local fallback store (write-ahead log on the local filesystem) when the DLQ is unavailable, and replay from the fallback once the DLQ recovers.

The `ProcessorStats` struct exposes counts but not rates or latency percentiles. A production monitoring layer should export `messages_processed_per_second`, `retry_rate`, `dlq_rate`, and `processing_latency_p99` as Prometheus metrics. These four metrics together tell the operator everything needed to assess consumer health without reading logs.