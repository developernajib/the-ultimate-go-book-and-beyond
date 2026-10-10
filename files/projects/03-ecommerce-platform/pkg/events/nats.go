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
	conn, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connecting to NATS: %w", err)
	}

	js, err := conn.JetStream()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("creating JetStream context: %w", err)
	}

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
	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("marshaling data: %w", err)
	}

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

	for key := range natsMsg.Header {
		msg.Headers[key] = natsMsg.Header.Get(key)
	}

	if err := handler(ctx, msg); err != nil {
		n.logger.Error("failed to handle message",
			zap.String("subject", msg.Subject),
			zap.Error(err),
		)
		natsMsg.Nak()
		return
	}

	natsMsg.Ack()
}

func createStreams(js nats.JetStreamContext) error {
	streams := []struct {
		name     string
		subjects []string
	}{
		{name: "ORDERS", subjects: []string{"order.*"}},
		{name: "PAYMENTS", subjects: []string{"payment.*"}},
		{name: "INVENTORY", subjects: []string{"inventory.*"}},
		{name: "NOTIFICATIONS", subjects: []string{"notification.*"}},
	}

	for _, stream := range streams {
		_, err := js.StreamInfo(stream.name)
		if err != nil {
			_, err = js.AddStream(&nats.StreamConfig{
				Name:      stream.name,
				Subjects:  stream.subjects,
				Storage:   nats.FileStorage,
				Retention: nats.WorkQueuePolicy,
				MaxAge:    24 * time.Hour,
			})
			if err != nil {
				return fmt.Errorf("creating stream %s: %w", stream.name, err)
			}
		}
	}

	return nil
}
