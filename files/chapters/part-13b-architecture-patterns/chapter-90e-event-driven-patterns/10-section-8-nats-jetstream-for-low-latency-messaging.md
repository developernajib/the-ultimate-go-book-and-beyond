## 90E.9 NATS JetStream for Low-Latency Messaging

NATS JetStream is a built-in persistence layer in NATS 2.x. It provides durable subjects, consumer groups, and configurable retention at significantly lower latency than Kafka - microsecond publish times vs. milliseconds. Use NATS JetStream when: latency matters more than throughput, you need a simpler operational model than Kafka, or you are building embedded edge systems.

```go
package natsstream

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

const (
	StreamName    = "ORDERS"
	ConsumerGroup = "order-processor"
)

// SetupStream creates or updates the ORDERS JetStream stream.
func SetupStream(nc *nats.Conn) (jetstream.JetStream, error) {
	js, err := jetstream.New(nc)
	if err != nil {
		return nil, fmt.Errorf("jetstream init: %w", err)
	}

	_, err = js.CreateOrUpdateStream(context.Background(), jetstream.StreamConfig{
		Name:        StreamName,
		Subjects:    []string{"orders.>"},      // wildcard: orders.created, orders.updated, etc.
		Retention:   jetstream.LimitsPolicy,    // delete old messages when limits are reached
		MaxMsgs:     10_000_000,                // keep 10M messages
		MaxAge:      7 * 24 * time.Hour,        // keep for 7 days
		MaxBytes:    10 * 1024 * 1024 * 1024,  // max 10GB
		Storage:     jetstream.FileStorage,     // durable - persisted to disk
		Replicas:    3,                          // 3-way replication for HA
		Compression: jetstream.S2Compression,   // S2 compression for disk efficiency
	})
	if err != nil {
		return nil, fmt.Errorf("create stream: %w", err)
	}

	return js, nil
}

// OrderEvent is the payload for order events.
type OrderEvent struct {
	EventID   string    `json:"event_id"`
	EventType string    `json:"event_type"`
	OrderID   string    `json:"order_id"`
	CustomerID string   `json:"customer_id"`
	Amount    int64     `json:"amount_cents"`
	OccurredAt time.Time `json:"occurred_at"`
}

// Publisher publishes order events to JetStream.
type Publisher struct {
	js jetstream.JetStream
}

func NewPublisher(js jetstream.JetStream) *Publisher {
	return &Publisher{js: js}
}

// Publish sends an event to the orders stream.
// JetStream publish is synchronous - it waits for server acknowledgment.
func (p *Publisher) Publish(ctx context.Context, event OrderEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	subject := fmt.Sprintf("orders.%s", event.EventType)

	ack, err := p.js.Publish(ctx, subject, data,
		// De-duplication: if the same MsgID is published within the dedup window,
		// JetStream silently discards the duplicate. Prevents double-publish on retry.
		jetstream.WithMsgID(event.EventID),
	)
	if err != nil {
		return fmt.Errorf("publish to %s: %w", subject, err)
	}

	slog.Debug("event published", "subject", subject, "seq", ack.Sequence, "stream", ack.Stream)
	return nil
}

// Consumer processes events with pull-based delivery.
// Pull consumers offer explicit backpressure: you fetch only as fast as you process.
type Consumer struct {
	consumer  jetstream.Consumer
	processor func(ctx context.Context, event OrderEvent) error
}

func NewConsumer(js jetstream.JetStream, processorFn func(ctx context.Context, event OrderEvent) error) (*Consumer, error) {
	// CreateOrUpdateConsumer is idempotent - safe to call on restart.
	consumer, err := js.CreateOrUpdateConsumer(context.Background(), StreamName, jetstream.ConsumerConfig{
		Name:          ConsumerGroup,
		Durable:       ConsumerGroup,       // named durable consumer persists offset between restarts
		FilterSubject: "orders.>",
		AckPolicy:     jetstream.AckExplicitPolicy, // must explicitly ack each message
		MaxDeliver:    5,                  // retry up to 5 times before routing to DLQ subject
		AckWait:       30 * time.Second,   // message is redelivered if not acked within 30s
		BackOff: []time.Duration{          // exponential backoff between retries
			5 * time.Second,
			30 * time.Second,
			2 * time.Minute,
			10 * time.Minute,
			30 * time.Minute,
		},
		DeliverPolicy: jetstream.DeliverNewPolicy, // only new messages (change to DeliverAllPolicy for replay)
		MaxAckPending: 100,               // backpressure: at most 100 in-flight unacked messages
	})
	if err != nil {
		return nil, fmt.Errorf("create consumer: %w", err)
	}

	return &Consumer{consumer: consumer, processor: processorFn}, nil
}

// Run starts the pull consumer message loop.
func (c *Consumer) Run(ctx context.Context) error {
	// FetchNoWait returns immediately if no messages are available.
	// Fetch blocks up to maxWait. Use Fetch for efficient long-polling.
	msgs, err := c.consumer.Messages(
		jetstream.PullMaxMessages(10), // fetch up to 10 messages per batch
	)
	if err != nil {
		return fmt.Errorf("messages iterator: %w", err)
	}
	defer msgs.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		msg, err := msgs.Next()
		if err != nil {
			if err == jetstream.ErrMsgIteratorClosed {
				return nil
			}
			return fmt.Errorf("next message: %w", err)
		}

		var event OrderEvent
		if err := json.Unmarshal(msg.Data(), &event); err != nil {
			slog.Error("unmarshal event", "error", err, "subject", msg.Subject())
			// Nak with no backoff - malformed message goes to DLQ after MaxDeliver retries.
			msg.Term()
			continue
		}

		if err := c.processor(ctx, event); err != nil {
			slog.Error("process event", "error", err, "event_id", event.EventID)
			// Nak: message will be redelivered with BackOff delay.
			msg.NakWithDelay(5 * time.Second)
			continue
		}

		msg.Ack()
	}
}
```

---
