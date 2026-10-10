## Interview Questions

**Q1: How does NATS JetStream differ from NATS core? When do you need JetStream?**

NATS core is a pure pub/sub system: at-most-once delivery with no persistence. When a message is published and no subscriber is connected, the message is gone. JetStream adds a durable, replicated log layer on top of NATS. Messages are stored in streams before delivery, enabling at-least-once (and exactly-once with deduplication) semantics. You need JetStream whenever message loss is unacceptable: payment events, audit logs, order processing, or any workflow where a subscriber restart should not cause data loss. NATS core remains appropriate for telemetry, heartbeats, and RPC where occasional loss is acceptable and sub-millisecond latency matters more than durability.

*What FAANG expects:* Candidates should pick the layer per-workload, not per-system. Strong answers split the same NATS cluster across both: JetStream for state-carrying events, core pub/sub for health pings and RPC, because running two messaging systems for two delivery profiles is an anti-pattern when one cluster does both.

Follow-ups:
- How does JetStream storage (file vs memory) interact with the `Replicas` setting during a full cluster restart?
- A NATS core subscriber misses 5 minutes of messages during a deploy. Walk me through the minimal change to never miss again without rewriting publishers.
- If JetStream's disk fills up, what does the publisher see, and what knob (`Discard`, `MaxBytes`) controls that behavior?

**Q2: Explain NATS subject hierarchy and wildcards. How do queue groups work?**

NATS subjects use dot-separated tokens: `orders.us.created`. Two wildcards apply: `*` matches exactly one token (`orders.*.created` matches `orders.us.created` but not `orders.us.east.created`), and `>` matches one or more tokens at the end (`orders.>` matches everything under `orders`). Queue groups implement load balancing: multiple subscribers can subscribe to the same subject with the same queue group name (second argument to `QueueSubscribe`). NATS routes each message to exactly one subscriber within the group, chosen round-robin. Subscribers in different queue groups each receive every message. This means queue groups give you horizontal scaling within a service, while separate queue groups give you fan-out to different services.

*What FAANG expects:* Senior candidates design subject hierarchies that encode the authorization boundary (account/tenant/region) in the prefix so account permissions, leaf-node routing, and mirroring policies compose naturally. Flat subject namespaces that put the tenant ID deep in the path are a red flag.

Follow-ups:
- You want `orders.us.>` replicated to a leaf node in us-east-1 but not `orders.eu.>`. How do you express that?
- A subscriber joins a queue group mid-stream. Does it receive the backlog? Why or why not?
- Compare queue groups to Kafka consumer groups, where is rebalancing handled, and what are the consistency implications?

**Q3: What are the delivery policies in JetStream consumers?**

`DeliverAllPolicy` starts from the first retained message in the stream, use this when a new consumer needs full history. `DeliverNewPolicy` starts from messages arriving after the consumer was created, use for live processing where history is irrelevant. `DeliverByStartSequencePolicy` begins at a specific message sequence, use for deterministic replay from a known checkpoint. `DeliverByStartTimePolicy` begins at messages newer than a timestamp, use after redeployment to skip already-processed time windows. `DeliverLastPolicy` delivers only the single most recent message, use for cache warming or "latest state" patterns. `DeliverLastPerSubjectPolicy` delivers the most recent message per unique subject, essential for filtered consumers where each subject represents a distinct entity (e.g., one message per device ID).

*What FAANG expects:* Candidates should tie delivery policy to the consumer's recovery story. Strong answers call out that a durable consumer records its own position once created, so the deliver policy only matters at first bind, changing it after the fact requires deletion and recreation.

Follow-ups:
- Which policy pairs naturally with the NATS KV store's "current value per key" semantics?
- You redeploy a service and want to skip the 30 minutes of events buffered while it was down. Which policy and why is that usually a bug disguised as a feature?
- How would you implement exactly-once reprocessing from a known sequence after discovering a bug in yesterday's handler?

**Q4: How do Redis Streams consumer groups work? What problem do they solve?**

Consumer groups allow multiple independent consumers to read from the same stream, with each consumer seeing a distinct subset of messages. When XREADGROUP is called with `">"`, Redis assigns undelivered messages to that consumer's Pending Entry List (PEL) and marks them as delivered. Other consumers in the same group will not receive those messages. XACK removes a message from the PEL. This solves two problems simultaneously: load balancing (multiple workers in the same group share the stream, scaling processing horizontally) and fan-out (multiple groups on the same stream each receive all messages independently, allowing billing, shipping, and notifications to each process every order event without one blocking another).

*What FAANG expects:* Strong candidates note that the PEL is Redis's delivery state, meaning consumer group state is durable with Redis AOF but tied to a single Redis shard, scaling beyond one shard means partitioning streams by key and coordinating PEL semantics per partition.

Follow-ups:
- Walk through the exact sequence of XREADGROUP -> process -> XACK. What invariant breaks if you swap the order?
- How does Redis Cluster shard a stream? What key tag strategy keeps a tenant's events on one node?
- A consumer's PEL grows unbounded. What are the three most likely root causes in priority order?

**Q5: Explain XPENDING and XCLAIM. Why are they important for reliability?**

XPENDING exposes the Pending Entry List: messages delivered to a consumer but not yet acknowledged. `XPENDING stream group - + 100` returns message IDs, their owning consumer, idle time (milliseconds since last delivery), and delivery count. This is how you detect stuck messages, if idle time exceeds your processing SLA, the owning consumer likely crashed. XCLAIM transfers ownership of a message from a crashed consumer to a live one, and the message is re-delivered to the claiming consumer. XAUTOCLAIM (Redis 6.2+) combines the scan and claim into a single atomic operation. Without these mechanisms, a consumer crash leaves its messages in the PEL permanently, no one processes them, no error surfaces, and your system silently develops an ever-growing processing backlog.

*What FAANG expects:* The answer must include a dead-letter path. FAANG teams do not XCLAIM forever, once delivery count crosses a threshold the message goes to a dedicated DLQ stream for human review. Candidates who say "XAUTOCLAIM solves reliability" without mentioning DLQ fail this question.

Follow-ups:
- Your idle threshold is 30 seconds but a long GC pause is 45 seconds. What happens and how do you distinguish a stuck consumer from a slow one?
- Two replicas both XCLAIM the same message at the same instant, who wins and why?
- Compare XAUTOCLAIM to Kafka's `heartbeat.interval.ms` / `session.timeout.ms` approach. Which handles split-brain better?

**Q6: Compare NATS JetStream and Redis Streams for a real-time chat application.**

Both are viable, but with different tradeoffs. NATS JetStream naturally models chat rooms as subjects (`chat.room.abc123.messages`) with JetStream streams per room and per-user consumers. The request/reply pattern handles read receipts elegantly. JetStream KV stores room metadata and user presence. However, NATS is additional infrastructure if you are not already running it. Redis Streams are ideal if Redis is already your session store and cache. Rooms map to stream keys, consumer groups model read-state per user. XRANGE with time-based IDs enables efficient message history queries. The operational simplicity of using one system (Redis) for both caching and messaging often outweighs JetStream's cleaner messaging semantics for teams at moderate chat scale (under 100K concurrent rooms).

*What FAANG expects:* Candidates should ask the scale and retention questions first: how many concurrent rooms, how long is history retained, are deletes required for GDPR? The right answer at 1K rooms is different from 10M rooms, and "it depends" with the right follow-up questions beats any confident single answer.

Follow-ups:
- At 10M rooms, one stream per room blows up both systems. How do you shard?
- How do you implement "mark all as read up to message X" in each system? Which is O(1) and which is O(n)?
- GDPR requires hard deletion of a user's messages. What primitives do you use in JetStream vs Redis Streams?

**Q7: How would you implement exactly-once processing with JetStream?**

Exactly-once in JetStream requires two components: publisher-side deduplication and consumer-side idempotency. On the publisher side, set a `Nats-Msg-Id` header with a deterministic ID derived from the business event (e.g., a database transaction ID or UUID). The stream's `Duplicates` window (e.g., 5 minutes) causes JetStream to silently drop any message with a previously seen ID within that window. On the consumer side, implement idempotency at the processing layer: before processing, check a deduplication store (Redis SET with the message ID, SETNX pattern) and skip if already processed. The combination of publisher deduplication (prevents stream duplication) and consumer idempotency (handles the AckWait window where a message might be redelivered before the ack reaches the server) achieves exactly-once semantics in practice.

*What FAANG expects:* The phrase "exactly-once" is a trap, FAANG interviewers want to hear "effectively-once" and an explicit acknowledgment that the guarantee is a protocol between publisher, broker, and consumer. Extra credit: tie the business event ID to an idempotency key the upstream caller already provides (e.g., Stripe's `Idempotency-Key` header) so the whole request-to-event path is idempotent end-to-end.

Follow-ups:
- Your dedup window is 5 minutes but a replay happens 10 minutes later. Is the duplicate caught? Where does the protection live now?
- Contrast JetStream's dedup with Kafka's idempotent producer (`enable.idempotence=true`). What failure modes differ?
- Consumer-side idempotency usually means a database check. How do you avoid that becoming the bottleneck?

**Q8: What is the NATS KV store and how is it implemented internally?**

NATS KV is a key-value store API layered directly on JetStream streams. Each KV bucket maps to a stream with a naming convention `$KV.<bucket-name>` and subjects `$KV.<bucket-name>.>`. A `Put(key, value)` call is a `js.Publish` to `$KV.<bucket>.<key>`. A `Get(key)` performs a `GetMsg` on the stream (a server-side point lookup by subject). `Watch(key)` creates a push consumer on the stream filtered to `$KV.<bucket>.<key>`, delivering initial value and all subsequent updates. `Delete(key)` publishes a message with the `KV-Operation: DEL` header, creating a tombstone. History per key (multiple revisions) is controlled by the stream's `MaxMsgsPerSubject` setting. This architecture means KV inherits all JetStream properties: persistence, replication, and eventual consistency across a cluster.

*What FAANG expects:* Strong answers recognize NATS KV is a feature-light etcd competitor for config and service discovery, not a general-purpose database. Candidates should name the trade-off: KV gives you Raft-replicated config with a trivial client API, but lacks transactions across keys, secondary indexes, or range queries, so it loses to CockroachDB/Spanner the moment your schema grows.

Follow-ups:
- How would you implement compare-and-swap (optimistic concurrency) using the underlying JetStream sequence?
- KV `Watch` on millions of keys from a single client, what fails first and how would you shard?
- Compare to etcd's watch semantics, specifically around compaction and missed events.

**Q9: When would you choose Redis Streams over Kafka?**

Choose Redis Streams over Kafka when: (1) you already operate Redis and adding Kafka would be a net-new infrastructure component. (2) your throughput is under 500K msg/sec, Redis Streams handles this comfortably with a single-node Redis or Redis Cluster. (3) your retention requirements are short (hours to days rather than weeks). (4) you want co-location of your event log with your cache or session store, eliminating an additional network hop. (5) your team's operational expertise is in Redis rather than Kafka. Kafka's advantages become decisive at >1M msg/sec, with requirements for weeks of retention, multi-datacenter replication via MirrorMaker, complex stream processing with Kafka Streams, or large ecosystem integrations (Debezium, Kafka Connect, Confluent Schema Registry).

*What FAANG expects:* The right framing is total cost of ownership, not throughput benchmarks. A team of 4 running Redis for cache already pays Redis's ops cost. Adding Kafka is a net-new headcount problem. FAANG answers think about on-call burden and integration surface, not just msg/sec.

Follow-ups:
- You hit 500K msg/sec on Redis Streams, what are the three knobs you tune before declaring "time to migrate to Kafka"?
- How does Kafka's tiered storage (KIP-405) change the "long retention" argument in 2026?
- A team picks Redis Streams because "Redis is already there," six months later they need exactly-once and Schema Registry. What does that migration look like?

**Q10: How does JetStream handle stream replication for high availability?**

JetStream uses the Raft consensus algorithm for stream replication. When a stream is configured with `Replicas: 3`, one server becomes the stream leader (elected via Raft leader election), and the other two are followers. All writes go to the leader, which replicates to followers before acknowledging the publisher. A `PubAck` is only sent after a quorum (2 of 3) confirms the write. If the leader fails, Raft elects a new leader from the followers within seconds. Consumers track their position in the stream via Raft-replicated state, so a consumer can resume from any server in the cluster. This means JetStream can lose `floor(replicas/2)` servers without losing data or availability, with 3 replicas, one server failure is tolerated. With 5 replicas, two failures are tolerated.

*What FAANG expects:* Candidates should know the asymmetry, each stream runs its own independent Raft group, not a cluster-wide Raft. Thousands of 3-replica streams on the same 3 servers means thousands of Raft groups running in parallel. This is why placement and `Placement` tag constraints matter at scale, and why meta-cluster Raft (for account/stream metadata) is separate from per-stream Raft.

Follow-ups:
- A 3-node cluster spans two AZs (2+1). Does a full AZ outage lose availability? Why?
- Walk through a stream write when the leader loses network to one follower. Where does the latency spike show up?
- Compare to Kafka's ISR, what does each model get wrong that the other gets right?

**Q11: Explain the difference between push and pull consumers in JetStream.**

Push consumers: the JetStream server actively delivers messages to a configured `DeliverSubject`. The consumer receives messages as fast as the server can send them. This is low latency and simple but requires the consumer to keep up, a slow consumer can cause the server to buffer messages (controlled by `MaxAckPending`). Best for real-time, low-latency processing where throughput is predictable. Pull consumers: the consumer calls `Fetch(n)` to explicitly request a batch of messages. The server responds with up to `n` messages. This gives the consumer full control over its processing rate, it only requests more work when ready. Best for batch processing, work queues, and rate-limited external API calls. Pull consumers scale naturally: multiple goroutines or instances can all call `Fetch` on the same durable pull consumer, and JetStream distributes messages across them automatically.

*What FAANG expects:* Candidates should know that the modern `jetstream` sub-package (stable in nats.go v1.31) treats pull as the default and push as legacy. The old reflex of "push is for real-time, pull is for batch" is dated, `Consume()` on a pull consumer streams messages with push-like latency and pull-like back-pressure.

Follow-ups:
- You have 3 replicas of a worker process, all should share load on a single pull consumer. What consumer config enables that and what breaks if you miss it?
- A push consumer's `DeliverSubject` is oversubscribed (slow consumer). What happens to the stream and to other consumers on the same stream?
- Under what conditions would you still choose a push consumer in 2026?

**Q12: How do you handle Redis Streams MAXLEN trimming without losing unprocessed messages?**

The key insight is that MAXLEN trims from the head (oldest messages), but the consumer group's `last-delivered-id` may still reference those trimmed messages. This creates a race condition: a consumer group that falls behind can reference messages that have already been trimmed. Mitigation: size MAXLEN based on your worst-case consumer lag. If your slowest consumer can fall 1 hour behind before alerting, set MAXLEN to `entries_per_second * 3600 * safety_factor`. Monitor consumer lag (distance between the stream's latest ID and each group's `last-delivered-id`) via XINFO GROUPS. Alert before consumers approach the trim boundary. For critical consumers that cannot miss messages, archive trimmed entries to a separate slower store (S3, Postgres) using a dedicated archival consumer group that runs ahead of all other consumers.

*What FAANG expects:* Senior candidates introduce MINID trimming (Redis 6.2+) as a safer alternative to MAXLEN when combined with a "watermark" of the oldest unacked ID across all groups. That pattern turns a probabilistic size cap into a correctness guarantee at the cost of unbounded growth if a consumer is truly stuck, trading silent data loss for loud lag alerts.

Follow-ups:
- Pseudocode the "lag watermark" pattern for MINID trimming across N consumer groups.
- Approximate vs exact trimming (`MAXLEN ~` vs `MAXLEN =`), what performance difference, and when would you ever pick exact?
- A consumer group is abandoned (nobody owns it) and holds the trim boundary. Detection and cleanup, go.

**Q13: What happens when a Redis Streams consumer crashes mid-processing?**

When a consumer reads messages via XREADGROUP, those messages are added to its Pending Entry List (PEL) immediately, before processing begins. If the consumer crashes between XREADGROUP and XACK, the messages remain in the PEL with that consumer's name. Redis does not automatically redeliver them. The messages are "stuck" until: (a) the same consumer restarts and reads from ID `"0"` instead of `">"` to reprocess its own PEL, or (b) another consumer claims them via XCLAIM or XAUTOCLAIM based on idle time exceeding a threshold. This is why the recovery pattern in the `ProcessLoop` implementation from §52H.6 first drains the consumer's own PEL (reading with ID `"0"`) before consuming new messages. Without this recovery step, a crashed consumer leaves its last batch permanently unprocessed.

*What FAANG expects:* The pitfall FAANG probes for is stable consumer names. If your consumer name is a pod UUID, each restart creates a new consumer and the old consumer's PEL is orphaned. Strong answers pin consumer names to stable identity (StatefulSet ordinal, deployment-slot hash) and pair that with XAUTOCLAIM for pods that never come back.

Follow-ups:
- A pod restarts 3 times per hour with ephemeral names, what does XINFO CONSUMERS show after a day, and why is it a problem?
- XCLAIM with `JUSTID` option vs claiming with the payload, when and why?
- You need sub-second failover instead of the typical 30-second idle threshold. What changes?

**Q14: How would you implement a priority queue using NATS JetStream?**

JetStream does not natively support priority. The recommended pattern is separate streams per priority level: `JOBS-HIGH`, `JOBS-MEDIUM`, `JOBS-LOW`. Workers are implemented as pull consumers that check the high-priority stream first. If `Fetch` on JOBS-HIGH returns messages, process them. Only if JOBS-HIGH returns empty (timeout) does the worker fall through to JOBS-MEDIUM, then JOBS-LOW. A typical ratio: workers check high-priority every cycle, medium every 3 cycles, and low every 10 cycles. For finer control, use multiple worker pools with different ratios. The trade-off vs Kafka (which also lacks native priority) or RabbitMQ (which has native priority queues up to 255 levels) is that this pattern requires application-level coordination and careful worker scheduling to prevent low-priority starvation.

*What FAANG expects:* Senior candidates push back on the premise. "Priority queue" usually means "I have SLA classes," and the better design is per-class throughput budgets enforced at the worker pool level, not strict-priority fetching that starves low-class work during traffic spikes. FAANG rewards questioning the requirement over implementing it.

Follow-ups:
- Your high-priority stream has constant traffic and low-priority jobs never run. What is the failure mode name, and how do you fix it without moving to RabbitMQ?
- Implement a weighted-fair-queuing variant using three pull consumers and one worker pool.
- When would you legitimately pick RabbitMQ's native priority queues over this pattern?

**Q15: Compare the operational complexity of NATS vs Redis Streams vs Kafka.**

NATS: single binary, embeds JetStream, minimal configuration. A 3-node JetStream cluster requires 3 server configs with routes defined. No ZooKeeper, no schema registry, no separate tooling. Ops complexity: low. Redis Streams: built into Redis. If you already run Redis, there is zero additional infrastructure, you are adding a data structure, not a system. Redis Cluster for stream sharding requires some topology planning, but Redis Cluster is well-understood. Ops complexity: very low (if Redis exists) to low (if adding Redis). Kafka: ZooKeeper dependency (until KRaft mode in Kafka 3.x), broker configuration, topic partition management, consumer lag monitoring via `kafka-consumer-groups.sh`, Schema Registry for Avro/Protobuf, Kafka Connect for integrations, Kafka Streams or ksqlDB for processing. Kafka requires dedicated ops expertise. Ops complexity: high. For teams starting greenfield with moderate scale, JetStream or Redis Streams delivers 80% of Kafka's capability at 20% of the operational burden.

*What FAANG expects:* Interviewers want to hear about day-2 ops: upgrades, disk pressure, partition skew, and rolling restart semantics, not install-day complexity. A strong answer also notes Kafka in 2026 is KRaft-default (ZooKeeper is deprecated), which shrinks the ops gap versus JetStream significantly compared to the pre-2023 picture.

Follow-ups:
- You inherit a 30-broker Kafka cluster and a 3-node NATS cluster. Which one do you migrate to KRaft / upgrade first and why?
- Redis Streams "free because Redis is already there", but it shares CPU with your cache. How do you prevent stream load from evicting hot cache keys?
- Rank the three systems on "time to first byte" for a new engineer on-call at 3 AM.

### Junior -> FAANG: Interview Preparation Strategy for Messaging Questions

FAANG messaging interviews follow a predictable pattern. The interviewer starts with a conceptual question (Q1, Q2 above), then narrows to a failure scenario (Q5, Q13), then asks you to compare systems (Q6, Q9, Q15). Prepare for each layer separately.

For conceptual questions: memorize the delivery guarantees, the key commands, and one concrete use case for each system. Do not memorize numbers from benchmark tables. Interviewers know those numbers change and are testing whether you understand the principles behind them.

For failure scenarios: practice narrating a failure sequence step by step. "Consumer crashes between XREADGROUP and XACK. The message is in the PEL. The consumer restarts. If it reads with '>' it gets new messages only and the PEL entry is orphaned. If it reads with '0' it recovers the PEL entry and reprocesses. Without XAUTOCLAIM, a different consumer never gets the message. With XAUTOCLAIM running every 30 seconds and an idle threshold of 2 minutes, the message is reclaimed after 2 minutes." That level of step-by-step precision is what FAANG interviewers are looking for.

For comparison questions: always start by asking clarifying questions. "Before I compare, can I ask about your current infrastructure? Do you already run Redis or NATS?" The interviewer will either give you context or confirm that the choice is genuinely open. Either way, asking the question signals system-design maturity.

### Senior @ FAANG: Bar-Raiser Signals in Messaging System Design

FAANG bar-raisers evaluate messaging questions on a different axis than the panel. The panel checks technical correctness. The bar-raiser checks whether the candidate's thinking would scale to a team of 50 engineers and 500 services.

The signals a bar-raiser looks for in messaging questions:

First, platform thinking over service thinking. Does the candidate design a solution for this service, or do they design a reusable pattern that serves multiple teams? A candidate who says "I would add XAUTOCLAIM to the consumer loop" is solving the problem. A candidate who says "I would add XAUTOCLAIM to the platform's consumer library so no team has to implement it individually" is thinking at L6/L7.

Second, governance instinct. Does the candidate mention ADRs, approved technology lists, or migration strategies unprompted? A candidate who jumps directly to "use JetStream" without mentioning whether the organization already operates NATS is missing the organizational context that determines whether the technical choice is actually correct.

Third, failure mode completeness. Does the candidate enumerate failure modes beyond the happy path? The questions in this section have explicit "what FAANG expects" notes that call out the failure modes interviewers probe for. The pattern is consistent: every guarantee has a failure window, and the correct answer includes what happens in that window and how it is mitigated.

Fourth, explicit trade-off articulation. Does the candidate say "I would use X because..." with a concrete "because," or do they say "X is better"? Bar-raisers push back on unqualified claims. Candidates who say "Redis Streams is simpler" without qualifying "simpler than what, for which team, under which operational constraints" are not yet reasoning at the level required for senior promotion.

---
