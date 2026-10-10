## 52I.1 Stream Processing Fundamentals

Stream processing operates on unbounded data sequences - events that arrive continuously rather than in discrete batches. Understanding the core concepts prevents the most common design mistakes.

> **Senior track**: The 2026 landscape is bifurcated. Apache Flink owns true stateful streaming (checkpointed keyed state, event-time watermarks, exactly-once state via RocksDB + S3 snapshots). Kafka Streams owns JVM-embedded, co-located state. The Go ecosystem is deliberately thin here: Benthos / Redpanda Connect (YAML-driven, stateless transforms) and hand-rolled goroutine pipelines cover everything short of windowed joins and session analytics. When someone says "let's rewrite our Flink job in Go," the right question is "where does the state live?" If the answer isn't "Redis / an external DB / we don't need state," you're heading for a rewrite of Flink in Go.

### Event Time vs Processing Time

Stream processors must choose whether to order and window events by the time they were generated (event time) or the time they arrived at the processor (processing time). Event-time windowing produces accurate results under out-of-order delivery but requires watermarks to handle late data. The distinction matters because network delays, mobile offline buffering, and retry storms can cause event time and processing time to diverge by seconds or even hours.

```
Event Time:      When the event actually occurred (embedded in event payload)
Processing Time: When the system processes the event (wall clock)

Example problem:
  - Mobile app sends click event at 14:00:00
  - Network delay: event arrives at processor at 14:00:45
  - Processing time = 14:00:45, but event time = 14:00:00

If you aggregate by processing time:
  - "5-minute window 14:00-14:05" misses events that occurred at 14:00 but arrived late

If you aggregate by event time:
  - You need watermarks to know when a window is "complete"
```

### Windowing Types

**Tumbling Windows** - Non-overlapping, fixed-size windows:
```
Events: e1(t=1) e2(t=3) e3(t=6) e4(t=8) e5(t=11)
Window size: 5

Window [0,5):  e1, e2       → emit count=2
Window [5,10): e3, e4       → emit count=2
Window [10,15): e5          → emit count=1

Window key = floor(event_time / window_size) * window_size
```

**Sliding Windows** - Overlapping windows, slide by step interval:
```
Window size: 5, slide: 2

Window [0,5):  e1(1), e2(3)
Window [2,7):  e2(3), e3(6)
Window [4,9):  e3(6), e4(8)
Window [6,11): e4(8), e5(11)

Each event appears in multiple windows: ceil(window_size/slide) windows
```

**Session Windows** - Gap-based grouping:
```
Events with gaps > 10 minutes start a new session.
  e1(t=1) e2(t=3) e3(t=4)   [10min gap]   e4(t=20) e5(t=22)
  └──── session 1 ───────┘                 └── session 2 ──┘
```

### Watermarks

Watermarks solve the late data problem. A watermark at time `W` means: "we believe all events with `event_time < W` have been received."

```
Watermark = max_event_time_seen - allowed_lateness

Example: allowed_lateness = 30 seconds
- We've seen events up to t=14:05:00
- Watermark = 14:04:30
- Windows ending before 14:04:30 can be safely emitted
- Events with event_time < watermark are "late"
```

### Backpressure

When a stream processor consumes events faster than downstream sinks can handle them, the pipeline must apply backpressure to slow the producer rather than dropping data or running out of memory. In Go, bounded channels provide a natural backpressure mechanism: a producer writing to a full channel blocks until a consumer reads from it, propagating the slowdown upstream without explicit flow-control logic.

```go
// Bounded channel = backpressure mechanism
// If workers can't keep up, upstream blocks (or drops if non-blocking)
workQueue := make(chan Event, 1000) // buffer of 1000

// Producer blocks when queue is full
func produce(ctx context.Context, events <-chan Event, work chan<- Event) {
    for {
        select {
        case <-ctx.Done():
            return
        case e := <-events:
            select {
            case work <- e:  // blocks when full = backpressure
            case <-ctx.Done():
                return
            }
        }
    }
}
```

### Junior -> FAANG: Internalizing Stream Processing Primitives

The three window types and the watermark concept are the minimum vocabulary for any stream processing interview. Here is how to make them stick before the interview.

For tumbling windows, anchor on billing and rate limiting. A billing system that counts API calls per 5-minute window uses tumbling windows because each call belongs to exactly one billing period. The window key formula, `floor(eventTime / windowSize) * windowSize`, is the single most important formula in this chapter. Practice computing it by hand for a few event timestamps before the interview.

For sliding windows, anchor on moving averages. "What was the average order value over the last 10 minutes, recalculated every 2 minutes?" is a sliding window. Each event belongs to multiple windows: `ceil(windowSize / slideInterval)` windows. This is the key tradeoff versus tumbling windows: more computational work per event, but a smoother output signal.

For session windows, anchor on user behavior analysis. "Group all clicks from a user into sessions, where a session ends after 30 minutes of inactivity." The window boundary is defined by data arrival patterns, not by the clock, which makes session windows harder to implement than tumbling or sliding windows.

Watermarks are the hardest concept for junior engineers to explain clearly under interview pressure. Practice this sentence: "A watermark at time W asserts that all events with event time before W have been received, which lets the system declare windows complete without waiting forever for late data." Then practice explaining what happens when a late event arrives after its window's watermark has passed: you either drop it, route it to a side output, or extend the allowed lateness window.

Backpressure in Go is implemented by bounded channels. When you see `make(chan Event, 1000)`, that buffer size is a flow-control parameter: it determines how many events can be queued before the producer blocks. An interviewer who asks "how does Go handle backpressure in a stream pipeline" is expecting you to mention bounded channels and explain that a producer writing to a full channel blocks, propagating the slowdown upstream.

### Senior @ FAANG: Stream Processing Architecture Decisions at Platform Scale

The senior-level questions in this domain are not about how to implement a window. They are about which runtime to choose, how to define state boundaries, and how to govern the platform so that individual teams cannot accidentally design pipelines that fail silently.

**The state boundary is the architectural decision.** Every stream processing design question reduces to: "where does the state live, and what are the durability and consistency guarantees of that state?" In-process Go state (a map protected by a mutex) is fast and simple but lost on restart. Redis state is durable across restarts but adds network latency and becomes a bottleneck at high fanout. Flink's RocksDB keyed state is durable, checkpointed to S3, and restored exactly on restart, but requires a JVM fleet and operational expertise to tune. The architectural decision is not "should we use Go or Flink?" but "what are the state size, durability, and consistency requirements, and which runtime satisfies them?"

**Idle partition watermark stalls.** In a multi-partition Kafka topic, the global watermark across all partitions is the minimum of the per-partition watermarks. A partition that receives no events does not advance its watermark, which stalls the global watermark and prevents windows from firing. This is not a theoretical concern: it happens routinely in production when traffic is skewed (most events go to a small number of partitions), during low-traffic periods, and after consumer rebalances. The production solution is idle-partition detection: if a partition has produced no events for N seconds, synthesize a watermark-advancing heartbeat. Flink has built-in idle-partition support. Hand-rolled Go processors must implement it explicitly.

**Backpressure propagation across service boundaries.** The backpressure mechanism described in this chapter (bounded Go channels) works within a single process. In a multi-service pipeline, where the Go consumer writes to an HTTP sink, backpressure from the sink must propagate back to the Kafka consumer, which must reduce its poll rate, which causes consumer lag to grow, which is visible in the Kafka consumer group lag metric, which must trigger an alert. Designing the backpressure chain to be observable at every hop is a platform engineering concern. A senior engineer defines the SLO for consumer lag, wires it to an alert, and ensures the on-call runbook explains which upstream component is the throttle point.

**The Benthos/Redpanda Connect decision.** For stateless transforms (schema conversion, PII stripping, field renaming, fan-out routing), writing a Go consumer service is often more complexity than the problem deserves. Benthos and its forks provide YAML-configured pipelines with production-grade runtimes, built-in metrics, and a large library of input/output connectors. The ADR question is: "does this pipeline require Go-specific logic (custom business rules, database lookups, complex conditional routing) that cannot be expressed in YAML, or is it a composition of standard transforms?" If the answer is the latter, the lower-maintenance choice is a YAML-configured pipeline, not a Go service that a future team member has to read and modify.

**Maturity model: from ad-hoc to platform.** Teams typically move through three stages. Stage 1: one team builds one Go consumer that polls one Kafka topic. No shared patterns, no shared monitoring, no governance. Stage 2: multiple teams build consumers using shared libraries (franz-go wrapper, common envelope parser, Prometheus metrics registration). Operational visibility improves. Stage 3: a platform team owns the stream processing runtime (Kafka Connect for CDC, a managed Flink cluster for stateful analytics, a Benthos/Redpanda Connect fleet for stateless transforms). Teams declare what they want transformed and where it should go, and the platform executes it. Senior engineers drive the org from Stage 1 to Stage 3 by identifying the patterns that repeat across teams and abstracting them into platform capabilities.

---
