## Section 2: Kappa Architecture

### 2.1 Single Stream Processing Path

Kappa is the default streaming architecture in 2026. Its central bet is that a durable append-only log (Kafka, Redpanda, Pulsar) plus a stateful stream processor (Flink for true streaming, Kafka Streams for JVM in-process, Benthos/Redpanda Connect for stateless Go transforms) can handle both real-time and historical workloads. Reprocessing, the case Lambda's batch layer existed for, becomes "spin up a parallel consumer from offset 0, let it catch up, swap the serving view atomically". On typical Flink deployments the replay catches up at 10x to 100x ingestion rate because there is no external network I/O gating the consumer.

> **Senior track**: Kappa is not magic. It collapses two codepaths into one, but it adds three hard problems back: (1) exactly-once semantics across the processor and its sinks (Flink's two-phase commit or Kafka transactions), (2) state store size (RocksDB-backed operator state can grow into terabytes and needs checkpointing), and (3) schema evolution (old events must remain replayable under new code). When an interviewer asks "why might you still pick Lambda?", the honest answer is: when the batch engine offers a capability streaming cannot (shuffle-heavy joins, complex UDFs in SQL warehouses), not "because batch is safer".

Stream processing patterns (windowing, watermarking, and stateful joins) allow Go services to compute real-time aggregations over unbounded event streams. The Go implementation below shows a minimal Kappa processor that dispatches events to typed handlers and supports reprocessing from any Kafka offset. For true stateful streaming at scale, most teams embed Flink or Kafka Streams upstream and let Go services consume the already-aggregated output.

```go
package kappa

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

// CheckpointStore tracks consumer offsets for restart recovery.
type CheckpointStore interface {
	Save(ctx context.Context, processorName string, offset int64) error
	Load(ctx context.Context, processorName string) (int64, error)
}

// StreamProcessor implements Kappa architecture: one pipeline for all data.
type StreamProcessor struct {
	name        string
	handlers    []EventHandler
	state       StateStore
	checkpoint  CheckpointStore
	metrics     ProcessorMetrics
}

// EventHandler processes one type of event.
type EventHandler interface {
	CanHandle(eventType string) bool
	Handle(ctx context.Context, event Event, state StateStore) error
}

// Event is the universal data unit in Kappa.
type Event struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	OccurredAt time.Time      `json:"occurred_at"`
	Source    string          `json:"source"`
	Version   int             `json:"version"`
}

// StateStore is an abstract key-value store for processor state.
type StateStore interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	Increment(ctx context.Context, key string, delta int64) (int64, error)
}

// ProcessorMetrics tracks processing statistics.
type ProcessorMetrics struct {
	processed atomic.Int64
	errors    atomic.Int64
	latencyNs atomic.Int64
}

func (m *ProcessorMetrics) RecordProcessed(latency time.Duration) {
	m.processed.Add(1)
	m.latencyNs.Add(latency.Nanoseconds())
}

func (m *ProcessorMetrics) RecordError() { m.errors.Add(1) }

func (m *ProcessorMetrics) AvgLatencyMs() float64 {
	n := m.processed.Load()
	if n == 0 {
		return 0
	}
	return float64(m.latencyNs.Load()/n) / float64(time.Millisecond)
}

// NewStreamProcessor creates a Kappa processor.
func NewStreamProcessor(name string, state StateStore, ck CheckpointStore) *StreamProcessor {
	return &StreamProcessor{name: name, state: state, checkpoint: ck}
}

// AddHandler registers an event handler.
func (sp *StreamProcessor) AddHandler(h EventHandler) {
	sp.handlers = append(sp.handlers, h)
}

// Process consumes events from in and dispatches to registered handlers.
func (sp *StreamProcessor) Process(ctx context.Context, in <-chan Event) error {
	for {
		select {
		case event, ok := <-in:
			if !ok {
				return nil
			}
			start := time.Now()
			err := sp.dispatch(ctx, event)
			if err != nil {
				sp.metrics.RecordError()
				// Log but continue - don't stop pipeline on one bad event
				fmt.Printf("processor %s: event %s error: %v\n", sp.name, event.ID, err)
			} else {
				sp.metrics.RecordProcessed(time.Since(start))
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (sp *StreamProcessor) dispatch(ctx context.Context, event Event) error {
	var lastErr error
	handled := false
	for _, h := range sp.handlers {
		if h.CanHandle(event.Type) {
			if err := h.Handle(ctx, event, sp.state); err != nil {
				lastErr = err
			}
			handled = true
		}
	}
	if !handled {
		// Unhandled events are not errors - just skip
		return nil
	}
	return lastErr
}

// Reprocess replays all events from an offset (Kappa's key advantage).
// This allows recomputing state from scratch when business logic changes.
func (sp *StreamProcessor) Reprocess(ctx context.Context, source EventSource, fromOffset int64) error {
	fmt.Printf("Starting reprocessing from offset %d\n", fromOffset)

	// Clear existing state
	// (In production, write to a new state store version, then atomically swap)

	events, err := source.ReadFrom(ctx, fromOffset)
	if err != nil {
		return fmt.Errorf("read from %d: %w", fromOffset, err)
	}

	return sp.Process(ctx, events)
}

// EventSource provides historical event replay.
type EventSource interface {
	ReadFrom(ctx context.Context, offset int64) (<-chan Event, error)
}

// KafkaEventSource reads events from Kafka for reprocessing.
type KafkaEventSource struct {
	brokers []string
	topic   string
}

func NewKafkaEventSource(brokers []string, topic string) *KafkaEventSource {
	return &KafkaEventSource{brokers: brokers, topic: topic}
}

func (s *KafkaEventSource) ReadFrom(ctx context.Context, offset int64) (<-chan Event, error) {
	out := make(chan Event, 1024)

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     s.brokers,
		Topic:       s.topic,
		StartOffset: offset,
		MinBytes:    1,
		MaxBytes:    10 << 20,
	})

	go func() {
		defer close(out)
		defer reader.Close()
		for {
			msg, err := reader.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				return
			}
			var event Event
			if err := json.Unmarshal(msg.Value, &event); err != nil {
				continue
			}
			select {
			case out <- event:
				reader.CommitMessages(ctx, msg)
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}
```

### Junior to FAANG: reading Kappa code without the hype

The code above looks like a Kappa processor, but a junior engineer should understand three things that the code does not make obvious. First, this is a stateless dispatcher with a pluggable state store, not a full streaming engine. Real Kappa workloads at scale run on Flink, Kafka Streams, or Spark Structured Streaming because those engines own the state, the checkpointing, and the exactly-once coordination with the log. A Go service like this is perfectly appropriate as the last mile, consuming already-aggregated output from Flink and serving it over an API, or as a stateless transformation step in an ingestion pipeline. It is not a Flink replacement. Pretending otherwise will produce a system that works in development and melts in production once state grows past a few gigabytes or failure recovery demands exactly-once semantics.

Second, the `Reprocess` method is the centerpiece of Kappa's value proposition, and the code comment flagging the need to write to a new state store version and atomically swap is the single most important line in the file. Reprocessing is how Kappa replaces Lambda's batch layer. When a business rule changes, you do not re-run a Spark job against historical data. You spin up a second instance of the stream processor reading from offset zero with the new code, let it catch up to the live head, verify it produces sensible results, and then atomically swap the serving view to point at the new state store. This dual-run pattern is the production shape of Kappa reprocessing, and the Go code sketches it but leaves the swap mechanics to the operator. In a real deployment the swap is usually handled by pointing the API tier at a versioned Redis keyspace, a versioned Iceberg table, or a versioned materialized view in Postgres.

Third, the `KafkaEventSource` commits offsets after sending to the channel but before the handler processes the event. That is at-most-once semantics, which is the wrong default. If the process crashes between the commit and the handler finishing, the event is lost. A junior looking at this should recognize that the right pattern is to commit after successful handling, not after reading, and to make the handler idempotent so that replays after a crash do not double-count. That correction, plus an idempotency key check in the handler, is the minimum viable version of at-least-once processing in Go against Kafka.

A common first-job worked example. Product asks for a leaderboard of top items purchased in the last hour, updated every second. The Kappa shape is to have the orders service emit an event to Kafka on every purchase, to write a small Go consumer using code like the above that increments a per-item counter in Redis with a one-hour TTL, and to serve the top-N from Redis via a sorted set. When a bug is found two weeks later, for example that test orders were not being filtered out, the fix is to deploy a new version of the handler, start it reading from the Kafka offset corresponding to two weeks ago, let it rebuild the Redis state into a new keyspace, and flip the serving layer over when the new keyspace catches up. That is the full Kappa lifecycle in one feature, and it is the example to have ready for any interview that asks you to describe a streaming system you built.

Interview entry-point questions on Kappa cluster on a few themes. Expect to be asked what makes Kappa possible that was not possible in 2011, and the answer is durable long-retention logs through Kafka tiered storage plus stateful stream processors with exactly-once guarantees. Expect to be asked how Kappa handles late-arriving data, and the answer is event-time processing with watermarks, where the processor tracks the minimum event timestamp it has seen and fires windowed aggregates only after the watermark advances past the window end plus a configurable allowed lateness. Expect to be asked what happens if the Kafka topic retention expires before you need to reprocess, and the answer is that you either extend retention with tiered storage to S3 or maintain a compacted snapshot of the log in an Iceberg table so that reprocessing reads from the lakehouse for old data and from Kafka for new data.

### Senior at FAANG: Kappa in 2026, the honest operational picture

At staff and principal level the Kappa conversation has matured significantly since Kreps's 2014 essay. The pattern has won, but the victory has surfaced a set of operational realities that the original formulation understated. A senior engineer should be able to articulate five of them clearly in a design review, because they are the questions that separate a credible Kappa design from a naive one.

The first reality is that exactly-once semantics are a property of the full pipeline, not of any single component, and the naive mental model that "Flink gives you exactly-once" is wrong in a load-bearing way. Flink's exactly-once guarantee covers the path from the Kafka source through Flink's internal state to a transactional sink. The guarantee is implemented via a two-phase commit protocol where Flink's checkpoint barrier triggers a pre-commit on all sinks, waits for all sinks to acknowledge, and then issues the commit alongside the checkpoint completion. The Kafka transactional producer, introduced in Kafka 0.11 in 2017 via KIP-98, is the canonical compatible sink. When the sink is Kafka, the guarantee extends end-to-end because the downstream consumer reads with `isolation.level=read_committed` and never sees uncommitted output. When the sink is Iceberg, the guarantee extends because Iceberg's snapshot commit is atomic at the metadata layer. When the sink is Elasticsearch, Redis, a plain HTTP endpoint, or any system without transactional commit semantics, the guarantee degrades to at-least-once and the consumer must provide idempotency. At staff level, the correct question to ask in a design review is not "is this exactly-once" but "what is the transactional boundary, and where does idempotency take over." If the team cannot answer that precisely, they do not have exactly-once semantics regardless of what the marketing deck claims.

The second reality is that state size dominates operational complexity at scale. Flink's RocksDB state backend, the de facto standard for large-state jobs, comfortably handles terabyte-scale state per operator with incremental checkpoints to S3. The operational consequences are significant. Incremental checkpoints mean that checkpoint storage grows with the churn rate of the state, not with the instantaneous state size, which in practice means that a job with high update rates can produce hundreds of gigabytes of checkpoint data per hour even with a steady-state of ten gigabytes. Savepoints, the portable snapshots used for job upgrades, serialize the full state and can take hours for large jobs, which creates a deployment window problem. State TTL, configurable per operator, is the primary tool for bounding growth, and the common failure mode is that teams set it generously, state grows without bound, and the job eventually cannot recover from a failure because the checkpoint restore time exceeds the acceptable downtime. At principal level, state sizing and retention policy should be a first-class design input, not a tuning knob to be adjusted later.

The third reality is schema evolution of the event log, which is the hardest long-term problem in Kappa and the one Kreps's original essay addressed only glancingly. The log is immutable, which means that an event written under version 1 of a schema must remain readable by every future version of the processor that might replay it. The only sustainable pattern is a schema registry with enforced compatibility rules, typically Confluent Schema Registry or Apicurio with Avro, Protobuf, or JSON Schema, configured for backward-compatible evolution. Backward compatibility means that the new schema can read old data, which in practice means you can add optional fields and remove unused optional fields but you cannot rename fields or change types without versioning. When a breaking change is genuinely required, the mature pattern is to emit both old and new event types in parallel for a migration window, update consumers to prefer the new type with fallback to the old, and deprecate the old type only after retention has aged out every consumer that might still need it. This discipline is boring and unglamorous and it is also the single thing that most distinguishes Kappa systems that age gracefully from ones that become unmaintainable.

The fourth reality is the Pulsar versus Kafka decision, which in 2026 has a more nuanced answer than either camp's advocates admit. Kafka's KRaft removal of Zookeeper in 3.3 and the general availability of tiered storage in 3.9, combined with the Confluent ecosystem and the sheer weight of operational tooling, make Kafka the default choice for most workloads. Pulsar's architectural separation of serving from storage via BookKeeper gives it genuine advantages in multi-tenant SaaS workloads where one cluster serves thousands of independent tenants with different retention and throughput profiles, and in deployments where geo-replication must be transparent rather than bolted on via MirrorMaker. Streamlio and later StreamNative have productionised Pulsar at real scale, and Yahoo, Tencent, and Splunk run it at billions of messages per day. The decision criterion at staff level is not "which is better" but "which failure modes can we absorb." Kafka's failure modes are well-documented and every senior data engineer has debugged them. Pulsar's failure modes, particularly BookKeeper-related ones, require a smaller pool of expertise. If your team does not have Pulsar experience and the workload does not specifically need multi-tenant isolation or native geo-replication, choose Kafka.

The fifth reality is the Flink versus Spark Structured Streaming versus Kafka Streams versus Beam decision, which determines the character of the entire pipeline. Flink is the correctness-first choice with true event-time semantics, rigorous watermarks, and mature exactly-once via two-phase commit. Its operational weight is significant, running a dedicated JobManager and TaskManagers with Zookeeper or Kubernetes-native coordination, and its learning curve for state management is real. Spark Structured Streaming, in micro-batch mode, wins when the organization already runs Spark for batch and wants to share both code and cluster. Its continuous processing mode is still experimental in practice as of 2026 despite being announced years ago, so its latency floor is typically hundreds of milliseconds to seconds rather than the tens of milliseconds Flink can hit. Kafka Streams is a library that runs inside a JVM service and scales by adding instances, which makes it the right answer for service-owned stream processing that should not require a separate cluster. Its exactly-once guarantee is tighter than a naive Go consumer because it uses Kafka transactions internally, but it lacks Flink's state backend maturity for very large state. Apache Beam is a portable API over runners and matters primarily when you need to run the same pipeline across Google Cloud Dataflow, Flink, and Spark, which in practice is mostly Google Cloud shops hedging against vendor lock-in. The fifth option worth mentioning is ksqlDB, which expresses stream-table duality as SQL running inside Kafka Streams, and which shines for lightweight analytics and stateful transformations that fit inside the declarative SQL model.

Stream-table duality is the conceptual lens through which all of these engines can be understood. The duality states that a table is the current-state projection of a log of changes, and a log is the changelog of a table under updates. Materializing a GROUP BY aggregate on a stream produces a table. Emitting a changelog of a table produces a stream. ksqlDB and Flink SQL both expose this as first-class syntax with `STREAM` and `TABLE` keywords. The design implication at principal level is that you stop designing databases and streams as separate systems with synchronization logic between them and start designing a single log as the source of truth with multiple projections materialized for different access patterns. Event sourcing, CQRS, CDC, and the lakehouse streaming hybrid are all special cases of this framing. Once you see the duality, the Kappa architecture is no longer a choice to debate. It is the consequence of taking the duality seriously.

The honest 2026 answer to the question "should we use Lambda or Kappa" is therefore neither. The answer is the lakehouse-native streaming hybrid, where a Kafka log is the operational source of truth for events, an Iceberg table is the analytical source of truth for state, Flink maintains the streaming projections, Spark or Trino handles the batch projections, and both engines share the same schema registry and the same transaction boundary. This is Kappa's log-centric philosophy combined with Lambda's recognition that batch and streaming have genuinely different workload shapes, reconciled through a shared table format that did not exist when either architecture was first proposed. Design accordingly, and when an interviewer asks the Lambda versus Kappa question, give them this answer rather than picking a side.

---
