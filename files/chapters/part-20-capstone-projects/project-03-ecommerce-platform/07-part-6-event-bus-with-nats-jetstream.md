## Part 6: Event Bus with NATS JetStream

In a microservices architecture, services need a way to communicate asynchronously without creating tight coupling between them. NATS JetStream provides a persistent message queue that guarantees delivery even if a consuming service is temporarily down. This event bus is the backbone of your system's asynchronous workflows: when an order is placed, the Order Service publishes an event, and the Payment, Notification, and Inventory services each react independently. This pattern keeps services loosely coupled and makes the system much easier to extend with new functionality.

### 6.1 Event Bus Implementation

**pkg/events/nats.go**

```go
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// Publisher publishes events
type Publisher interface {
	Publish(ctx context.Context, subject string, data any) error
	Close() error
}

// Subscriber subscribes to events
type Subscriber interface {
	Subscribe(subject string, handler MessageHandler) error
	SubscribeQueue(subject, queue string, handler MessageHandler) error
	Close() error
}

// MessageHandler handles incoming messages
type MessageHandler func(ctx context.Context, msg *Message) error

// Message represents an event message
type Message struct {
	Subject   string
	Data      []byte
	Timestamp time.Time
	Headers   map[string]string
}

// NATSEventBus implements Publisher and Subscriber using NATS JetStream
type NATSEventBus struct {
	conn   *nats.Conn
	js     nats.JetStreamContext
	logger *zap.Logger
}

// NewNATSEventBus creates a new NATS event bus
func NewNATSEventBus(natsURL string, logger *zap.Logger) (*NATSEventBus, error) {
	// Connect to NATS
	conn, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to NATS: %w", err)
	}

	// Create JetStream context
	js, err := conn.JetStream()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("creating JetStream context: %w", err)
	}

	// Create streams
	if err := createStreams(js); err != nil {
		conn.Close()
		return nil, fmt.Errorf("creating streams: %w", err)
	}

	return &NATSEventBus{
		conn:   conn,
		js:     js,
		logger: logger,
	}, nil
}

// Publish publishes an event
func (n *NATSEventBus) Publish(ctx context.Context, subject string, data any) error {
	// Marshal data to JSON
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshaling data: %w", err)
	}

	// Publish message
	_, err = n.js.Publish(subject, payload)
	if err != nil {
		return fmt.Errorf("publishing message: %w", err)
	}

	n.logger.Debug("published event",
		zap.String("subject", subject),
		zap.Int("payload_size", len(payload)),
	)

	return nil
}

// Subscribe subscribes to a subject
func (n *NATSEventBus) Subscribe(subject string, handler MessageHandler) error {
	_, err := n.js.Subscribe(subject, func(msg *nats.Msg) {
		n.handleMessage(msg, handler)
	}, nats.Durable(subject))

	if err != nil {
		return fmt.Errorf("subscribing to subject %s: %w", subject, err)
	}

	n.logger.Info("subscribed to subject", zap.String("subject", subject))

	return nil
}

// SubscribeQueue subscribes to a subject with queue group
func (n *NATSEventBus) SubscribeQueue(subject, queue string, handler MessageHandler) error {
	_, err := n.js.QueueSubscribe(subject, queue, func(msg *nats.Msg) {
		n.handleMessage(msg, handler)
	}, nats.Durable(queue))

	if err != nil {
		return fmt.Errorf("subscribing to queue %s/%s: %w", subject, queue, err)
	}

	n.logger.Info("subscribed to queue",
		zap.String("subject", subject),
		zap.String("queue", queue),
	)

	return nil
}

// Close closes the connection
func (n *NATSEventBus) Close() error {
	n.conn.Close()
	return nil
}

func (n *NATSEventBus) handleMessage(natsMsg *nats.Msg, handler MessageHandler) {
	ctx := context.Background()

	msg := &Message{
		Subject:   natsMsg.Subject,
		Data:      natsMsg.Data,
		Timestamp: time.Now(),
		Headers:   make(map[string]string),
	}

	// Copy headers
	for key := range natsMsg.Header {
		msg.Headers[key] = natsMsg.Header.Get(key)
	}

	// Handle message
	if err := handler(ctx, msg); err != nil {
		n.logger.Error("failed to handle message",
			zap.String("subject", msg.Subject),
			zap.Error(err),
		)
		// NACK the message for retry
		natsMsg.Nak()
		return
	}

	// ACK the message
	natsMsg.Ack()
}

func createStreams(js nats.JetStreamContext) error {
	// Create streams for different event types
	streams := []struct {
		name     string
		subjects []string
	}{
		{
			name:     "ORDERS",
			subjects: []string{"order.*"},
		},
		{
			name:     "PAYMENTS",
			subjects: []string{"payment.*"},
		},
		{
			name:     "INVENTORY",
			subjects: []string{"inventory.*"},
		},
		{
			name:     "NOTIFICATIONS",
			subjects: []string{"notification.*"},
		},
	}

	for _, stream := range streams {
		_, err := js.StreamInfo(stream.name)
		if err != nil {
			// Stream doesn't exist, create it
			_, err = js.AddStream(&nats.StreamConfig{
				Name:     stream.name,
				Subjects: stream.subjects,
				Storage:  nats.FileStorage,
				Retention: nats.WorkQueuePolicy,
				MaxAge:   24 * time.Hour,
			})
			if err != nil {
				return fmt.Errorf("creating stream %s: %w", stream.name, err)
			}
		}
	}

	return nil
}
```

### 6.2 Event Handlers Example

**services/notification/internal/handlers/order_events.go**

```go
package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/pkg/events"
	"github.com/yourusername/ecommerce/services/notification/internal/service"
)

// OrderEventHandler handles order events
type OrderEventHandler struct {
	notificationService *service.NotificationService
	logger              *zap.Logger
}

// NewOrderEventHandler creates a new OrderEventHandler
func NewOrderEventHandler(
	notificationService *service.NotificationService,
	logger *zap.Logger,
) *OrderEventHandler {
	return &OrderEventHandler{
		notificationService: notificationService,
		logger:              logger,
	}
}

// HandleOrderCreated handles order created events
func (h *OrderEventHandler) HandleOrderCreated(ctx context.Context, msg *events.Message) error {
	var event OrderCreatedEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		return fmt.Errorf("unmarshaling event: %w", err)
	}

	h.logger.Info("handling order created event", zap.String("order_id", event.OrderID))

	// Send order confirmation email
	if err := h.notificationService.SendOrderConfirmation(ctx, event.OrderID, event.UserID); err != nil {
		return fmt.Errorf("sending order confirmation: %w", err)
	}

	return nil
}

// HandlePaymentConfirmed handles payment confirmed events
func (h *OrderEventHandler) HandlePaymentConfirmed(ctx context.Context, msg *events.Message) error {
	var event PaymentConfirmedEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		return fmt.Errorf("unmarshaling event: %w", err)
	}

	h.logger.Info("handling payment confirmed event", zap.String("order_id", event.OrderID))

	// Send payment confirmation email
	if err := h.notificationService.SendPaymentConfirmation(ctx, event.OrderID, event.UserID); err != nil {
		return fmt.Errorf("sending payment confirmation: %w", err)
	}

	return nil
}

// Event types

type OrderCreatedEvent struct {
	OrderID string `json:"order_id"`
	UserID  string `json:"user_id"`
	Total   string `json:"total"`
}

type PaymentConfirmedEvent struct {
	OrderID         string `json:"order_id"`
	UserID          string `json:"user_id"`
	PaymentIntentID string `json:"payment_intent_id"`
	Total           string `json:"total"`
}
```

---

### Junior → FAANG: Event-Driven Architecture as a Decoupling Mechanism

The event bus is what makes microservices independent. Without it, the Order Service would have to call the Notification Service and Inventory Service directly, creating runtime coupling: if either service is down, the order fails. With an event bus, the Order Service publishes an OrderPlaced event and returns success immediately. Downstream services process the event independently when they are available.

At-least-once delivery (NATS JetStream's guarantee) means a consumer may receive the same event more than once. Every event consumer must be idempotent: processing the same event twice should produce the same result as processing it once. For a notification service, the idempotency mechanism is checking "did we already send a notification for this order ID" before sending.

Event schema design matters for consumer flexibility. Publish events with enough context that consumers do not need to call back to the producer to do their work. An OrderPlaced event should include the customer email, the order total, and the item list, not just the order ID (which would force each consumer to call back to the Order Service to get the full order).

### Senior @ FAANG: Event Bus Governance as a Platform Responsibility

At senior level, the event bus is a shared platform resource. Every team that publishes or consumes events must register their schemas in a schema registry. The registry enforces schema compatibility (backward compatibility for new fields, versioning for breaking changes) and provides discoverability (what events does this service publish, who consumes them).

Dead letter queues (DLQ) are the operational safety net for failed event processing. When a consumer fails to process an event after the maximum retry count, the event is moved to the DLQ. Without a DLQ, failed events are lost. With a DLQ, they are preserved for investigation and manual replay. The operational process for DLQ monitoring (alert when DLQ depth grows, runbook for manual replay) must be defined before the system goes to production.

Consumer group management is an operational concern. Multiple instances of the same service must consume from the same consumer group so that each event is processed by exactly one instance (not all instances). Misconfigured consumer groups cause duplicate event processing. Platform-level consumer group naming conventions (derived from the service name and event topic) prevent accidental misconfiguration.

---
