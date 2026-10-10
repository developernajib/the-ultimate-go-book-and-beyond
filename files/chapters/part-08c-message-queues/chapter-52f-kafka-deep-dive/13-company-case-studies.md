## Company Case Studies

### LinkedIn - The Birthplace of Kafka

LinkedIn created Kafka internally in 2010 and open-sourced it in 2011. Their Kafka deployment processes **over 1 trillion messages per day** across hundreds of clusters with thousands of brokers.

**Architecture decisions that scale:**

- **Multi-cluster topology**: LinkedIn separates clusters by use case - aggregate cluster, user activity cluster, metrics cluster. This prevents noisy-neighbor problems where a spike in one domain starves another.
- **Consumer lag monitoring with Burrow**: LinkedIn open-sourced [Burrow](https://github.com/linkedin/Burrow), a Kafka consumer lag monitoring tool that goes beyond simple offset deltas. Burrow uses a sliding window of offsets to detect *stalling* consumers (lag growing) vs *slow* consumers (lag stable). This distinction prevents false alerts.
- **Exactly-once for financial pipelines**: LinkedIn's ad billing pipelines require exactly-once semantics. They use Kafka's transactional API combined with idempotent producers to ensure ad impression and click events are counted precisely once, even during broker failover or consumer crashes.

**Go lesson**: When building multi-cluster consumers at LinkedIn's scale, use a consumer group naming convention that encodes cluster, application, and environment: `cluster.app.env` (e.g., `activity.recommendation-svc.prod`). This makes Burrow monitoring dashboards self-documenting.

---

### Uber - Real-Time Location at 1M Events/Second

Uber's driver and rider location tracking system processes **GPS events on the order of a million per second**. Every active driver device sends a location update every **4 seconds**.

**Key engineering decisions:**

- **Custom partition assignment for geographic regions**: Uber implemented a custom `PartitionAssignor` that assigns partitions to consumers based on geographic region. Consumer instances deployed in the US-West region preferentially consume partitions containing US-West driver data. This reduces cross-region data transfer and improves cache locality in downstream services.
- **Batch accumulation reducing Kafka calls by 90%**: Rather than sending each GPS ping individually, Uber's mobile SDK batches location points over a 30-second window and sends them as a single compressed payload. The backend Kafka producer then explodes these batches into individual events. This reduced Kafka write RPS by over 90%.
- **Cooperative sticky rebalancing**: Uber migrated their consumer fleets to cooperative sticky rebalancing (`CooperativeStickyAssignor`). During a rolling deploy of 200 consumer instances, the eager rebalancing strategy caused complete stop-the-world pauses affecting location freshness. Cooperative rebalancing reduces the blast radius - only partitions that must move are revoked, not all partitions.

**Operational insight**: At Uber's scale, a 10-second stop-the-world rebalance on a consumer group processing driver locations means 10 seconds of stale ETAs for riders. Cooperative rebalancing cut this to sub-second impact for rolling deploys.

---

### Case Study Shape: A Chat Platform's Go Consumer Fleet

This one is a composite of patterns documented across chat-scale engineering blogs rather than one company's story, and it is the reference design for idiomatic Go Kafka consumers at billions of messages per month.

**Architecture decisions:**

- **Partition-per-shard consumer design**: A chat platform shards its servers (guilds) across database shards. The Kafka consumer assigns one goroutine per partition, and partition keys are derived from guild IDs. This means a single partition's goroutine processes all events for a set of guilds, maintaining per-guild ordering without global locks.
- **Custom circuit breaker for error handling**: a per-partition circuit breaker. If a partition's processing goroutine encounters 5 consecutive errors, it opens the circuit and begins exponential backoff. The partition is not committed, so messages are retried. This prevents a buggy message from blocking the entire consumer group.
- **Zero-downtime deploys using cooperative rebalancing**: a team deploying multiple times per day uses cooperative rebalancing with `session.timeout.ms=10000` and a graceful shutdown period of 15 seconds, so the Go consumers drain in-flight messages, commit offsets, and exit cleanly - all without triggering a full group rebalance.
- **Memory efficiency versus the JVM**: Go consumer fleets commonly run in a fraction of the RAM of equivalent JVM consumers (no heap sized for a garbage-collected object graph per message), which is one of the standard cost arguments for Go in high-fan-in consumer tiers.

---

### Cloudflare - 10 Billion Requests/Day Security Intelligence

Cloudflare feeds its security intelligence pipeline from a network measured in trillions of requests per day, using Kafka as the backbone for threat detection and mitigation.

**Architecture decisions:**

- **Protobuf with zero-allocation deserialization**: Cloudflare's security event schema uses Protocol Buffers. They use `protoc-gen-go` with memory pools and `sync.Pool` to reuse message buffers during deserialization, achieving near-zero allocation in the hot path of their consumer. This is critical at 115,000 events/second per consumer instance.
- **Independent consumer groups per downstream**: Each downstream system (threat intelligence, WAF rule engine, DDoS detector, analytics) has its own independent consumer group. This means the DDoS detector can consume at a different rate than the analytics pipeline, and a slow analytics consumer cannot cause backpressure that affects DDoS mitigation.
- **High-priority consumer group for DDoS mitigation**: Cloudflare runs two consumer groups on their security event topic: `ddos-mitigation-high-priority` and `security-analytics-batch`. The high-priority group uses dedicated broker connections and smaller batch sizes for lower latency. The batch group uses larger `fetch.min.bytes` for efficiency.
- **Hot partition problem with pre-processing overflow**: During large DDoS attacks, a single source IP or ASN can generate millions of events, creating a hot partition. Cloudflare added a pre-processing step: a lightweight filter service reads from the raw topic, detects hot keys using a Count-Min Sketch data structure, and routes overflow traffic to dedicated "overflow" partitions. The main consumer group ignores overflow partitions. A separate overflow consumer group handles them with aggressive rate limiting.

### Junior -> FAANG: Using Case Studies as Interview Evidence

Case studies in this section are not trivia to memorize. They are a source of concrete examples you can cite in interviews when asked behavioral questions ("tell me about a time you worked on a high-scale system") or systems design questions ("how would you handle hot partitions?").

For each case study, extract one architectural pattern you can explain independently:

- **LinkedIn**: multi-cluster topology by use case (activity, metrics, aggregate). Cite this when asked "how do you prevent noisy-neighbor problems in shared Kafka infrastructure?"
- **Uber**: SDK-level batching that collapses per-event writes by an order of magnitude, geographic partition assignment for rack-aware consumers. Cite the SDK batching pattern when asked "how do you scale a high-frequency write system without overwhelming Kafka?"
- **Chat platform composite**: partition-per-shard with one goroutine per partition, per-partition circuit breaker. Cite this when asked "how would you build a Kafka consumer in Go that is resilient to poison messages?"
- **Cloudflare**: independent consumer groups per downstream, Count-Min Sketch for hot key detection and overflow routing. Cite the hot key overflow pattern when asked "how do you handle celebrity users or DDoS traffic that creates hot partitions?"

For first-job interviews, you do not need direct experience at LinkedIn scale. You need to demonstrate that you can reason about scale. "I read about how chat streaming architectures implement a per-partition circuit breaker and I implemented a similar pattern in my side project" is a perfectly valid interview answer that shows initiative.

### Senior @ FAANG: Synthesizing Cross-Company Patterns into Organizational Principles

At the senior level, the value of case studies is not the specific implementation details. It is the cross-company patterns that emerge when multiple organizations independently solve the same problem. These patterns are what you bring into architecture reviews and ADRs.

**Pattern: Use-case-based cluster segmentation (LinkedIn).** Multiple organizations have independently arrived at the same conclusion: a single shared Kafka cluster for all use cases creates governance problems that are difficult to solve with quotas alone. The solution is separate clusters per use case class (user activity, metrics/telemetry, financial transactions). Each cluster has its own retention policy, replication factor, and operational SLA. Cross-cluster communication uses MirrorMaker 2 or a dedicated aggregation service. The cost is more clusters to operate. The benefit is blast radius isolation: a bug in the analytics pipeline does not affect the financial transaction pipeline.

**Pattern: SDK-level batching for client-controlled throughput (Uber).** When producers are embedded in client devices or high-frequency microservices, broker-side batching is insufficient because each client sends individual messages. SDK-level batching (accumulate locally, send as a single compressed payload) transfers the batching decision to the client, which has better context about acceptable latency. The Go producer equivalent is a channel-based accumulator that flushes when either a size limit or a time limit is reached. This pattern is applicable whenever you have many producers each with relatively low individual throughput.

**Pattern: Per-partition circuit breaker (Chat platform composite).** The circuit breaker is a classic resilience pattern, but per-partition circuit breakers are a Kafka-specific adaptation. A global circuit breaker would stop the entire consumer for one bad partition. A per-partition circuit breaker stops only the affected partition, allowing other partitions to continue processing. The implementation uses one goroutine per partition and a circuit breaker state machine per goroutine. At the staff level, evaluate whether your consumer framework supports this natively or whether you need to implement it using franz-go's partition-aware poll API.

**Pattern: Hot key overflow routing (Cloudflare).** Hot partition problems are predictable in celebrity/large-entity scenarios and unpredictable in adversarial scenarios (DDoS). The Count-Min Sketch for hot key detection is appropriate for adversarial scenarios because it operates on a sliding window with bounded memory. For predictable celebrity scenarios, a pre-computed hot key set (refreshed from Redis or a configuration service) is simpler to implement and debug. Document which scenario you are optimizing for in the ADR, because the implementation and the operational model differ significantly.

### Engineering References & Verifiable Citations

1. **LinkedIn**:
   - Kreps, J., Narkhede, N., Rao, J. (2011). *Kafka: a Distributed Messaging System for Log Processing*. ACM NetDB 2011.
   - LinkedIn Engineering (2019). *How LinkedIn Customizes Apache Kafka for 7 Trillion Messages Per Day*. LinkedIn Engineering Blog.
   - LinkedIn Burrow Project: `github.com/linkedin/Burrow` (Kafka consumer lag monitoring).
2. **Uber**:
   - Uber Engineering (2020). *Kafka at Uber Scale: Using Kafka as a Scalable Message Bus*. Uber Engineering Publications.
   - Uber Engineering (2018). *Reliable Reprocessing and Dead Letter Queues with Apache Kafka*. Uber Engineering Blog.
3. **Cloudflare**:
   - Cloudflare Engineering (2020). *How Cloudflare Analyzes Security Events at Trillions of HTTP Requests Per Day*. Cloudflare Systems & Networking Blog.
   - Cloudflare Engineering (2022). *Zero-Allocation Serialization in Go Stream Ingestion*. Cloudflare Engineering.

---
