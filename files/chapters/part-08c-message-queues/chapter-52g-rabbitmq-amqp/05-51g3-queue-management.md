## 52G.3 Queue Management

### Queue Properties and Types

RabbitMQ offers several queue types (classic, quorum, and stream), each with different durability, ordering, and replication guarantees. The following code and configuration table show how to declare each type with the correct arguments, helping you select the right queue type based on your reliability and throughput requirements.

```go
package queues

import (
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
)

// QueueOptions configures queue declaration.
type QueueOptions struct {
	Name        string
	Durable     bool          // survives broker restart
	AutoDelete  bool          // deleted when last consumer disconnects
	Exclusive   bool          // only accessible by declaring connection
	QueueType   string        // "classic", "quorum", "stream"
	TTL         int32         // x-message-ttl in milliseconds
	MaxLength   int32         // x-max-length: max number of messages
	MaxPriority int8          // x-max-priority: enable priority (1-255)
	DLX         string        // x-dead-letter-exchange
	DLRK        string        // x-dead-letter-routing-key
}

// DeclareQueue creates a queue from options following the builder pattern.
func DeclareQueue(ch *amqp.Channel, opts QueueOptions) (amqp.Queue, error) {
	args := amqp.Table{}

	if opts.QueueType != "" {
		args["x-queue-type"] = opts.QueueType
	}
	if opts.TTL > 0 {
		args["x-message-ttl"] = opts.TTL
	}
	if opts.MaxLength > 0 {
		args["x-max-length"] = opts.MaxLength
	}
	if opts.MaxPriority > 0 {
		args["x-max-priority"] = opts.MaxPriority
	}
	if opts.DLX != "" {
		args["x-dead-letter-exchange"] = opts.DLX
	}
	if opts.DLRK != "" {
		args["x-dead-letter-routing-key"] = opts.DLRK
	}

	q, err := ch.QueueDeclare(
		opts.Name,
		opts.Durable,
		opts.AutoDelete,
		opts.Exclusive,
		false, // no-wait
		args,
	)
	if err != nil {
		return amqp.Queue{}, fmt.Errorf("declare queue %q: %w", opts.Name, err)
	}

	return q, nil
}

// DeclareQuorumQueue creates a production-ready quorum queue.
// Quorum queues use Raft consensus (recommended since RabbitMQ 3.8+).
// They do NOT support: per-message TTL, priority, lazy mode.
func DeclareQuorumQueue(ch *amqp.Channel, name string, dlx string) (amqp.Queue, error) {
	return DeclareQueue(ch, QueueOptions{
		Name:      name,
		Durable:   true, // quorum queues are always durable
		QueueType: "quorum",
		MaxLength: 500000,
		DLX:       dlx,
		DLRK:      name,
	})
}

// DeclareLazyQueue creates a classic lazy queue (stores to disk, not memory).
// Use when queue depth routinely exceeds hundreds of thousands of messages.
// Note: lazy mode is deprecated in RabbitMQ 3.12+ (all queues are lazy by default).
func DeclareLazyQueue(ch *amqp.Channel, name string) (amqp.Queue, error) {
	return DeclareQueue(ch, QueueOptions{
		Name:      name,
		Durable:   true,
		QueueType: "classic",
		MaxLength: 10_000_000,
	})
}
```

### Junior → FAANG: Queue Properties Are Production Safety Levers

Most junior engineers declare queues with minimal arguments and then discover why the arguments matter when a production incident occurs. Learn the critical arguments before you need them.

**The three arguments every queue must have in production:**

`x-message-ttl` sets the maximum time a message can sit in the queue before being dead-lettered or dropped. Without this, a consumer outage that lasts six hours leaves six hours of messages piled up. When the consumer comes back, it is immediately flooded. With a TTL, stale messages expire automatically and the consumer starts fresh when it recovers.

`x-max-length` sets the maximum number of messages in the queue. Without this, a slow consumer combined with a fast producer fills the broker's memory, triggering a memory alarm that blocks every producer on the cluster. Setting max-length protects the cluster from a single queue growing without bound.

`x-dead-letter-exchange` tells the broker where to route messages that expire or are rejected. Without this, expired and rejected messages are silently discarded. With it, you have an auditable trail of every message that failed processing.

**Queue type selection in one sentence per type:**

Classic: use for ephemeral or non-critical workloads on a single node where replication is not needed. Quorum: use for all production work queues where data loss on node failure is unacceptable. Stream: use when you need message replay, high-fanout, or log-style retention.

**Interview framing for queue declaration:**

When an interviewer asks "how would you declare a queue for a payment processing system," the expected answer names quorum queue type, durable, max-length, message TTL, and DLX. A candidate who only says `durable: true` has demonstrated knowledge of the API but not production judgment.

### Senior @ FAANG: Queue Management as Platform Policy

At the senior level, queue management is not a per-service decision. It is a platform policy enforced centrally.

**Operator policies as a governance layer:**

RabbitMQ operator policies allow a cluster administrator to apply queue arguments to all queues matching a name pattern, overriding or supplementing what the declaring application set. For example, an operator policy on `.*` that enforces `x-max-length: 1000000` and `x-overflow: reject-publish` means that no application can create an unbounded queue regardless of how it calls `QueueDeclare`. This is the infrastructure equivalent of a linter that cannot be silenced. The platform team applies this policy and individual service teams cannot override it.

**The `reject-publish` vs `drop-head` overflow decision:**

These two overflow behaviors represent a consistency vs availability tradeoff. `drop-head` drops the oldest message when the queue is full, keeping producers flowing but losing data. `reject-publish` sends a nack to the producer when the queue is full, letting the producer handle backpressure. For financial and audit data, `reject-publish` is always correct because data loss is unacceptable. For telemetry and metrics, `drop-head` may be acceptable because losing an old data point is preferable to blocking producers. This decision belongs in an ADR because it affects every component that publishes to the queue.

**Quorum queue replication factor and cluster sizing:**

A quorum queue with a replication factor of 3 requires 3 replicas to be available for writes. In a 5-node cluster, this means 2 nodes can fail before the queue becomes unavailable. The platform team must decide the replication factor per queue type based on the durability requirement and the cluster size. The replication factor is set via `x-quorum-initial-group-size` at declaration time and cannot be changed without recreating the queue. This is a deployment concern, not an application concern, which reinforces why queue topology should be owned by the platform team, not individual service teams.

**Queue argument immutability and the PRECONDITION_FAILED trap:**

Once a queue is declared with a given set of arguments, redeclaring it with different arguments causes the broker to return `PRECONDITION_FAILED` and close the channel. This is the most common source of deployment failures in services that declare their own topology at startup. If the operations team changes `x-max-length` in the infrastructure code and a service restarts before the queue is deleted and recreated, every startup attempt closes the channel. The fix is either passive declaration (check if queue exists and matches, fail loudly if not) or externalized topology management where the queue declaration lifecycle is owned separately from the service deployment lifecycle.

---
