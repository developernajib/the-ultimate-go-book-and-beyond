## 52G.9 Performance Tuning & Best Practices

### Anti-Pattern: One Channel Per Message

Creating a new AMQP channel for every published message is a common mistake that exhausts broker resources under any real load because channels are not cheap to create or destroy. The following before/after code illustrates the problem and shows the correct pattern: maintaining a single long-lived channel per goroutine.

```go
// BAD: creates and closes a channel for every message (100x overhead).
func badPublish(conn *amqp.Connection, body []byte) error {
	ch, _ := conn.Channel()     // expensive allocation
	defer ch.Close()
	return ch.PublishWithContext(context.Background(), "ex", "key", false, false,
		amqp.Publishing{Body: body})
}

// GOOD: reuse a channel or use a channel pool.
func goodPublish(pool *ChannelPool, body []byte) error {
	ctx := context.Background()
	ch, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer pool.Release(ch)
	return ch.PublishWithContext(ctx, "ex", "key", false, false,
		amqp.Publishing{Body: body})
}
```

### Batch Publishing with Confirms

Batching publishes before waiting for confirms dramatically increases RabbitMQ throughput by amortizing the per-message confirm round-trip latency across a group of messages. The following implementation accumulates messages in a buffer, publishes the batch, then waits for confirms with a configurable timeout before acknowledging success to the caller.

```go
package perf

import (
	"context"
	"fmt"
	"log/slog"

	amqp "github.com/rabbitmq/amqp091-go"
)

// BatchPublisher collects messages and publishes them in a batch,
// waiting for all confirms before returning.
type BatchPublisher struct {
	ch     *amqp.Channel
	confs  <-chan amqp.Confirmation
	logger *slog.Logger
}

// NewBatchPublisher enables confirm mode on ch.
func NewBatchPublisher(ch *amqp.Channel, logger *slog.Logger) (*BatchPublisher, error) {
	if err := ch.Confirm(false); err != nil {
		return nil, fmt.Errorf("confirm mode: %w", err)
	}
	return &BatchPublisher{
		ch:     ch,
		confs:  ch.NotifyPublish(make(chan amqp.Confirmation, 1024)),
		logger: logger,
	}, nil
}

// PublishBatch sends all messages and waits for all broker confirms.
func (b *BatchPublisher) PublishBatch(ctx context.Context, exchange, key string, bodies [][]byte) error {
	start := b.ch.GetNextPublishSeqNo()

	for _, body := range bodies {
		if err := b.ch.PublishWithContext(ctx, exchange, key, false, false,
			amqp.Publishing{
				DeliveryMode: amqp.Persistent,
				Body:         body,
			},
		); err != nil {
			return fmt.Errorf("batch publish: %w", err)
		}
	}

	// Collect confirmations for all published messages.
	confirmed := uint64(0)
	expected := uint64(len(bodies))
	end := start + expected - 1

	for confirmed < expected {
		select {
		case conf := <-b.confs:
			if conf.DeliveryTag >= start && conf.DeliveryTag <= end {
				if !conf.Ack {
					return fmt.Errorf("nack for seq %d", conf.DeliveryTag)
				}
				confirmed++
			}
		case <-ctx.Done():
			return fmt.Errorf("batch publish timeout after %d/%d confirms", confirmed, expected)
		}
	}

	b.logger.Debug("batch publish complete",
		"count", len(bodies),
		"exchange", exchange,
	)
	return nil
}
```

### Message Serialization Comparison

| Format | Size | Speed | Schema | Use case |
|--------|------|-------|--------|---------|
| JSON | Largest | Moderate | None | Debugging, external APIs |
| Protobuf | Smallest | Fastest | Required | Internal microservices |
| MessagePack | Medium | Fast | None | Mixed environments |

For high-throughput systems (>50K msg/s), use Protobuf. For moderate throughput (<10K msg/s) where human readability during debugging matters, JSON is acceptable.

### Junior → FAANG: Performance Habits That Prevent Production Incidents

Performance tuning is not premature optimization when the defaults guarantee failure under load. The patterns in this section are baseline habits, not advanced techniques.

**The channel-per-operation anti-pattern costs more than you think:**

Creating and closing a channel for every message involves: a TCP round-trip to send `channel.open`, broker-side Erlang process creation, a round-trip for `channel.open-ok`, the publish, and a round-trip for `channel.close`. At 1,000 messages per second, that is 3,000 extra round-trips per second. At 10ms broker round-trip time, this adds 30 seconds of extra latency per second of publish throughput. The service falls behind immediately. The channel pool pattern in this codebase eliminates this overhead entirely.

**Batch size selection is empirical, not theoretical:**

The `BatchPublisher` pattern improves throughput by amortizing confirm latency over a group of messages. The right batch size depends on your message size, broker latency, and throughput requirement. Start with batch size 100 and measure. If confirm latency is 5ms and you publish 100 messages per batch, your effective throughput ceiling is 20,000 messages per second per publishing goroutine. If you need more, either increase batch size or parallelize across multiple publishing goroutines, each with its own channel.

**JSON vs Protobuf: make the decision once, enforce it via the platform library:**

The serialization format choice affects every producer and consumer. Making it a per-service decision creates a polyglot message bus where consumers must support multiple formats. The platform library should enforce one format for internal messages (Protobuf for high-throughput, JSON for low-throughput or external integration) and provide serialization middleware that handles encoding and decoding transparently. Service teams should not be writing `json.Marshal` or `proto.Marshal` directly in their publisher and consumer code.

### Senior @ FAANG: Performance Engineering for RabbitMQ at Throughput Scale

At the senior level, performance tuning is not about applying known best practices but about profiling specific bottlenecks and making targeted changes with measured outcomes.

**The confirm latency floor and how to approach it:**

Publisher confirm latency for quorum queues has a floor determined by Raft replication latency. In a 3-node cluster with nodes in the same datacenter, this floor is 1-3ms per round-trip. With asynchronous confirms and pipelining, you can achieve 30,000-100,000 confirms per second per channel before hitting this floor. Beyond this ceiling, you must either use multiple channels in parallel (each with its own confirm goroutine) or accept reduced durability by using classic queues (which confirm on single-node write, not Raft majority). Document which ceiling you are hitting before proposing the durability tradeoff.

**Memory allocation in the hot publish path:**

In a Go service publishing 50,000 messages per second, every allocation in the publish path contributes to GC pressure. The `amqp.Publishing` struct is stack-allocated but the `Body []byte` slice it references is heap-allocated. If you allocate a new byte slice for every message, you generate 50,000 GC objects per second. The optimization is to use a `sync.Pool` for byte buffers and serialize directly into the pooled buffer, passing the buffer's bytes to `Publishing.Body`. Benchmark the allocation profile before and after with `go test -bench -memprofile` to verify the improvement is real.

**Prefetch tuning for heterogeneous message processing times:**

When a single consumer processes messages with highly variable processing times (some complete in 1ms, others in 5 seconds), a high prefetch value causes head-of-line blocking at the consumer level. A slow message occupies one worker goroutine for 5 seconds while 49 other messages sit in the prefetch buffer waiting. The solution is either separate queues per message type (so fast messages get their own consumer pool), or a work-stealing pattern where the consumer goroutine pool dynamically assigns messages to idle goroutines rather than the static channel-per-goroutine model.

**Connection-level and channel-level flow control:**

RabbitMQ implements backpressure via `Channel.Flow` frames, which tell the producer to pause publishing. The `amqp091-go` library exposes `NotifyFlow` for this. In production, a producer that receives a flow-pause frame should stop publishing, wait for the resume signal, and then re-publish any messages that were in-flight during the pause. Most production code ignores `NotifyFlow` and relies on TCP backpressure instead (the broker stops reading the socket, which eventually blocks the producer's `Write` call). For latency-sensitive producers, explicitly handling `NotifyFlow` and backing off at the application level provides more predictable behavior than waiting for TCP buffering to saturate.

---
