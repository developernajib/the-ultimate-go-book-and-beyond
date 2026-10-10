## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand event-driven architecture principles** and when to use EDA vs request-response
- **Implement event producers and consumers** with Kafka, RabbitMQ, and NATS
- **Design events and commands** with proper versioning and schema evolution
- **Apply Event Sourcing patterns** to capture all state changes as immutable events
- **Implement CQRS** to separate read and write models for optimal performance
- **Build projections and read models** from event streams
- **Handle exactly-once delivery** with the outbox pattern and idempotent consumers
- **Apply production patterns** for high-throughput event processing, partitioning, and cross-datacenter replication

### Junior → FAANG: Turning Objectives Into a Study Checklist

Learning objectives are most useful when you convert them into concrete test questions you can answer before moving on. For each objective listed above, here is the concrete check.

For "understand when to use EDA vs request-response": can you describe a scenario where EDA would make the system worse, not better? If you cannot, you do not yet understand the tradeoffs.

For "implement event producers and consumers": have you written a consumer that fails halfway through processing and verified that the event is re-delivered and processed correctly? Replay behavior is where understanding solidifies.

For "handle exactly-once delivery with the outbox pattern": can you trace the exact sequence of database writes and Kafka publishes that occur when the outbox relay crashes and restarts? Write out the timeline on paper.

For "apply event sourcing": have you loaded an aggregate from events after the process restarts and confirmed that the reconstructed state matches the state before shutdown? This is the proof that your apply logic is correct.

**Gap awareness for early-career engineers.** These objectives assume familiarity with Go channels and goroutines (chapter 11), SQL transactions (specifically what happens when a transaction rolls back after a partial write), and HTTP service design. If any of those feel uncertain, review them before this chapter because the examples build on all three simultaneously.

**Interview entry point.** When asked about event-driven architecture in a screening interview, demonstrate mastery of the objectives by offering a concrete example from your own work or from the chapter's order service. Concrete specifics ("I implemented the outbox pattern so that the order record and the Kafka event commit atomically in the same Postgres transaction") are far more credible than abstract summaries.

### Senior @ FAANG: Evaluating Objectives Against Staff-Level Expectations

The objectives listed are correct for a mid-level engineer. At L6 and above, the same list implies deeper dimensions.

"Understand EDA principles" at staff level means you can facilitate a cross-team architecture review where three teams have different opinions about whether a given interaction should be synchronous or event-driven, you can articulate the governance implications of each choice (who owns the schema contract, who alerts on consumer lag, what happens when a consumer falls days behind), and you can make a recommendation that accounts for the organizational context, not just the technical merits.

"Implement event producers and consumers" at staff level means you have opinions about which Go client to use and why (not just "I used kafka-go"), you can justify the partition key for a given topic based on ordering requirements and cardinality, and you understand the rebalance behavior differences between range, round-robin, sticky, and cooperative sticky assignment strategies.

"Handle exactly-once delivery" at staff level means you can explain why the outbox pattern is superior to Kafka transactions for services that also write to a database, you know what Debezium CDC draining eliminates (application-level polling latency, missed rows during network partitions, and the need to tune polling intervals), and you can describe the failure mode when the relay falls behind and how to alert on it.

"Apply production patterns for high-throughput processing" at staff level means you have concrete numbers: what throughput can a single partition sustain with your message size and consumer processing time, when does partition count become the bottleneck versus consumer concurrency, and how does cross-datacenter replication (MirrorMaker 2, Cluster Linking) affect consumer group offsets and replay capability.

These are the dimensions a bar-raiser looks for when evaluating whether a candidate is operating at the staff level versus the senior level.

---
