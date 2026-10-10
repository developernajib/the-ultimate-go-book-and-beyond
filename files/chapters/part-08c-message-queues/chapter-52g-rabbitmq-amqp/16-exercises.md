## Exercises

### Exercise 1: Notification Fanout System

**Goal**: Build a fanout system where user events are delivered to email, push, and webhook consumers with independent failure isolation.

```go
package exercise1

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// UserEvent represents an event (signup, purchase, etc.).
type UserEvent struct {
	UserID    string    `json:"user_id"`
	EventType string    `json:"event_type"`
	Payload   any       `json:"payload"`
	Timestamp time.Time `json:"timestamp"`
}

// NotificationSystem wires up the fanout topology.
type NotificationSystem struct {
	conn   *amqp.Connection
	logger *slog.Logger
}

// Setup declares the fanout exchange and three subscriber queues.
func (n *NotificationSystem) Setup(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare("user.events", "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("events exchange: %w", err)
	}

	queues := []struct {
		name string
		dlx  string
	}{
		{"notifications.email", "notifications.email.dlx"},
		{"notifications.push", "notifications.push.dlx"},
		{"notifications.webhook", "notifications.webhook.dlx"},
	}

	for _, q := range queues {
		// DLX for each queue (independent failure isolation).
		if err := ch.ExchangeDeclare(q.dlx, "direct", true, false, false, false, nil); err != nil {
			return fmt.Errorf("dlx %s: %w", q.dlx, err)
		}
		dlqName := q.name + ".failed"
		if _, err := ch.QueueDeclare(dlqName, true, false, false, false, nil); err != nil {
			return fmt.Errorf("dlq %s: %w", dlqName, err)
		}
		if err := ch.QueueBind(dlqName, "failed", q.dlx, false, nil); err != nil {
			return fmt.Errorf("dlq bind %s: %w", dlqName, err)
		}

		// Main subscriber queue.
		if _, err := ch.QueueDeclare(q.name, true, false, false, false, amqp.Table{
			"x-dead-letter-exchange":    q.dlx,
			"x-dead-letter-routing-key": "failed",
			"x-message-ttl":             int32(3600000), // 1h
			"x-max-length":              int32(100000),
		}); err != nil {
			return fmt.Errorf("queue %s: %w", q.name, err)
		}

		// Bind to fanout (routing key ignored).
		if err := ch.QueueBind(q.name, "", "user.events", false, nil); err != nil {
			return fmt.Errorf("bind %s: %w", q.name, err)
		}
	}

	n.logger.Info("fanout topology ready")
	return nil
}

// PublishEvent sends a user event to all subscribers.
func (n *NotificationSystem) PublishEvent(ctx context.Context, ch *amqp.Channel, evt UserEvent) error {
	evt.Timestamp = time.Now().UTC()
	body, err := json.Marshal(evt)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	return ch.PublishWithContext(ctx, "user.events", "", false, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Body:         body,
		},
	)
}

// EmailWorker processes email notifications.
type EmailWorker struct{ logger *slog.Logger }

func (w *EmailWorker) Handle(ctx context.Context, d amqp.Delivery) error {
	var evt UserEvent
	if err := json.Unmarshal(d.Body, &evt); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}
	w.logger.Info("email: sending notification",
		"user_id", evt.UserID,
		"event", evt.EventType,
	)
	// In production: call email service (SES, SendGrid, etc.)
	return nil
}

// StartEmailWorker starts a consumer for email notifications.
func StartEmailWorker(ctx context.Context, conn *amqp.Connection, logger *slog.Logger) error {
	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("email worker channel: %w", err)
	}

	if err := ch.Qos(20, 0, false); err != nil {
		return fmt.Errorf("email worker qos: %w", err)
	}

	deliveries, err := ch.Consume("notifications.email", "email-worker", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("email consumer: %w", err)
	}

	worker := &EmailWorker{logger: logger}
	go func() {
		defer ch.Close()
		for {
			select {
			case d, ok := <-deliveries:
				if !ok {
					return
				}
				if err := worker.Handle(ctx, d); err != nil {
					logger.Error("email worker: failed", "error", err)
					_ = d.Nack(false, false) // send to DLX
				} else {
					_ = d.Ack(false)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return nil
}
```

### Exercise 2: Priority Task Queue

**Goal**: Implement a priority queue with three levels where high-priority tasks drain before medium, and medium before low.

```go
package exercise2

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	QueueName   = "tasks.priority"
	PriorityLow = uint8(1)
	PriorityMed = uint8(5)
	PriorityHigh = uint8(9)
)

// Task is a unit of work with a priority level.
type Task struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Priority uint8   `json:"priority"`
	Data     any     `json:"data"`
}

// SetupPriorityQueue declares a queue with x-max-priority=10.
func SetupPriorityQueue(ch *amqp.Channel) error {
	_, err := ch.QueueDeclare(QueueName, true, false, false, false, amqp.Table{
		"x-max-priority": int32(10),
		"x-max-length":   int32(500000),
	})
	return err
}

// SubmitTask publishes a task with the given priority.
func SubmitTask(ctx context.Context, ch *amqp.Channel, task Task) error {
	body, err := json.Marshal(task)
	if err != nil {
		return fmt.Errorf("marshal task: %w", err)
	}

	return ch.PublishWithContext(ctx, "", QueueName, false, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			Priority:     task.Priority, // broker uses this for ordering
			Timestamp:    time.Now(),
			Body:         body,
		},
	)
}

// PriorityWorker consumes from the priority queue - RabbitMQ automatically
// delivers higher-priority messages first when multiple are ready.
type PriorityWorker struct {
	ch     *amqp.Channel
	logger *slog.Logger
}

func NewPriorityWorker(conn *amqp.Connection, logger *slog.Logger) (*PriorityWorker, error) {
	ch, err := conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("channel: %w", err)
	}
	// prefetch=5 to allow broker to sort by priority across a small window
	if err := ch.Qos(5, 0, false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("qos: %w", err)
	}
	return &PriorityWorker{ch: ch, logger: logger}, nil
}

func (w *PriorityWorker) Run(ctx context.Context) error {
	deliveries, err := w.ch.Consume(QueueName, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				return fmt.Errorf("delivery channel closed")
			}

			var task Task
			if err := json.Unmarshal(d.Body, &task); err != nil {
				w.logger.Error("priority worker: bad payload", "error", err)
				_ = d.Reject(false)
				continue
			}

			priorityLabel := "low"
			switch {
			case d.Priority >= PriorityHigh:
				priorityLabel = "high"
			case d.Priority >= PriorityMed:
				priorityLabel = "medium"
			}

			w.logger.Info("priority worker: processing",
				"task_id", task.ID,
				"priority", d.Priority,
				"level", priorityLabel,
			)

			// Simulate work.
			time.Sleep(10 * time.Millisecond)
			_ = d.Ack(false)

		case <-ctx.Done():
			return nil
		}
	}
}
```

### Exercise 3: Circuit-Breaker Aware Consumer

**Goal**: Build a consumer that pauses consumption when a downstream service is unhealthy and automatically resumes when the health check passes.

```go
package exercise3

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// CircuitState represents the circuit breaker state.
type CircuitState int32

const (
	StateClosed   CircuitState = iota // Normal: consuming messages.
	StateOpen                         // Tripped: not consuming.
	StateHalfOpen                     // Testing: one probe before re-opening.
)

// CircuitBreaker tracks downstream health and controls consumption.
type CircuitBreaker struct {
	state       atomic.Int32
	failures    atomic.Int64
	threshold   int64
	healthURL   string
	checkPeriod time.Duration
	logger      *slog.Logger
}

// NewCircuitBreaker creates a circuit breaker with the given threshold.
func NewCircuitBreaker(healthURL string, threshold int64, checkPeriod time.Duration, logger *slog.Logger) *CircuitBreaker {
	cb := &CircuitBreaker{
		threshold:   threshold,
		healthURL:   healthURL,
		checkPeriod: checkPeriod,
		logger:      logger,
	}
	cb.state.Store(int32(StateClosed))
	return cb
}

// IsOpen returns true if the circuit is open (consumer should pause).
func (cb *CircuitBreaker) IsOpen() bool {
	return CircuitState(cb.state.Load()) == StateOpen
}

// RecordFailure increments failure count and opens the circuit if threshold is exceeded.
func (cb *CircuitBreaker) RecordFailure() {
	count := cb.failures.Add(1)
	if count >= cb.threshold {
		if cb.state.CompareAndSwap(int32(StateClosed), int32(StateOpen)) {
			cb.logger.Warn("circuit breaker: OPEN",
				"failures", count,
				"threshold", cb.threshold,
			)
		}
	}
}

// RecordSuccess resets failure count and closes the circuit.
func (cb *CircuitBreaker) RecordSuccess() {
	cb.failures.Store(0)
	cb.state.Store(int32(StateClosed))
}

// StartHealthCheck polls the downstream service and closes the circuit when healthy.
func (cb *CircuitBreaker) StartHealthCheck(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(cb.checkPeriod)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				if !cb.IsOpen() {
					continue // Only probe when circuit is open.
				}

				if err := cb.probe(); err != nil {
					cb.logger.Warn("circuit breaker: health check failed", "error", err)
					continue
				}

				cb.logger.Info("circuit breaker: downstream healthy, CLOSING circuit")
				cb.RecordSuccess()

			case <-ctx.Done():
				return
			}
		}
	}()
}

// probe checks the downstream health endpoint.
func (cb *CircuitBreaker) probe() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, cb.healthURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check returned %d", resp.StatusCode)
	}
	return nil
}

// CircuitBreakerConsumer pauses consumption when the circuit is open.
type CircuitBreakerConsumer struct {
	ch      *amqp.Channel
	queue   string
	cb      *CircuitBreaker
	handler func(ctx context.Context, d amqp.Delivery) error
	logger  *slog.Logger
}

// NewCircuitBreakerConsumer creates a consumer with circuit breaker protection.
func NewCircuitBreakerConsumer(
	ch *amqp.Channel,
	queue string,
	cb *CircuitBreaker,
	handler func(ctx context.Context, d amqp.Delivery) error,
	logger *slog.Logger,
) *CircuitBreakerConsumer {
	return &CircuitBreakerConsumer{
		ch:      ch,
		queue:   queue,
		cb:      cb,
		handler: handler,
		logger:  logger,
	}
}

// Run starts consuming with circuit breaker-aware pausing.
func (c *CircuitBreakerConsumer) Run(ctx context.Context) error {
	if err := c.ch.Qos(10, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := c.ch.Consume(c.queue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %q: %w", c.queue, err)
	}

	c.logger.Info("circuit breaker consumer: started", "queue", c.queue)

	for {
		select {
		case d, ok := <-deliveries:
			if !ok {
				return fmt.Errorf("delivery channel closed")
			}

			// If circuit is open, requeue and wait.
			if c.cb.IsOpen() {
				c.logger.Warn("circuit breaker: OPEN, requeuing message",
					"delivery_tag", d.DeliveryTag,
				)
				_ = d.Nack(false, true) // requeue=true

				// Back off to avoid tight requeue loop.
				select {
				case <-time.After(c.cb.checkPeriod):
				case <-ctx.Done():
					return nil
				}
				continue
			}

			// Process normally.
			if err := c.handler(ctx, d); err != nil {
				c.logger.Error("circuit breaker consumer: handler failed",
					"error", err,
					"delivery_tag", d.DeliveryTag,
				)
				c.cb.RecordFailure()
				_ = d.Nack(false, !d.Redelivered)
			} else {
				c.cb.RecordSuccess()
				_ = d.Ack(false)
			}

		case <-ctx.Done():
			c.logger.Info("circuit breaker consumer: stopping")
			return nil
		}
	}
}
```

### Junior → FAANG: How to Use Exercises for Interview Preparation

The three exercises in this section progress from foundational (fanout notification system) to intermediate (priority task queue) to advanced (circuit breaker consumer). Use them in sequence, and do not skip to the circuit breaker exercise until you can implement the fanout system from memory.

**Exercise 1 prerequisite check:**

Before starting the fanout exercise, verify you can answer these questions without looking at the code. Why is there a separate DLX per subscriber queue rather than one shared DLX? (Answer: independent failure isolation. A broken email consumer should not route failures to the push consumer's DLQ.) Why does the routing key matter for fanout queue binding? (Answer: it does not. Fanout ignores routing keys. The empty string in `QueueBind` is correct.) What happens if the `notifications.email` queue fills to `x-max-length`? (Answer: new messages are dropped or dead-lettered depending on `x-overflow` setting, which is not set here, so the default `drop-head` applies.)

**Exercise 2 interview framing:**

Priority queues come up in interviews as a "how would you ensure urgent jobs are processed first" question. The correct answer is: use RabbitMQ's `x-max-priority` queue with values 1-10, publish with the correct Priority field in `amqp.Publishing`, set prefetch low enough that the broker can sort by priority across the consumer's window. The caveat to always mention: RabbitMQ priority is not strict preemption. A message being consumed is not interrupted by a higher-priority arrival. Priority only applies to messages waiting in the queue.

**Exercise 3 extension for practice:**

The circuit breaker in exercise 3 opens on individual handler failures. A production improvement is opening on a rate of failures within a time window (5 failures in 10 seconds) rather than on a cumulative count. Implement this by adding a sliding window counter to `CircuitBreaker` and comparing it against a rate threshold. This is the token bucket vs leaky bucket distinction in rate limiting applied to failure detection.

### Senior @ FAANG: Exercise Extensions for Staff-Level Capability Building

The exercises as written are correct implementations of their stated patterns. A staff-level engineer would extend them with the concerns that matter at platform scale.

**Exercise 1 extension: topology-as-code and multi-vhost isolation:**

The `NotificationSystem.Setup` method declares topology ad hoc at runtime in application code. A production notification system at FAANG would externalize this topology to Terraform or a dedicated provisioning service. The extension: write a Terraform configuration that declares the `user.events` exchange, the three subscriber queues with their DLX configurations, and the operator policies that enforce max-length and TTL. The Go application only consumes from queues it expects to exist, and fails at startup with a clear error if the expected topology is missing. This separates topology lifecycle from application deployment lifecycle.

**Exercise 2 extension: priority queue as a design smell indicator:**

Before implementing the priority queue exercise, ask whether the design requires it. If you have three priority levels with significantly different consumer SLAs (high: process in 1s, medium: process in 30s, low: process in 5m), the correct design is three separate queues with separate consumer pools, not one priority queue. Three separate queues give you independent depth metrics per priority, independent consumer scaling, and the ability to alert on high-priority queue depth independently of low-priority backlog. The priority queue exercise is correct as a learning exercise, but in production, reaching for `x-max-priority` should trigger the question: "would separate queues per priority give me better observability and isolation?"

**Exercise 3 extension: circuit breaker state as a distributed concern:**

The `CircuitBreaker` in exercise 3 is process-local. In a deployment with 20 consumer pods, each pod has its own circuit breaker instance. If one pod detects that the downstream service is unhealthy and opens its circuit, the other 19 pods continue sending requests. The distributed circuit breaker pattern stores state in Redis: the failure count and circuit state are shared across all consumer pods. When any pod crosses the failure threshold, all pods read the open state from Redis and pause consumption. Implementing this extension requires Redis client code, a distributed counter, and a mechanism for pods to poll Redis for circuit state changes at the `checkPeriod` interval.

---
