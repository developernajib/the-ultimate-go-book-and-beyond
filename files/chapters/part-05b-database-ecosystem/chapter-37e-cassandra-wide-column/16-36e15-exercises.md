## 37E.15 Exercises

**Exercise 1: IoT Fleet Tracker**

Build a vehicle fleet tracking system using Cassandra:
- Store GPS positions at 1Hz per vehicle (up to 100K vehicles)
- Query: last known position for vehicle
- Query: position history for vehicle over last 24 hours
- Query: all vehicles in a geographic bounding box (current positions only)
- Requirements: 100K writes/second, 10-second data freshness SLA

Design schema, implement Go service, handle time-bucket partitioning, and use TWCS with 1-hour TTL.

**Exercise 2: Rate Limiter Service**

Implement a distributed rate limiter using Cassandra:
- Per-user rate limiting: 100 requests/minute, 1000 requests/hour
- Use counter tables for counting
- Implement sliding window algorithm
- Handle Cassandra failures gracefully (fall back to local rate limiting)
- Benchmark: measure LWT vs non-LWT approach latency

**Exercise 3: Event Sourcing with Cassandra**

Build an event-sourced order service:
- Append-only events table: `(aggregate_id, sequence_num) → event_type, payload, created_at`
- Snapshot table for performance: latest state cache
- Implement event replay from any sequence number
- Handle concurrent writes with LWT on sequence number
- Materialized view that rebuilds on replay

### Junior → FAANG: Working the Exercises as a Junior

The three exercises above all look like "build a feature." At junior level the discipline is to turn each into a worked example that an interviewer would recognize. For each, answer these five questions before you write any CQL.

1. What is the exact access pattern for every read? Write them in plain English, one per line.
2. What is the write rate per partition, not per cluster?
3. What is the expected partition size in rows and bytes after one month?
4. What is the consistency level and why?
5. What is the compaction strategy and why?

Worked example on Exercise 1. Access patterns are (a) last known position for vehicle, (b) last 24 hours for vehicle, (c) bounding-box current positions. These are three different queries and the junior reflex is three tables.

Table A `vehicle_current ((vehicle_id)) → lat, lon, ts` with `USING TTL 120`. One row per vehicle. Updated every second. No clustering column because the row is overwritten.

Table B `vehicle_history ((vehicle_id, hour_bucket), ts DESC) → lat, lon`. TTL 86400. TWCS with one-hour windows. Partition size after 24 hours per bucket is 3600 rows at roughly 64 bytes each, well under 100MB.

Table C for bounding box is the trap. A naive `(geohash_prefix)` partition key puts all vehicles in a busy city in one partition. Use `(geohash_prefix, minute_bucket)` with TTL 120 so stale vehicles drop. Reads do a scatter-gather across the geohash prefixes that overlap the bounding box, which is a known-cost client-side operation.

Why did this fail reflex. If you ship Exercise 1 with `(vehicle_id)` alone and no bucket on Table B, a single vehicle with a year of history has 31 million rows per partition. Reads time out. The fix is always "add a bucket that caps partition size at 100MB."

First-job deliverable. Write the schema, write the Go service using `gocql` with token-aware routing, write a k6 or Go benchmark that generates 100k writes per second, and write a small report with the five answers above. That report is your interview portfolio piece.

### Senior @ FAANG: Staff Extensions to Every Exercise

At staff level the exercises are not features, they are platform problems. Ship each with an ADR, observability, governance, and a scale test.

Extension to Exercise 1 (IoT Fleet Tracker). Staff deliverable: a Kafka-to-Cassandra ingest with idempotency. The GPS stream lands in Kafka partitioned by `vehicle_id`. A Go consumer group writes into Cassandra using `INSERT ... IF NOT EXISTS` keyed by `(vehicle_id, ts)`, but only for the history table. The current-position table uses normal `INSERT` with a timestamp column and accepts last-write-wins. ADR captures the decision to use LWT only on the history table and only when the producer cannot guarantee exactly-once delivery. Observability includes per-partition write rate histogram, tombstone rate per table, p99 write latency segmented by compaction phase. Governance includes a schema lint that rejects new tables in this keyspace without a `default_time_to_live`.

Extension to Exercise 2 (Rate Limiter). Staff deliverable: reject Cassandra counters as the primitive. Build on a Kafka + Flink pipeline with sliding-window aggregation, write the aggregates into Cassandra every 100ms, and use Redis for the hot read path. ADR explains why counters are rejected (non-idempotent, no TTL, tombstone-on-delete). Include a staff-extension scale test that shows the counter-based approach drifting under 10% replica failure rate versus the aggregate approach staying accurate. Governance rule: no new counter tables without a principal engineer sign-off.

Extension to Exercise 3 (Event Sourcing). Staff deliverable: design a multi-region event store with LOCAL_QUORUM writes in the primary region and async replication to the secondary, plus an Accord-based multi-partition transaction path for the rare flows that span aggregates (when Accord ships GA). ADR covers the choice of LWT on sequence numbers versus a Kafka-ordered producer that eliminates LWT entirely. Build the reconciliation job that verifies the event log against the materialized view every hour. Observability includes replay lag per aggregate and materialized-view drift alarms.

Additional staff exercises to layer on top.

Exercise 4. Write a schema lint for Cassandra. Input is a directory of CQL files. Output is a structured report flagging `ALLOW FILTERING`, `LOGGED BATCH` across partitions, `IF NOT EXISTS` on high-QPS tables, unbounded partitions, missing `default_time_to_live` on TTL-tagged keyspaces, native secondary indexes, and consistency level `QUORUM` in multi-DC configs. Ship as a pre-commit hook and a CI check. This single tool deletes a year of incidents.

Exercise 5. Design a multi-region topology with LOCAL_QUORUM and a failover runbook. Two regions, RF=3 each, asymmetric workload (80/20 split). Write the ADR for the region failover procedure, including the window during which writes are paused, the reconciliation strategy when the failed region returns, and the monitoring that triggers the failover. Include a chaos test plan.

Exercise 6. Build a Kafka-to-Cassandra ingest with exactly-once semantics using idempotent keys plus consumer offset commits inside a CQL transaction. Measure the throughput cost of idempotency versus at-least-once plus deduplication in a downstream materialized view. Record the decision in an ADR.

Exercise 7. Migrate a table from STCS to UCS on a live 50-node cluster without exceeding 30% extra disk or 10% read latency regression. Write the runbook. Test it on a staging cluster. Document the rollback path.

Maturity model for exercise delivery.

L1 Ships the happy path.
L2 Ships with tests.
L3 Ships with observability and runbooks.
L4 Ships with an ADR, rollback plan, and governance hooks.
L5 Ships something other teams adopt without asking.

---
