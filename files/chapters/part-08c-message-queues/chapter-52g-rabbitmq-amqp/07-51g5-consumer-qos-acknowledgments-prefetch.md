## 52G.5 Consumer QoS, Acknowledgments & Prefetch

### The Acknowledgment Model

| Method | Meaning | Effect on broker |
|--------|---------|-----------------|
| `Ack` | Processed successfully | Message deleted from queue |
| `Nack` | Failed, requeue or discard | Requeued (if `requeue=true`) or dead-lettered |
| `Reject` | Failed, discard single message | Same as `Nack` but for single message |

**Never mix `Ack` and `Nack` on the same delivery tag.** Doing so causes a channel-level protocol error.

### Prefetch Tuning

`basic.qos` controls how many unacknowledged messages the broker pushes to a consumer at once.

- `prefetch=0`: Unlimited. Broker floods the consumer. **Never use in production.**
- `prefetch=1`: Safest. One message at a time. Low throughput but fair distribution.
- `prefetch=N` (N > 1): Sweet spot for throughput. Start at 10-50 and benchmark.

```go
package consumer

import (
	"context"
	"fmt"
	"log/slog"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ConsumerConfig holds consumer configuration.
type ConsumerConfig struct {
	Queue     string
	Tag       string // consumer tag; empty = auto-generated
	Prefetch  int    // QoS prefetch count; recommended: 10-50
	AutoAck   bool   // false = manual ack (recommended for production)
}

// MessageHandler processes a single delivery. Must be safe to call concurrently.
// Return nil to ack, non-nil to nack.
type MessageHandler func(ctx context.Context, d amqp.Delivery) error

// Consumer wraps an AMQP channel with QoS, graceful shutdown, and structured logging.
type Consumer struct {
	ch      *amqp.Channel
	cfg     ConsumerConfig
	handler MessageHandler
	logger  *slog.Logger
}

// NewConsumer creates a Consumer and sets channel QoS.
func NewConsumer(ch *amqp.Channel, cfg ConsumerConfig, handler MessageHandler, logger *slog.Logger) (*Consumer, error) {
	// Per-consumer prefetch (global=false).
	if err := ch.Qos(cfg.Prefetch, 0, false); err != nil {
		return nil, fmt.Errorf("set qos: %w", err)
	}

	return &Consumer{
		ch:      ch,
		cfg:     cfg,
		handler: handler,
		logger:  logger,
	}, nil
}

// Run starts consuming messages until ctx is canceled or the channel closes.
func (c *Consumer) Run(ctx context.Context) error {
	deliveries, err := c.ch.Consume(
		c.cfg.Queue,
		c.cfg.Tag,
		c.cfg.AutoAck, // auto-ack: false = manual
		false,         // exclusive
		false,         // no-local (not supported in amqp091-go)
		false,         // no-wait
		nil,           // args
	)
	if err != nil {
		return fmt.Errorf("consume %q: %w", c.cfg.Queue, err)
	}

	c.logger.Info("consumer: started",
		"queue", c.cfg.Queue,
		"prefetch", c.cfg.Prefetch,
		"auto_ack", c.cfg.AutoAck,
	)

	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				c.logger.Warn("consumer: delivery channel closed")
				return fmt.Errorf("delivery channel closed")
			}
			c.processDelivery(ctx, d)

		case <-ctx.Done():
			c.logger.Info("consumer: shutting down", "reason", ctx.Err())
			return nil
		}
	}
}

// processDelivery calls the handler and acks or nacks based on the result.
func (c *Consumer) processDelivery(ctx context.Context, d amqp.Delivery) {
	logger := c.logger.With(
		"delivery_tag", d.DeliveryTag,
		"exchange", d.Exchange,
		"routing_key", d.RoutingKey,
		"redelivered", d.Redelivered,
	)

	if err := c.handler(ctx, d); err != nil {
		logger.Error("consumer: handler failed, nacking",
			"error", err,
			"requeue", !d.Redelivered, // don't re-requeue already-redelivered messages
		)

		// Requeue=false on second failure sends to DLX.
		requeue := !d.Redelivered
		if nackErr := d.Nack(false, requeue); nackErr != nil {
			logger.Error("consumer: nack failed", "error", nackErr)
		}
		return
	}

	if ackErr := d.Ack(false /* multiple=false: ack only this message */); ackErr != nil {
		logger.Error("consumer: ack failed", "error", ackErr)
	}
}

// BulkConsumer demonstrates multiple=true for bulk ack.
// Acks all messages up to and including the given delivery tag.
func BulkAck(ch *amqp.Channel, upToTag uint64) error {
	// multiple=true: ack all unacknowledged deliveries up to upToTag
	return ch.Ack(upToTag, true)
}
```

### Junior → FAANG: Acknowledgments and the Requeue Decision

Every junior who has written a consumer has had a bug where messages disappear or loop forever. Both failures come from the same root cause: not understanding what requeue means and when to use it.

**The requeue=true trap:**

When you call `d.Nack(false, true)`, you tell the broker to put the message back at the front of the queue immediately. If your handler fails because of a bug or a bad payload, the message comes back immediately and your handler fails again. Infinitely. This is a busy loop that consumes 100% of one consumer goroutine and produces zero useful work. The broker delivers the message with `Redelivered: true` on the second attempt. The correct pattern in this codebase is to requeue on the first failure and reject to DLX on the second, using `d.Redelivered` as the signal.

**The requeue=false path:**

`d.Nack(false, false)` tells the broker to dead-letter the message if a DLX is configured, or drop it if no DLX is configured. A message that reaches the DLX is available for inspection and replay. A message that is dropped silently is lost. Always configure a DLX on any queue that uses manual ack. Without it, requeue=false means silent data loss.

**Prefetch as a flow control knob:**

Start with prefetch=10 for any new consumer. Observe queue depth and consumer latency under load. If queue depth grows faster than consumers drain it, increase prefetch or add consumers. If individual consumer memory usage is high (the consumer is holding many in-flight messages), decrease prefetch. The formula `prefetch * avg_message_size * num_consumers` gives you the maximum memory the consumer pool can hold from unacknowledged messages.

**Interview question: "what does autoAck=true do":**

Never use `autoAck=true` in production. When autoAck is true, the broker marks a message as delivered as soon as it sends it to the consumer, without waiting for an acknowledgment. If the consumer crashes while processing, the message is lost. The only correct answer to "when should I use autoAck=true" is "never in production."

### Senior @ FAANG: Consumer Design for Durability and Throughput at Scale

Consumer QoS design at FAANG scale involves tradeoffs between throughput, memory, ordering, and tail latency that cannot be resolved with a single prefetch value. The design space requires understanding the interaction between prefetch, consumer concurrency, and message ordering guarantees.

**Prefetch and single-active consumer semantics:**

RabbitMQ supports a `x-single-active-consumer` argument that ensures only one consumer on a queue receives messages at a time. This preserves per-queue ordering even with multiple consumer registrations (the others wait in standby). The interaction with prefetch is subtle: a single-active consumer with prefetch=50 can hold 50 in-flight messages while other registered consumers receive none. If the active consumer is slow, the entire queue is throttled. Sizing prefetch for single-active-consumer queues requires understanding the processing time distribution, not just the average.

**Bulk ack performance vs safety tradeoff in high-throughput systems:**

At 50,000 messages per second on a single consumer goroutine, per-message ack adds 50,000 AMQP Method frames per second in the ack direction. Each frame requires broker processing and a write to the quorum log on the replica set. Bulk ack (`multiple=true`) collapses many acks into one frame, reducing broker write amplification. The safety tradeoff: if the consumer crashes after processing messages 1-1000 but before acking them with `Ack(1000, true)`, all 1000 messages are redelivered. Idempotent handlers absorb this without data corruption. Non-idempotent handlers create 1000 duplicates. The correct design question before enabling bulk ack is always "is this handler idempotent by design or by accident?"

**Consumer group isolation in multi-tenant systems:**

In a multi-tenant platform where different customers have different SLA tiers, a single shared queue with mixed customer messages means a single slow customer's processing backlog degrades all other customers. The correct design is separate queues per SLA tier (gold, silver, bronze) with dedicated consumer pools sized per tier. This eliminates head-of-line blocking across tenants. The exchange routing key or headers exchange can route messages to the correct tier queue based on message metadata without the producer knowing about the tier structure.

**Graceful shutdown ordering:**

The shutdown sequence for a consumer matters for message loss. The correct order is: cancel the consumer (`ch.Cancel`) to stop the broker from delivering new messages, drain all in-flight deliveries (wait for the delivery channel to drain), ack or nack all pending deliveries, then close the channel, then close the connection. Closing the connection first returns all unacked messages to the queue immediately but races with the in-flight processing loop. A clean cancel and drain prevents this race. The `Consumer.Run` method above handles context cancellation but does not explicitly cancel the consumer, leaving a window between context cancellation and channel close where the broker continues delivering messages that the consumer will not process.

---
