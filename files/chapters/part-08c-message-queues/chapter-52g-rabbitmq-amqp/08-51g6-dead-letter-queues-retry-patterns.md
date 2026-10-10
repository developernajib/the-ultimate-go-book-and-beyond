## 52G.6 Dead Letter Queues & Retry Patterns

### Why Messages Become Dead Letters

A message becomes a dead letter when:
1. Rejected with `requeue=false` (`Reject` or `Nack`)
2. Message TTL (`x-message-ttl`) expires on the queue
3. Queue max-length (`x-max-length`) is exceeded and overflow policy is `drop-head`

### Exponential Backoff Retry with TTL Queues

RabbitMQ supports exponential backoff retry natively using TTL queues chained through dead letter exchanges, without any plugins or external retry libraries. The core idea: when a consumer rejects a message, it flows to a DLX that routes it to a TTL-based holding queue. After the TTL expires, the message dead-letters back to the original work queue for another processing attempt. Multiple TTL queues at increasing delays (5s, 30s, 5m) create the exponential backoff tiers.

```
worker.queue ─(reject)──► dlx.orders ─► retry.orders.5s ─(TTL=5s)──► worker.queue
                                      ├► retry.orders.30s─(TTL=30s)─► worker.queue
                                      └► retry.orders.5m ─(TTL=5m)──► worker.queue
```

The following implementation sets up the full retry topology (DLX, TTL retry queues at each backoff level, a permanent dead-letter queue for poison messages), and a `RetryPublisher` that tracks retry count in message headers and routes failures to the appropriate backoff tier.

```go
package retry

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// RetryConfig defines the backoff schedule.
type RetryConfig struct {
	WorkQueue   string
	DLX         string
	MaxAttempts int
	Delays      []time.Duration // length = number of retry levels
}

// DefaultRetryConfig provides a 3-level exponential backoff.
func DefaultRetryConfig(queueName string) RetryConfig {
	return RetryConfig{
		WorkQueue:   queueName,
		DLX:         queueName + ".dlx",
		MaxAttempts: 4, // 1 original + 3 retries
		Delays:      []time.Duration{5 * time.Second, 30 * time.Second, 5 * time.Minute},
	}
}

// SetupRetryTopology creates all queues/exchanges needed for exponential backoff retry.
func SetupRetryTopology(ch *amqp.Channel, cfg RetryConfig) error {
	// 1. DLX (receives failed messages from worker queue).
	if err := ch.ExchangeDeclare(cfg.DLX, "direct", true, false, false, false, nil); err != nil {
		return fmt.Errorf("dlx declare: %w", err)
	}

	// 2. Permanent DLQ (poison messages after all retries exhausted).
	dlqName := cfg.WorkQueue + ".failed"
	if _, err := ch.QueueDeclare(dlqName, true, false, false, false, nil); err != nil {
		return fmt.Errorf("dlq declare: %w", err)
	}
	if err := ch.QueueBind(dlqName, "failed", cfg.DLX, false, nil); err != nil {
		return fmt.Errorf("dlq bind: %w", err)
	}

	// 3. Retry queues with TTL - when TTL expires, message goes back to work queue.
	for i, delay := range cfg.Delays {
		retryQueue := fmt.Sprintf("%s.retry.%d", cfg.WorkQueue, i+1)
		ttlMs := int32(delay.Milliseconds())

		if _, err := ch.QueueDeclare(retryQueue, true, false, false, false, amqp.Table{
			"x-message-ttl":             ttlMs,
			"x-dead-letter-exchange":    "",             // default exchange
			"x-dead-letter-routing-key": cfg.WorkQueue, // route back to worker queue
		}); err != nil {
			return fmt.Errorf("retry queue %s declare: %w", retryQueue, err)
		}

		// Bind retry queue to DLX with routing key "retry.N"
		rk := fmt.Sprintf("retry.%d", i+1)
		if err := ch.QueueBind(retryQueue, rk, cfg.DLX, false, nil); err != nil {
			return fmt.Errorf("retry queue %s bind: %w", retryQueue, err)
		}
	}

	// 4. Worker queue with DLX configured.
	if _, err := ch.QueueDeclare(cfg.WorkQueue, true, false, false, false, amqp.Table{
		"x-queue-type":              "quorum",
		"x-dead-letter-exchange":    cfg.DLX,
		"x-dead-letter-routing-key": "retry.1", // first retry level
	}); err != nil {
		return fmt.Errorf("work queue declare: %w", err)
	}

	return nil
}

// RetryHeader is stored in message headers to track retry state.
const (
	HeaderRetryCount = "x-retry-count"
	HeaderOriginalQ  = "x-original-queue"
	HeaderLastError  = "x-last-error"
)

// RetryPublisher re-publishes a failed delivery to the appropriate retry level.
type RetryPublisher struct {
	ch     *amqp.Channel
	cfg    RetryConfig
	logger *slog.Logger
}

func NewRetryPublisher(ch *amqp.Channel, cfg RetryConfig, logger *slog.Logger) *RetryPublisher {
	return &RetryPublisher{ch: ch, cfg: cfg, logger: logger}
}

// HandleFailure decides whether to retry or send to permanent DLQ.
func (r *RetryPublisher) HandleFailure(ctx context.Context, d amqp.Delivery, handlerErr error) error {
	retryCount := int32(0)
	if v, ok := d.Headers[HeaderRetryCount]; ok {
		retryCount, _ = v.(int32)
	}
	retryCount++

	if int(retryCount) > len(r.cfg.Delays) {
		// Poison message - all retries exhausted.
		r.logger.Error("retry: max attempts reached, sending to DLQ",
			"queue", r.cfg.WorkQueue,
			"retry_count", retryCount,
			"error", handlerErr,
		)
		return r.publishToDLQ(ctx, d, handlerErr, retryCount)
	}

	routingKey := fmt.Sprintf("retry.%d", retryCount)
	r.logger.Warn("retry: scheduling retry",
		"routing_key", routingKey,
		"retry_count", retryCount,
		"delay", r.cfg.Delays[retryCount-1],
	)

	headers := amqp.Table{}
	for k, v := range d.Headers {
		headers[k] = v
	}
	headers[HeaderRetryCount] = retryCount
	headers[HeaderOriginalQ] = r.cfg.WorkQueue
	headers[HeaderLastError] = handlerErr.Error()

	return r.ch.PublishWithContext(ctx, r.cfg.DLX, routingKey, false, false,
		amqp.Publishing{
			ContentType:  d.ContentType,
			DeliveryMode: amqp.Persistent,
			Headers:      headers,
			Body:         d.Body,
		},
	)
}

func (r *RetryPublisher) publishToDLQ(ctx context.Context, d amqp.Delivery, err error, retryCount int32) error {
	metadata, _ := json.Marshal(map[string]any{
		"original_body": string(d.Body),
		"error":         err.Error(),
		"retry_count":   retryCount,
		"timestamp":     time.Now().UTC(),
	})

	headers := amqp.Table{
		HeaderRetryCount: retryCount,
		HeaderLastError:  err.Error(),
	}

	return r.ch.PublishWithContext(ctx, r.cfg.DLX, "failed", false, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Headers:      headers,
			Body:         metadata,
		},
	)
}
```

### Junior → FAANG: Dead Letter Queues Are Production Safety Nets

Most junior engineers know what a DLQ is but cannot implement the full retry topology from scratch. Know this pattern cold before any FAANG interview.

**Why the TTL + DLX chain works:**

RabbitMQ does not have a built-in "retry in N seconds" primitive. The TTL + DLX chain emulates it using two properties of the broker. First, when a message's TTL expires in a queue, the broker dead-letters it to the queue's configured DLX. Second, the default exchange routes messages directly to a queue by name using the message's routing key. By setting a TTL queue's `x-dead-letter-exchange` to the default exchange and `x-dead-letter-routing-key` to the original work queue name, an expired message returns to the work queue automatically with no external scheduler.

**Tracking retry count in headers:**

The `x-retry-count` header in this implementation is a custom header. RabbitMQ also adds its own `x-death` header to dead-lettered messages, which contains an array of death records with the original exchange, routing key, and timestamp. You can read `x-death` instead of maintaining your own counter, but the built-in format is more complex to parse. Using a simple `x-retry-count` integer header is cleaner for most use cases.

**The permanent DLQ is not optional:**

After all retry levels are exhausted, the message must go somewhere auditable. A permanent DLQ with a separate consumer that logs and alerts is the minimum acceptable design. A system with retry logic but no permanent DLQ means failed messages eventually vanish. An interviewer who asks "what happens after max retries" expects to hear "the message goes to a permanent dead-letter queue that triggers an alert and allows manual replay."

### Senior @ FAANG: Retry Topology as an Operational Contract

At the senior level, the retry topology is not just an implementation pattern. It is an operational contract between the engineering team and the on-call rotation, defining how failures surface, how they are triaged, and how they are resolved.

**Head-of-line blocking in per-queue TTL:**

The TTL mechanism in RabbitMQ checks TTL only at the head of the queue. If a message with a very long TTL sits at the head of a retry queue, messages behind it with shorter effective TTLs are blocked from expiring even if their TTL has passed. This is the "head-of-line blocking" problem with per-queue TTL. The fix in this implementation is using separate queues per delay tier (one queue for 5s delays, one for 30s, one for 5m). Each queue is dedicated to one TTL value, so there is no head-of-line blocking across delay levels. Do not mix messages with different intended delays in the same TTL queue.

**Retry storms and downstream protection:**

When a downstream service recovers from an outage, all accumulated retry queue messages become eligible for redelivery at once. If the work queue has 100,000 messages from the retry queues all expiring within the same second, the downstream service is hit with 100,000 concurrent requests immediately. This is a retry storm. The protection strategies are: exponential backoff with jitter (randomize the exact TTL within a range so messages do not expire simultaneously), circuit breaker on the consumer (pause consumption when the downstream is unhealthy, as shown in the exercises), and rate-limiting the consumer's downstream calls explicitly with a token bucket.

**DLQ replay tooling as a platform capability:**

A permanent DLQ without replay tooling is a data graveyard. At FAANG scale, the platform team owns a replay service that reads from any DLQ, optionally transforms the message, and re-publishes it to the original exchange with the original routing key. The replay service must support: filtering by time range, filtering by error type in the headers, rate-limited replay to avoid retry storms, and dry-run mode that logs what would be replayed without actually publishing. This is a first-class platform capability, not a one-off script.

**The poison message problem at scale:**

A poison message is one that fails processing on every attempt regardless of retry count. The retry topology handles this by routing to the permanent DLQ after max retries. But at scale, a single deployment of a bug that corrupts message payloads can fill the DLQ with thousands of poison messages in minutes. The platform needs a DLQ depth alert with a threshold calibrated to normal background noise (a few messages per hour is acceptable, hundreds per minute is a deployment problem). The alert must fire before the DLQ itself fills up and triggers its own max-length overflow.

**ADR: per-message TTL vs per-queue TTL:**

The implementation in this section uses per-queue TTL (all messages in a retry queue share the same TTL). Per-message TTL is also available via the `expiration` property in `amqp.Publishing`. Per-message TTL is more flexible (each message can have a different delay) but reintroduces the head-of-line blocking problem because RabbitMQ only checks expiration at the head of the queue. The recommendation for retry topologies is always per-queue TTL with one queue per delay tier. Document this choice in an ADR because future engineers will be tempted to use per-message TTL for "more flexibility" and reintroduce the bug.

---
