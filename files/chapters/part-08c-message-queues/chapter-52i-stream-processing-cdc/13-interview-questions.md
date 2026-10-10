## Interview Questions

**Q1: What is CDC and why is log-based CDC preferred over query-based polling?**

CDC (Change Data Capture) captures database mutations as a stream of events. Log-based CDC reads the database's internal transaction log (PostgreSQL WAL, MySQL binlog, MongoDB oplog) rather than polling tables. Advantages: (1) captures ALL changes including deletes. polling can't see deleted rows without soft-delete flags. (2) millisecond latency vs seconds/minutes for polling. (3) reads are from the log, not the primary data files, so no extra load on the OLTP path. (4) events are ordered by LSN/transaction, so causal ordering within a partition is preserved. (5) captures all intermediate states of a row changed multiple times in one polling interval. (6) no application code changes required. Debezium 3.4+ (Apache 2.0, released late 2025) is the de-facto log-based CDC platform and ships connectors for Postgres, MySQL, MongoDB, SQL Server, Oracle, Cassandra, and Db2.

**What FAANG expects:** You know that "CDC" means log-based specifically, you can name the log per engine (Postgres WAL via `pgoutput`/logical decoding, MySQL binlog in ROW format, MongoDB change streams on top of the oplog), and you understand CDC delivers at-least-once by default. Not exactly-once. Candidates who say "CDC solves exactly-once" are downgraded.

**Follow-ups:**
- Why does MySQL binlog need `binlog_format=ROW` for CDC? (STATEMENT replays SQL, loses deterministic row state. ROW captures actual column values before/after.)
- What's the difference between logical and physical replication in Postgres? (Physical ships byte-for-byte WAL for replicas. Logical decodes WAL into INSERT/UPDATE/DELETE row events via an output plugin such as `pgoutput`.)
- If CDC is at-least-once, how do you get end-to-end exactly-once? (Idempotent sinks keyed by LSN or primary key, or consumer-side dedup keyed by `source.lsn` or `topic:partition:offset`.)

---

**Q2: Explain the Debezium envelope format. What does each field contain?**

The Debezium envelope wraps CDC events with metadata: `before` (row state before change, null for inserts and when REPLICA IDENTITY is DEFAULT and no PK change), `after` (row state after change, null for deletes), `source` (metadata: database, schema, table, LSN position, transaction ID, commit timestamp), `op` (operation type: `c`=create, `u`=update, `d`=delete, `r`=snapshot read, `t`=truncate), `ts_ms` (processing timestamp at Debezium, NOT the DB commit time. Use `source.ts_ms` for event-time windowing), and optional `transaction` block when the transaction metadata topic is enabled. `source.lsn` (Postgres) or `source.pos`/`source.file` (MySQL binlog) is the idempotency key for downstream deduplication and for monitoring replication lag.

**What FAANG expects:** You know `ts_ms` and `source.ts_ms` mean different things and that using `ts_ms` for event-time windowing is a bug. You also know tombstones (null-value records with a key) are emitted after deletes when `tombstones.on.delete=true` to drive Kafka log compaction, and you can explain why SMTs like `ExtractNewRecordState` are commonly used to flatten the envelope for downstream consumers that don't understand it.

**Follow-ups:**
- What is a tombstone and why does Debezium emit one? (Null-value record with same key as the delete, signals log-compacted topics to drop the key.)
- If `before` is null on an update, what went wrong? (`REPLICA IDENTITY` on Postgres is not set to `FULL` or at least the primary key, so Debezium can't reconstruct prior state.)
- How do you correlate events that belong to the same DB transaction? (Enable `provide.transaction.metadata=true`. `transaction.id` plus `data_collection_order` let you reconstruct commit ordering.)

---

**Q3: What is the dual-write problem? How does the outbox pattern solve it?**

The dual-write problem: updating a database AND publishing to a message broker cannot be done atomically without a distributed transaction, and XA/2PC is unacceptable in modern stacks (Kafka doesn't participate, and 2PC kills availability). If you update the DB then publish, the broker call can fail, leaving the DB updated but the event unpublished. If you publish first then update, the DB write can fail and consumers see an event for state that was never committed. The outbox pattern solves this by writing the event to an `outbox` table in the SAME database transaction as the business data change. Both writes are atomic. A separate relay then reads unpublished rows and publishes them to Kafka. Two relay styles exist: (a) polling relay (`SELECT ... FOR UPDATE SKIP LOCKED`, simple, adds poll-interval latency), (b) CDC relay (Debezium watches the outbox table, sub-second latency, no polling).

**What FAANG expects:** You know outbox gives at-least-once, not exactly-once, and you explicitly name idempotent consumers as the other half of the solution. You recommend starting with a polling relay and migrating to Debezium-backed outbox only when scale justifies the Kafka Connect fleet. You also know about Debezium's `EventRouter` SMT, which routes outbox rows to per-aggregate topics automatically.

**Follow-ups:**
- Why `FOR UPDATE SKIP LOCKED` in the polling relay? (Lets multiple relay replicas run concurrently without blocking each other.)
- Why do consumers still need to be idempotent even with the outbox? (Relay can crash after Kafka acks but before marking the row published. On restart it republishes.)
- When would you NOT use the outbox? (Fire-and-forget events with no consistency requirement, or when the aggregate doesn't have a transactional DB at all.)

---

**Q4: How would you implement tumbling windows in Go without a stream processing framework?**

A tumbling window key is computed as `floor(eventTime / windowSize) * windowSize`. Maintain a map of `(partitionKey, windowStart) -> accumulator`. When a new event arrives, compute its window key and fold it into the matching state. Advance the watermark as `max(eventTime seen) - allowedLateness`. When the watermark advances past a window's end time, emit the window result and delete it from the map. Use a mutex-guarded map for single-node state or shard the key space across goroutines (hash partitioning) to eliminate lock contention. For multi-process deployments, back state with Redis (single window per key) or migrate to Flink, which persists state to RocksDB with checkpointed exactly-once snapshots.

**What FAANG expects:** You acknowledge pure-Go windowing is fine for stateless or small-state workloads but doesn't survive process restarts, and that production stateful streaming at scale means Flink (stateful, exactly-once, event-time, checkpointing to S3) or Kafka Streams (JVM, co-located state). In the Go ecosystem the pragmatic choice for stateless transforms is Benthos / Redpanda Connect (YAML-configured, no stateful ops). You can articulate this trade-off without fanboy-ism.

**Follow-ups:**
- How do you recover window state after a crash? (Persist checkpoints to Redis/Postgres keyed by `(key, windowStart)`, or move to Flink.)
- Why does Benthos/Redpanda Connect not do windowing? (It's a stateless transform engine. aggregations/joins require external state.)
- How would you shard windowing across N goroutines? (`hash(key) % N` fan-out, each shard owns disjoint keys, no locks needed within a shard.)

---

**Q5: What is a watermark in stream processing? How do you handle late data?**

A watermark `W` at time `T` asserts: "all events with `event_time < T` have been received." It's an estimate. Usually wrong in the tail. That allows the system to declare windows complete. Watermarks are typically computed as `max(event_time_seen) - allowedLateness` where `allowedLateness` accounts for known skew (network delays, mobile offline buffering). Late data (events arriving after the watermark has passed their window) has three handling options: (1) drop. Ignore events that arrive too late. (2) allowed-lateness window. Keep the window open for an extra `L` seconds and re-emit an updated result. (3) side output. Route late events to a separate "late" stream for audit or manual reconciliation. The correct choice depends on your SLA. dropping 0.01% late events is often fine for dashboards. unacceptable for billing.

**What FAANG expects:** You can distinguish punctuated watermarks (emitted on special marker events) from periodic watermarks (computed every N seconds), and you know Flink's bounded-out-of-orderness watermark strategy. You also bring up "watermark progress stalls" as a real production issue. If one partition is idle, the min-watermark across partitions doesn't advance, and windows never fire.

**Follow-ups:**
- What's an idle partition and how does it stall watermarks? (A partition with no events produces no watermark progress. Global watermark = min across partitions stalls. Fix with idle-partition detection + heartbeat watermarks.)
- What's the difference between event time, ingestion time, and processing time? (Event: when it happened at source. Ingestion: when broker received it. Processing: when operator handled it.)
- Can you have multiple watermarks in one pipeline? (Yes. per-partition watermarks, then operator takes the min when joining across partitions.)

---

**Q6: How do you ensure exactly-once processing in a CDC pipeline?**

True exactly-once end-to-end requires: (1) idempotent sinks. Elasticsearch `index` with explicit `_id`, Postgres `INSERT ... ON CONFLICT DO UPDATE`, ClickHouse `ReplacingMergeTree` keyed by primary key, Redis `SET`. Applying the same operation twice produces the same final state. (2) at-least-once delivery from Debezium to Kafka and from Kafka to the consumer. Commit Kafka offsets only after the sink write has acknowledged, so on restart you reprocess but the sink de-dupes. (3) for non-idempotent sinks (outbound email, webhook, payment capture), dedup with Redis `SETNX` keyed by `source.lsn` (stable across reprocessing) or by `topic:partition:offset`. Dedup TTL must be >= Kafka retention or you'll forget an event's ID before Kafka forgets the event. (4) for Kafka-to-Kafka pipelines, use the idempotent producer plus transactions (`transactional.id` + `isolation.level=read_committed`) to get Kafka's own exactly-once semantics (EOS). Debezium itself is at-least-once: if the connector crashes after publishing but before flushing its offset to the `connect-offsets` topic, it re-emits on restart.

**What FAANG expects:** You lead with "Debezium is at-least-once. We build idempotent sinks," not "enable exactly-once flag." You know `source.lsn` is the correct dedup key because it's stable under reprocessing, while `topic:partition:offset` changes if Debezium re-snapshots. You distinguish Kafka EOS (producer+consumer both Kafka, transactional) from end-to-end EOS (external sink, which Kafka transactions can't cover).

**Follow-ups:**
- Why is `source.lsn` a better dedup key than `offset`? (LSN is stable across re-snapshots and connector restarts. Offset is not.)
- What's Kafka's transactional/EOS model and why doesn't it help for ClickHouse? (Transactional producers atomically publish + commit offsets within Kafka. ClickHouse isn't in that transaction, so external writes are still at-least-once.)
- If dedup TTL is shorter than Kafka retention, what happens? (Old events replayed after consumer reset are re-applied to the sink.)

---

**Q7: What happens to a Debezium replication slot if the connector goes down for a week?**

PostgreSQL uses the replication slot to track the connector's WAL position via `restart_lsn`. While the connector is down, Postgres cannot recycle WAL segments past that LSN. Over a week on a busy database this easily accumulates hundreds of GB. Eventually `pg_wal/` fills the disk, at which point Postgres refuses new writes and the primary goes read-only, then crashes. Mitigations: (1) monitor `pg_replication_slots.confirmed_flush_lsn` vs `pg_current_wal_lsn()` and alert at 1 GB lag, page at 5 GB. (2) set `max_slot_wal_keep_size` (Postgres 13+) so the slot is invalidated past the limit rather than filling the disk. invalidated slots require a fresh snapshot, which is painful but better than an outage. (3) runbook automation: if a slot has made no progress in 24 hours, drop it, alert SREs, and restart Debezium with `snapshot.mode=initial`. (4) managed Postgres offerings (RDS, Cloud SQL, Aurora) surface slot lag as a first-class metric. wire it into your on-call paging.

**What FAANG expects:** You've been paged for this at 3 AM at least once and know the mitigations cold. You also mention the tombstone risk: an invalidated slot means you lose the ability to observe deletes that happened while you were down, so downstream systems need to reconcile via a full snapshot + diff.

**Follow-ups:**
- What's `max_slot_wal_keep_size` set to in your production fleet? (A defensible answer: sized to 4-6 hours of peak WAL, so an on-call has time to react.)
- If a slot is invalidated, how do you recover downstream state without double-counting? (New snapshot emits `op=r` events. idempotent sinks handle it. For non-idempotent sinks, run a reconciliation job keyed by PK.)
- How does this look different on MySQL? (Binlog retention via `binlog_expire_logs_seconds` is time-based, not slot-based. You can't "hold" binlogs by having a connector. You set retention to cover max expected downtime.)

---

**Q8: Compare stream processing in Go vs Apache Flink for a FAANG-scale use case.**

Go strengths: lightweight goroutines, low memory, single-binary deploy, great for stateless transforms (filter, enrich, route, protobuf-reencode), and trivial to operate with standard k8s tooling. Go gaps: no framework-level stateful operators, no built-in checkpointing, no event-time watermarks across a cluster, no built-in exactly-once state. Flink strengths: built-in keyed state (RocksDB local, incremental snapshots to S3), checkpointed exactly-once state, event-time watermarks across a job graph, windowing/CEP/SQL interfaces, savepoints for version upgrades. Flink costs: JVM ops overhead, tuning RocksDB and network buffers, savepoint/restore procedures. Pragmatic FAANG pattern: Go consumers for high-throughput stateless preprocessing (Debezium envelope decode, PII stripping, routing to per-tenant topics), Flink for anything that needs windowed aggregation, multi-stream join, or session analytics. The Go ecosystem also has Benthos / Redpanda Connect (YAML-defined stateless transforms) for the "just move and transform" use case where even writing Go feels heavy.

**What FAANG expects:** You don't pitch "rewrite Flink in Go." You know Kafka Streams is the third choice (JVM, co-located state, no separate cluster) and you can say when it's the right tool (when the consuming team is already JVM and state fits in local RocksDB). You also know Benthos was forked to Bento after the Redpanda acquisition, so you're not surprised when someone at a coffee chat brings it up.

**Follow-ups:**
- When is Kafka Streams better than Flink? (Embedded in a JVM service, no separate cluster, simpler ops, state co-located. Bounded to one JVM's memory plus local disk.)
- How do you do windowed joins in Go without Flink? (External state in Redis or a Postgres staging table. Works for modest cardinality. breaks past ~1M active keys.)
- What's the Benthos vs Bento story? (Benthos maintainer moved to Redpanda. Project rebranded to Redpanda Connect. community forked the pre-acquisition code as Bento. Both are alive as of 2026.)

---

**Q9: How would you implement CDC for a multi-tenant SaaS application?**

Options depend on tenancy model: (1) shared schema, `tenant_id` column. One Debezium connector, include `tenant_id` in the Kafka message key. Consumers filter by `tenant_id` or an SMT routes to per-tenant topics. simplest, but one noisy tenant saturates the connector. (2) database-per-tenant. One connector per tenant DB, topics named `tenant-{id}.orders`. isolates blast radius and supports data-residency requirements, but the connector fleet grows with tenants. Automate provisioning via Kafka Connect REST API or a controller. (3) schema-per-tenant (single DB, many schemas). One connector with `schema.include.list` or multiple connectors each scoped to a schema group. middle ground on isolation and ops cost. Cross-cutting concerns: regulatory residency (may force option 2 per region), schema drift between tenants (option 3 makes this painful), cost (option 2 is most expensive to operate but easiest to reason about under SOC2/GDPR audits). At Shopify's scale the public blog posts describe a variant of option 2 with dynamic connector provisioning.

**What FAANG expects:** You lead with "which tenancy model is already in place?" rather than prescribing one. You know data-residency regulations (GDPR, India's DPDP, US state-level) often force option 2 regardless of engineering preference. You mention the connector control plane problem (how do you deploy 10,000 connectors?) and name Strimzi or Confluent's managed connectors as real answers.

**Follow-ups:**
- How do you roll out a schema migration across 10,000 tenant DBs? (Per-tenant migration service with rate limiting. Debezium pauses per connector during DDL if configured. you'd batch the migration over days, not all at once.)
- What key do you partition the Kafka topic by in option 1? (`tenant_id` to preserve per-tenant ordering. Never by `order_id` alone, or cross-tenant ordering invariants break.)
- How do you prevent one tenant from saturating the pipeline? (Quota by `tenant_id` at the producer side, or rate-limit per-tenant topics at the consumer, or use separate Kafka clusters for enterprise tenants.)

---

**Q10: What is the outbox pattern and when should you use it over direct Kafka publishing?**

Use the outbox when: (1) your service writes to a transactional DB AND must publish events with the same atomicity as the DB write. losing the event would cause state divergence. (2) your publishing infrastructure (Kafka) may be temporarily unavailable and you can't afford to block the business transaction waiting for Kafka to come back. (3) you want to avoid 2PC but need at-least-once guarantees. Skip the outbox when: (1) events are fire-and-forget (metrics, non-critical notifications). (2) there's no transactional DB in the write path (e.g., writing directly to Cassandra, which doesn't have the same transactional model). (3) your scale and SLA tolerate the rare dual-write inconsistency. The outbox adds: an extra table (index it. it's a FIFO-ish queue), a relay process (polling or Debezium-backed), and some publish latency (poll interval for polling relay, milliseconds for CDC relay). The CDC-based outbox variant is strictly better once you already run Debezium for other CDC workloads.

**What FAANG expects:** You don't reflexively recommend the outbox for every service. You acknowledge it's operational overhead and you pair it with a consumer-side idempotency story. You know the Debezium `EventRouter` SMT specifically targets outbox tables and handles per-aggregate topic routing automatically.

**Follow-ups:**
- How do you prune the outbox table? (Background job deleting rows with `published_at < now() - 7 days`. Keep enough history to replay on consumer re-bootstrap.)
- What's the payload format in the outbox row? (Pre-serialized JSON or Avro with schema ID. Never store a raw domain object. The relay shouldn't depend on domain types.)
- Why not just let the service publish to Kafka directly inside the transaction? (The transaction hasn't committed yet. downstream would see an event for state that may roll back.)

---

**Q11: How do you handle schema evolution in CDC pipelines?**

Core problem: a new column in the source table must flow through Debezium, Kafka, and all consumers, which deploy at different times. Strategies: (1) Schema Registry (Confluent, Apicurio, buf.build BSR). register schemas per topic, enforce backward or full compatibility. Debezium can publish Avro/Protobuf with schema IDs. Consumers cache schemas and handle missing-optional-fields gracefully. (2) consumer lenient deserialization. In Go, `json.Unmarshal` already ignores unknown fields. Mark all fields `,omitempty` and don't panic on absent ones. (3) versioned topics (`orders-v1`, `orders-v2`). Old consumers keep reading v1. New consumers read v2. dual-write during migration. expensive but explicit. (4) columnar sinks (ClickHouse) handle `ALTER TABLE ADD COLUMN` online and the missing column simply defaults to NULL/zero for old rows. (5) Debezium schema change topic (`<server>.schema-changes.<db>`) emits DDL events. downstream consumers can react or alert on unexpected schema changes.

**What FAANG expects:** You name Schema Registry and compatibility modes (`BACKWARD`, `FORWARD`, `FULL`) explicitly. You can describe a concrete migration: add a new optional column, deploy producers first, wait for all consumers to accept the new schema, then make the column required if necessary. You acknowledge JSON-without-Schema-Registry is what most teams actually run, and you know the pitfalls (silent data loss when a consumer was written against an old shape).

**Follow-ups:**
- What's the difference between `BACKWARD` and `FORWARD` compatibility? (Backward: new schema can read old data. Forward: old schema can read new data.)
- How do you handle a renamed column? (Not backward-compatible in most systems. introduce new column, dual-write, migrate consumers, drop old column. Never just rename.)
- What happens if a consumer parses an event with an unknown `op` type? (Debezium may introduce `t` (truncate). Consumers that switch on `op` without a default case crash. Always log-and-skip unknown ops.)

---

**Q12: Explain the difference between event time and processing time. Why does it matter?**

Event time is when the business event actually occurred, embedded in the event payload (`order.created_at`, `source.ts_ms` in Debezium). Processing time is when the stream processor observed the event. They diverge because of network delays, mobile apps buffering events while offline, retry storms, consumer pauses during rebalances, and uneven consumer processing rates. This matters for aggregations: "orders per minute" should use event time, not processing time, otherwise a backlog of delayed mobile events arriving together inflates the current minute and leaves the true minute empty. The solution is watermark-based event-time windowing. process by event time, use watermarks to decide when a window is complete, and set an explicit policy for truly-late events (drop, side-output, or update).

**What FAANG expects:** You reach for a concrete failure scenario (mobile offline-then-reconnect, a 6-hour Kafka consumer outage on Black Friday) and walk through what each time semantic would produce. You also mention ingestion time as a third option (when the broker received the event, useful when you don't trust client clocks).

**Follow-ups:**
- When would you use processing time deliberately? (SLO dashboards measuring your own pipeline latency, or when source events have no reliable timestamp.)
- How do you handle clock skew between producers? (NTP discipline on producers. If you can't, use ingestion time. Never use client wall-clock without tolerance.)
- What's the difference between `ts_ms` and `source.ts_ms` in Debezium? (`source.ts_ms` is the DB commit time. `ts_ms` is when Debezium processed the WAL record. Always use `source.ts_ms` for event-time logic.)

---

**Q13: How would you design a system that needs to process 1M CDC events/second?**

Scale at every tier: (1) DB sharding. 1M/sec of writes doesn't fit on one Postgres, so source data is already sharded, each shard with its own Debezium connector and slot. (2) Kafka partitioning. Partition the CDC topics by natural key (order_id, user_id) to preserve per-key order. 200-400 partitions for 1M/sec gives ~2.5-5K/sec per partition, which is well within a single consumer's budget. (3) consumer fleet. Deploy Go consumer pods equal to partition count. Each pod handles its assigned partitions, typically 5-10K events/sec per pod with Protobuf and batch processing. (4) stateful processing. Shard state by key with Redis Cluster or move windowed aggregations to Flink. (5) sink bulking. ClickHouse `INSERT` wants thousands of rows per batch, Elasticsearch `_bulk` wants 1-5 MB per request, Redis needs pipelining. (6) serialization. JSON is a tax at this volume. Protobuf or Avro cuts parse CPU by 3-5x. (7) observability. p99 end-to-end latency, per-partition consumer lag, Debezium slot lag. (8) backpressure. If a sink slows, the consumer must slow. Which means Kafka consumer lag grows. Which means Debezium slot lag grows. Which means Postgres disk fills. Instrument and alert on this chain, not just the final sink.

**What FAANG expects:** You name explicit numbers (partition count, batch size, per-pod throughput) rather than waving at "scale horizontally." You identify the backpressure chain up to the Postgres slot, which is the scariest failure mode at 1M/sec. You mention that some of this traffic belongs in Flink rather than Go, depending on how much state is involved.

**Follow-ups:**
- Why does partition count matter? (Consumer parallelism is capped at partition count within one consumer group. Too few partitions = bottleneck. Too many = coordinator and rebalance overhead.)
- What happens if one partition is hot? (Key-skew. One consumer falls behind. mitigate by using a composite key or introducing a secondary partitioner upstream.)
- At 1M/sec, what's the budget per event in a Go consumer running at 5K/sec? (200 microseconds. JSON parse alone can eat 50-100 µs. Protobuf or fastjson is required.)

---

**Q14: What are the tradeoffs between Debezium running standalone vs embedded?**

Standalone Debezium (Kafka Connect plugin): runs in a Kafka Connect cluster, uses Connect's distributed mode for horizontal scaling, fault tolerance (rebalance on worker loss), and centralized config via REST API. Operational cost: you run a Connect cluster. Debezium Embedded (`io.debezium.engine`, Java library): runs inside your JVM application, direct programmatic control, no Connect cluster, simpler infra. Downsides: no automatic failover. If your process dies, CDC stops. You own checkpointing to a durable store. Go story: there's no official Go embedded Debezium. Options for Go shops are (a) run standalone Debezium and consume from Kafka with franz-go (the mainstream choice), (b) use `github.com/jackc/pglogrepl` to read the Postgres logical replication stream directly in Go, bypassing Kafka. Good for simple single-consumer use cases but you reinvent Debezium's snapshotting, heartbeat, and schema handling. Debezium Server (standalone process, not Connect) is a third option for non-JVM shops that want Debezium's logic without running Kafka Connect.

**What FAANG expects:** You know Debezium Server exists as of late 2024 and is the modern answer for "I want Debezium without Kafka Connect." You're not surprised by the question about pglogrepl, and you explicitly warn against building a bespoke pglogrepl consumer in production unless you own the full on-call.

**Follow-ups:**
- What's Debezium Server? (Standalone process that ships Debezium changes to Kinesis, Pulsar, Pub/Sub, Redis Streams, etc., without Kafka Connect.)
- Why is pglogrepl risky in production? (You own: slot management, snapshot handling, heartbeat, schema changes, DDL detection, failover. Debezium solved all of that years ago.)
- When is embedded the right answer? (Single-instance CLI tools, local development, low-volume integration services that can tolerate CDC pauses during deploys.)

---

**Q15: How do you monitor a CDC pipeline in production?**

Key signals and alerts: (1) **replication slot lag** (`pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)` per slot). warn at 1 GB, page at 5 GB. This is the one that causes outages. (2) **Debezium connector status** via Kafka Connect REST API (`/connectors/<name>/status`). `FAILED` or `UNASSIGNED` must page. (3) **consumer lag** (Kafka consumer-group lag on CDC topics). SLO example: "99% of DB changes reflected in sink within 5 seconds." (4) **events/sec by op type** (c/u/d/r). sudden drop = broken connector, sudden `r` burst = unexpected re-snapshot. (5) **sink write errors and retries** (ClickHouse, Elasticsearch). Spike = schema drift or sink outage. (6) **dedup-hit rate** (how many events were skipped as duplicates). High rate = consumer restart loop or offset reset. (7) **schema registry compatibility errors**. New producer schema rejected = deploy blocked. (8) **end-to-end latency** (DB commit `source.ts_ms` to sink write time). This is the only user-visible SLO. (9) **CDC audit count**. Periodically `SELECT count(*) FROM source_table` vs `SELECT count(*) FROM sink_table` and alert on divergence beyond a threshold.

**What FAANG expects:** You lead with the replication slot metric, because that's the one that takes down production. You also mention e2e latency and source-to-sink row-count parity as SLOs the business actually cares about, not just infra health metrics. You run Grafana dashboards and have a runbook for slot invalidation.

**Follow-ups:**
- Why is slot lag the number-one alert? (It's the only metric where CDC failure causes the primary DB to go down. All other metrics are downstream pain.)
- How do you measure end-to-end CDC latency? (Inject synthetic heartbeat row in source every N seconds, measure time until it appears in the sink. expose as histogram.)
- What's the right action on a dedup-hit spike? (Check for consumer restart loop, offset reset, or a producer replay. don't just silence the alert.)

### Junior -> FAANG: Interview Preparation Strategy for CDC and Stream Processing

The 15 questions in this section cover the full scope of what FAANG interviewers ask about CDC and stream processing at the L4-L5 level. Here is how to prepare for them efficiently.

Group the questions by theme rather than studying them sequentially. Theme 1 (CDC fundamentals): Q1, Q2, Q7, Q14. Theme 2 (exactly-once and delivery guarantees): Q3, Q6, Q10. Theme 3 (stream processing): Q4, Q5, Q8, Q12, Q13. Theme 4 (operations and production): Q7, Q9, Q11, Q15.

For each theme, prepare a 2-minute verbal explanation before the interview. Practice saying it out loud, not just thinking through it. The bottleneck in CDC interviews is usually articulation, not understanding: candidates who know the material well often struggle to explain it clearly under interview pressure.

The questions that junior candidates most often struggle with are Q5 (watermarks) and Q6 (exactly-once). For Q5, the failure mode is confusing the watermark definition with the mechanism. Practice this: the watermark is the input to window completion logic, not an output. For Q6, the failure mode is saying "enable exactly-once mode" without explaining which components need to be idempotent and why.

For every question, prepare one concrete production scenario that illustrates the concept. For Q7 (replication slot accumulation), the scenario is: connector crashes on Friday at 5 PM, nobody notices over the weekend, Monday morning the primary database goes read-only because the WAL directory is full. Being able to tell this story concretely is more persuasive than a correct but abstract answer.

The follow-up questions are as important as the main questions. Interviewers use follow-ups to probe depth. If you answer Q1 correctly, the interviewer will ask "if CDC is at-least-once, how do you get end-to-end exactly-once?" Prepare a three-sentence answer for each follow-up listed in this section.

### Senior @ FAANG: Bar-Raiser Signals and L6/L7 Framing

Bar-raiser interviewers are looking for signals that distinguish L5 from L6. The difference is not in knowing more facts. It is in reasoning from system-level constraints and making principled trade-offs with explicit justification.

**Signal: you lead with constraints, not solutions.** When asked Q13 (design a system for 1M CDC events/second), an L5 candidate proposes a solution. An L6 candidate first establishes the constraints: "What is the SLO for end-to-end latency? What are the idempotency requirements for the sink? Is the state per-key or global? What is the key cardinality?" The constraints determine the architecture. Proposing an architecture without establishing constraints is not a bar-raiser signal.

**Signal: you name the organizational problem alongside the technical problem.** Q9 (multi-tenant CDC) is not just a technical question. At FAANG scale, the organizational problem (how do you provision and operate 10,000 connectors across hundreds of teams?) is harder than the technical problem. Bar-raisers name both and address both. For the connector control plane, naming Strimzi or Confluent's managed offering and explaining the trade-offs (Strimzi: more control, more ops burden. Confluent: less control, SaaS pricing) is an L6-level response.

**Signal: you distinguish what you would build from what you would buy.** Q8 (Go vs Flink) is an ADR question. An L5 candidate compares features. An L6 candidate says: "For stateless transforms, we build a Go consumer because our team already operates Go services and the operational overhead is zero. For stateful windowed aggregations with durable state, we would use a managed Flink offering rather than build and operate a Flink cluster ourselves, because the engineering cost of operating Flink is higher than the cost of the managed service at our current scale." The L6 signal is the explicit consideration of build-vs-buy, operational cost, and team capability.

**Signal: you know the failure mode of your own recommendation.** When recommending the outbox pattern (Q10), an L6 candidate proactively identifies: "The outbox adds latency because of the poll interval. If the business requires sub-second event delivery, a CDC relay is better. The outbox adds an extra table, which needs its own index, its own retention job, and its own monitoring for table bloat. And the relay must be idempotent-safe on the consumer side, because the relay gives at-least-once, not exactly-once." Identifying the failure modes of your own recommendation is the bar-raiser signal, because it demonstrates that you have operated the thing you are recommending, not just read about it.

**Signal: you connect individual technical decisions to organizational SLOs.** The best candidates tie every technical question back to a measurable outcome. "We chose `REPLICA IDENTITY FULL` on the orders table because the consumer-side audit log requires the full before-state, and the 20% WAL volume increase was within the capacity budget for our write load." "We set the dedup TTL to 14 days because our Kafka topic retention is 14 days, and a shorter TTL would allow duplicates if a consumer reset replayed more than the TTL window." These explicit, quantified justifications are the difference between a candidate who understands the concepts and one who has applied them under real constraints.

---
