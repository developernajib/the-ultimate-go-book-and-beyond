# Chapter 64: Design Message Queue

*A queue is just a promise, a promise that no work will be lost, and that every message will eventually be processed.*

Message queues are the connective tissue of distributed systems. They decouple producers from consumers, absorb traffic spikes by buffering work, enable parallelism through partitioned consumption, and provide a durable audit trail of every event that passed through a system. When a service goes down, messages waiting in the queue survive. When it comes back up, it picks up exactly where it left off. This simple guarantee - durability under failure - is what transforms a fragile chain of synchronous service calls into a resilient, independently deployable architecture.

The engineering depth required to build a production-grade message queue is substantial. At-least-once delivery requires durable write-ahead logs with fsync guarantees, making the disk I/O model a critical performance constraint. Consumer groups require a partition-assignment protocol - similar to Kafka's group coordinator - that must handle rebalancing when consumers join or leave without dropping or duplicating messages. Ordering guarantees interact with partitioning in subtle ways: total ordering across all partitions is prohibitively expensive, but per-partition ordering is achievable and sufficient for most use cases. Dead-letter queues and poison-pill handling require policies that distinguish between transient failures (network timeouts worth retrying) and permanent failures (malformed messages worth parking). Backpressure mechanisms must propagate from overwhelmed consumers back to producers before memory buffers overflow.

In Go, the message queue implementation maps beautifully onto the language's idioms. Producers write to buffered channels. A persistence goroutine drains the channel to a write-ahead log. Consumer goroutines read from the log with independent offsets tracked per consumer group. Partition assignment uses a consistent-hash ring, and the coordinator runs as a separate goroutine monitoring heartbeats. This chapter builds each layer from first principles in Go, explaining the design decisions that distinguish Kafka from RabbitMQ from SQS, so you understand not just how to implement a queue but why the major systems were designed the way they were.

**What you'll learn in this chapter:**

- Implementing a write-ahead log (WAL) in Go for durable message persistence with configurable fsync policies
- Designing consumer groups with partition assignment, offset tracking, and rebalancing protocols
- Understanding and implementing at-least-once, at-most-once, and exactly-once delivery semantics and their cost trade-offs
- Building per-partition ordering guarantees while enabling parallel consumption across partitions
- Implementing dead-letter queues and configurable retry policies with exponential backoff for consumer failures
- Designing backpressure mechanisms that propagate from consumers to producers to prevent unbounded memory growth
- Handling consumer lag monitoring and alerting to detect slow consumers before they cause partition offset overflow
- Comparing architectural trade-offs between log-based queues (Kafka-style) and broker-based queues (RabbitMQ-style)

**Why this matters at scale:**

LinkedIn built Kafka in 2011 because their existing ActiveMQ deployment could not sustain the write throughput required for activity stream processing across hundreds of millions of users - Kafka's log-based design, inspired by database commit logs, now handles over 7 trillion messages per day at LinkedIn alone. Uber's Cherami and later uReplicator were engineering investments in message queue infrastructure designed to handle their specific workload: extremely high-throughput, geographically distributed, with strict per-trip ordering requirements that generic brokers could not satisfy efficiently. Shopify's engineering team published a detailed post-mortem on a Black Friday incident where consumer group rebalancing storms caused message processing delays of over 20 minutes - a lesson in why rebalancing protocols must be designed for large consumer group sizes from the start.

**Prerequisites:** Chapters 1-63. Solid understanding of Go goroutines and channels. Familiarity with file I/O and `os.File` operations in Go.

---

### Junior -> FAANG: Understanding Why Message Queues Exist

Before you can design a queue, you must understand the problem it solves. A synchronous service call couples two services in time: if the downstream service is slow or down, the upstream caller blocks or fails. A message queue breaks that coupling. The producer writes to the queue and moves on. The consumer reads when it is ready.

The three guarantees to memorize early are: at-most-once (message may be lost, never duplicated), at-least-once (message may be duplicated, never lost), and exactly-once (requires coordination, carries cost). At a FAANG interview, "exactly-once across distributed services" is almost always the wrong answer unless the interviewer explicitly asks for it. Start with at-least-once plus idempotent consumers.

The most common first-job mistake is treating a message queue as a remote procedure call with a delay. It is not. There is no guarantee about when the message will be processed, no built-in timeout, and no return value. Design your producer to not care when or whether the consumer has processed the message, and design your consumer to handle duplicate delivery gracefully.

Entry-point interview framing: when an interviewer asks "how would you decouple a notification service from your user registration flow?", the answer starts with a message queue. The producer (registration service) publishes a `user.registered` event. The consumer (notification service) sends the welcome email. If the notification service is down, registrations still succeed and emails are sent when the service recovers.

### Senior @ FAANG: Governing Message Queue Infrastructure as a Platform

At the L6/L7 level, the decision is not which queue to use but how to govern queue usage across dozens of teams and hundreds of topics. Without governance, teams create topics with no retention policy, no consumer group naming convention, no schema enforcement, and no lag alerting. The result is a Kafka cluster where no one can tell which topics are still in use, which consumers are healthy, or which messages are safe to delete.

The architecture decision record (ADR) for a platform team introducing a shared message queue should address: schema registry policy (Avro with compatibility rules vs JSON with no enforcement), topic naming conventions (team.domain.entity.event vs freeform), default retention (7 days vs infinite vs tiered), lag alert thresholds and ownership (who gets paged when consumer lag exceeds 1M messages), and partition count guidelines (start with 8, scale by measuring consumer throughput per partition before adding more).

Maturity model for message queue adoption: Level 1 is ad hoc topics created by individual teams with no observability. Level 2 is standardized topic naming and a lag dashboard. Level 3 is schema registry enforcement with backward compatibility checks in CI. Level 4 is cost attribution by topic and consumer group, with automatic alerts when a consumer has been lagging for more than 24 hours. Level 5 is self-service topic provisioning with policy guardrails, automated DLQ creation, and capacity forecasting.

Bar-raiser interview signal: candidates who can explain why they would choose a log-based queue (Kafka) over a broker-based queue (RabbitMQ) for a specific workload, and articulate the trade-off in terms of consumer replay, throughput, and routing flexibility, demonstrate the depth expected at senior level. Candidates who say "use Kafka for everything" without qualification do not. The correct framing: log-based queues are better for high-throughput event streams where replay and consumer-group independence matter. broker-based queues are better for task queues where per-message routing, priority, and push delivery matter.

Staff-level concern: at 10,000 messages per second, a single Kafka cluster is fine. At 10 million messages per second across 50 topics, you are managing partition leader distribution, inter-broker replication lag, and the cost of cross-AZ replication traffic. The platform team owns the answer to "how do we safely increase partition count on a live topic?" (the answer involves coordinated consumer group rebalancing and a migration window) and "which topics are candidates for tiered storage to reduce disk cost?" (the answer requires per-topic throughput and retention analysis).
