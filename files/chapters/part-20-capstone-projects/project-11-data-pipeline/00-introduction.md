# Capstone Project 11: Distributed Data Pipeline Framework

**Difficulty**: Advanced
**Estimated Time**: 4 weeks
**Target**: Real-time distributed stream processing engine with stateful windowing
**Tech Stack**: Go 1.27+, Raft consensus, Pebble/BadgerDB, gRPC, Protobuf, Kafka/NATS inputs

---

### Project Overview & Architecture

Modern data-driven organizations depend on real-time event stream processing for fraud detection, live telemetry aggregations, search indexing, and real-time inventory adjustments. Batch processing running every 24 hours is no longer fast enough; systems must process events with millisecond latencies while guaranteeing strict correctness even when network partitions occur.

In this capstone project, you will build a distributed Stream Processing Engine in Go modeled after Apache Flink and Apache Beam. The engine models processing topologies as Directed Acyclic Graphs (DAGs) of operators (sources, transformations, windowed aggregations, sinks), supports both event-time and processing-time windowing with watermark progression, and provides fault-tolerant state management via periodic distributed checkpointing.

```
┌──────────────────────────────────────────────────────────────┐
│                    Event Ingestion Sources                   │
│                                                              │
│        Kafka Topic / NATS Stream / Network Sockets           │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│               DAG Stream Execution Pipeline                  │
│                                                              │
│   Source Operator (Event Deserialization & Timestamping)     │
│       │                                                      │
│       ▼                                                      │
│   Map / Filter / FlatMap Operators (Stateless Transform)     │
│       │                                                      │
│       ▼                                                      │
│   KeyBy Operator (Partitioning & Sharding by Key)            │
│       │                                                      │
│       ▼                                                      │
│   Windowing Operator (Tumbling, Sliding, Session Windows)    │
│   ├─ Watermark Generator (Tracking Event-Time Progression)   │
│   ├─ Trigger Coordinator (Early, On-Time, Late Firings)      │
│   └─ Embedded Key-Value State Store (BadgerDB/Pebble)        │
│       │                                                      │
│       ▼                                                      │
│   Sink Operator (Database, ElasticSearch, Webhook Delivery)  │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Core Model & Transformations)**: Define the core record types, pipeline builders, and stateless stream operators (`Map`, `Filter`, `FlatMap`).
- **Part 3 (Windowing & Triggers)**: Implement Tumbling, Sliding, and Session windows with trigger mechanisms for handling bursty data streams.
- **Part 4 (Watermarks & Event-Time Progression)**: Build watermark generators that track event-time progression across distributed streams, handling out-of-order and delayed events.
- **Part 5 (State Management & Checkpointing)**: Integrate an embedded persistent key-value store (BadgerDB) for accumulating window state, and implement Chandy-Lamport distributed checkpointing.
- **Part 6 & 7 (Distributed Coordination & Fault Tolerance)**: Use Raft consensus and gRPC transport to coordinate multiple worker nodes, redistributing partitioned partitions when a node crashes.

### Junior → FAANG: Concurrency & Channel Mechanics

- **Avoiding Pipeline Deadlocks**: In multi-stage concurrent pipelines connected by Go channels, if downstream stages slow down without bounded buffering, upstream channels block. If circular dependencies or unbounded spawning occur, the entire runtime deadlocks. Master backpressure propagation and select-with-context timeout patterns.
- **Deterministic Record Processing**: Concurrency without careful ordering leads to non-deterministic calculations. Learn how key-based partitioning (hashing keys to specific worker goroutines) guarantees in-order processing per entity without sacrificing multi-core parallelism.

### Senior @ FAANG: Exactly-Once Semantics & Late Event Handling

- **The Myth of "Exactly-Once" Processing**: At scale, network packets duplicate and nodes fail. True "exactly-once" means *at-least-once processing* combined with *idempotent state persistence* or distributed two-phase commit checkpointing. Master the Chandy-Lamport snapshot algorithm to record consistent global state across nodes without stopping execution.
- **Handling Late-Arriving Events Gracefully**: In mobile and IoT networks, events can arrive hours late due to network dropouts. Design watermark delay heuristics, allowed-lateness thresholds, and side-output dead-letter streams to ensure late data is captured for downstream auditing without corrupting already-emitted windows.
