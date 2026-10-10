## Section 6: Stream Processing Patterns

### 6.1 Choosing the stream processor

Before you build windowing logic in raw Go, be clear about what your options are in 2026:

| Engine | Strength | Weakness | Go relevance |
|--------|---------|----------|--------------|
| Apache Flink | True event-time streaming, exactly-once, huge RocksDB state, SQL + DataStream APIs | JVM, operational weight, k8s operator required | Go services consume Flink output. Flink itself runs on JVM |
| Kafka Streams | Embedded library, no separate cluster, transactional writes | JVM-only, state store per instance | None directly |
| Benthos / Redpanda Connect | Stateless or lightly stateful Go service, YAML-configured pipelines, hundreds of connectors | Not built for very large stateful joins | Canonical Go-native choice for transforms, routing, and CDC fan-out |
| Materialize / RisingWave | Streaming SQL with incremental view maintenance | Newer, fewer production war stories | Go clients over pgwire protocol |
| Hand-written Go | Total control, zero JVM, easy to operate | You implement checkpointing, watermarks, state recovery yourself | Fine for simple aggregations and low state footprint |

The rule: pick Flink when you need true stateful streaming at scale with strict exactly-once. Pick Kafka Streams when your whole stack is JVM. Pick Benthos/Redpanda Connect when the transform is stateless or the state fits in memory and you want a Go operational profile. Write it by hand in Go when none of the above fit and the scope is small.

> **Senior track**: The single most common mistake in hand-rolled Go stream processors is confusing processing time with event time. Wall-clock windowing breaks under late events, replay, or partition lag. Use the event's own timestamp, track a watermark as "max observed event time minus allowed lateness", and only close a window when the watermark passes its end. The `WatermarkTracker` below implements this minimally.

### 6.2 Windowed Aggregations

`WindowedAggregator` supports all three standard window semantics (tumbling, sliding, and session) through a single type controlled by a `windowType` constant. The injected `aggregate` function decouples the windowing mechanics from the aggregation logic, so the same `WindowedAggregator` can compute counts, sums, or custom statistics without modifying the windowing state machine.

```go
package streaming

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Window type constants.
const (
	TumblingWindow = "tumbling"
	SlidingWindow  = "sliding"
	SessionWindow  = "session"
)

// WindowedAggregator computes time-windowed aggregations on a stream.
type WindowedAggregator struct {
	windowType string
	windowSize time.Duration
	slideBy    time.Duration // for sliding windows
	sessionGap time.Duration // for session windows
	aggregate  func([]StreamEvent) AggregationResult
	windows    sync.Map     // windowKey → *windowState
	output     chan WindowResult
}

// StreamEvent is a timestamped data point.
type StreamEvent struct {
	Key       string
	Value     float64
	EventTime time.Time
}

// WindowResult is the output of a window computation.
type WindowResult struct {
	Key       string
	WindowStart time.Time
	WindowEnd   time.Time
	Result    AggregationResult
}

// AggregationResult holds computed window metrics.
type AggregationResult struct {
	Count float64
	Sum   float64
	Min   float64
	Max   float64
	Avg   float64
}

type windowState struct {
	events  []StreamEvent
	start   time.Time
	end     time.Time
}

// NewTumblingWindowAggregator creates a non-overlapping window aggregator.
func NewTumblingWindowAggregator(windowSize time.Duration, aggregate func([]StreamEvent) AggregationResult) *WindowedAggregator {
	return &WindowedAggregator{
		windowType: TumblingWindow,
		windowSize: windowSize,
		aggregate:  aggregate,
		output:     make(chan WindowResult, 1024),
	}
}

// Process processes an event and emits window results when windows close.
func (wa *WindowedAggregator) Process(ctx context.Context, event StreamEvent) {
	windowKey := wa.tumblingKey(event.Key, event.EventTime)

	v, _ := wa.windows.LoadOrStore(windowKey, &windowState{
		start: event.EventTime.Truncate(wa.windowSize),
		end:   event.EventTime.Truncate(wa.windowSize).Add(wa.windowSize),
	})
	ws := v.(*windowState)

	ws.events = append(ws.events, event)
}

func (wa *WindowedAggregator) tumblingKey(key string, t time.Time) string {
	windowNum := t.UnixNano() / int64(wa.windowSize)
	return fmt.Sprintf("%s:%d", key, windowNum)
}

// Flush emits all windows that have passed their end time.
func (wa *WindowedAggregator) Flush(now time.Time) {
	wa.windows.Range(func(k, v any) bool {
		ws := v.(*windowState)
		if now.After(ws.end) {
			// Window is closed - compute and emit
			key := k.(string)
			// Extract base key (before the colon)
			baseKey := key
			if idx := len(key) - 1; idx > 0 {
				for i := len(key) - 1; i >= 0; i-- {
					if key[i] == ':' {
						baseKey = key[:i]
						break
					}
				}
			}

			result := wa.aggregate(ws.events)
			select {
			case wa.output <- WindowResult{
				Key:         baseKey,
				WindowStart: ws.start,
				WindowEnd:   ws.end,
				Result:      result,
			}:
			default:
			}
			wa.windows.Delete(k)
		}
		return true
	})
}

// Output returns the channel of window results.
func (wa *WindowedAggregator) Output() <-chan WindowResult { return wa.output }

// SumAggregator computes sum/count/min/max/avg.
func SumAggregator(events []StreamEvent) AggregationResult {
	if len(events) == 0 {
		return AggregationResult{}
	}
	result := AggregationResult{
		Min: events[0].Value,
		Max: events[0].Value,
	}
	for _, e := range events {
		result.Sum += e.Value
		result.Count++
		if e.Value < result.Min {
			result.Min = e.Value
		}
		if e.Value > result.Max {
			result.Max = e.Value
		}
	}
	if result.Count > 0 {
		result.Avg = result.Sum / result.Count
	}
	return result
}

// WatermarkTracker handles late-arriving events in stream processing.
type WatermarkTracker struct {
	maxLag     time.Duration
	watermark  time.Time
	mu         sync.Mutex
}

func NewWatermarkTracker(maxLag time.Duration) *WatermarkTracker {
	return &WatermarkTracker{maxLag: maxLag}
}

// Advance updates the watermark based on the latest event time.
// The watermark = max observed event time - max lag.
func (wt *WatermarkTracker) Advance(eventTime time.Time) time.Time {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	watermark := eventTime.Add(-wt.maxLag)
	if watermark.After(wt.watermark) {
		wt.watermark = watermark
	}
	return wt.watermark
}

// IsLate returns true if an event arrived after the watermark.
func (wt *WatermarkTracker) IsLate(eventTime time.Time) bool {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	return eventTime.Before(wt.watermark)
}

func (wt *WatermarkTracker) Current() time.Time {
	wt.mu.Lock()
	defer wt.mu.Unlock()
	return wt.watermark
}
```

### Junior → FAANG: Stream Processing for First-Job Engineers

Stream processing is one of the densest topics in a system design interview because three distinct ideas collide in it: time, state, and fault tolerance. Juniors who have only written request/response services often carry two prerequisite gaps. First, they confuse processing time (wall clock on the machine running the code) with event time (the timestamp the event was generated at the source). Second, they assume that an unbounded stream can be treated like a batch with more data, which fails immediately because there is no "end" at which to compute a final answer.

The mental model to carry into every discussion. A stream is an unbounded sequence of timestamped events partitioned by some key. A stream processor reads events, maintains keyed state, emits derived events or updates, and survives process restarts by checkpointing state to durable storage. Windowing is how you turn an unbounded stream into bounded chunks you can aggregate over. Watermarks are how the processor decides when it has seen enough late-arriving data to close a window. Checkpointing is how the processor survives a crash without losing state or duplicating output. If you can articulate those four sentences cleanly, you have the entry-point concept.

Windowing taxonomy, worth memorizing for interviews. Tumbling windows are fixed-size, non-overlapping buckets: one-minute tumbling windows give you 60 non-overlapping slots per hour. Sliding windows overlap: five-minute windows sliding by one minute give you one emission per minute, each covering the last five minutes. Session windows are dynamic, closing after a gap of inactivity: if two events from the same user arrive within 30 minutes of each other they belong to the same session, otherwise a new session opens. Global windows are the degenerate case used with custom triggers. The code above implements tumbling directly. Flink and Kafka Streams give you all four out of the box.

Worked example for a first job. A product team wants a real-time dashboard of clicks per campaign over the last five minutes, updated every 10 seconds. This is a sliding window of size 5 minutes sliding by 10 seconds, keyed by campaign ID, aggregating count. The watermark policy allows 30 seconds of lateness: an event whose event time is more than 30 seconds behind the current watermark is dropped or routed to a late-events sink. The state per campaign is the count plus the window boundaries. Checkpoint every 60 seconds to S3. Your first ticket will be tuning the watermark lag (too low and you drop legitimate events, too high and the dashboard feels stale) or writing the late-events sink. Both are bounded, tractable tickets with clear success criteria.

First-job context. Most FAANG stream-processing work runs on Flink (Pinterest, Uber, Netflix, Stripe) or Kafka Streams (LinkedIn) rather than hand-rolled Go. Your Go code will usually be the producer that writes into Kafka, the consumer that reads aggregated output from a Kafka or Iceberg sink, or a small Benthos/Redpanda Connect deployment for stateless transforms. Be able to read Flink SQL. You do not need to write Flink jobs in your first year unless you join a streaming team directly, but you will debug their output.

### Senior @ FAANG: Stream Processing Patterns, State, and the Production Surface

At staff level the stream processing conversation is mostly about state management, time semantics, and failure recovery. The canonical literature is Tyler Akidau, Slava Chernyak, and Reuven Lax's Streaming Systems (2018), which remains the best treatment of event time, watermarks, and triggers. Fabian Hueske and Vasiliki Kalavri's Stream Processing with Apache Flink (2nd ed. 2024) is the reference for Flink internals. Confluent's I Heart Logs by Jay Kreps and the Kafka Streams documentation are the Kafka-native equivalents. The Dataflow Model paper (Akidau et al., 2015) is still the intellectual foundation worth re-reading every few years.

Windowing in depth. Tumbling windows over event time are the default. Sliding windows are expensive in state because each event belongs to multiple windows simultaneously: a five-minute window sliding by one minute means each event is counted in five windows, and the state store grows proportionally. Session windows are the most expensive because window boundaries are data-dependent and cannot be pre-allocated. Flink implements session windows through a merge-on-arrival strategy: each event creates a candidate window, and arriving events either extend an existing window or trigger a merge. The cost is that session windows cannot be incrementally aggregated in the pre-aggregation step of a combiner, which means session-window pipelines must carry every event in state until the window closes. Budget memory accordingly. Global windows are the escape hatch for custom trigger logic (for example, "emit when the sum exceeds a threshold") and should be used sparingly because they leak state unless the custom trigger is disciplined about eviction.

Watermarks are the single most misunderstood primitive. A watermark is a heuristic assertion by the processor that no event with timestamp earlier than the watermark will ever arrive. It is not a guarantee. Flink's default watermark generator tracks the maximum observed event time minus a fixed allowed-lateness bound. Kafka Streams uses stream time, which is effectively the same idea. Tuning the allowed lateness is a correctness-versus-latency tradeoff: too aggressive (too little lateness) drops legitimate late events and corrupts aggregates, too conservative inflates state and delays output. The 2026 production pattern is per-source adaptive watermarks: the processor tracks historical lateness distribution per source partition and sets watermark lag at the P99.9 observed lateness plus a margin. Flink 1.19 added experimental support for this through the `WatermarkStrategy.forGenerator` customization. For business-critical pipelines, emit late events to a side output sink so analysts can reconcile after the fact, rather than silently dropping.

State management and the RocksDB backend. Flink uses RocksDB as its keyed state backend because the JVM heap cannot hold the state a serious pipeline accumulates. Each task manager has a local RocksDB instance, keyed state is partitioned by the key's hash, and checkpoints ship SST files to durable storage (S3, GCS, HDFS). The operational knobs that matter: incremental checkpointing (on by default in 1.15+) ships only the new SSTs rather than the full state, cutting checkpoint cost by an order of magnitude. Managed memory configuration (`taskmanager.memory.managed.size`) governs how much off-heap memory RocksDB gets and is the single most common tuning parameter. State TTL (`StateTtlConfig`) auto-evicts keys that have not been updated for a window, and without it your state grows monotonically. The changelog state backend (introduced in 1.15) trades checkpoint latency for recovery time and is useful for low-latency pipelines where traditional checkpointing creates end-to-end stalls.

Checkpointing, savepoints, and exactly-once. Flink checkpointing uses the Chandy-Lamport distributed snapshot algorithm, implemented through barriers injected into the stream. When a barrier passes an operator, the operator snapshots its state asynchronously and forwards the barrier. When all sinks have acknowledged the barrier, the checkpoint is complete. Checkpoint interval tuning is another first-quarter ticket: too frequent and you burn IO on snapshots, too infrequent and recovery replays too much. The usual starting point is one checkpoint per minute for low-state pipelines and every five to ten minutes for heavy-state ones. Savepoints are user-triggered checkpoints used for version upgrades, pipeline migrations, and state surgery. Exactly-once requires transactional sinks (Kafka transactional producer, JDBC with idempotent upserts, Iceberg atomic commits) plus two-phase-commit coordination with the checkpoint barrier. Without transactional sinks, Flink gives you exactly-once state and at-least-once output. Be precise about this in design reviews.

Complex Event Processing (CEP) via FlinkCEP. CEP detects patterns across streams: sequences, alternations, and time-bounded conjunctions. The canonical use cases are fraud detection (card presented in New York followed by card present in Tokyo within 10 minutes), supply chain anomalies (shipment scanned into warehouse, not scanned out within SLA), and security incident correlation. FlinkCEP compiles a pattern into a non-deterministic finite automaton that maintains partial matches per key. The state cost is proportional to the number of live partial matches, which explodes if patterns are loosely bounded in time. Always set a within-window bound. The alternative tool is Siddhi (WSO2), which has a richer DSL but smaller community. Apache Beam exposes CEP-style patterns through its state API, and Materialize handles them through streaming SQL subqueries. CEP in custom Go code is feasible for small pattern sets but is rarely the right build-versus-buy call.

SQL over streams. Flink SQL is the 2026 dominant interface for stream processing because it lowers the authoring bar and because the same SQL runs on bounded and unbounded inputs through Flink's unified batch/stream engine. ksqlDB (Confluent) is the Kafka-native equivalent, simpler but less feature-complete. Materialize and RisingWave are the two serious streaming database entrants: both expose incremental view maintenance over streaming inputs through a Postgres-compatible SQL interface, meaning you write a `CREATE MATERIALIZED VIEW` over a Kafka topic and the view stays fresh within milliseconds as input changes. Materialize's timely dataflow engine (descended from Naiad) is the most mature incremental view maintenance implementation in production. RisingWave is the open-source challenger and has closed much of the feature gap in 2025. The choice between Flink SQL and a streaming database comes down to: do you need a pipeline (multi-stage transformations with custom operators, choose Flink) or do you need a derived table (continuously fresh result of a query, choose Materialize or RisingWave). Both camps have their interview-legible use cases and the right answer is "it depends on whether the output is consumed by other pipelines or by a BI tool."

Hand-rolled Go stream processors, when they are the right call. Scope is small, state fits in memory or a local BoltDB/Pebble instance, and the team prefers operational simplicity over feature breadth. Redpanda Connect (formerly Benthos) is the most important Go entry in this space and is production-grade for stateless transforms and light stateful aggregations. For anything beyond that, writing your own checkpoint coordinator, watermark tracker, and state backend is months of work, and at the end you have a worse Flink. The honest senior posture is: use Flink unless you have a specific reason not to, and accept the JVM operational tax as the price of not rebuilding the stack from scratch. The exception is edge and embedded contexts (IoT gateways, ship-board systems) where JVM footprint is prohibitive, and there Go plus Pebble is the right choice.

Backpressure, poison messages, and the operational tail. Backpressure in stream processors propagates from slow sinks back to sources. Flink handles this through credit-based flow control in the network stack, Kafka Streams through consumer pause/resume. When backpressure sustains, watermarks stall, windows do not close, and downstream dashboards go stale. The operational response is to identify the slow operator (Flink's backpressure UI, Kafka Streams metrics on queue depth) and either scale it out or widen the downstream sink. Poison messages (malformed events that crash the deserializer) must be routed to a dead-letter sink rather than restarting the job, because a crash-loop on a poison message stalls the entire pipeline. The pattern is a try/catch around deserialization that emits to a Kafka topic named `{pipeline}-dlq` with the raw bytes, the error, and the source offset. Every serious pipeline has a DLQ, and the DLQ itself has an SLO: if DLQ throughput exceeds 0.01 percent of main throughput, someone is paged.

---
