## Summary

Apache Kafka is the dominant event streaming platform for distributed systems at scale. Its core architecture advantages, sequential disk I/O that rivals in-memory systems, zero-copy network transfers that eliminate CPU overhead, pull-based consumption that handles backpressure naturally, and horizontal scaling through partitioning, combine to sustain millions of events per second with durability guarantees that transient message queues cannot match.

For Go engineers, the ecosystem has matured significantly. `kafka-go` by Segment offers an idiomatic Go API with straightforward reader/writer abstractions suitable for most production workloads. `franz-go` offers lower-level access with more complete Kafka protocol support, better performance at extreme throughput, and advanced features like sticky partitioning - the right choice when squeezing maximum performance from Go consumers. Neither library has a Kafka Streams equivalent, so Go engineers build stateful processing manually using goroutines, channels, and external state stores like Redis or PostgreSQL.

Five production patterns distinguish experienced Kafka operators from beginners: (1) **exactly-once semantics via transactional outbox** - understanding that Kafka's native transactions cover only the broker layer and that true end-to-end exactly-once requires idempotency at the database layer. (2) **cooperative rebalancing and static membership** - eliminating stop-the-world pauses that cause SLA breaches during rolling deploys. (3) **consumer lag as a first-class operational signal** - treating growing lag as an early warning system rather than discovering issues from user complaints. (4) **schema evolution with compatibility guarantees** - using Schema Registry or buf.build to prevent incompatible changes from breaking consumers silently. And (5) **the Dead Letter Queue pattern** - providing a systematic path for poison messages that would otherwise block partition processing indefinitely.

Operational excellence with Kafka requires monitoring consumer lag per partition, partition leader distribution, ISR count, producer retry rates, and commit latency. The migration from ZooKeeper to KRaft mode removes a significant operational burden and unlocks sub-second controller failover. For multi-datacenter deployments, MirrorMaker 2 provides reliable active-passive replication with offset synchronization for zero-data-loss failover.

Kafka is not always the right choice. For request-reply patterns, use gRPC or NATS. For priority queues, use RabbitMQ or Asynq. For small-scale pub/sub under 10K msg/sec, Redis Streams or NATS provides lower operational overhead. The right tool depends on your throughput requirements, retention needs, consumer group semantics, and operational capacity.

---

**Key takeaways:**

- **Kafka is a distributed commit log, not a message queue**, its value comes from replayability, long retention, and independent consumer groups, not just async delivery.
- **Exactly-once end-to-end requires idempotency at every layer.** Kafka's transactional API covers the broker. Your database needs `ON CONFLICT DO NOTHING` and your consumer needs the transactional outbox/inbox pattern.
- **Partitioning is the primary scalability lever**, partition count bounds consumer parallelism. Partition key choice determines data distribution. hot partitions require careful key design.
- **Cooperative sticky rebalancing and static membership are required at scale**, eager rebalancing causes stop-the-world pauses that violate SLAs during rolling deploys.
- **Consumer lag is the most important operational metric**, a growing lag indicates a capacity, correctness, or dependency problem before any user-visible impact. Instrument it with Prometheus and build autoscaling around it with KEDA.

### Junior -> FAANG: Building a Personal Kafka Mastery Checklist from the Summary

The summary bullet points are not just a review. They are a self-assessment framework. For each bullet point, ask: "Can I explain this from first principles, write code that demonstrates it, and describe a failure mode it prevents?"

**"Kafka is a distributed commit log, not a message queue."** Can you explain to a non-Kafka engineer why this distinction means you can replay events from 3 days ago, add a new consumer group, and not affect the existing consumer group? If yes, check this box.

**"Exactly-once end-to-end requires idempotency at every layer."** Can you draw the boundaries: Kafka transactions handle the broker layer, transactional outbox handles the database layer, idempotent consumer handles the external API layer? If yes, check this box.

**"Partitioning is the primary scalability lever."** Can you derive the partition count for a 500 MB/s topic assuming 20 MB/s per partition throughput? (Answer: 25 partitions minimum.) Can you explain why adding partitions after topic creation breaks key-hash ordering? If yes, check this box.

**"Cooperative sticky rebalancing and static membership are required at scale."** Can you explain the difference between eager and cooperative rebalancing with a concrete example of what breaks during a rolling deploy with each strategy? If yes, check this box.

**"Consumer lag is the most important operational metric."** Can you write a Prometheus alert rule that fires when consumer lag grows by more than 10,000 in 5 minutes? If yes, check this box.

Any box you cannot check is a targeted study area. Return to the corresponding section and run the code, not just read it.

### Senior @ FAANG: What the Summary Omits and Why it Matters

A good summary captures the chapter. A senior engineer notices what the summary does not capture, because those omissions are where production surprises come from.

**The summary does not address Kafka as an organizational coordination system.** Every bullet point describes a technical property. At the staff level, Kafka's impact is as much organizational as technical: it allows teams to decouple, to evolve independently, and to build without coordinating every schema change or throughput spike through a central team. This organizational benefit is the reason Kafka is worth its operational cost. When writing an ADR proposing Kafka adoption, lead with the organizational decoupling argument before the technical throughput argument.

**The summary does not address when to remove Kafka.** The chapter teaches you when to use Kafka. It does not teach you when to migrate away from it. At the staff level, you will encounter systems where Kafka was adopted prematurely (100 messages per day), where the operational cost has grown beyond its value, and where a simpler alternative would reduce toil without sacrificing correctness. The summary should implicitly prompt the question: "does this system still justify Kafka's operational overhead?" Review this question annually for each Kafka-dependent system.

**The summary does not address the human cost of Kafka expertise.** Operating Kafka requires on-call engineers who understand ISR mechanics, partition reassignment, broker sizing, and consumer group debugging. Building and maintaining this expertise has a real organizational cost. At the platform level, the decision to adopt Kafka is also a decision to hire and retain engineers who can operate it. A summary that omits this cost understates the true total cost of the technology.

**The summary bullet point on EOS contains a subtle scope limitation.** "Kafka's transactional API covers the broker. Your database needs ON CONFLICT DO NOTHING" is correct but compressed. The full statement is: Kafka transactions are atomic within the Kafka log. The moment a consumer writes to any external system (database, cache, HTTP endpoint, file system), that write is outside the transaction scope. Every external write must be independently idempotent. In a system with five downstream sinks, each sink requires its own idempotency mechanism. The summary makes this sound simpler than it is in practice.
