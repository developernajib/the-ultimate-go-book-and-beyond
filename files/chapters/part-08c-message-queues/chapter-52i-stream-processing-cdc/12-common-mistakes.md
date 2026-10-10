## Common Mistakes

### 1. Using Query-Based Polling Instead of Log-Based CDC

Teams often start with a simple `SELECT … WHERE updated_at > last_poll` loop because it requires no infrastructure beyond the existing database. This approach silently misses deletes, reorders rapid updates, and adds read load to the primary database proportional to polling frequency.

**Wrong approach**:
```go
// Polling misses deletes, creates DB load, not real-time
for {
    rows, _ := db.QueryContext(ctx, `
        SELECT * FROM orders WHERE updated_at > $1
    `, lastPoll)
    // Process rows...
    lastPoll = time.Now()
    time.Sleep(30 * time.Second)
}
```

**Problems**: Deletes are invisible. If you poll every 30s and two updates occur, you see both but in the wrong order. Full table scans add read load. Not real-time.

**Correct**: Use Debezium with PostgreSQL logical replication - captures all changes in order, millisecond latency, no DB load.

---

### 2. Not Handling Debezium Snapshot Phase Differently

Debezium performs an initial snapshot of the source table before switching to streaming mode, and snapshot events must be handled differently from incremental change events to avoid duplicate inserts or incorrect upserts in the sink. The following code shows how to detect the snapshot phase via the `source.snapshot` field in the Debezium envelope and route snapshot rows through a bulk-load path instead of the normal change handler.

```go
// WRONG: treating snapshot events like streaming events
case "r": // snapshot READ
    db.Exec("INSERT INTO analytics ...") // fails on duplicate PK

// CORRECT: snapshot events need UPSERT semantics
case "r": // snapshot READ
    db.Exec("INSERT INTO analytics ... ON CONFLICT (id) DO UPDATE SET ...")
```

During initial snapshot, Debezium emits `op: "r"` for every existing row. If your sink doesn't handle upserts, you'll get constraint violations.

---

### 3. Replication Slot Accumulation

Failing to drop inactive replication slots is one of the most dangerous PostgreSQL operational mistakes: each slot holds WAL segments on disk until the slot's consumer advances its LSN, and an abandoned slot will eventually fill the disk and halt the database. The following monitoring query and Go-based slot cleanup utility help detect and remove stale slots before they cause an outage.

```sql
-- DANGEROUS: if Debezium connector stops, WAL piles up
SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
FROM pg_replication_slots;

-- Monitor this! Alert if lag > 1GB
-- If a slot is inactive and growing, DROP IT:
SELECT pg_drop_replication_slot('debezium_orders');
```

Replication slots prevent PostgreSQL from cleaning up WAL segments. A stopped connector can fill your disk within hours on a busy database.

---

### 4. Processing CDC Events Without Idempotency

Kafka guarantees at-least-once delivery, which means a consumer crash after processing but before offset commit causes the event to be redelivered. If the sink operation is not idempotent, this redelivery produces duplicates - double notifications, double charges, or double inventory decrements.

```go
// WRONG: non-idempotent sink
func handleOrderCreated(order Order) {
    db.Exec("INSERT INTO notifications (order_id, ...) VALUES (?)", order.ID)
    // If this runs twice, user gets two emails
}

// CORRECT: idempotent upsert
func handleOrderCreated(order Order) {
    db.Exec(`
        INSERT INTO notifications (order_id, ...)
        VALUES (?)
        ON CONFLICT (order_id) DO NOTHING
    `, order.ID)
}
```

---

### 5. Not Advancing Watermarks Properly

A stream processor that never advances its event-time watermark will accumulate unbounded state as it waits for late events that may never arrive, eventually exhausting memory. The correct approach advances the watermark to `maxEventTimeSeen - allowedLateness` rather than to `time.Now() - lag`, because wall-clock-based watermarks advance even during idle periods and can close windows before all in-flight events for that window have been delivered by slow partitions.

```go
// WRONG: advancing watermark based on wall clock
watermark = time.Now().Add(-30 * time.Second)
// Problem: if no events arrive, watermark still advances
// and you emit windows that may be incomplete

// CORRECT: advance watermark based on max event time seen
maxEventTimeSeen = max(maxEventTimeSeen, event.EventTime)
watermark = maxEventTimeSeen.Add(-allowedLateness)
// Windows only emit when we've actually seen events past their end time
```

---

### 6. Stateful Processing Without Persistence

In-memory state in a stream processor is lost on restart, causing incorrect aggregations and missing events unless checkpointing is implemented. The following implementation checkpoints the processor's state map to a Redis hash on each window close, allowing the processor to resume from the last checkpoint after a crash without reprocessing the entire event history.

```go
// WRONG: in-memory only window state
windowCounts := map[string]int64{}
// On restart: all aggregation state lost, re-processing from checkpoint gives wrong counts

// CORRECT: checkpoint state to Redis periodically
func (w *WindowAggregator) checkpoint(ctx context.Context, rdb *redis.Client) error {
    for key, state := range w.windows {
        data, _ := json.Marshal(state)
        rdb.Set(ctx, "window:"+key.String(), data, w.windowSize*2)
    }
    return nil
}
```

### Junior -> FAANG: Building a Mental Checklist From Common Mistakes

The six mistakes in this section are not random. They represent the failure modes that are most likely to survive code review and reach production, because they are not compile-time errors and not always immediately visible in testing.

For your first job, internalize these as a pre-deployment checklist:

Before deploying a new CDC consumer, ask: does my sink handle `op: r` (snapshot) events with upsert semantics, or will it fail on duplicate primary keys? If you are not sure, check the sink's insert behavior explicitly.

Before deploying a CDC consumer to production, ask: have I set up an alert on replication slot lag for the Debezium connector this consumer depends on? If the connector stops, your consumer will eventually catch up, but the PostgreSQL disk will fill first if nobody is watching the slot.

Before deploying any event handler, ask: is this operation idempotent? If the same event is delivered twice (which Kafka guarantees will happen eventually), does the result change? If yes, add a deduplication mechanism.

Before designing a window aggregator, ask: is my watermark advancing based on max event time seen (correct) or based on wall clock time (incorrect during backlog replay)? Advancing by wall clock means windows fire during replay based on current time, not the time of the events being replayed.

Before deploying a stateful stream processor, ask: what happens to the window state if this pod restarts? If the answer is "we lose it," either the use case tolerates that loss (low-stakes dashboards, metrics with short windows) or you need to add checkpointing.

The most impactful first-job habit to build: after every production incident, ask which item on this checklist was missed. Treat the checklist as a living document that grows with your team's experience.

### Senior @ FAANG: Mistake Patterns as Systemic Risks

At the senior level, common mistakes are not just individual errors. They are systemic risks that will manifest across the organization if the platform does not address them structurally.

**Query-based polling as a structural risk.** Mistake 1 (polling instead of log-based CDC) is common because polling requires no new infrastructure. Teams adopt it because it is the path of least resistance, and it works well enough in development. The systemic risk is that as polling-based sync proliferates, it adds cumulative read load to the primary database. At 10 polling consumers each running a full-table scan every 30 seconds, the aggregate database load from sync traffic can exceed the load from the actual application. A platform-level response is: provide CDC as a managed capability so that the path of least resistance is log-based, not polling. If teams don't have to configure Debezium themselves, they will use it.

**Replication slot accumulation as a governance failure.** Mistake 3 (replication slot accumulation) is not an individual engineer error. It is a governance failure: there was no platform-level monitoring of slot lag, no policy for handling stopped connectors, and no runbook that on-call engineers could execute without subject-matter expertise. A senior engineer's response is not to fix the immediate slot accumulation but to put in place the governance that prevents it from recurring: centralized slot lag monitoring with organization-wide alerting thresholds, a policy documented in the on-call runbook, and automated tooling that can drop an abandoned slot and trigger a connector restart without human intervention.

**Idempotency enforcement at the platform level.** Mistake 4 (non-idempotent sinks) cannot be prevented by code review alone, because the correctness of an idempotent sink often depends on understanding the delivery semantics of the upstream system. A platform-level approach is to provide idempotent sink wrappers as shared libraries: a ClickHouse batch inserter that uses `ReplacingMergeTree` by default, an Elasticsearch upserter that requires a document ID, a PostgreSQL upserter that generates `ON CONFLICT DO UPDATE`. Teams that use these wrappers get idempotency by default, without needing to understand the underlying CDC delivery semantics.

**Stateful processing without persistence: the hidden time bomb.** Mistake 6 (in-memory state without persistence) is often invisible until the first production restart. The state loss is not immediately visible because the stream processor simply starts accumulating new state from the latest events, and the missing historical state is only apparent when comparing the processor's output to the expected output for the restart window. At FAANG scale, where stream processors may restart hundreds of times per day across a fleet (due to rolling deployments, preemptible instances, and node failures), stateful in-memory processing is a continuous source of incorrect output. The platform response is to make persistence the default: provide a `CheckpointedWindowAggregator` that requires a Redis or Postgres backend rather than offering the option. If engineers must explicitly opt out of persistence, they are forced to justify the decision.

---
