## 52H.8 Pub/Sub vs Streams Comparison & Decision Matrix

### Full Comparison Table

| Feature | NATS Core | JetStream | Redis Pub/Sub | Redis Streams | Kafka | RabbitMQ |
|---|---|---|---|---|---|---|
| Persistence | None | File/Memory | None | Yes (AOF/RDB) | Yes (disk) | Yes (disk) |
| At-most-once | Yes | No | Yes | No | No | No |
| At-least-once | No | Yes | No | Yes | Yes | Yes |
| Exactly-once | No | Yes (dedup) | No | No (manual) | Yes (idempotent) | No |
| Consumer groups | Queue groups | Yes | No | Yes | Yes | Yes |
| Message ordering | Per subject | Per stream | No | Per stream | Per partition | Per queue |
| Replication | Cluster | Raft | None/Cluster | AOF/Cluster | ISR | Mirroring |
| Retention | None | Time/Size/Count | None | Time/Size/Count | Time/Size | TTL/Count |
| Throughput | >10M msg/s | ~1M msg/s | ~1M msg/s | ~500K msg/s | >10M msg/s | ~200K msg/s |
| Latency | <1ms | 1-5ms | <1ms | 1-2ms | 5-15ms | 1-5ms |
| Ops complexity | Very low | Low | Very low | Low | High | Medium |
| Protocol | NATS | NATS | RESP | RESP | Kafka binary | AMQP |
| Multi-tenancy | Accounts | Accounts | DB select | DB select | Topics | vHosts |

### Decision Framework

Choosing between pub/sub (NATS core), persistent streams (NATS JetStream), and Redis Streams hinges on your requirements for message replay, at-least-once delivery, and operational simplicity. The following decision tree maps functional requirements (persistence, consumer groups, throughput targets) to the appropriate technology.

```
Is persistence required?
├── NO  → NATS Core (ultra-low latency, fire-and-forget, RPC)
└── YES
    ├── Already running Redis?
    │   ├── YES → Redis Streams (co-located, no new infra)
    │   └── NO
    │       ├── Need >1M msg/sec or complex routing?
    │       │   ├── YES → Kafka (scale, ecosystem, long retention)
    │       │   └── NO
    │       │       ├── Need NATS for other workloads too?
    │       │       │   ├── YES → JetStream (simplicity, NATS KV, leaf nodes)
    │       │       │   └── NO
    │       │       │       └── Need priority queues / complex routing?
    │       │       │           ├── YES → RabbitMQ
    │       │       │           └── NO  → JetStream (simpler ops than Kafka)
    │       └── ─────────────────────────────────────────────
```

**Use NATS Core when**: sub-millisecond latency required. At-most-once is acceptable. Request/reply RPC patterns dominate. telemetry/heartbeat data.

**Use JetStream when**: you need NATS simplicity with persistence. Edge computing with NATS leaf nodes. moderate scale (<1M msg/sec). NATS KV for distributed config. Offline-first scenarios.

**Use Redis Streams when**: you already operate Redis. time-series event data. Need consumer groups at moderate scale. Simple ops story. co-located with cache layer.

**Use Kafka when**: throughput >1M msg/sec. Long-term retention (days/weeks). Complex routing with Kafka Streams or ksqlDB. Large existing ecosystem investment.

**Use RabbitMQ when**: complex routing (header exchanges, topic exchanges with many bindings). priority queues. AMQP compatibility requirements. per-message TTL.

### 2026 Production Benchmark & Cost Realities: Kafka vs RabbitMQ vs Redis Streams vs NATS

Selecting a messaging broker based solely on maximum throughput benchmarks frequently leads to inflated infrastructure costs and operational complexity. In the comparative analysis [Kafka vs RabbitMQ vs Redis Streams vs NATS 2026: I Burned $847 on Kafka Before Finding the $67 Fix](https://medium.com/@author/kafka-vs-rabbitmq-vs-redis-streams-vs-nats-2026-i-burned-847-on-kafka-before-finding-the-67-fix) and [Why More And More Teams Are Abandoning RabbitMQ for NATS](https://medium.com/@author/why-more-and-more-teams-are-abandoning-rabbitmq-for-nats), engineers stress-tested all four systems under a 10-million-message production workload.

#### Production Performance and Infrastructure Cost Matrix

| Broker | Max Throughput | p99 Latency | Baseline Memory | Monthly Cloud Cost (Typical Cluster) | Operational Trade-off |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Kafka 4.0** | ~600,000 msg/s | ~5.0 ms | 8 GB+ / broker | $500 - $2,000 (AWS MSK 3-node) | High JVM heap overhead, complex partition management, rigid worker ceilings. |
| **RabbitMQ 4.1** | ~39,000 msg/s (queue) <br> ~97,000 msg/s (stream) | ~1.0 ms (low) <br> ~12.0 ms (burst) | 512 MB - 2 GB | $150 - $400 | Native DLQs and complex routing, but Erlang clustering partition healing overhead. |
| **Redis Streams** | ~1,000,000 msg/s | < 1.0 ms | In-memory RAM | $80 - $250 | Fastest read/write latency, but consumer lag causes RAM exhaustion and OOM crashes. |
| **NATS Core** | ~11,000,000 msg/s | ~0.2 ms (200 µs) | 50 MB (15 MB binary) | $30 - $100 | Microsecond latency, but zero persistence (at-most-once fire-and-forget only). |
| **NATS JetStream** | ~250,000 - 400,000 msg/s | 1.0 - 5.0 ms | ~500 MB | $60 - $200 | Raft-backed persistence, Go single-binary ops, horizontal scalability at 10% Kafka cost. |

#### Architectural Failure Modes & Trade-offs

1. **The Redis Streams RAM Trap**: Because Redis Streams stores entries in-memory, an unconsumed backlog directly consumes RAM. If a downstream consumer crashes or lags during a burst, Redis memory usage climbs until the host kernel invokes the OOM killer. If Redis also serves as the application's shared cache, the message backlog takes down the entire caching tier.
2. **The Kafka Capacity Overkill**: A managed 3-broker Kafka cluster on AWS MSK costs roughly $500 - $850/month before storage and data transfer fees. For workloads processing under 100,000 messages daily, this equates to significant cost per message. Tuning JVM heap allocations, batch sizes, and partition rebalancing requires dedicated operational engineering.
3. **NATS JetStream as the Lean Alternative**: JetStream embeds durable stream storage directly inside the 15MB NATS Go binary via an integrated Raft engine. For teams requiring durable at-least-once delivery, consumer groups, and stream replay without JVM infrastructure or Kafka operational burdens, JetStream delivers ~300,000 msg/s per node at approximately $67/month in cloud compute.

### Junior -> FAANG: Using the Decision Matrix Without Over-Applying It

Decision matrices like the one in this section are reference tools, not algorithms. Use them to eliminate obviously wrong choices quickly, then apply judgment to the remaining candidates.

The most common misuse pattern among entry-level engineers is picking the system with the best benchmark numbers rather than the system that fits the team's operational context. A team that has never run Kafka should not pick Kafka because its throughput numbers are higher. The operational gap between "I have never run this system" and "I can debug it at 3 AM" is enormous, and it directly affects your incident MTTR.

A practical first step when making a technology choice: before looking at the decision matrix, write down the operational systems your team currently owns and the engineers who know how to operate them. Then check which of the candidate systems overlaps with that list. Operational expertise is often the deciding factor at small-to-medium scale.

Use the throughput and latency numbers in the comparison table as sanity checks: if your workload is 50,000 msg/sec and all four systems support that, throughput is not the deciding dimension. Move to the next column in the matrix that actually differentiates your candidates.

### Senior @ FAANG: Decision Matrix Governance and ADR Integration

The decision matrix in this section is a snapshot of a particular moment in the ecosystem's evolution. Redis Streams' numbers reflect Redis 7.x on a well-sized single node. JetStream numbers reflect a 3-node cluster with file storage. These numbers shift with each major release and with hardware generation. A staff engineer should treat the matrix as an input to an ADR, not as the output.

The ADR for a messaging technology decision at FAANG level includes five sections that go beyond what the matrix captures. First, the organizational constraints: which systems does the platform team already provide SLAs for? Adding a system outside that list means the team owning the new service also owns its production operations. Second, the total cost of ownership: licensing, compute, storage, egress, and on-call time for the first 12 months. Third, the failure scenario analysis: what happens to this system during a regional AZ outage, and does that failure mode match the application's SLA requirements? Fourth, the migration path: if this system proves insufficient in 18 months, what is the migration cost to the next tier? Fifth, the sunset criteria: what measurable thresholds trigger a re-evaluation of the decision?

The decision tree in this section handles the "which system" question but not the "how do we govern the decision over time" question. In a large engineering organization, each team making independent messaging technology choices leads to a portfolio of N different systems, each with their own client libraries, monitoring dashboards, and on-call procedures. The platform team's job is to define a small approved list and provide golden-path libraries for each approved system, so that the decision tree leads teams to a managed platform service rather than a DIY deployment. The decision matrix is the justification for why those specific systems are on the approved list.

---
