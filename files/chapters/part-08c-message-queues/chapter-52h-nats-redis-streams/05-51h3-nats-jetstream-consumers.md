## 52H.3 NATS JetStream - Consumers

Consumers define how messages are delivered from a stream to subscribers.

### Push vs Pull

**Push consumers**: The server delivers messages to a configured `DeliverSubject`. Best for low-latency, real-time processing where the consumer can keep up with the stream.

**Pull consumers**: The consumer explicitly fetches batches. Best for batch processing, rate-controlled workflows, and work queue patterns where you want explicit concurrency control.

### Deliver Policies

| Policy | Behavior |
|---|---|
| `DeliverAllPolicy` | Start from first message in stream |
| `DeliverNewPolicy` | Only new messages after consumer creation |
| `DeliverByStartSequencePolicy` | Start at a specific sequence number |
| `DeliverByStartTimePolicy` | Start at messages newer than a timestamp |
| `DeliverLastPolicy` | Only the most recent message |
| `DeliverLastPerSubjectPolicy` | Most recent message per filtered subject |

The implementation below covers both consumer types. `NewPushConsumer` binds a durable push consumer to a stream and returns a subscription that receives messages automatically. `NewPullConsumer` creates a durable pull consumer with a `ProcessBatch` method that fetches messages explicitly. The pull consumer includes a `RunLoop` that continuously fetches and processes batches until the context is canceled, with a brief pause on errors to prevent tight retry loops.

Note that `NewPushConsumer` builds a `ConsumerConfig` struct to illustrate the full set of options, but uses `nats.Subscribe` option functions for the actual subscription - this is the idiomatic approach with the `nats.go` client library.

> **Senior track**: The modern `github.com/nats-io/nats.go/jetstream` sub-package (stable since nats.go v1.31, April 2026 release) is now the recommended API for new code. It exposes `Stream`, `Consumer`, `Consume`, `Messages`, and `Fetch` as first-class types and retires push consumers as a legacy path - pull consumers backed by `Consume()` give the server full control over flow and replace virtually every push use case with better batching, back-pressure, and cluster failover. The `nats.JetStreamContext` API shown here still works and is what most production codebases use today, but when you greenfield a service in 2026 reach for the new `jetstream` package. It also unlocks `FilterSubjects` (multiple subject filters per consumer, requires server >= 2.10), which removes the need for fan-in streams in most routing setups.

```go
// file: internal/nats/jetstream/consumer.go
package jetstream

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// PushConsumer subscribes to a stream via server-push delivery.
type PushConsumer struct {
	sub    *nats.Subscription
	logger *slog.Logger
}

// PushConsumerConfig configures a durable push consumer.
type PushConsumerConfig struct {
	Stream         string
	Durable        string
	DeliverSubject string
	FilterSubject  string
	DeliverPolicy  nats.DeliverPolicy
	AckPolicy      nats.AckPolicy
	AckWait        time.Duration
	MaxDeliver     int
	BackOff        []time.Duration
}

// NewPushConsumer creates a durable push consumer and returns a subscription.
func NewPushConsumer(
	js nats.JetStreamContext,
	cfg PushConsumerConfig,
	handler nats.MsgHandler,
	logger *slog.Logger,
) (*PushConsumer, error) {
	consumerCfg := &nats.ConsumerConfig{
		Durable:        cfg.Durable,
		DeliverSubject: cfg.DeliverSubject,
		FilterSubject:  cfg.FilterSubject,
		DeliverPolicy:  cfg.DeliverPolicy,
		AckPolicy:      cfg.AckPolicy,
		AckWait:        cfg.AckWait,
		MaxDeliver:     cfg.MaxDeliver,
		BackOff:        cfg.BackOff,
	}

	sub, err := js.Subscribe(
		cfg.FilterSubject,
		handler,
		nats.Durable(cfg.Durable),
		nats.DeliverNew(),
		nats.AckExplicit(),
		nats.AckWait(cfg.AckWait),
		nats.MaxDeliver(cfg.MaxDeliver),
		nats.ConsumerName(cfg.Durable),
		nats.BindStream(cfg.Stream),
	)
	if err != nil {
		return nil, fmt.Errorf("creating push consumer %s: %w", cfg.Durable, err)
	}

	_ = consumerCfg // used for documentation purposes above

	logger.Info("push consumer started",
		slog.String("stream", cfg.Stream),
		slog.String("durable", cfg.Durable),
		slog.String("filter", cfg.FilterSubject),
	)
	return &PushConsumer{sub: sub, logger: logger}, nil
}

// Unsubscribe stops the push consumer.
func (pc *PushConsumer) Unsubscribe() error {
	return pc.sub.Unsubscribe()
}

// PullConsumer fetches messages in batches from a stream.
type PullConsumer struct {
	js     nats.JetStreamContext
	stream string
	name   string
	sub    *nats.Subscription
	logger *slog.Logger
}

// NewPullConsumer creates a durable pull consumer.
func NewPullConsumer(
	js nats.JetStreamContext,
	stream, consumerName, filterSubject string,
	ackWait time.Duration,
	maxDeliver int,
	backoff []time.Duration,
	logger *slog.Logger,
) (*PullConsumer, error) {
	sub, err := js.PullSubscribe(
		filterSubject,
		consumerName,
		nats.BindStream(stream),
		nats.AckWait(ackWait),
		nats.MaxDeliver(maxDeliver),
		nats.BackOff(backoff),
	)
	if err != nil {
		return nil, fmt.Errorf("creating pull consumer %s: %w", consumerName, err)
	}

	logger.Info("pull consumer started",
		slog.String("stream", stream),
		slog.String("consumer", consumerName),
		slog.String("filter", filterSubject),
	)

	return &PullConsumer{
		js:     js,
		stream: stream,
		name:   consumerName,
		sub:    sub,
		logger: logger,
	}, nil
}

// ProcessBatch fetches up to batchSize messages, calls handler for each, and acks on success.
func (pc *PullConsumer) ProcessBatch(ctx context.Context, batchSize int, handler func(*nats.Msg) error) error {
	msgs, err := pc.sub.Fetch(batchSize, nats.Context(ctx))
	if err != nil {
		if err == context.DeadlineExceeded || err == context.Canceled {
			return nil // Normal shutdown
		}
		// ErrTimeout means no messages available - not an error.
		if err == nats.ErrTimeout {
			return nil
		}
		return fmt.Errorf("fetch from %s/%s: %w", pc.stream, pc.name, err)
	}

	for _, msg := range msgs {
		meta, err := msg.Metadata()
		if err != nil {
			pc.logger.Error("failed to get message metadata",
				slog.String("error", err.Error()),
			)
			// Nak so it gets redelivered.
			_ = msg.Nak()
			continue
		}

		pc.logger.Debug("processing message",
			slog.Uint64("seq", meta.Sequence.Stream),
			slog.String("subject", msg.Subject),
			slog.Uint64("delivery_count", meta.NumDelivered),
		)

		if err := handler(msg); err != nil {
			pc.logger.Error("handler error - naking message",
				slog.Uint64("seq", meta.Sequence.Stream),
				slog.String("error", err.Error()),
			)
			// NakWithDelay uses the consumer's BackOff schedule.
			_ = msg.NakWithDelay(backoffDelay(meta.NumDelivered))
			continue
		}

		if err := msg.Ack(); err != nil {
			pc.logger.Error("ack failed",
				slog.Uint64("seq", meta.Sequence.Stream),
				slog.String("error", err.Error()),
			)
		}
	}
	return nil
}

// backoffDelay returns an exponential backoff duration based on delivery attempt.
func backoffDelay(attempt uint64) time.Duration {
	delays := []time.Duration{
		5 * time.Second,
		30 * time.Second,
		2 * time.Minute,
		10 * time.Minute,
	}
	if int(attempt) >= len(delays) {
		return delays[len(delays)-1]
	}
	return delays[attempt]
}

// RunLoop continuously processes batches until context is canceled.
func (pc *PullConsumer) RunLoop(ctx context.Context, batchSize int, handler func(*nats.Msg) error) error {
	pc.logger.Info("pull consumer loop started",
		slog.String("consumer", pc.name),
		slog.Int("batch_size", batchSize),
	)

	for {
		select {
		case <-ctx.Done():
			pc.logger.Info("pull consumer loop stopping", slog.String("consumer", pc.name))
			return nil
		default:
			if err := pc.ProcessBatch(ctx, batchSize, handler); err != nil {
				pc.logger.Error("batch processing error",
					slog.String("consumer", pc.name),
					slog.String("error", err.Error()),
				)
				// Brief pause before retrying to avoid tight error loops.
				select {
				case <-ctx.Done():
					return nil
				case <-time.After(1 * time.Second):
				}
			}
		}
	}
}
```

### Junior -> FAANG: Choosing Between Push and Pull Consumers

The push-vs-pull decision is one of the most common JetStream interview questions at the entry level. Here is a practical heuristic for your first few services.

Reach for a pull consumer by default. Pull consumers give the consumer explicit control over its processing rate. If your handler is slow (calls a database, makes an HTTP request, does CPU-intensive work), a pull consumer prevents the server from overwhelming you with messages faster than you can process them. The `Fetch(batchSize)` call acts as a natural back-pressure valve.

Push consumers are appropriate when your handler is very fast and consistently keeps up with the stream, and when you need the absolute lowest latency between message arrival and handler invocation. Real-time dashboards and streaming analytics are the canonical push consumer use cases.

Regardless of which type you use, always set `MaxDeliver` and `AckWait`. A consumer without these settings will eventually produce a poison-pill situation where one bad message is retried forever. The `backoffDelay` function in the code above is a template you can copy directly into your first production service.

### Senior @ FAANG: Consumer Design for Multi-Tenant and High-Churn Environments

The `PullConsumer` implementation here is correct for a single-service workload. At platform scale, three additional concerns emerge that the code does not address.

The first is consumer lifecycle in ephemeral compute environments. In a Kubernetes deployment where pods are replaced on every deploy, the durable consumer name must be stable across pod restarts. If `consumerName` is derived from the pod name or includes a UUID, each new pod creates a new durable consumer, leaving the old consumer's unacknowledged messages in limbo. For deployments with a StatefulSet, pin consumer names to the ordinal index. For Deployments (not StatefulSets), the consumer name should be a per-replica slot derived from the deployment name and a slot number, managed by a leader-election sidecar. This is a non-trivial infrastructure concern that should live in the platform library, not in individual services.

The second concern is the `MaxAckPending` setting, which is absent from the `PullConsumer` constructor above. For work queue streams with `WorkQueuePolicy`, `MaxAckPending` caps how many messages can be outstanding (delivered but not acked) across all consumers on the stream at once. Setting it too low throttles throughput. Setting it too high allows a slow or crashed consumer to hold a large batch in-flight, blocking other consumers from receiving new work. The right value is `batchSize * workerCount * 2`, and it should be calculated from the actual deployment configuration rather than hardcoded.

The third concern is consumer lag observability. The `ProcessBatch` loop does not emit a lag metric: the difference between the stream's current sequence and the consumer's current ack floor. Consumer lag is the most actionable SLO signal for a JetStream-backed service. At FAANG, a pull consumer without lag metrics and an alert on lag exceeding the `MaxAge` budget is considered incomplete. The `ConsumerInfo` API returns `NumPending` (messages waiting to be delivered) and `NumAckPending` (delivered but not yet acked). Both should be exported as Prometheus gauges.

---
