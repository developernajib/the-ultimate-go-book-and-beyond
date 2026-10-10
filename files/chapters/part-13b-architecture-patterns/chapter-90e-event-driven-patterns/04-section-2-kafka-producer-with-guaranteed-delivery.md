## 90E.3 Kafka Producer with Guaranteed Delivery

A Kafka producer achieves at-least-once delivery by requiring acknowledgment from all in-sync replicas before considering a publish successful. The `franz-go` client used here sets `RequiredAcks` to `AllISRAcks`, which means the broker waits for every replica to write the record before responding. An exponential retry backoff handles transient broker unavailability without overwhelming the cluster. Snappy compression reduces network bandwidth and broker storage with minimal CPU overhead, making it a good default for structured JSON payloads. The `PublishBatch` method demonstrates how to send multiple records in a single round-trip for bulk scenarios such as CDC (change data capture) pipelines.

```go
package producer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// ReliableProducer sends messages to Kafka with at-least-once delivery
type ReliableProducer struct {
	client *kgo.Client
	logger *slog.Logger
}

type ProducerConfig struct {
	Brokers     []string
	ClientID    string
	MaxRetries  int
	RetryBackoff time.Duration
}

func NewReliableProducer(cfg ProducerConfig) (*ReliableProducer, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ClientID(cfg.ClientID),
		// Durability: wait for all in-sync replicas
		kgo.RequiredAcks(kgo.AllISRAcks()),
		// Idempotent producer prevents duplicates from retries
		kgo.ProducerBatchMaxBytes(1 << 20), // 1MB
		// Compression
		kgo.ProducerBatchCompression(kgo.SnappyCompression()),
		// Retry
		kgo.RetryBackoffFn(func(attempt int) time.Duration {
			if attempt > 5 {
				return 5 * time.Second
			}
			return time.Duration(attempt*100) * time.Millisecond
		}),
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, fmt.Errorf("create kafka client: %w", err)
	}

	return &ReliableProducer{client: client, logger: slog.Default()}, nil
}

// Publish sends an event synchronously
func (p *ReliableProducer) Publish(ctx context.Context, topic string, key string, event any) error {
	value, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	record := &kgo.Record{
		Topic: topic,
		Key:   []byte(key),
		Value: value,
		Headers: []kgo.RecordHeader{
			{Key: "event-type", Value: []byte(fmt.Sprintf("%T", event))},
			{Key: "timestamp", Value: []byte(time.Now().UTC().Format(time.RFC3339Nano))},
		},
	}

	// Produce and wait for acknowledgment
	if err := p.client.ProduceSync(ctx, record).FirstErr(); err != nil {
		return fmt.Errorf("produce to %s: %w", topic, err)
	}

	p.logger.Info("event published",
		"topic", topic, "key", key, "type", fmt.Sprintf("%T", event))
	return nil
}

// PublishBatch sends multiple events efficiently
func (p *ReliableProducer) PublishBatch(ctx context.Context, topic string, events []struct {
	Key   string
	Event any
}) error {
	records := make([]*kgo.Record, len(events))
	for i, e := range events {
		value, _ := json.Marshal(e.Event)
		records[i] = &kgo.Record{
			Topic: topic,
			Key:   []byte(e.Key),
			Value: value,
		}
	}

	results := p.client.ProduceSync(ctx, records...)
	for _, result := range results {
		if result.Err != nil {
			return fmt.Errorf("batch produce error: %w", result.Err)
		}
	}
	return nil
}

func (p *ReliableProducer) Close() {
	p.client.Close()
}
```

---
