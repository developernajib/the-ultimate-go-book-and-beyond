## Summary

This chapter built a message queue from binary message encoding through to consumer group rebalancing:

- **Write-ahead log**: Append-only segment files with binary index files give O(log n) message lookup by offset and crash recovery by replaying unacknowledged segments
- **Partitioned topics**: Partition count determines maximum consumer parallelism. Key-based hashing routes related messages to the same partition for per-key ordering without cross-partition coordination
- **Consumer groups**: Three assignment strategies (range, round-robin, sticky) trade off between simplicity and rebalance stability. sticky assignment minimizes partition movement during membership changes, reducing the rebuild cost for consumers with local state
- **Delivery semantics**: At-most-once commits offsets before processing (fast, loses messages on crash). At-least-once commits after processing (requires idempotent handlers). Exactly-once requires transactional offset commits coordinated with the processing output
- **Producer batching**: Accumulating messages to a size or time threshold before sending reduces network round trips, increasing throughput from thousands to millions of messages per second
- **Dead-letter queues**: Messages that fail processing after a configured retry count are moved to a DLQ with their failure metadata, preventing poison pills from blocking partition progress

The key architectural insight: a log-based queue (Kafka-style) and a broker-based queue (RabbitMQ-style) make fundamentally different trade-offs. Log-based queues provide replay, high throughput, and consumer-side pull semantics. broker-based queues provide flexible routing, push delivery, and per-message acknowledgment. Choosing the right model depends on whether your workload is stream processing (log) or task distribution (broker).

### Junior -> FAANG: What to Internalize Before Your Next Interview

Three things to be able to say precisely in a message queue design interview.

First: the relationship between partition count, consumer parallelism, and key-based ordering. Partition count sets the ceiling on consumers per group. Key-based hashing routes related messages to the same partition for ordering. These two facts together mean that your choice of partition key and partition count must be made simultaneously, not independently.

Second: the delivery semantic trade-off. At-most-once is for metrics and analytics where loss is acceptable. At-least-once is for most production use cases, combined with idempotent consumers. Exactly-once within a Kafka pipeline is achievable with transactions. Exactly-once to external systems requires application-level idempotency regardless of what Kafka promises.

Third: the DLQ contract. A DLQ is not a trash can. It is a bounded waiting area for messages that require human or automated intervention. Every DLQ needs: an alert on depth growth, a replay tool, and a policy for how long messages are retained before they are archived or discarded.

### Senior @ FAANG: Governing Message Queue Infrastructure at Scale

The chapter's implementation details become governance questions at senior level.

WAL fsync policy becomes a cluster-wide default that the platform team sets and that individual teams override only with documented justification. The default for financial data is sync-per-write. The default for analytics is sync-per-interval. Misapplying the analytics default to a financial workload is a data-loss incident that gets discovered in an audit, not in production.

Consumer group naming conventions become a discoverability and ownership problem. A cluster with 500 consumer groups named `consumer-1` through `consumer-500` is ungovernable. The platform team defines a convention (`team.service.topic.env`) and enforces it via admission control in the provisioning API. Groups that do not match the pattern are rejected at creation time, not flagged in a post-hoc audit.

The log-based vs broker-based choice becomes a platform standardization decision. Most organizations standardize on one primary queue system (Kafka for streaming, SQS for simple task queues, or RabbitMQ for complex routing) and treat others as exceptions that require architectural review. Standardization reduces operational complexity. Every on-call engineer knows how to debug one queue system, not three.
