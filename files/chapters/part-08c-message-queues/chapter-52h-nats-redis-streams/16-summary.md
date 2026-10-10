## Summary

NATS JetStream and Redis Streams serve as complementary persistent messaging solutions. NATS core provides ultra-low latency pub/sub and request/reply, while JetStream layers durable, replicated persistence on top with a clean API for streams, pull/push consumers, backoff retry, and the KV store. Redis Streams deliver append-only, consumer-group-based processing co-located with existing Redis infrastructure - ideal when operational simplicity matters more than raw throughput.

**Key takeaways:**

1. **Persistence model**: NATS core is at-most-once (no storage). JetStream is at-least-once with exactly-once via `Nats-Msg-Id` deduplication. Redis Streams are at-least-once via consumer group XACK acknowledgment.

2. **Consumer group semantics**: NATS queue groups provide load balancing within a group (each message → one subscriber). JetStream consumers provide durable cursors into a stream with explicit ack tracking. Redis Streams consumer groups maintain a Pending Entry List requiring explicit XACK - crashes leave messages in PEL until XCLAIM recovery.

3. **Failure recovery**: JetStream - Raft-replicated, survives server failure, consumers auto-resume. Redis Streams - AOF/RDB persistence, but PEL recovery requires XAUTOCLAIM. No automatic rebalancing on consumer crash.

4. **Decision rule**: Use NATS core for RPC and telemetry. JetStream for persistence-with-NATS-simplicity at moderate scale. Redis Streams when Redis is already in your stack. Kafka when you need >1M msg/sec, long retention, or the Kafka ecosystem.

5. **Production checklist**: Always set `MaxDeliver` on JetStream consumers. Always set `MAXLEN` on Redis Streams. Always implement XPENDING/XAUTOCLAIM recovery. Always register NATS reconnection handlers. Always use bounded block timeouts in XREADGROUP loops.

### Junior -> FAANG: Consolidating Your Understanding Before Moving On

Before moving to the next chapter, verify your understanding against the five key takeaways.

For takeaway 1 (persistence model): can you write a single test that demonstrates the difference between NATS core and JetStream delivery under a subscriber restart? The test should publish 10 messages while no subscriber is connected, then start a subscriber and count how many messages it receives. For NATS core, the count is 0. For JetStream with `DeliverAllPolicy`, the count is 10. If you cannot write that test from memory, revisit sections 52H.1 and 52H.2.

For takeaway 3 (failure recovery): the phrase "AOF/RDB persistence" hides a detail that matters in production. AOF with `appendfsync everysec` (the default) can lose up to 1 second of writes on a crash. AOF with `appendfsync always` loses nothing but has roughly 2x the write latency. Know which your Redis deployment uses before relying on Redis Streams for durability.

For takeaway 5 (production checklist): print this list and review it against every Redis Streams and JetStream service you write. Treat items on the list as linting rules, not suggestions. A service that reaches production without all five checked is not production-ready.

### Senior @ FAANG: Chapter Synthesis for Platform and Architecture Discussions

The summary's five takeaways frame the chapter from a service implementation perspective. For a staff engineer, the synthesis question is different: what does this chapter's material imply for how a platform team should build and govern messaging infrastructure?

The takeaways collectively point to three platform-level conclusions. First, the delivery guarantee is a contract between producer, broker, and consumer, not a property of the broker alone. A platform team must provide libraries that implement the correct side of the contract for each role: idempotent producers with dedup keys, consumers with correct error classification and ack/nak semantics, and monitoring that surfaces contract violations (unexpected duplicates, stuck PELs, missed messages). Leaving this contract implementation to individual service teams produces N different implementations with N different failure modes.

Second, the operational checklist in takeaway 5 is a quality gate, not a best practice. Any service that reaches production without completing the checklist should be blocked by the platform's deployment pipeline, not by a code reviewer hoping the engineer remembered. Encoding quality gates in CI checks, admission controllers, or service mesh policies is the platform engineer's answer to recurring operational mistakes.

Third, the decision framework in section 52H.8 is a living document. The Kafka KRaft milestone in 2023 changed the operational complexity comparison. The Valkey fork in 2024 changed the Redis licensing context. Each major ecosystem change is a trigger to revisit the approved technology list and update the decision matrix. A staff engineer who owns messaging infrastructure should schedule a quarterly review of the decision matrix against the current ecosystem state, and produce an updated ADR if the recommendations change.

---
