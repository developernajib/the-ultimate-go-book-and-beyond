## 52H.6 Redis Streams - Consumer Groups & XACK

Consumer groups solve the fan-out problem: multiple services consuming from the same stream independently, or multiple workers within a service load-balancing messages. Each group maintains its own position in the stream and a **Pending Entry List (PEL)** of messages that have been delivered but not yet acknowledged.

The `GroupConsumer` below implements the full consumer lifecycle: group creation via `XGROUP CREATE`, message reading via `XREADGROUP`, acknowledgment via `XACK`, and PEL recovery on startup. The `ProcessLoop` method first drains any pending messages left over from a previous crash, then enters the main read-process-ack loop. The `PendingMonitor` and `ClaimStaleMessages` methods handle the failure recovery path - detecting idle messages via `XPENDING` and reclaiming them via `XAUTOCLAIM`, with a dead-letter stream for messages that exceed the maximum delivery count.

```go
// file: internal/redis/streams/consumer_group.go
package streams

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// GroupConsumer implements the consumer group pattern with XREADGROUP/XACK/XCLAIM.
type GroupConsumer struct {
	client       *redis.Client
	stream       string
	group        string
	consumer     string
	batchSize    int64
	blockTimeout time.Duration
	logger       *slog.Logger
}

// NewGroupConsumer creates a consumer group and returns a GroupConsumer.
func NewGroupConsumer(
	ctx context.Context,
	client *redis.Client,
	stream, group, consumer string,
	batchSize int64,
	blockTimeout time.Duration,
	logger *slog.Logger,
) (*GroupConsumer, error) {
	// XGROUP CREATE stream group $ MKSTREAM
	// "$" means start from new messages. Use "0" to read all existing messages.
	err := client.XGroupCreateMkStream(ctx, stream, group, "$").Err()
	if err != nil {
		// BUSYGROUP means the group already exists - this is fine.
		if err.Error() != "BUSYGROUP Consumer Group name already exists" {
			return nil, fmt.Errorf("xgroup create %s/%s: %w", stream, group, err)
		}
	} else {
		logger.Info("consumer group created",
			slog.String("stream", stream),
			slog.String("group", group),
		)
	}

	return &GroupConsumer{
		client:       client,
		stream:       stream,
		group:        group,
		consumer:     consumer,
		batchSize:    batchSize,
		blockTimeout: blockTimeout,
		logger:       logger,
	}, nil
}

// MessageHandler is the function signature for processing a stream entry.
type MessageHandler func(ctx context.Context, msg redis.XMessage) error

// Read fetches new messages from the group using XREADGROUP with ">".
// ">" is the special ID meaning "give me messages not yet delivered to any consumer".
func (gc *GroupConsumer) Read(ctx context.Context) ([]redis.XMessage, error) {
	result, err := gc.client.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    gc.group,
		Consumer: gc.consumer,
		Streams:  []string{gc.stream, ">"},
		Count:    gc.batchSize,
		Block:    gc.blockTimeout,
	}).Result()

	if err != nil {
		if err == redis.Nil {
			return nil, nil
		}
		if ctx.Err() != nil {
			return nil, nil
		}
		return nil, fmt.Errorf("xreadgroup %s/%s/%s: %w", gc.stream, gc.group, gc.consumer, err)
	}

	if len(result) == 0 {
		return nil, nil
	}

	return result[0].Messages, nil
}

// Ack acknowledges a processed message, removing it from the PEL.
func (gc *GroupConsumer) Ack(ctx context.Context, ids ...string) error {
	if err := gc.client.XAck(ctx, gc.stream, gc.group, ids...).Err(); err != nil {
		return fmt.Errorf("xack %s/%s: %w", gc.stream, gc.group, err)
	}
	return nil
}

// ProcessLoop is the main loop: read → process → ack, with pending recovery.
func (gc *GroupConsumer) ProcessLoop(ctx context.Context, handler MessageHandler) error {
	gc.logger.Info("consumer group loop started",
		slog.String("stream", gc.stream),
		slog.String("group", gc.group),
		slog.String("consumer", gc.consumer),
	)

	// First, recover any pending messages from a previous crash.
	if err := gc.recoverPending(ctx, handler); err != nil {
		gc.logger.Error("pending recovery failed", slog.String("error", err.Error()))
	}

	for {
		select {
		case <-ctx.Done():
			gc.logger.Info("consumer group loop stopping")
			return nil
		default:
		}

		messages, err := gc.Read(ctx)
		if err != nil {
			gc.logger.Error("read error",
				slog.String("consumer", gc.consumer),
				slog.String("error", err.Error()),
			)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(1 * time.Second):
				continue
			}
		}

		for _, msg := range messages {
			if err := gc.processMessage(ctx, msg, handler); err != nil {
				gc.logger.Error("process message error",
					slog.String("id", msg.ID),
					slog.String("error", err.Error()),
				)
				// Do NOT ack - message stays in PEL for retry.
			}
		}
	}
}

// processMessage processes a single message and acks on success.
func (gc *GroupConsumer) processMessage(ctx context.Context, msg redis.XMessage, handler MessageHandler) error {
	if err := handler(ctx, msg); err != nil {
		return err
	}
	return gc.Ack(ctx, msg.ID)
}

// recoverPending reads messages from the PEL (unacknowledged from previous run).
func (gc *GroupConsumer) recoverPending(ctx context.Context, handler MessageHandler) error {
	gc.logger.Info("recovering pending messages",
		slog.String("consumer", gc.consumer),
	)

	cursor := "0-0"
	const pendingBatch = 100
	recovered := 0

	for {
		result, err := gc.client.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    gc.group,
			Consumer: gc.consumer,
			Streams:  []string{gc.stream, cursor},
			Count:    pendingBatch,
		}).Result()

		if err != nil {
			if err == redis.Nil {
				break
			}
			return fmt.Errorf("xreadgroup pending %s: %w", gc.stream, err)
		}

		if len(result) == 0 || len(result[0].Messages) == 0 {
			break
		}

		messages := result[0].Messages
		for _, msg := range messages {
			if err := gc.processMessage(ctx, msg, handler); err != nil {
				gc.logger.Error("pending message processing failed",
					slog.String("id", msg.ID),
					slog.String("error", err.Error()),
				)
			} else {
				recovered++
			}
		}

		// Advance cursor.
		cursor = messages[len(messages)-1].ID
		if int64(len(messages)) < pendingBatch {
			break
		}
	}

	gc.logger.Info("pending recovery complete", slog.Int("recovered", recovered))
	return nil
}

// PendingMonitor inspects and reports on the group's pending entry list.
type PendingMonitor struct {
	client *redis.Client
	stream string
	group  string
	logger *slog.Logger
}

// NewPendingMonitor creates a monitor.
func NewPendingMonitor(client *redis.Client, stream, group string, logger *slog.Logger) *PendingMonitor {
	return &PendingMonitor{client: client, stream: stream, group: group, logger: logger}
}

// Summary returns aggregate PEL statistics (total pending, oldest/newest IDs, consumer breakdown).
func (pm *PendingMonitor) Summary(ctx context.Context) (*redis.XPending, error) {
	pending, err := pm.client.XPending(ctx, pm.stream, pm.group).Result()
	if err != nil {
		return nil, fmt.Errorf("xpending summary %s/%s: %w", pm.stream, pm.group, err)
	}
	return pending, nil
}

// StaleMessages returns messages in the PEL idle longer than the given duration.
func (pm *PendingMonitor) StaleMessages(ctx context.Context, idleThreshold time.Duration) ([]redis.XPendingExt, error) {
	pending, err := pm.client.XPendingExt(ctx, &redis.XPendingExtArgs{
		Stream:   pm.stream,
		Group:    pm.group,
		Start:    "-",
		Stop:     "+",
		Count:    100,
		Idle:     idleThreshold,
	}).Result()

	if err != nil {
		return nil, fmt.Errorf("xpending ext %s/%s: %w", pm.stream, pm.group, err)
	}
	return pending, nil
}

// ClaimStaleMessages transfers ownership of stale messages to this consumer.
func (gc *GroupConsumer) ClaimStaleMessages(ctx context.Context, idleThreshold time.Duration, handler MessageHandler) error {
	// XAUTOCLAIM transfers idle messages and returns them in one command (Redis 6.2+).
	result, err := gc.client.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream:   gc.stream,
		Group:    gc.group,
		Consumer: gc.consumer,
		MinIdle:  idleThreshold,
		Start:    "0-0",
		Count:    100,
	}).Result()

	if err != nil {
		return fmt.Errorf("xautoclaim %s/%s: %w", gc.stream, gc.group, err)
	}

	if len(result.Messages) == 0 {
		return nil
	}

	gc.logger.Info("claimed stale messages",
		slog.Int("count", len(result.Messages)),
		slog.String("consumer", gc.consumer),
	)

	// Dead letter threshold: messages delivered more than 5 times go to a dead letter stream.
	const maxDeliveries = 5
	deadLetterStream := gc.stream + ":dead-letter"

	for _, msg := range result.Messages {
		// Inspect delivery count from XPENDING data embedded in message.
		// We use XPendingExt to get the delivery count for each ID.
		deliveryCount := gc.getDeliveryCount(ctx, msg.ID)

		if deliveryCount >= maxDeliveries {
			gc.logger.Warn("routing to dead letter",
				slog.String("id", msg.ID),
				slog.Int("deliveries", deliveryCount),
			)
			// Copy to dead letter stream.
			dlArgs := &redis.XAddArgs{
				Stream: deadLetterStream,
				ID:     "*",
				Values: msg.Values,
			}
			dlArgs.Values["_original_id"] = msg.ID
			dlArgs.Values["_delivery_count"] = deliveryCount
			if _, dlErr := gc.client.XAdd(ctx, dlArgs).Result(); dlErr != nil {
				gc.logger.Error("dead letter xadd failed",
					slog.String("id", msg.ID),
					slog.String("error", dlErr.Error()),
				)
			}
			// Ack to remove from PEL.
			_ = gc.Ack(ctx, msg.ID)
			continue
		}

		if err := gc.processMessage(ctx, msg, handler); err != nil {
			gc.logger.Error("claimed message processing failed",
				slog.String("id", msg.ID),
				slog.String("error", err.Error()),
			)
		}
	}
	return nil
}

// getDeliveryCount fetches the delivery count for a single pending message.
func (gc *GroupConsumer) getDeliveryCount(ctx context.Context, id string) int {
	pending, err := gc.client.XPendingExt(ctx, &redis.XPendingExtArgs{
		Stream: gc.stream,
		Group:  gc.group,
		Start:  id,
		Stop:   id,
		Count:  1,
	}).Result()

	if err != nil || len(pending) == 0 {
		return 0
	}
	return int(pending[0].RetryCount)
}
```

### Junior -> FAANG: Making Consumer Groups Reliable in Your First Service

The `GroupConsumer` code above demonstrates the full recovery lifecycle, but first-job engineers often deploy only the happy path (`XREADGROUP` with `">"` and `XACK`) and skip the pending recovery. Here is why that breaks in production.

When your consumer pod is restarted by Kubernetes (OOM kill, rolling deploy, node eviction), any messages it was processing but had not yet acked remain in its PEL. The next time the pod starts and calls `XREADGROUP` with `">"`, it gets new messages only. The in-flight messages at the time of the crash are stuck until their idle time triggers `XAUTOCLAIM`. Without `XAUTOCLAIM`, they stay stuck forever.

The `recoverPending` function in the code above reads the consumer's own PEL by passing cursor `"0"` to `XREADGROUP` instead of `">"`. Always call this on startup, before entering the main read loop. It is safe to call even if the PEL is empty (it just returns immediately).

One more first-job habit: always use a stable consumer name. If your consumer name is the pod's hostname (which in Kubernetes is the pod name, not the StatefulSet ordinal), every deploy creates a new consumer and orphans the old PEL. Pin the consumer name to the deployment slot or StatefulSet ordinal.

### Senior @ FAANG: Consumer Group Architecture for Scale and Correctness

The `GroupConsumer` implementation is solid for a single-service, single-stream deployment. At platform scale, the design needs to address three concerns that do not appear in the code.

The first is the `BUSYGROUP` error handling in `NewGroupConsumer`. The current code compares the error message string to a literal. This is fragile: different Redis versions and proxies (e.g., Envoy Redis filter, Twemproxy, Redis Cluster proxy) may return slightly different error text. The idiomatic fix is to use `strings.Contains(err.Error(), "BUSYGROUP")` or, better, to preface the `XGROUP CREATE` with an `XGROUP CREATECONSUMER` existence check. The `go-redis/v9` client provides `IsRedisError` helpers in newer versions that allow checking for specific server-side error codes without string matching.

The second concern is the dead-letter implementation in `ClaimStaleMessages`. The code writes to `gc.stream + ":dead-letter"` and acks the original message. This creates a correctness window: if the `XADD` to the dead-letter stream succeeds but the `XACK` of the original fails (network partition between the two commands), the message is both in the dead-letter stream and still in the original group's PEL. The next `XAUTOCLAIM` cycle will claim it again and attempt to write a second dead-letter entry. The mitigation is to use a Lua script that atomically executes `XADD` to the DLQ and `XACK` on the original in a single Redis command. Lua scripts execute atomically on a single Redis node, which is sufficient when the stream and DLQ key are on the same shard.

The third concern is multi-stream consumer groups. The `GroupConsumer` is bound to one stream. At scale, a single tenant's events may be sharded across multiple streams (e.g., `events:orders:shard-0` through `events:orders:shard-N`). The consumer group must be created on each shard, and the consumer pod must poll all shards. The `XREADGROUP` command supports multiple streams in a single call, but each stream needs its own group created separately. A platform library should abstract shard enumeration, group initialization, and multi-stream polling behind a single `ShardedGroupConsumer` interface so individual services do not need to manage shard topology manually.

---
