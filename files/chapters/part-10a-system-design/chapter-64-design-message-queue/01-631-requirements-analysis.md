## 64.1 Requirements Analysis

### Functional Requirements

1. **Producer API**: Publish messages to topics
2. **Consumer API**: Subscribe and consume messages
3. **Consumer Groups**: Multiple consumers sharing work
4. **Message Ordering**: Per-partition ordering guarantees
5. **Retention**: Time-based and size-based retention
6. **Replay**: Ability to replay messages from any offset

### Non-Functional Requirements

1. **High Throughput**: 1M+ messages per second
2. **Low Latency**: < 10ms end-to-end latency
3. **Durability**: No message loss (configurable)
4. **Scalability**: Horizontal scaling
5. **High Availability**: Survive node failures

---

### Junior -> FAANG: Translating Business Needs into Queue Requirements

The hardest part of a system design interview for junior engineers is not the technical implementation, it is extracting the right requirements before drawing any boxes. For a message queue, the questions that matter most are: Who are the producers and consumers? What is the expected message rate at peak? How long must messages be retained if consumers fall behind? Is ordering required, and if so, at what granularity?

Ordering is the trap question. Saying "we need global ordering" will almost always be wrong because it means a single partition and zero parallelism. The correct answer in almost every real scenario is "per-key ordering": all messages for a given user, order, or account must be processed in sequence, but messages for different entities can be processed in parallel. Practice turning a vague requirement ("messages must be in order") into a precise one ("messages for the same `order_id` must be processed in order, and we have approximately 10 million active orders").

Retention is often overlooked by juniors. If your consumer can fall behind by up to 48 hours (due to a deployment or incident) and your retention is set to 24 hours, you will silently lose messages. A safe default is to set retention to 3-5 times the maximum expected consumer lag.

### Senior @ FAANG: Requirements Analysis as an ADR Forcing Function

At senior level, requirements analysis for a message queue is not a one-time exercise before implementation. It is an ongoing governance process that informs every configuration decision. The non-functional requirements listed here (1M messages per second, sub-10ms latency, no message loss) are deliberately in tension with each other. Achieving all three simultaneously requires explicit trade-off documentation.

The ADR should capture: what delivery semantic is required and why (at-least-once is chosen because idempotent consumers are cheaper to build than distributed transactions), what the fsync policy is (sync every write for financial data, every 100ms for analytics), and what the replication factor is (3 for production, 1 for development, with justification for each).

Capacity planning drives partition count, which is the most consequential decision in a Kafka deployment. Work backward from throughput: if a single consumer processes 50K messages per second, and the target throughput is 1M messages per second, you need at least 20 partitions and 20 consumer instances at peak. Add 50% headroom and you get 30 partitions as a starting point. Changing partition count later on a live topic requires a coordinated migration because message ordering within a partition is invalidated when messages are redistributed across new partition boundaries.

L6/L7 signal: the ability to derive partition count, replication factor, and retention policy from a capacity model rather than from intuition or tribal knowledge. Document the assumptions. The throughput per consumer, the acceptable rebalance time, the disk budget per broker. So that future engineers can revisit the decision when those assumptions change.
