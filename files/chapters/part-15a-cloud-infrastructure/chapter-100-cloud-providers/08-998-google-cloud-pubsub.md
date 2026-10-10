## 100.8 Google Cloud Pub/Sub

Cloud Pub/Sub separates message producers (publishers) from consumers (subscribers) through topics and subscriptions, where multiple subscriptions on the same topic each receive an independent copy of every message. Publishing is inherently asynchronous, `topic.Publish` returns a `PublishResult` immediately and batches messages by byte size, count, or delay threshold before flushing to the API, so calling `result.Get` is necessary to confirm delivery and retrieve the server-assigned message ID. Subscribers call `msg.Ack()` to remove a message from the subscription or `msg.Nack()` to return it for redelivery, and `ReceiveSettings.NumGoroutines` controls how many goroutines process messages concurrently within a single `Receive` call.

```go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "cloud.google.com/go/pubsub"
)

type PubSubClient struct {
    client *pubsub.Client
}

func NewPubSubClient(projectID string) (*PubSubClient, error) {
    ctx := context.Background()
    client, err := pubsub.NewClient(ctx, projectID)
    if err != nil {
        return nil, err
    }
    return &PubSubClient{client: client}, nil
}

func (c *PubSubClient) Close() error {
    return c.client.Close()
}

// Publish message
func (c *PubSubClient) Publish(ctx context.Context, topicID string, data any) (string, error) {
    topic := c.client.Topic(topicID)

    body, err := json.Marshal(data)
    if err != nil {
        return "", fmt.Errorf("marshal: %w", err)
    }

    result := topic.Publish(ctx, &pubsub.Message{
        Data: body,
    })

    // Block until message is published
    id, err := result.Get(ctx)
    if err != nil {
        return "", fmt.Errorf("publish: %w", err)
    }

    return id, nil
}

// Publish batch (async)
func (c *PubSubClient) PublishBatch(ctx context.Context, topicID string, messages []any) error {
    topic := c.client.Topic(topicID)

    // Configure batching
    topic.PublishSettings.ByteThreshold = 5000
    topic.PublishSettings.CountThreshold = 100
    topic.PublishSettings.DelayThreshold = 100 * time.Millisecond

    var results []*pubsub.PublishResult

    for _, msg := range messages {
        body, err := json.Marshal(msg)
        if err != nil {
            return fmt.Errorf("marshal: %w", err)
        }

        result := topic.Publish(ctx, &pubsub.Message{Data: body})
        results = append(results, result)
    }

    // Wait for all publishes
    for _, result := range results {
        if _, err := result.Get(ctx); err != nil {
            return fmt.Errorf("publish: %w", err)
        }
    }

    return nil
}

// Subscribe to messages
func (c *PubSubClient) Subscribe(ctx context.Context, subscriptionID string, handler func(context.Context, []byte) error) error {
    sub := c.client.Subscription(subscriptionID)

    // Configure subscription
    sub.ReceiveSettings.MaxOutstandingMessages = 100
    sub.ReceiveSettings.NumGoroutines = 10

    return sub.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
        if err := handler(ctx, msg.Data); err != nil {
            msg.Nack() // Will be redelivered
            return
        }
        msg.Ack()
    })
}

// Pull messages (synchronous)
func (c *PubSubClient) Pull(ctx context.Context, subscriptionID string, maxMessages int) ([]*pubsub.Message, error) {
    sub := c.client.Subscription(subscriptionID)

    var messages []*pubsub.Message
    var mu sync.Mutex

    cctx, cancel := context.WithCancel(ctx)
    defer cancel()

    err := sub.Receive(cctx, func(ctx context.Context, msg *pubsub.Message) {
        mu.Lock()
        messages = append(messages, msg)
        if len(messages) >= maxMessages {
            cancel()
        }
        mu.Unlock()
    })

    if err != nil && err != context.Canceled {
        return nil, err
    }

    return messages, nil
}
```

---

### Junior → FAANG: Cloud Pub/Sub Semantics and Correct Message Handling

The most important concept in Pub/Sub: a message that is read but not acknowledged will be redelivered after the acknowledgment deadline expires. This means your message handler must be idempotent (producing the same result when processing the same message multiple times). If your handler cannot be made idempotent, you need a deduplication layer (a database record of processed message IDs, checked before processing).

The `NumGoroutines` setting in `ReceiveSettings` controls the number of goroutines processing messages concurrently within a single subscriber. This is not the same as the number of subscribers. One subscriber process with `NumGoroutines=10` processes up to 10 messages concurrently. The correct value depends on the processing time and the message throughput: higher concurrency increases throughput but also increases memory usage and the number of in-flight messages (which affects acknowledgment deadline management).

First-job habit: always use `msg.Nack()` when message processing fails rather than just not acknowledging. A `Nack()` immediately returns the message for redelivery. Not acknowledging waits for the deadline to expire before redelivery, which delays error recovery.

### Senior @ FAANG: Pub/Sub Architecture and at-Scale Subscriber Design

At staff level, Pub/Sub subscriber design involves concurrency, flow control, and dead letter topic configuration that require careful architectural thought. The `MaxOutstandingMessages` and `MaxOutstandingBytes` settings in `ReceiveSettings` are the flow control parameters that prevent a fast publisher from overwhelming a slow subscriber. Without flow control, a subscriber can accumulate more in-flight messages than its resources can handle, leading to OOM kills or processing timeouts.

The Pub/Sub ordering key feature (for ordered message delivery) changes the concurrency model significantly: messages with the same ordering key are delivered in order, which means they must be processed sequentially. Enabling ordering keys effectively reduces concurrency for keyed message groups to 1. This is a significant performance constraint that needs to be evaluated against the ordering requirement.

Exactly-once delivery in Pub/Sub (a separately-enabled feature) provides duplicate detection within a 10-minute window for the same region. It is more expensive and has lower throughput limits than the default at-least-once model. The architectural decision between at-least-once with idempotent processing versus exactly-once with its constraints is a per-topic design choice that requires understanding the cost of duplicate processing versus the cost of idempotency implementation versus the cost of the exactly-once feature.
