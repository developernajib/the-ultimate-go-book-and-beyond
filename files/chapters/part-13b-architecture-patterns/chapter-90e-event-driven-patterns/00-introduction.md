# Chapter 90E: Event-Driven Architecture Patterns

*The most scalable systems are built from loosely coupled components that communicate through events, not direct calls.*

Synchronous request-response architectures have a well-understood failure mode: when any downstream service is slow or unavailable, the entire call chain stalls. Services accumulate temporal coupling - they must be running at the same time for the system to function. They also develop spatial coupling, where callers must know the address and API contract of every dependency. As the number of services grows, this coupling compounds. Adding a new consumer of an existing event requires modifying the producer. A downstream service degrading under load propagates backpressure upstream. A deployment in service B breaks the availability SLA of service A. Event-driven architecture severs these couplings: producers emit events into a durable broker without knowing or caring who consumes them, consumers process at their own pace with independent scaling, and the broker provides the durability guarantees that allow consumers to fall behind and catch up without data loss.

Go engineers building event-driven systems face a set of challenges that are distinct from general messaging concepts. Kafka consumer groups, partition assignment, and offset management are Go-level implementation details that determine whether your service achieves exactly-once processing or silently drops or duplicates messages. NATS JetStream's push and pull consumer models have different back-pressure characteristics that affect how you handle load spikes. Schema evolution - adding fields to an event without breaking consumers built against the old schema - requires deliberate versioning strategies from day one, not as an afterthought when you first need to evolve a high-volume event type. Poison pill handling, dead-letter queues, and consumer idempotency are not optional enhancements. They are the difference between a system that recovers gracefully from bad data and one that stalls permanently on a single malformed message.

This chapter covers the full stack of production event-driven Go development. It begins with event schema design using the CloudEvents specification and Protobuf versioning, moves through Kafka integration with the `confluent-kafka-go` and `segmentio/kafka-go` libraries, covers NATS JetStream for lower-latency use cases, and addresses the operational concerns (dead-letter queues, consumer lag monitoring, schema registry integration, and exactly-once semantics) that separate toy producers from production event pipelines. Each pattern is illustrated with complete, runnable Go code and annotated with the specific failure modes it prevents.

**What you'll learn in this chapter:**
- Design event schemas using the CloudEvents specification and implement schema versioning strategies that allow producers and consumers to evolve independently
- Implement Kafka producers in Go with proper partitioning, compression, idempotent delivery, and error handling using `segmentio/kafka-go`
- Build reliable Kafka consumers with consumer group management, offset committing strategies, and exactly-once processing semantics
- Apply the Event Notification, Event-Carried State Transfer, and Event Sourcing messaging patterns, selecting the right one for each use case
- Implement dead-letter queues and poison pill handling so that a single bad message never stalls an entire consumer group
- Use NATS JetStream for low-latency, at-least-once messaging with pull consumers and configurable back-pressure
- Instrument event-driven systems with consumer lag metrics, end-to-end latency tracing, and schema compatibility alerts
- Implement the Competing Consumers pattern for horizontal scaling and the Sequential Convoy pattern for ordered per-entity processing

**Why this matters at scale:**

Edge key-value stores like Cloudflare's Workers KV replicate writes to hundreds of locations within seconds through event-driven propagation, a fan-out shape only an event backbone makes practical. Payment platforms push millions of events per day through Kafka-backed pipelines where exactly-once processing is a financial correctness requirement, not just a performance goal. Netflix's Flink-based event processing platform ingests billions of events daily from Go-instrumented services, with dead-letter queues and schema registries as first-class infrastructure that every producing team is required to configure before their event type goes to production.

**Prerequisites:** Chapter 90D (Advanced Architecture Patterns), familiarity with basic concurrency in Go (Chapters 10-13), and exposure to Kafka or any message broker at the conceptual level.

---
