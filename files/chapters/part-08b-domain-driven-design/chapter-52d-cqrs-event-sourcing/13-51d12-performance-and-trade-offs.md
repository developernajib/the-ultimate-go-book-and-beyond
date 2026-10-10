## 52D.13 Performance and Trade-offs

### CQRS Performance Characteristics

**Write side**: Performance is dominated by the aggregate load and save cycle. For event-sourced aggregates, this is event stream load + event append. With snapshots, load time is O(events since last snapshot). Without snapshots, it is O(total events).

**Read side**: Read models are pre-computed and denormalized - reads are typically a single indexed table lookup. This is significantly faster than loading and computing from aggregates.

**Projection lag**: There is inherent latency between a write and the read model update. Measure this in production. Under normal load it should be < 100ms. Under high load or projector backpressure, it can grow. Monitor the lag as a key metric.

### Event Store Optimization

**Partitioning**: For very high-volume event stores, partition the `event_store` table by time (monthly or weekly partitions):

```sql
CREATE TABLE event_store (
    position    BIGSERIAL,
    stream_id   VARCHAR(255) NOT NULL,
    -- ... other columns
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);

CREATE TABLE event_store_2025_q1
    PARTITION OF event_store
    FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');
```

**Event stream reading**: Always read with `ORDER BY stream_version ASC` with an index on `(stream_id, stream_version)`. Never sort by `recorded_at` for stream reads - timestamps can have conflicts under concurrent appends.

**Archive old events**: Events more than a year old are rarely replayed (use snapshots). Archive them to cold storage (S3 with Parquet format) for cost efficiency.

### Projection Rebuilds

A property of event sourcing that is also a cost: every read model is rebuildable from the event log. In steady state this is a superpower (fix a projection bug, replay, done). In practice it is an operational discipline you must design for from day one.

The rebuild contract has four parts:

1. **Checkpointing**. Every projector records `(projection_name, last_event_position)` on commit. A crashed projector resumes from its checkpoint, not from the start. Store the checkpoint in the same transaction as the projection write so they cannot diverge.
2. **Idempotent apply**. Replaying the same event twice must produce the same result. For SQL projections this usually means `INSERT ... ON CONFLICT DO UPDATE` keyed by the natural ID, or a uniqueness guard on `(aggregate_id, event_position)`.
3. **Blue/green projection tables**. When the projection schema changes, create a new table (`orders_view_v2`), start a fresh consumer from position 0, let it catch up while `v1` still serves reads, flip the reader when `v2` lag is near zero, drop `v1` after a grace period. Do not rebuild in place against live traffic.
4. **Progress visibility**. Expose `last_event_position` per projection as a metric. During a rebuild, "when will this finish?" is a question you need a numeric answer for, not a vibe.

A projector rebuilding a few hundred million events on a modest Postgres instance is a multi-hour job. Plan for it: parallelize by stream, batch the inserts, disable indexes during bulk load and rebuild them at the end, and measure throughput in events/second so you can give ETAs instead of shrugs.

### When Event Sourcing Hurts

- **Simple entities that change frequently**: An entity that changes every second with no need for history is a poor candidate.
- **Large payloads in events**: Events should be small (< 1KB). Storing file content in events is wrong - store a reference to blob storage.
- **DELETE-heavy workflows**: If business logic requires deleting data (GDPR right to erasure), Event Sourcing requires careful design - typically encrypting personal data and deleting the encryption key (crypto-shredding).

### Junior → FAANG: Building Performance Intuition for CQRS Systems

Performance in CQRS systems has two separate concerns: write-side latency (how long a command takes) and read-side latency (how long a query takes). They scale independently, and the bottlenecks are completely different.

Write-side latency for an event-sourced system is: event store load time + domain logic time + event store append time. Without snapshots, load time is O(N events). The `Benchmark` exercise at the end of this chapter is not optional: actually run it, measure the numbers, and plot the curve. At 1000 events with no snapshot, load time is likely 10-50ms. With a snapshot at 50 events, it drops to under 1ms. The numbers change everything about your production planning.

Read-side latency for a denormalized projection is typically a single indexed lookup: under 1ms. This is the point of CQRS. The trade-off is not read vs write performance. It is write simplicity vs projection maintenance burden.

Projection lag is your key operational metric. "Projection lag = current event store position - projector's last processed position." Measure it in number of events and in time (time since the oldest unprocessed event was written). Alert when it exceeds a threshold. The threshold depends on your product: a real-time trading system might alert at 100ms lag, an analytics dashboard might be fine with 5 minutes.

For FAANG entry-level interviews: "my read model is lagging, what do I do?" is a common systems design follow-up. The structured answer is: measure where the time goes (event publish latency, consumer throughput, projection DB write time), identify the bottleneck, and apply the fix targeted to that bottleneck (batch writes, more partitions, faster storage). "Scale it up" without measurement is the wrong answer.

### Senior @ FAANG: Capacity Planning, Partition Strategy, and the Rebuild SLO

The performance section identifies the right concerns but leaves the quantitative planning to the reader. Here is the framework for FAANG-level capacity planning on an event-sourced system.

For the write side: measure the P99 aggregate load latency with snapshots at your expected snapshot interval. Multiply by your peak command rate. If peak is 1000 deposits/second and each load takes 2ms P99, that is 2000ms of aggregate load work per second across your command handling goroutines. How many goroutines do you need? `goroutines = peak_commands_per_second * P99_load_latency_seconds`. For the example: 1000 * 0.002 = 2. In practice, add a 3x safety factor: 6 goroutines. This is a trivial calculation that most teams skip, then wonder why they have load-shedding at peak traffic.

The partitioning SQL in this section (range partitioning by `recorded_at`) is the correct approach for large event stores. The operational implication: partition maintenance must be automated. Create next quarter's partition before the current quarter fills, or your inserts will fail. This is a `pg_cron` job, a Kubernetes CronJob, or a Terraform-managed DDL pipeline. The partition creation job must be monitored and alerted on failure. Partition maintenance failure is a silent write outage waiting to happen.

The "archive old events to S3 with Parquet" mention deserves a lifecycle design. The query pattern for archived events is: projection rebuilds (sequential full scan), point-in-time queries (filter by stream ID and timestamp), and compliance exports (all events for a given subject). Parquet on S3 with partitioning by `(year, month, stream_id_prefix)` serves all three if you use Athena or Spark for the query layer. The operational cost is: rebuilding a projection from S3 Parquet is slower than from Postgres (no row-level access, must scan full Parquet files). The mitigation is keeping the last 6-12 months in Postgres for active projection use and archiving only events older than that.

The rebuild SLO deserves a formal calculation. For a projector with 500 million events, processing at 100,000 events/second (a reasonable throughput for batch Postgres inserts with indexes disabled), rebuild time is 5000 seconds (83 minutes). This is your baseline rebuild SLO. If a projection bug causes 48 hours of incorrect data, the fix plus rebuild is a 1.5-hour total incident. If rebuild throughput is 10,000 events/second, the rebuild takes 14 hours, turning a 1.5-hour incident into a 15-hour one. Rebuild throughput is an operational SLO that should be measured in staging before production incidents reveal it.

---
