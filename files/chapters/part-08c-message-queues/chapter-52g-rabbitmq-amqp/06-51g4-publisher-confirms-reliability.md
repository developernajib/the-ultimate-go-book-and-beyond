## 52G.4 Publisher Confirms & Reliability

By default, `Channel.Publish` is fire-and-forget. The broker may drop the message if memory is full, the queue does not exist, or the broker crashes mid-write. **Publisher confirms** provide at-least-once delivery at the broker level.

### Asynchronous Publisher with Confirms

Publisher confirms are RabbitMQ's mechanism for guaranteeing that the broker has accepted and persisted a message before the producer considers it delivered. The following implementation uses asynchronous confirm mode, which allows the producer to pipeline multiple publishes and reconcile acknowledgments in a separate goroutine for maximum throughput.

```go
package publisher

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// PendingConfirm tracks an in-flight published message.
type PendingConfirm struct {
	SeqNo    uint64
	Body     []byte
	Exchange string
	Key      string
	done     chan struct{}
	err      error
}

// Wait blocks until the confirm is received or ctx expires.
func (p *PendingConfirm) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return p.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ConfirmingPublisher publishes messages and tracks broker confirms asynchronously.
type ConfirmingPublisher struct {
	ch       *amqp.Channel
	confirms <-chan amqp.Confirmation
	returns  <-chan amqp.Return

	mu      sync.Mutex
	pending map[uint64]*PendingConfirm

	logger *slog.Logger
}

// NewConfirmingPublisher puts the channel into confirm mode and starts
// the confirm/return listener goroutines.
func NewConfirmingPublisher(ch *amqp.Channel, logger *slog.Logger) (*ConfirmingPublisher, error) {
	// Enable publisher confirms on this channel.
	if err := ch.Confirm(false /* no-wait */); err != nil {
		return nil, fmt.Errorf("confirm mode: %w", err)
	}

	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 256))
	returns := ch.NotifyReturn(make(chan amqp.Return, 64))

	p := &ConfirmingPublisher{
		ch:       ch,
		confirms: confirms,
		returns:  returns,
		pending:  make(map[uint64]*PendingConfirm),
		logger:   logger,
	}

	go p.handleConfirms()
	go p.handleReturns()

	return p, nil
}

// handleConfirms processes broker acknowledgments in the background.
func (p *ConfirmingPublisher) handleConfirms() {
	for confirm := range p.confirms {
		p.mu.Lock()
		pend, ok := p.pending[confirm.DeliveryTag]
		if ok {
			delete(p.pending, confirm.DeliveryTag)
		}
		p.mu.Unlock()

		if !ok {
			p.logger.Warn("publisher: received confirm for unknown seq",
				"seq", confirm.DeliveryTag)
			continue
		}

		if confirm.Ack {
			pend.err = nil
			p.logger.Debug("publisher: message confirmed",
				"seq", confirm.DeliveryTag,
				"exchange", pend.Exchange,
			)
		} else {
			// Nack: broker could not enqueue (e.g., queue full, internal error).
			pend.err = fmt.Errorf("nack received for seq %d", confirm.DeliveryTag)
			p.logger.Error("publisher: message nacked",
				"seq", confirm.DeliveryTag,
				"exchange", pend.Exchange,
			)
		}
		close(pend.done)
	}
}

// handleReturns processes mandatory messages that could not be routed.
func (p *ConfirmingPublisher) handleReturns() {
	for ret := range p.returns {
		p.logger.Error("publisher: message returned (unroutable)",
			"exchange", ret.Exchange,
			"routing_key", ret.RoutingKey,
			"reply_code", ret.ReplyCode,
			"reply_text", ret.ReplyText,
		)
	}
}

// Publish sends a message and returns a PendingConfirm to await the broker ack.
func (p *ConfirmingPublisher) Publish(
	ctx context.Context,
	exchange, routingKey string,
	body []byte,
) (*PendingConfirm, error) {
	pend := &PendingConfirm{
		Body:     body,
		Exchange: exchange,
		Key:      routingKey,
		done:     make(chan struct{}),
	}

	p.mu.Lock()
	// GetNextPublishSeqNo returns the seq number the NEXT publish will use.
	seqNo := p.ch.GetNextPublishSeqNo()
	p.pending[seqNo] = pend
	p.mu.Unlock()

	err := p.ch.PublishWithContext(ctx, exchange, routingKey, true, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Timestamp:    time.Now(),
			Body:         body,
		},
	)
	if err != nil {
		p.mu.Lock()
		delete(p.pending, seqNo)
		p.mu.Unlock()
		return nil, fmt.Errorf("publish: %w", err)
	}

	pend.SeqNo = seqNo
	return pend, nil
}

// PublishAndWait publishes and synchronously waits for the broker confirm.
// Suitable for low-throughput, high-reliability paths.
func (p *ConfirmingPublisher) PublishAndWait(
	ctx context.Context,
	exchange, routingKey string,
	body []byte,
) error {
	pend, err := p.Publish(ctx, exchange, routingKey, body)
	if err != nil {
		return err
	}
	return pend.Wait(ctx)
}
```

### Junior → FAANG: Publisher Confirms Are Not Optional

The single most common reliability mistake in RabbitMQ code written by junior engineers is publishing without confirms. Understanding why requires understanding what "publish" actually does at the protocol level.

**What happens without confirms:**

`ch.PublishWithContext` sends an AMQP Method frame to the broker and returns immediately. It does not wait for the broker to acknowledge receipt. If the broker is under memory pressure, the queue is full, or the broker crashes between receiving the frame and writing it to disk, the message is lost. Your producer code sees no error. The return value is nil. The message is gone.

**What confirms actually guarantee:**

When you call `ch.Confirm(false)` on a channel, you are enabling confirm mode for that channel. Every subsequent publish on that channel receives a sequence number. After the broker has durably accepted the message (for a quorum queue, this means a quorum of replicas have acknowledged the write), it sends a Confirmation frame back with the sequence number and an `Ack` flag. Only at this point can you safely consider the message delivered.

**The nack case:**

A nack (`Ack == false`) means the broker could not accept the message. Common causes: the queue has exceeded `x-max-length` with `x-overflow: reject-publish`, the broker has a memory alarm active, or an internal broker error. A nack is not a network error and it is not a transient condition you should silently retry. It requires explicit handling: log it, increment a counter, and retry with backoff only after the underlying cause is resolved.

**Interview pattern: describe publisher confirms from memory:**

State the sequence: enable confirm mode, observe the sequence number before publishing, track the pending map from sequence number to your callback, handle the async confirm channel in a goroutine, on nack trigger retry logic. Candidates who describe synchronous per-message waiting without explaining why that hurts throughput are showing partial knowledge.

### Senior @ FAANG: Publisher Confirms, Outbox Pattern, and Exactly-Once Semantics

Publisher confirms give you at-least-once delivery from the application to the broker. The gap between at-least-once and exactly-once requires a different pattern, and understanding that gap is a senior-level concern.

**The publish-before-confirm crash window:**

Consider a producer that publishes a message and then crashes before receiving the confirm. When the producer restarts, it does not know whether the message was received by the broker. If it re-publishes, the consumer receives it twice. At-least-once delivery makes this redelivery acceptable by contract, but only if the consumer is idempotent. The confirm mechanism does not close this window. It only tells you that the broker received the message you just sent, not whether a previous crashed attempt succeeded.

**The outbox pattern for exactly-once-to-broker semantics:**

To close the crash window, the producer must durably record its intent to publish before publishing. The pattern: write the message to a local database table (the outbox) in the same transaction as the business operation that triggered it. A separate goroutine reads the outbox and publishes to RabbitMQ with confirms. On successful confirm, mark the outbox row as sent. On broker nack, leave the row and retry on the next polling cycle. This guarantees that even if the process crashes mid-publish, the outbox row survives and the message is published on the next restart. The consumer still receives duplicates if the process crashes after the broker confirm but before the outbox row is marked sent, so idempotent consumers remain required, but the window is narrowed to this exact case.

**In-flight map memory bounds:**

The `ConfirmingPublisher` in this section maintains a `map[uint64]*PendingConfirm`. In a high-throughput publisher, this map can grow without bound if confirms are not delivered promptly, for example during a broker slowdown. The map size is bounded by the number of unconfirmed messages, which is bounded by the window between publish rate and confirm rate. At 50,000 messages per second and a 200ms confirm latency, the in-flight map holds 10,000 entries. Each `PendingConfirm` holds the body bytes and a channel, so at 1KB average message size, this is 10MB in the map alone, not counting the channel pool. The platform library should expose a metric for pending confirm count and alert when it exceeds a threshold, because a growing in-flight map is an early indicator of broker overload.

**Per-channel confirms and the multi-publisher architecture:**

Confirm mode is per-channel, not per-connection. A channel in confirm mode must not be shared with non-confirm publishes. In a service that publishes both high-priority (needs confirms) and low-priority (fire-and-forget acceptable) messages, use two channels: one in confirm mode for high-priority, one in normal mode for low-priority. Mixing them on a single channel means either all messages pay the confirm overhead or none do.

---
