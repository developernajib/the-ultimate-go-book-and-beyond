## 52H.2 NATS JetStream - Streams & Persistence

JetStream layers persistence on top of NATS core. A **stream** is an ordered, durable log bound to one or more subjects. Messages published to matching subjects are automatically stored. **Consumers** are named cursors into the stream - they track which messages have been delivered and acknowledged.

### Key Stream Configuration Options

| Field | Description |
|---|---|
| `Subjects` | List of NATS subjects to capture (supports wildcards) |
| `Storage` | `nats.FileStorage` (survives restart) or `nats.MemoryStorage` |
| `Retention` | `LimitsPolicy`, `InterestPolicy`, `WorkQueuePolicy` |
| `Replicas` | Number of cluster nodes to replicate to (1, 3, 5) |
| `MaxAge` | Automatically delete messages older than duration |
| `MaxBytes` | Cap total stream storage |
| `MaxMsgs` | Cap number of messages |
| `Discard` | `DiscardOld` (drop oldest) or `DiscardNew` (reject new when full) |
| `Duplicates` | Deduplication window - messages with same `Nats-Msg-Id` within window are deduplicated |

The `StreamManager` below wraps JetStream stream creation with an idempotent `EnsureStream` method - it creates the stream if missing or updates it if the configuration has changed. The `Publisher` provides both synchronous publishing (waits for server acknowledgment before returning) and asynchronous batch publishing (collects `PubAckFuture` handles, then waits for all acknowledgments). Synchronous publishing suits low-volume, high-importance messages. Asynchronous publishing suits bulk ingestion where per-message latency is less critical than aggregate throughput.

```go
// file: internal/nats/jetstream/stream_manager.go
package jetstream

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// StreamManager handles JetStream stream lifecycle.
type StreamManager struct {
	js     nats.JetStreamContext
	logger *slog.Logger
}

// NewStreamManager creates a JetStream context from an existing NATS connection.
func NewStreamManager(conn *nats.Conn, logger *slog.Logger) (*StreamManager, error) {
	js, err := conn.JetStream(nats.PublishAsyncMaxPending(256))
	if err != nil {
		return nil, fmt.Errorf("creating jetstream context: %w", err)
	}
	return &StreamManager{js: js, logger: logger}, nil
}

// StreamConfig defines stream parameters.
type StreamConfig struct {
	Name        string
	Subjects    []string
	Storage     nats.StorageType
	Retention   nats.RetentionPolicy
	Replicas    int
	MaxAge      time.Duration
	MaxBytes    int64
	MaxMsgs     int64
	DedupWindow time.Duration
}

// EnsureStream creates or updates a stream idempotently.
func (sm *StreamManager) EnsureStream(ctx context.Context, cfg StreamConfig) (*nats.StreamInfo, error) {
	streamCfg := &nats.StreamConfig{
		Name:       cfg.Name,
		Subjects:   cfg.Subjects,
		Storage:    cfg.Storage,
		Retention:  cfg.Retention,
		Replicas:   cfg.Replicas,
		MaxAge:     cfg.MaxAge,
		MaxBytes:   cfg.MaxBytes,
		MaxMsgs:    cfg.MaxMsgs,
		Duplicates: cfg.DedupWindow,
		Discard:    nats.DiscardOld,
		// NoAck false - require explicit acks from consumers.
		NoAck: false,
	}

	info, err := sm.js.StreamInfo(cfg.Name)
	if err != nil {
		if !errors.Is(err, nats.ErrStreamNotFound) {
			return nil, fmt.Errorf("fetching stream info %s: %w", cfg.Name, err)
		}

		// Stream does not exist - create it.
		info, err = sm.js.AddStream(streamCfg)
		if err != nil {
			return nil, fmt.Errorf("creating stream %s: %w", cfg.Name, err)
		}
		sm.logger.Info("stream created",
			slog.String("name", cfg.Name),
			slog.Any("subjects", cfg.Subjects),
		)
		return info, nil
	}

	// Stream exists - update configuration.
	info, err = sm.js.UpdateStream(streamCfg)
	if err != nil {
		return nil, fmt.Errorf("updating stream %s: %w", cfg.Name, err)
	}
	sm.logger.Info("stream updated", slog.String("name", cfg.Name))
	return info, nil
}

// Publisher wraps JetStream publishing with sync and async patterns.
type Publisher struct {
	js     nats.JetStreamContext
	logger *slog.Logger
}

// NewPublisher creates a publisher from an existing JetStream context.
func NewPublisher(js nats.JetStreamContext, logger *slog.Logger) *Publisher {
	return &Publisher{js: js, logger: logger}
}

// Publish sends a message synchronously and waits for server acknowledgment.
func (p *Publisher) Publish(ctx context.Context, subject string, data []byte, opts ...nats.PubOpt) (*nats.PubAck, error) {
	ack, err := p.js.Publish(subject, data, opts...)
	if err != nil {
		return nil, fmt.Errorf("js publish to %s: %w", subject, err)
	}

	p.logger.Debug("message published",
		slog.String("subject", subject),
		slog.String("stream", ack.Stream),
		slog.Uint64("seq", ack.Sequence),
		slog.Bool("duplicate", ack.Duplicate),
	)
	return ack, nil
}

// PublishWithDedup sends a message with a deduplication ID.
// Within the stream's Duplicates window, messages with the same ID are silently dropped.
func (p *Publisher) PublishWithDedup(ctx context.Context, subject, msgID string, data []byte) (*nats.PubAck, error) {
	return p.Publish(ctx, subject, data, nats.MsgId(msgID))
}

// AsyncBatch demonstrates async publishing - high throughput, lower latency.
func (p *Publisher) AsyncBatch(ctx context.Context, subject string, messages [][]byte) error {
	futures := make([]nats.PubAckFuture, 0, len(messages))

	for i, data := range messages {
		future, err := p.js.PublishAsync(subject, data)
		if err != nil {
			return fmt.Errorf("async publish message %d: %w", i, err)
		}
		futures = append(futures, future)
	}

	// Wait for all acks or context cancellation.
	for i, future := range futures {
		select {
		case ack := <-future.Ok():
			p.logger.Debug("async ack received",
				slog.Int("index", i),
				slog.Uint64("seq", ack.Sequence),
			)
		case err := <-future.Err():
			return fmt.Errorf("async ack error for message %d: %w", i, err)
		case <-ctx.Done():
			return fmt.Errorf("context canceled waiting for ack %d: %w", i, ctx.Err())
		}
	}

	return nil
}
```

### Junior -> FAANG: Understanding Stream Configuration Before Production

New engineers tend to create streams with default settings and tune later. With JetStream, the defaults will cause production incidents. Three settings require deliberate decisions before any stream handles real traffic.

First, `Retention`. `LimitsPolicy` keeps messages until they age out or the stream fills up, which is right for event logs but wrong for work queues. `WorkQueuePolicy` deletes messages after they are acknowledged, which is right for job queues but means you cannot replay history. `InterestPolicy` keeps messages until all active consumers have acknowledged, which prevents the stream from growing when consumers are slow but surprises teams who expect Kafka-like independent consumer cursors.

Second, `MaxDeliver` must be set on every consumer. This is covered in section 52H.3, but it starts with the stream configuration: the `EnsureStream` call is where you decide how long messages are retained for unacknowledged consumers. If your `MaxAge` is 72 hours and a consumer is down for 4 days, those messages are gone when the consumer comes back. Know your retention window before choosing `MaxAge`.

Third, `Replicas`. For development, `Replicas: 1` is fine. For any production data, use 3 or 5 with a multi-node cluster. `Replicas: 1` on a single-node server is one hardware failure away from total data loss.

Practice exercise: create three streams with different retention policies and verify their behavior by publishing 100 messages to each, then restarting the server and checking what was retained.

### Senior @ FAANG: Stream Configuration as a Platform Contract

The `EnsureStream` pattern shown here is a common production approach, but it has a governance gap: it updates the stream configuration on every service start without version control or change review. At scale, this means any engineer who changes `MaxAge` or `Replicas` in a `StreamConfig` struct triggers an in-place stream reconfiguration at deployment time, with no diff, no approval, and potentially no rollback path.

A mature platform treats stream configuration the same way it treats database schema: changes go through a migration path, are reviewed as infrastructure changes, and are deployed independently from application code. One approach is to separate stream provisioning from service deployment entirely. Stream definitions live in a central infra-as-code repository (Terraform with a NATS provider, or a dedicated stream-provisioner service), and application code only binds to existing streams using `BindStream`. The `EnsureStream` pattern is then limited to development environments and integration tests.

The `Publisher.AsyncBatch` method raises a subtle correctness question worth examining in code review: the `PublishAsync` call returns futures, and the loop then iterates those futures to collect acknowledgments. If the context is canceled partway through the futures loop, some messages have been written to the stream (their futures already completed successfully before the cancellation) and some have not. The caller gets an error return, but the partial batch is not rolled back. This is acceptable for most append-only event streams, but it is a correctness problem for work queues that expect all-or-nothing batch semantics. The fix for work queue semantics is synchronous publish with a transaction boundary at the application layer, not async batch publishing. Documenting this distinction in the method's godoc is a bar-raiser habit.

For stream sizing, the `MaxBytes` field is frequently underestimated. A common mistake is setting `MaxBytes` to 10 GiB and then publishing messages with large payloads. When the stream fills up and `Discard: DiscardOld` is active, older messages are silently dropped. `StreamInfo` exposes `State.Bytes` and `State.Msgs`. Alerting when `State.Bytes` exceeds 80% of `MaxBytes` is a mandatory SLO for any stream carrying business-critical events.

---
