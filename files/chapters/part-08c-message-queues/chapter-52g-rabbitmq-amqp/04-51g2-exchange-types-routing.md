## 52G.2 Exchange Types & Routing

RabbitMQ implements five exchange types. Choosing the wrong one is a common architectural mistake.

### Direct Exchange - Exact Routing Key Match

A direct exchange routes each message to queues whose binding key exactly matches the message's routing key. This is the simplest and most common exchange type, used for task distribution, RPC reply routing, and any scenario where each message has a single known destination. The following code declares a direct exchange, binds a quorum queue to it, and publishes a message with a specific routing key.

```go
package exchanges

import (
	"context"
	"fmt"
	"log/slog"

	amqp "github.com/rabbitmq/amqp091-go"
)

// SetupDirectExchange declares a direct exchange, a queue, and binds them.
func SetupDirectExchange(ch *amqp.Channel) error {
	// Declare the exchange.
	if err := ch.ExchangeDeclare(
		"orders",  // name
		"direct",  // kind
		true,      // durable (survives broker restart)
		false,     // auto-deleted (delete when no bindings)
		false,     // internal (cannot publish directly)
		false,     // no-wait
		nil,       // arguments
	); err != nil {
		return fmt.Errorf("direct exchange declare: %w", err)
	}

	// Declare the queue.
	q, err := ch.QueueDeclare(
		"orders.new", // name
		true,         // durable
		false,        // auto-delete
		false,        // exclusive
		false,        // no-wait
		amqp.Table{
			"x-queue-type": "quorum", // use quorum for HA
		},
	)
	if err != nil {
		return fmt.Errorf("orders.new queue declare: %w", err)
	}

	// Bind: queue receives messages where routing_key == "new"
	if err := ch.QueueBind(q.Name, "new", "orders", false, nil); err != nil {
		return fmt.Errorf("orders.new queue bind: %w", err)
	}

	slog.Info("direct exchange ready", "exchange", "orders", "queue", q.Name)
	return nil
}

// PublishDirect sends a message to the direct exchange with a routing key.
func PublishDirect(ctx context.Context, ch *amqp.Channel, routingKey string, body []byte) error {
	return ch.PublishWithContext(ctx,
		"orders",   // exchange
		routingKey, // routing key (must match binding)
		true,       // mandatory: return if unroutable
		false,      // immediate: deprecated, always false
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent, // survive broker restart
			Body:         body,
		},
	)
}
```

### Topic Exchange - Wildcard Routing

A topic exchange routes messages based on wildcard matching against dot-separated routing keys. This is the right choice for log routing, event filtering by category and severity, and any scenario where consumers need to subscribe to a subset of a hierarchical message space. Two wildcards are available: `*` matches exactly one word, and `#` matches zero or more words. The following code creates a topic exchange with three queues bound to different patterns, demonstrating how a single published message can reach multiple queues based on partial key matching.

```go
// SetupTopicExchange demonstrates topic exchange routing.
// Routing patterns:
//   logs.error.payment → matches "logs.#", "logs.error.*", "logs.error.payment"
//   logs.info.auth     → matches "logs.#", "logs.info.*"
func SetupTopicExchange(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare("logs", "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("topic exchange declare: %w", err)
	}

	queues := []struct {
		name    string
		pattern string
	}{
		{"logs.all", "logs.#"},           // all logs
		{"logs.errors", "logs.error.*"},  // only errors
		{"logs.payment", "logs.*.payment"}, // all payment logs
	}

	for _, q := range queues {
		if _, err := ch.QueueDeclare(q.name, true, false, false, false, nil); err != nil {
			return fmt.Errorf("queue declare %s: %w", q.name, err)
		}
		if err := ch.QueueBind(q.name, q.pattern, "logs", false, nil); err != nil {
			return fmt.Errorf("queue bind %s: %w", q.name, err)
		}
	}

	return nil
}
```

### Fanout Exchange - Broadcast

A fanout exchange ignores the routing key entirely and delivers a copy of every message to all bound queues. This makes it the correct choice for broadcast scenarios: cache invalidation across multiple services, real-time notification delivery to email/push/webhook consumers simultaneously, and event streaming to multiple independent processors. The following code binds three subscriber queues to a single fanout exchange.

```go
// SetupFanoutExchange broadcasts every message to all bound queues.
// Routing key is ignored by fanout exchanges.
func SetupFanoutExchange(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare("events", "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("fanout exchange declare: %w", err)
	}

	subscribers := []string{"events.email", "events.push", "events.webhook"}
	for _, name := range subscribers {
		if _, err := ch.QueueDeclare(name, true, false, false, false, nil); err != nil {
			return fmt.Errorf("queue declare %s: %w", name, err)
		}
		// Routing key "" is ignored for fanout.
		if err := ch.QueueBind(name, "", "events", false, nil); err != nil {
			return fmt.Errorf("queue bind %s: %w", name, err)
		}
	}

	return nil
}
```

### Headers Exchange - Attribute-Based Routing

A headers exchange routes messages by matching key-value pairs in the message headers against the binding arguments, ignoring the routing key. Use this when routing depends on multiple attributes simultaneously, for example, routing notifications by both region and priority level, where a single routing key string cannot express the combination cleanly. The `x-match` argument on the binding controls whether all headers must match (`all`) or at least one (`any`).

```go
// SetupHeadersExchange routes by message header attributes.
// x-match: "all" requires all headers to match; "any" requires at least one.
func SetupHeadersExchange(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare("notifications", "headers", true, false, false, false, nil); err != nil {
		return fmt.Errorf("headers exchange declare: %w", err)
	}

	if _, err := ch.QueueDeclare("notifications.sms", true, false, false, false, nil); err != nil {
		return fmt.Errorf("sms queue declare: %w", err)
	}

	// Bind with header matching: x-match=all means ALL headers must match.
	bindArgs := amqp.Table{
		"x-match":  "all",
		"region":   "us-east",
		"priority": "high",
	}
	return ch.QueueBind("notifications.sms", "", "notifications", false, bindArgs)
}

// PublishWithHeaders publishes using header-based routing.
func PublishWithHeaders(ctx context.Context, ch *amqp.Channel, headers amqp.Table, body []byte) error {
	return ch.PublishWithContext(ctx, "notifications", "", true, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Headers:      headers,
			Body:         body,
		},
	)
}
```

### Dead Letter Exchange Setup

Dead letter exchanges route undeliverable messages (rejected, expired, or overflow) to a separate queue for inspection and replay. The following code configures a primary queue with a DLX binding, ensuring that any message failing processing lands in an auditable dead-letter queue rather than disappearing silently.

```go
// SetupDeadLetterExchange creates a DLX pattern: original queue sends dead letters
// to the DLX which routes them to a dead letter queue.
func SetupDeadLetterExchange(ch *amqp.Channel) error {
	// 1. Declare the DLX (just a regular direct exchange).
	if err := ch.ExchangeDeclare("orders.dlx", "direct", true, false, false, false, nil); err != nil {
		return fmt.Errorf("dlx declare: %w", err)
	}

	// 2. Declare the dead letter queue.
	if _, err := ch.QueueDeclare("orders.dead", true, false, false, false, nil); err != nil {
		return fmt.Errorf("dead letter queue declare: %w", err)
	}
	if err := ch.QueueBind("orders.dead", "orders.new", "orders.dlx", false, nil); err != nil {
		return fmt.Errorf("dead letter queue bind: %w", err)
	}

	// 3. Declare the original queue with DLX configured.
	_, err := ch.QueueDeclare("orders.new", true, false, false, false, amqp.Table{
		"x-queue-type":              "quorum",
		"x-dead-letter-exchange":    "orders.dlx",
		"x-dead-letter-routing-key": "orders.new", // routing key on DLX
		"x-message-ttl":             int32(86400000), // 24h TTL
		"x-max-length":              int32(100000),   // max 100K messages
	})
	return err
}
```

### Junior → FAANG: Choosing the Right Exchange Type

The four exchange types each solve a specific routing problem. Picking the wrong one is a common interview and on-the-job mistake.

**Decision rules you must memorize:**

Use direct when you know exactly which queue a message belongs to at publish time and there is a one-to-one relationship between routing key and destination. The routing key is the queue name in the simplest case. Task dispatch and RPC reply queues are the canonical examples.

Use topic when you want consumers to subscribe to a subset of a hierarchical event space without the producer knowing which consumers exist. The producer publishes `payments.eu.completed` and any queue bound to `payments.#`, `payments.eu.*`, or `payments.*.completed` receives a copy. Adding a new consumer never requires a producer change.

Use fanout when you need every bound consumer to receive every message with no filtering. Cache invalidation, real-time notification broadcast, and audit log replication are correct uses. Fanout is faster than topic because it skips routing key evaluation entirely.

Use headers when routing depends on multiple independent attributes simultaneously and a dot-separated routing key string cannot encode the combination cleanly. In practice, headers exchange is rarely the right choice because it makes routing invisible to anyone reading the code. If you reach for headers, first ask whether a topic exchange with a carefully designed key hierarchy solves the same problem more transparently.

**Interview trap: "which exchange type is best":**

The correct answer is "it depends on the routing requirement." Topic is the most versatile and covers the majority of real-world cases. Fanout is correct for pure broadcast. Direct is correct when the destination is known and fixed. Headers is almost always avoidable. State these rules and then apply one to a concrete example the interviewer gives you.

### Senior @ FAANG: Exchange Topology as Runtime-Flexible Infrastructure

At the senior level, exchange type selection is an architectural decision with long-term operational consequences, not a one-time implementation choice.

**Topic exchange as the foundation for Open-Closed routing:**

The Open-Closed Principle at infrastructure level means that adding a new consumer pipeline should not require changes to the producer or to the broker configuration that the producer owns. Topic exchanges achieve this when the routing key hierarchy is designed with extension in mind. A key like `orders.{region}.{status}` allows a new analytics team to bind `orders.#` and receive everything, a compliance team to bind `orders.*.completed` and receive only completions, and a regional ops team to bind `orders.eu.*` and receive only EU activity. The producer never changes. This is the same extensibility pattern as interface design in Go.

**Exchange-to-exchange bindings for composable topology:**

RabbitMQ supports binding one exchange to another, a feature that most engineers never discover. This enables composable routing topologies. A fanout exchange can fan out to multiple topic exchanges, each of which applies its own filtering rules. This separates broadcast semantics (fanout) from routing semantics (topic) into independent components. The operational benefit is that you can add a new topic exchange with its own binding logic without touching the fanout exchange or any existing bindings. This is the infrastructure equivalent of the decorator pattern.

**Mandatory flag and NotifyReturn as a correctness invariant:**

Publishing with `mandatory: true` tells the broker to return the message via `NotifyReturn` if it cannot be routed to any queue. In production, unroutable messages are a configuration bug, either a missing binding or a typo in the routing key. Without the mandatory flag, unroutable messages are silently dropped. The broker logs them, but if nobody reads broker logs, the data loss is invisible. At FAANG, the expectation is that `NotifyReturn` is always instrumented with an error log and a metric increment, so unroutable messages surface in alerting within minutes.

**DLX as a separate exchange, not a queue:**

A common mistake is confusing the dead-letter exchange with the dead-letter queue. The DLX is a regular exchange. The DLQ is the queue bound to that exchange. This distinction matters for topology design: you can bind multiple queues to the same DLX with different routing keys to create tiered dead-letter handling (retry queue, permanent failure queue, alert queue). The DLX itself has no special behavior, it is just an exchange that happens to receive dead-lettered messages. Understanding this lets you compose retry topologies from primitives rather than relying on magic.

---
