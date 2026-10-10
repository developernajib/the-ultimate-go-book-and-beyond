## Architecture Overview

The following diagram maps the end-to-end CDC pipeline. WAL changes flow from PostgreSQL through a Debezium connector into Kafka topics, where Go stream processors consume, transform, and route them to analytical and operational sinks. Tracing this data path before diving into individual components reveals where latency accumulates, where failures can occur, and where exactly-once boundaries apply.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      CDC + Stream Processing Pipeline                    │
└──────────────────────────────────────────────────────────────────────────┘

  Source Database (PostgreSQL)
  ┌──────────────────────────┐
  │  orders table            │
  │  WAL (Write-Ahead Log)   │──── logical replication ────┐
  │  replication slot        │                             │
  └──────────────────────────┘                             ▼
                                                  ┌─────────────────┐
  Application Service                             │    Debezium     │
  ┌──────────────────────────┐                    │  Kafka Connect  │
  │  OrderService            │                    │   Connector     │
  │  ┌──────────────────┐    │                    └────────┬────────┘
  │  │  DB Transaction  │    │                             │ CDC events
  │  │  + Outbox write  │    │                             ▼
  │  └──────────────────┘    │                   ┌─────────────────┐
  └──────────────────────────┘                   │  Apache Kafka   │
                                                  │  orders-cdc     │
  Stream Processor (Go)                           │  topic          │
  ┌──────────────────────────┐                    └────────┬────────┘
  │  Watermark Tracker       │◄───── consume ─────────────┘
  │  Window Aggregator       │
  │  State Store (Redis)     │───── sink ──────┬──► Elasticsearch
  └──────────────────────────┘                 ├──► ClickHouse
                                               └──► Redis Cache

  Window Types:
  Tumbling:  [──5min──][──5min──][──5min──]
  Sliding:   [──5min──]
                  [──5min──]
                      [──5min──]
  Session:   [─activity─] gap [─activity─]
```

### Junior -> FAANG: Reading an Architecture Diagram in an Interview

When an interviewer shows you an architecture diagram like this one, they are not asking you to describe what you see. They are asking you to reason about the failure modes, latency characteristics, and delivery guarantees at each boundary.

Start at the left edge: the database write. Every other component in this diagram is downstream of that write. The WAL is appended before the data file is updated, so Debezium sees changes that are committed and durable. This is important because it means CDC events correspond to real, committed state changes, not speculative writes.

Move right to Debezium. The connector reads from a logical replication slot, which acts as a cursor. If Debezium stops, the slot holds the WAL position. When Debezium restarts, it re-reads from where it left off. This is what makes CDC reliable, but it is also what makes slot lag dangerous: an unmonitored, stuck connector holds the WAL indefinitely.

Move to Kafka. The topic is partitioned. For CDC topics, the partition key is typically the primary key of the source row (Debezium defaults to the row's primary key as the Kafka record key). This preserves per-row ordering: all changes to order 123 land in the same partition in commit order.

Move to the Go consumer. The consumer reads records, processes them, writes to the sink, and then commits offsets. If the process crashes between the sink write and the offset commit, the records are redelivered. This is why the sink must be idempotent.

At the bottom, notice the three sinks: Elasticsearch, ClickHouse, and Redis. Each has a different idempotency mechanism. Elasticsearch uses a document ID as the upsert key. ClickHouse uses `ReplacingMergeTree` with a version column. Redis uses `SET` with the same key, which overwrites. In an interview, being able to name the idempotency mechanism for each sink type is a strong positive signal.

### Senior @ FAANG: Architecture as a Governance Document

A diagram like this is not just an explainer for new team members. At the senior level it is an architecture decision record that encodes commitments about latency, delivery semantics, schema contracts, and operational ownership.

**Latency budget decomposition.** The diagram shows four hops: database commit to WAL, WAL to Debezium to Kafka, Kafka to Go consumer, consumer to sink. Each hop has a latency budget. A P99 end-to-end SLO of 2 seconds from DB commit to sink write needs to be distributed across these hops. In practice: WAL-to-Debezium is sub-10ms on a well-configured slot. Debezium-to-Kafka depends on batch accumulation settings (`poll.interval.ms`, `max.batch.size`). Kafka-to-consumer depends on `fetch.min.bytes` and `fetch.max.wait.ms`. Consumer-to-sink depends on batch flush interval and sink write latency. A senior engineer instruments each hop independently, not just the end-to-end latency, so that when the SLO degrades, the offending segment is immediately identifiable.

**Delivery guarantee boundaries.** The diagram shows three distinct at-least-once boundaries: (a) Debezium to Kafka (connector offset may not flush before crash, causing re-emit), (b) Kafka consumer to sink (offset commit after sink write, but not transactionally), (c) sink internal (ReplacingMergeTree merges are async, so duplicate rows may be visible between merge cycles). A senior engineer documents which boundary each downstream team is responsible for defending, because a consumer team that assumes the platform guarantees exactly-once will build non-idempotent sinks and suffer production incidents.

**State store placement.** The diagram shows a Redis state store inside the Go processor. This is a deliberate architectural choice that has consequences. Redis is a single point of failure and a write bottleneck if every event requires a Redis read-modify-write. An alternative is sharding state by key across goroutines within the consumer, with Redis only for persistence between restarts. The diagram should encode this decision. An architecture review that asks "why Redis here and not an in-process map with checkpoint" is doing exactly what senior engineers should do: surfacing the assumptions baked into the diagram.

**Multi-region considerations.** This diagram is implicitly single-region. At FAANG scale, the architecture question is whether CDC events replicate across regions, and if so, how. Options: (a) Kafka MirrorMaker 2 replicates the CDC topic to a second region, with consumers in each region writing to regional sinks, (b) the source database is the replication source and each region runs its own Debezium connector against a regional replica, (c) the sink is globally distributed and the single-region CDC pipeline feeds it. Each option has different consistency characteristics and data-residency implications. An L6 engineer frames the multi-region topology before the first line of code is written.

---
