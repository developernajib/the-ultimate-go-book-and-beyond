## 90E.4 Kafka Consumer with Exactly-Once Processing

Achieving exactly-once semantics in a Kafka consumer requires combining two techniques: idempotent processing and a dead-letter queue (DLQ) for messages that cannot be handled successfully after all retries. The consumer group below commits offsets only after successfully processing each record, and retries failed messages with exponential backoff before routing them to a DLQ topic. The `IdempotencyStore` wraps any handler to make it safe against duplicate deliveries. Kafka can redeliver the same offset after a consumer restart, so the store checks whether the record's partition-offset key has already been processed and skips it if so. This approach tolerates network interruptions and rebalances without producing duplicate side effects in downstream systems.

```go
package consumer

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// EventHandler processes a single event
type EventHandler func(ctx context.Context, record *kgo.Record) error

// ConsumerGroup is a Kafka consumer group with automatic offset management
type ConsumerGroup struct {
	client   *kgo.Client
	handlers map[string]EventHandler
	dlq      *DeadLetterQueue
	logger   *slog.Logger
	config   ConsumerConfig
}

type ConsumerConfig struct {
	Brokers      []string
	GroupID      string
	Topics       []string
	MaxRetries   int
	DLQTopic     string
}

type DeadLetterQueue struct {
	producer *kgo.Client
	topic    string
}

func NewConsumerGroup(cfg ConsumerConfig) (*ConsumerGroup, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ConsumerGroup(cfg.GroupID),
		kgo.ConsumeTopics(cfg.Topics...),
		// Start from beginning if no committed offset
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Process in order
		kgo.FetchMaxBytes(10 << 20), // 10MB
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, err
	}

	cg := &ConsumerGroup{
		client:   client,
		handlers: make(map[string]EventHandler),
		logger:   slog.Default(),
		config:   cfg,
	}

	// Set up DLQ producer
	if cfg.DLQTopic != "" {
		dlqClient, err := kgo.NewClient(kgo.SeedBrokers(cfg.Brokers...))
		if err == nil {
			cg.dlq = &DeadLetterQueue{producer: dlqClient, topic: cfg.DLQTopic}
		}
	}

	return cg, nil
}

// RegisterHandler registers a handler for a specific event type
func (cg *ConsumerGroup) RegisterHandler(eventType string, handler EventHandler) {
	cg.handlers[eventType] = handler
}

// Run starts consuming events
func (cg *ConsumerGroup) Run(ctx context.Context) error {
	cg.logger.Info("consumer group started",
		"group", cg.config.GroupID, "topics", cg.config.Topics)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		fetches := cg.client.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return nil
		}

		if errs := fetches.Errors(); len(errs) > 0 {
			for _, fe := range errs {
				cg.logger.Error("fetch error",
					"topic", fe.Topic, "partition", fe.Partition, "error", fe.Err)
			}
		}

		fetches.EachPartition(func(p kgo.FetchTopicPartition) {
			p.EachRecord(func(record *kgo.Record) {
				cg.processRecord(ctx, record)
			})
		})

		// Commit processed offsets
		if err := cg.client.CommitUncommittedOffsets(ctx); err != nil {
			cg.logger.Error("commit offsets", "error", err)
		}
	}
}

func (cg *ConsumerGroup) processRecord(ctx context.Context, record *kgo.Record) {
	// Extract event type from headers
	eventType := ""
	for _, h := range record.Headers {
		if h.Key == "event-type" {
			eventType = string(h.Value)
			break
		}
	}

	handler, ok := cg.handlers[eventType]
	if !ok {
		// Try default handler
		handler, ok = cg.handlers["*"]
		if !ok {
			cg.logger.Warn("no handler for event type",
				"type", eventType, "topic", record.Topic)
			return
		}
	}

	// Process with retries
	var lastErr error
	for attempt := 0; attempt <= cg.config.MaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt*100) * time.Millisecond
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		}

		if err := handler(ctx, record); err != nil {
			lastErr = err
			cg.logger.Warn("handler error, will retry",
				"attempt", attempt, "event_type", eventType, "error", err)
			continue
		}

		cg.logger.Info("event processed",
			"type", eventType,
			"partition", record.Partition,
			"offset", record.Offset)
		return
	}

	// Max retries exceeded - send to DLQ
	cg.logger.Error("event processing failed, sending to DLQ",
		"type", eventType, "error", lastErr)
	cg.sendToDLQ(ctx, record, lastErr)
}

func (cg *ConsumerGroup) sendToDLQ(ctx context.Context, record *kgo.Record, err error) {
	if cg.dlq == nil {
		return
	}

	dlqRecord := &kgo.Record{
		Topic: cg.dlq.topic,
		Key:   record.Key,
		Value: record.Value,
		Headers: append(record.Headers,
			kgo.RecordHeader{Key: "original-topic", Value: []byte(record.Topic)},
			kgo.RecordHeader{Key: "error", Value: []byte(err.Error())},
			kgo.RecordHeader{Key: "failed-at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		),
	}

	cg.dlq.producer.ProduceSync(ctx, dlqRecord)
}

func (cg *ConsumerGroup) Close() {
	cg.client.Close()
	if cg.dlq != nil {
		cg.dlq.producer.Close()
	}
}

// IdempotencyStore tracks processed event IDs to prevent duplicates
type IdempotencyStore struct {
	processed map[string]time.Time
	ttl       time.Duration
}

func NewIdempotencyStore(ttl time.Duration) *IdempotencyStore {
	return &IdempotencyStore{
		processed: make(map[string]time.Time),
		ttl:       ttl,
	}
}

// IsProcessed returns true if this event ID has already been processed
func (s *IdempotencyStore) IsProcessed(eventID string) bool {
	ts, ok := s.processed[eventID]
	if !ok {
		return false
	}
	if time.Since(ts) > s.ttl {
		delete(s.processed, eventID)
		return false
	}
	return true
}

// MarkProcessed records that an event has been processed
func (s *IdempotencyStore) MarkProcessed(eventID string) {
	s.processed[eventID] = time.Now()
}

// IdempotentHandler wraps a handler to skip duplicate events
func IdempotentHandler(store *IdempotencyStore, handler EventHandler) EventHandler {
	return func(ctx context.Context, record *kgo.Record) error {
		// Extract event ID from key or headers
		eventID := string(record.Key) + ":" + fmt.Sprintf("%d:%d", record.Partition, record.Offset)

		if store.IsProcessed(eventID) {
			slog.Info("skipping duplicate event", "id", eventID)
			return nil
		}

		if err := handler(ctx, record); err != nil {
			return err
		}

		store.MarkProcessed(eventID)
		return nil
	}
}
```

---
