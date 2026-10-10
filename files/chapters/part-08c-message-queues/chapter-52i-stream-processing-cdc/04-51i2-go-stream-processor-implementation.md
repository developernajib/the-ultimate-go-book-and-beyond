## 52I.2 Go Stream Processor Implementation

> **Senior track**: In-process Go windowing is appropriate only when state either fits in one pod's memory and can be rebuilt on restart, or is pushed to Redis. For multi-pod shared state, durable checkpointing, or event-time joins across streams, use Flink (or Kafka Streams if you're on the JVM) rather than reimplementing RocksDB in Go. For stateless transforms (filter, enrich, reencode, route), Benthos / Redpanda Connect (and the Bento fork) let you skip writing Go at all, with YAML config and a production-grade runtime.

### Generic Event Processor

The following Go implementation uses generics to define a type-safe `Processor[T]` that handles concurrency and backpressure without duplicating boilerplate across pipeline stages. The `Event` interface requires each event to expose its timestamp and partitioning key, which the windowing layer uses for time-based bucketing and key-based grouping.

```go
package stream

import (
    "context"
    "sync"
    "time"
)

// Event is the base interface for all stream events
type Event interface {
    EventTime() time.Time
    Key() string
}

// Processor transforms one event type to another
type Processor[In, Out any] interface {
    Process(ctx context.Context, event In) ([]Out, error)
}

// Pipeline chains processors together
type Pipeline[T Event] struct {
    workers int
    input   <-chan T
}

func NewPipeline[T Event](input <-chan T, workers int) *Pipeline[T] {
    return &Pipeline[T]{workers: workers, input: input}
}

// WindowKey computes the tumbling window start time for an event
func TumblingWindowKey(eventTime time.Time, windowSize time.Duration) time.Time {
    ts := eventTime.UnixNano()
    size := windowSize.Nanoseconds()
    return time.Unix(0, (ts/size)*size).UTC()
}
```

### Tumbling Window Aggregator

Tumbling windows divide a stream into fixed-size, non-overlapping time buckets - the simplest aggregation primitive for metrics, billing, and rate calculations. This implementation maintains an in-memory map of time-bucketed accumulators keyed by `(partitionKey, windowStart)`. When the watermark advances past a window's end time, the aggregator emits the result and discards the window state. Events arriving after `watermark - allowedLateness` are dropped and logged.

```go
package stream

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

// WindowResult holds the aggregated result for a completed window
type WindowResult[T any] struct {
    WindowStart time.Time
    WindowEnd   time.Time
    Key         string
    Value       T
    Count       int64
}

// TumblingWindowAggregator aggregates events into tumbling windows
type TumblingWindowAggregator[T Event, A any] struct {
    windowSize     time.Duration
    allowedLateness time.Duration
    accumulate     func(acc A, event T) A
    zero           func() A

    mu       sync.Mutex
    windows  map[windowKey]*windowState[A]
    watermark time.Time

    output chan WindowResult[A]
    logger *slog.Logger
}

type windowKey struct {
    key   string
    start time.Time
}

type windowState[A any] struct {
    acc   A
    count int64
    start time.Time
    end   time.Time
}

func NewTumblingWindowAggregator[T Event, A any](
    windowSize time.Duration,
    allowedLateness time.Duration,
    zero func() A,
    accumulate func(acc A, event T) A,
    logger *slog.Logger,
) *TumblingWindowAggregator[T, A] {
    return &TumblingWindowAggregator[T, A]{
        windowSize:      windowSize,
        allowedLateness: allowedLateness,
        accumulate:      accumulate,
        zero:            zero,
        windows:         make(map[windowKey]*windowState[A]),
        output:          make(chan WindowResult[A], 1000),
        logger:          logger,
    }
}

// Add processes an incoming event
func (w *TumblingWindowAggregator[T, A]) Add(event T) {
    w.mu.Lock()
    defer w.mu.Unlock()

    eventTime := event.EventTime()
    windowStart := TumblingWindowKey(eventTime, w.windowSize)
    windowEnd := windowStart.Add(w.windowSize)

    // Check if event is late (beyond watermark + allowed lateness)
    if eventTime.Before(w.watermark.Add(-w.allowedLateness)) {
        w.logger.Warn("dropping late event",
            "event_time", eventTime,
            "watermark", w.watermark,
            "key", event.Key(),
        )
        return
    }

    k := windowKey{key: event.Key(), start: windowStart}
    state, ok := w.windows[k]
    if !ok {
        state = &windowState[A]{
            acc:   w.zero(),
            start: windowStart,
            end:   windowEnd,
        }
        w.windows[k] = state
    }

    state.acc = w.accumulate(state.acc, event)
    state.count++
}

// AdvanceWatermark advances the watermark and emits completed windows
func (w *TumblingWindowAggregator[T, A]) AdvanceWatermark(newWatermark time.Time) {
    w.mu.Lock()
    defer w.mu.Unlock()

    if !newWatermark.After(w.watermark) {
        return
    }
    w.watermark = newWatermark

    // Emit windows that are now complete (end time < watermark)
    for k, state := range w.windows {
        if state.end.Before(w.watermark) {
            select {
            case w.output <- WindowResult[A]{
                WindowStart: state.start,
                WindowEnd:   state.end,
                Key:         k.key,
                Value:       state.acc,
                Count:       state.count,
            }:
            default:
                w.logger.Warn("output channel full, dropping window result")
            }
            delete(w.windows, k)
        }
    }
}

// Output returns the channel of completed window results
func (w *TumblingWindowAggregator[T, A]) Output() <-chan WindowResult[A] {
    return w.output
}
```

### Usage Example: Click Count Per User Per 5 Minutes

This example wires together the generic processor and tumbling window aggregator to count user clicks per 5-minute window. The `ClickEvent` type implements the `Event` interface, and the accumulator function simply increments a counter. The 30-second allowed lateness accommodates mobile clients with intermittent connectivity.

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "time"

    "myapp/stream"
)

type ClickEvent struct {
    UserID    string
    Page      string
    Timestamp time.Time
}

func (c ClickEvent) EventTime() time.Time { return c.Timestamp }
func (c ClickEvent) Key() string          { return c.UserID }

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // Aggregator: count clicks per user per 5-minute window
    agg := stream.NewTumblingWindowAggregator[ClickEvent, int64](
        5*time.Minute,
        30*time.Second, // allow events up to 30s late
        func() int64 { return 0 },
        func(acc int64, e ClickEvent) int64 { return acc + 1 },
        logger,
    )

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Process results
    go func() {
        for result := range agg.Output() {
            logger.Info("window result",
                "user_id", result.Key,
                "window_start", result.WindowStart,
                "click_count", result.Value,
            )
        }
    }()

    // Simulate events
    now := time.Now()
    events := []ClickEvent{
        {UserID: "user-1", Page: "/home", Timestamp: now},
        {UserID: "user-1", Page: "/products", Timestamp: now.Add(1 * time.Minute)},
        {UserID: "user-2", Page: "/home", Timestamp: now.Add(2 * time.Minute)},
        {UserID: "user-1", Page: "/cart", Timestamp: now.Add(6 * time.Minute)}, // next window
    }

    for _, e := range events {
        agg.Add(e)
        // Advance watermark based on event time minus lateness tolerance
        agg.AdvanceWatermark(e.Timestamp.Add(-30 * time.Second))
    }

    // Final watermark advance to flush remaining windows
    agg.AdvanceWatermark(now.Add(15 * time.Minute))

    _ = ctx
}
```

### Junior -> FAANG: Understanding What This Code Is Actually Doing

The generic `Processor[In, Out]` interface and `TumblingWindowAggregator` in this section are not just implementation patterns. They are the design decisions you need to be able to justify in an interview.

The `Event` interface requires two methods: `EventTime()` and `Key()`. These are the two dimensions the windowing system needs. `EventTime()` is used to place the event in the correct time bucket. `Key()` is used to group events so that "user-1's clicks" and "user-2's clicks" are tracked in separate accumulators. If you remove `Key()`, you get global aggregations. If you remove `EventTime()` and use processing time instead, you get simpler code that produces wrong answers during backlog replay.

The `windowKey` struct combines `key` (the partition key) and `start` (the window start time). This is the minimum necessary to uniquely identify an accumulator. Two events with the same user ID but in different time windows produce different `windowKey` values and different accumulators.

The watermark check in `Add()` uses `eventTime.Before(w.watermark.Add(-w.allowedLateness))`. Read this as: "if this event's timestamp is earlier than the watermark minus the allowed lateness budget, drop it." The double negation is confusing at first. The simpler mental model: events older than `watermark - allowedLateness` are too late to be included in their window, which has already been emitted.

The `default:` branch in `AdvanceWatermark()` drops window results when the output channel is full. This is a deliberate backpressure decision: the window emitter does not block waiting for the consumer to drain the output channel, it drops instead. In production, you would want this drop to increment a Prometheus counter so you can detect and alert on it.

A first-job habit to build: always check whether a channel send can block and decide explicitly whether blocking or dropping is the right behavior. The answer depends on your SLO for data completeness versus latency.

### Senior @ FAANG: Production Gaps in This Implementation and How to Close Them

This implementation is pedagogically clear but has several gaps that a senior engineer would identify in a code review before it goes to production.

**Gap 1: output channel drop is silent.** The `default:` branch in `AdvanceWatermark()` drops a window result with a log warning but does not increment a metric. In production, a single-digit drop rate might be acceptable for a dashboard use case. A zero-drop requirement for billing means the `default:` branch should either block (which requires the caller to drain the output channel promptly) or return an error that triggers a consumer pause. The choice depends on the SLO.

**Gap 2: no state persistence across restarts.** The `windows` map is entirely in memory. On process restart, all partial window state is lost. For a 5-minute tumbling window, worst case is 5 minutes of lost aggregations, which manifests as undercount in the emitted results. Closing this gap requires checkpointing the `windows` map to Redis or Postgres on a cadence shorter than the window size, and restoring from the checkpoint on startup. The checkpoint key should include the processor's consumer group ID and the Kafka partition assignments, so that multiple replicas don't overwrite each other's state.

**Gap 3: concurrent `Add()` and `AdvanceWatermark()` under the same lock.** Both methods acquire `w.mu`. If `Add()` is called from a tight consumer loop and `AdvanceWatermark()` is called periodically from a ticker goroutine, the mutex becomes a contention point. At high event rates (100K+ events/sec), the lock contention is measurable. The standard mitigation is to shard the window map by key: compute `hash(event.Key()) % shardCount` to select a shard, and each shard has its own mutex. This eliminates inter-key lock contention entirely.

**Gap 4: watermark computation is caller's responsibility.** The implementation requires the caller to compute the watermark and call `AdvanceWatermark()`. This is fine for the example, where the caller has access to event timestamps. In a real Kafka consumer, watermark computation must account for per-partition max event times (the global watermark is the minimum across all partitions) and idle partition detection (a partition with no recent events should not hold back the watermark indefinitely). Wrapping this logic into a `WatermarkTracker` type that the caller feeds per-partition event times into, and that returns the global watermark, is the correct abstraction.

**Gap 5: generics increase binary size and complicate stack traces.** The `TumblingWindowAggregator[T Event, A any]` generic type instantiates separate code for each `(T, A)` pair. In a service with five different event types, this produces five instantiations, each with separate method tables and stack trace symbols. This is not a dealbreaker, but it is worth knowing before a performance investigation, because flamegraphs will show `TumblingWindowAggregator[ClickEvent, int64].Add` and `TumblingWindowAggregator[OrderEvent, OrderAcc].Add` as separate symbols.

**The production decision: when to move off this implementation.** This code is correct for a single-replica consumer handling one stream of events with state that fits comfortably in one process's memory. The signals that indicate it's time to migrate: (a) restart recovery time is unacceptable because rebuilding state from Kafka replay takes too long, (b) memory usage of the `windows` map is approaching the pod limit, (c) key cardinality is high enough that sharding state across goroutines requires explicit coordination across processes, (d) the pipeline requires multi-stream joins or session windows, which require shared state that a single-process implementation cannot provide without an external store. When any of these signals appear, the right move is Flink, not a bigger Go pod.

---
