## 7. Cross-Region Replication Engine

The replication engine publishes mutations to a global message bus (Kafka with MirrorMaker 2 or AWS MSK Global Replication) and consumes from remote regions. When your application writes data in one region, the engine wraps that mutation in a `ReplicationEvent` that includes the table name, key, payload, a vector clock snapshot, and a timestamp. This event is published to a Kafka topic, and consumers in every other region pick it up asynchronously. On the receiving side, the engine loads the local version of the same key, runs the configured conflict resolver (LWW, vector-clock-aware, or a custom domain-specific merge function), and writes the winner to the local store. Events from the local region are automatically skipped to avoid feedback loops.

```go
// replication/engine.go
package replication

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"yourmodule/crdt"
)

// OperationType classifies a replicated mutation.
type OperationType string

const (
	OpUpsert OperationType = "upsert"
	OpDelete OperationType = "delete"
	OpMerge  OperationType = "merge" // CRDT merge
)

// ReplicationEvent is the wire format sent across regions.
type ReplicationEvent struct {
	ID          string            `json:"id"`
	SourceRegion string           `json:"source_region"`
	Table       string            `json:"table"`
	Key         string            `json:"key"`
	Op          OperationType     `json:"op"`
	Payload     json.RawMessage   `json:"payload"`
	Clock       *crdt.VectorClock `json:"clock"`
	Timestamp   time.Time         `json:"timestamp"`
	Checksum    string            `json:"checksum"` // SHA-256 of payload
}

// Publisher sends events to a remote bus. Interface for testability.
type Publisher interface {
	Publish(ctx context.Context, topic string, event *ReplicationEvent) error
}

// Subscriber receives events from the bus.
type Subscriber interface {
	Subscribe(ctx context.Context, topic string) (<-chan *ReplicationEvent, error)
}

// ConflictResolver decides which version wins when two concurrent writes arrive.
type ConflictResolver interface {
	Resolve(local, remote *ReplicationEvent) (*ReplicationEvent, error)
}

// LWWConflictResolver picks the event with the later timestamp.
type LWWConflictResolver struct{}

func (r *LWWConflictResolver) Resolve(local, remote *ReplicationEvent) (*ReplicationEvent, error) {
	if remote.Timestamp.After(local.Timestamp) {
		return remote, nil
	}
	// Tie-break by source region lexicographic order for determinism.
	if local.Timestamp.Equal(remote.Timestamp) && remote.SourceRegion > local.SourceRegion {
		return remote, nil
	}
	return local, nil
}

// VectorClockConflictResolver uses vector clocks to detect true conflicts.
type VectorClockConflictResolver struct {
	onConflict func(local, remote *ReplicationEvent) (*ReplicationEvent, error)
}

func NewVectorClockResolver(
	onConflict func(local, remote *ReplicationEvent) (*ReplicationEvent, error),
) *VectorClockConflictResolver {
	return &VectorClockConflictResolver{onConflict: onConflict}
}

func (r *VectorClockConflictResolver) Resolve(local, remote *ReplicationEvent) (*ReplicationEvent, error) {
	if local.Clock == nil || remote.Clock == nil {
		// Fall back to LWW if clocks are missing.
		lww := &LWWConflictResolver{}
		return lww.Resolve(local, remote)
	}

	relation := local.Clock.Compare(remote.Clock)
	switch relation {
	case crdt.RelationBefore:
		return remote, nil // remote is causally later
	case crdt.RelationAfter:
		return local, nil // local is causally later
	case crdt.RelationEqual:
		return local, nil // identical; keep local
	case crdt.RelationConcurrent:
		if r.onConflict != nil {
			return r.onConflict(local, remote)
		}
		// Default: LWW tie-break
		if remote.Timestamp.After(local.Timestamp) {
			return remote, nil
		}
		return local, nil
	}
	return local, nil
}

// Store is the local data store interface that the engine writes into.
type Store interface {
	Get(ctx context.Context, table, key string) (*ReplicationEvent, error)
	Put(ctx context.Context, event *ReplicationEvent) error
}

// Engine orchestrates publishing local mutations and applying remote ones.
type Engine struct {
	localRegion string
	publisher   Publisher
	subscriber  Subscriber
	store       Store
	resolver    ConflictResolver
	clock       *crdt.VectorClock
	mu          sync.Mutex
	logger      *slog.Logger
}

// NewEngine constructs a replication engine for the local region.
func NewEngine(
	localRegion string,
	pub Publisher,
	sub Subscriber,
	store Store,
	resolver ConflictResolver,
	logger *slog.Logger,
) *Engine {
	return &Engine{
		localRegion: localRegion,
		publisher:   pub,
		subscriber:  sub,
		store:       store,
		resolver:    resolver,
		clock:       crdt.NewVectorClock(),
		logger:      logger,
	}
}

// Publish records a local mutation, advances the vector clock, and sends to bus.
func (e *Engine) Publish(ctx context.Context, table, key string, op OperationType, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshalling payload: %w", err)
	}

	e.mu.Lock()
	e.clock.Increment(e.localRegion)
	clock := e.clock.Clone()
	e.mu.Unlock()

	event := &ReplicationEvent{
		ID:           generateID(),
		SourceRegion: e.localRegion,
		Table:        table,
		Key:          key,
		Op:           op,
		Payload:      raw,
		Clock:        clock,
		Timestamp:    time.Now().UTC(),
	}

	topic := topicFor(table)
	if err := e.publisher.Publish(ctx, topic, event); err != nil {
		return fmt.Errorf("publishing to topic %q: %w", topic, err)
	}

	e.logger.InfoContext(ctx, "event published",
		"region", e.localRegion, "table", table, "key", key, "op", op)
	return nil
}

// StartConsuming begins reading remote events and applying them.
func (e *Engine) StartConsuming(ctx context.Context, tables []string) error {
	for _, table := range tables {
		ch, err := e.subscriber.Subscribe(ctx, topicFor(table))
		if err != nil {
			return fmt.Errorf("subscribing to table %q: %w", table, err)
		}
		go e.consumeLoop(ctx, ch)
	}
	return nil
}

func (e *Engine) consumeLoop(ctx context.Context, ch <-chan *ReplicationEvent) {
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			if event.SourceRegion == e.localRegion {
				continue // skip our own events
			}
			if err := e.applyRemote(ctx, event); err != nil {
				e.logger.ErrorContext(ctx, "failed to apply remote event",
					"id", event.ID, "region", event.SourceRegion, "err", err)
			}
		}
	}
}

func (e *Engine) applyRemote(ctx context.Context, remote *ReplicationEvent) error {
	// Merge remote clock into local.
	e.mu.Lock()
	e.clock.Merge(remote.Clock)
	e.mu.Unlock()

	// Load local version.
	local, err := e.store.Get(ctx, remote.Table, remote.Key)
	if err != nil {
		// Key doesn't exist locally yet - apply directly.
		return e.store.Put(ctx, remote)
	}

	// Resolve conflict.
	winner, err := e.resolver.Resolve(local, remote)
	if err != nil {
		return fmt.Errorf("conflict resolution failed: %w", err)
	}

	e.logger.InfoContext(ctx, "remote event applied",
		"table", remote.Table, "key", remote.Key,
		"winner", winner.SourceRegion)
	return e.store.Put(ctx, winner)
}

func topicFor(table string) string {
	return "replication." + table
}

// generateID returns a simple monotonic ID. In production use uuid or ulid.
var idCounter uint64

func generateID() string {
	idCounter++
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), idCounter)
}
```

---

### Junior -> FAANG: Understanding the Replication Event Model

The most important line in the `Engine` code is the one that skips self-originated events: `if event.SourceRegion == e.localRegion { continue }`. Without this guard, the engine would consume its own publications, re-apply them locally, and republish them again, creating an infinite feedback loop. This pattern (filter your own events) appears in any system that uses a shared message bus for replication: change data capture (CDC), event sourcing, and CQRS all share this idiom.

The `ConflictResolver` interface is the extension point that makes the engine composable. The chapter provides `LWWConflictResolver` and `VectorClockConflictResolver`. For an interview question like "how would you handle a case where an order's status can be canceled from two regions simultaneously?", the answer is "implement a domain-specific `ConflictResolver` that returns an error for the canceled-canceled case and pages the on-call engineer, rather than silently picking a winner."

Practice: implement a `MaxConflictResolver[T constraints.Ordered]` that always picks the replication event whose payload has the higher numeric value. This is useful for metrics aggregation where you want the maximum observed value to win.

### Senior @ FAANG: Replication Engine as a Platform Primitive

**Exactly-once processing requires more than unique event IDs.** The engine above generates event IDs via `generateID()` which uses a global counter, making IDs non-unique across process restarts. A production engine uses UUIDs or ULIDs for event IDs and maintains a deduplication window in Redis (keyed by event ID, with TTL longer than the maximum redelivery window). The `applyRemote` function checks this window before calling `store.Put`. Without this, a Kafka consumer restart causes every in-flight event to be reprocessed, potentially applying the same update twice.

**Checksum verification at the consumer.** The `ReplicationEvent` struct has a `Checksum` field for the payload's SHA-256. The `applyRemote` method does not verify it. A production engine verifies the checksum before applying the event and sends the malformed event to a dead-letter topic. Without this verification, a single corrupt message in the replication bus can silently corrupt data in every remote region that processes it.

**Replication lag monitoring as a primary SLA metric.** The engine publishes and consumes events but does not track the age of the oldest unprocessed event. In production, every `consumeLoop` should emit a metric: the difference between `time.Now()` and the event's `Timestamp`. This is the replication lag. If lag exceeds the RPO threshold (e.g., 30 seconds for a tier-1 service), an alert fires. This metric is more actionable than Kafka consumer group lag in bytes because it is expressed in business-meaningful units (time, which maps directly to RPO).

**Topic partitioning strategy affects conflict frequency.** The engine uses one Kafka topic per table. Within that topic, events for the same key should go to the same partition to preserve ordering for that key. If two concurrent writes to the same key land in different partitions, they may be consumed out of order by different consumer goroutines, and the vector clock comparison may yield a spurious `RelationAfter` instead of `RelationConcurrent`. A production engine uses key-based partitioning (`hash(table:key) % numPartitions`) and runs a single consumer goroutine per partition to preserve per-key ordering.

**Conflict resolver observability.** Every time the `LWWConflictResolver` or `VectorClockConflictResolver` discards an event, it should emit a structured log entry and increment a `conflicts_discarded_total` counter labeled by table, resolver type, and winning region. At staff level, you build a Grafana dashboard around this metric and set an alert if the conflict rate for any table exceeds a threshold. A spike in conflicts is an early signal of a split-brain condition or a replication configuration problem.
