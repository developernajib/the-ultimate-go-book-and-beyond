## Go Implementation: Order Event Consumer

As orders move through their lifecycle, multiple downstream services need to react: analytics tracks conversion metrics, the notification service sends push alerts, and the tracking service starts streaming driver locations to the customer. Rather than coupling these services directly to the Order Service, all order state changes are published to a Kafka topic. Each downstream service runs its own consumer group, processing events independently and at its own pace. If one consumer falls behind or crashes, it replays missed events from Kafka without affecting other consumers.

```go
package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// OrderEventConsumer processes order lifecycle events from Kafka
// Used by analytics, notification, and tracking services
type OrderEventConsumer struct {
	client     *kgo.Client
	handlers   map[string]EventHandler
	logger     *slog.Logger
}

type OrderEvent struct {
	OrderID   string    `json:"order_id"`
	EventType string    `json:"event_type"`
	Status    string    `json:"status"`
	ActorID   string    `json:"actor_id"`
	Metadata  map[string]any `json:"metadata"`
	Timestamp time.Time `json:"timestamp"`
}

type EventHandler func(ctx context.Context, event OrderEvent) error

func NewOrderEventConsumer(brokers []string, groupID string, logger *slog.Logger) (*OrderEventConsumer, error) {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ConsumerGroup(groupID),
		kgo.ConsumeTopics("order-events"),
		// Only records explicitly marked with MarkCommitRecords are
		// committed, so a failed handler leaves its offset uncommitted.
		kgo.AutoCommitMarks(),
	)
	if err != nil {
		return nil, fmt.Errorf("create kafka client: %w", err)
	}

	return &OrderEventConsumer{
		client:   client,
		handlers: make(map[string]EventHandler),
		logger:   logger,
	}, nil
}

func (c *OrderEventConsumer) RegisterHandler(eventType string, handler EventHandler) {
	c.handlers[eventType] = handler
}

// Run starts consuming events in a loop
func (c *OrderEventConsumer) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		fetches := c.client.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 {
			for _, e := range errs {
				c.logger.Error("kafka fetch error",
					"topic", e.Topic,
					"partition", e.Partition,
					"error", e.Err)
			}
			continue
		}

		fetches.EachRecord(func(record *kgo.Record) {
			var event OrderEvent
			if err := json.Unmarshal(record.Value, &event); err != nil {
				c.logger.Error("unmarshal event", "error", err)
				return
			}

			handler, ok := c.handlers[event.EventType]
			if !ok {
				// No handler registered, mark so the offset advances
				c.client.MarkCommitRecords(record)
				return
			}

			if err := handler(ctx, event); err != nil {
				c.logger.Error("handle event",
					"event_type", event.EventType,
					"order_id", event.OrderID,
					"error", err)
				// Not marked, so not committed -- redelivered after a
				// restart or rebalance. Kafka commits are per-partition
				// offsets, so marking a later record in the same
				// partition would advance past this one. Production
				// systems pair this with a dead-letter topic.
				return
			}
			c.client.MarkCommitRecords(record)
		})

		// Commit offsets for successfully processed (marked) records
		if err := c.client.CommitMarkedOffsets(ctx); err != nil {
			c.logger.Error("commit offsets", "error", err)
		}
	}
}

// Example handler registrations:
// consumer.RegisterHandler("order_placed", analyticsService.TrackOrderPlaced)
// consumer.RegisterHandler("driver_assigned", trackingService.StartTracking)
// consumer.RegisterHandler("delivered", reviewService.ScheduleReviewRequest)
```

---
