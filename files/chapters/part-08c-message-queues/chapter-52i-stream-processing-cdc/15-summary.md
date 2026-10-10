## Summary

Stream processing and CDC are complementary: stream processing transforms events as they flow, while CDC captures data changes at the source. Together, they let systems react to changes as they happen rather than working from stale snapshots.

**Go's position in stream processing**: Go excels at stateless and lightly stateful stream processing - high-throughput event routing, transformation, and aggregation with small state. For complex stateful analytics requiring durable state persistence across restarts and exactly-once guarantees, Apache Flink remains the industry standard. A common pattern: Go services for preprocessing and routing, Flink for complex analytics.

**CDC as a foundation**: Real-time search indexes, cache invalidation, analytics, event sourcing, and microservice data sync all require reliable change propagation. Debezium + Kafka is the production standard, and the Go consumer patterns in this chapter apply to any CDC event stream.

**The outbox pattern for reliable events**: Any service that writes to a database and must publish events reliably needs the outbox pattern. Direct dual-writes are eventually inconsistent under failure. The outbox pattern with CDC-based relay provides transactional guarantees at the cost of added complexity.

**Key takeaways for FAANG interviews**:
1. Log-based CDC is the only approach that captures deletes, maintains ordering, and has no DB load impact
2. The outbox pattern solves dual-write atomicity - always use it for business-critical events
3. Watermarks are the mechanism for declaring stream windows complete - understand allowed lateness trade-offs
4. Idempotent sinks (upserts) are the foundation of exactly-once processing in CDC pipelines
5. Replication slot monitoring is the #1 operational concern for Debezium - unmonitored slots fill disks

### Junior -> FAANG: Consolidating This Chapter Into Interview-Ready Knowledge

The five key takeaways at the end of this summary are the minimum viable vocabulary for a FAANG interview on CDC and stream processing. But knowing them as bullet points is not enough. You need to be able to use them fluently in a conversation, connecting them to each other and to concrete examples.

The first takeaway (log-based CDC) answers the question "how would you sync a database to Elasticsearch in real time?" The correct answer starts with log-based CDC, explains why (captures deletes, ordered, no database load), and names Debezium as the standard tool.

The second takeaway (outbox pattern) answers the question "how do you ensure events are reliably published when your database write succeeds?" The correct answer is the outbox pattern, with an explicit acknowledgment that it gives at-least-once, not exactly-once, and that consumers must be idempotent.

The third takeaway (watermarks) answers the question "how do you handle late data in a stream processing pipeline?" The correct answer defines the watermark as an estimate of stream completeness, explains the allowed-lateness parameter, and names the three handling options for truly-late events: drop, side-output, or window extension.

The fourth takeaway (idempotent sinks) answers the question "how do you achieve exactly-once processing with Kafka?" The correct answer: you don't achieve it with a flag. You achieve it by designing idempotent sinks and committing Kafka offsets only after the sink write succeeds.

The fifth takeaway (replication slot monitoring) is the operational knowledge that separates candidates with theoretical CDC knowledge from those who have worked with it in production. Knowing that unmonitored slots fill disks, knowing the PostgreSQL query to check slot lag, and knowing the alert threshold (1 GB warn, 5 GB page) is the production-readiness signal interviewers look for at L4-L5.

### Senior @ FAANG: CDC and Stream Processing as Platform Infrastructure

The summary's framing ("CDC as a foundation for real-time architectures") understates the senior-level concern. At FAANG, CDC and stream processing are not foundations for individual features. They are platform capabilities that enable an entire organization's real-time data needs.

**The platform evolution arc.** Most organizations start with individual teams building bespoke CDC consumers. This phase works until the number of teams is large enough that the aggregate operational burden (each team managing its own connector, slot monitoring, and schema evolution) exceeds the benefit. The signal for platform-level intervention is when the same incident (slot accumulation, schema mismatch, consumer lag during deployment) recurs across multiple teams within a quarter. At that point, the senior engineering investment is in shared tooling: a managed Debezium fleet, a shared schema registry with enforced compatibility, a standard consumer framework with built-in slot lag monitoring and idempotent sink wrappers.

**The ADR catalog for this chapter.** A senior engineer who has internalized this chapter can write the following ADRs without research: (a) why we use log-based CDC rather than polling for all new data sync requirements, (b) why we use the polling outbox relay rather than the CDC relay for services with sub-second latency tolerance, (c) why we use `REPLICA IDENTITY FULL` on tables where consumer audit logs require full before-state, (d) why we use `source.lsn` as the dedup key rather than `topic:partition:offset` for non-idempotent sinks, (e) why we use Go for stateless CDC transforms and Flink for stateful aggregations. These decisions have multi-year consequences and should be documented explicitly so that future engineers can understand the reasoning and challenge it with new information.

**The staff-level question: what is the CDC platform's SLO?** At L7 and above, the question is not how to build a CDC pipeline. It is how to define and enforce an SLO for the CDC platform across the organization. The SLO has two components: availability (what percentage of database changes are successfully delivered to downstream consumers within the latency target?) and correctness (what percentage of downstream consumers are operating with data that diverges from the source by more than the allowed threshold?). Defining these SLOs, instrumenting for them at the platform level, and holding individual team pipelines accountable to them is the staff engineer's role in a CDC platform. Most organizations measure the former and not the latter, because availability is easier to instrument than correctness. A staff-level contribution is building the correctness measurement infrastructure: row count reconciliation jobs, checksum sampling, and divergence alerting that covers the full consumer fleet rather than individual pipelines.
