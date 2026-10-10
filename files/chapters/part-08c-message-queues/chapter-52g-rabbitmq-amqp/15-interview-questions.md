## Interview Questions

**Q1: How does AMQP differ from Kafka's protocol? When would you choose RabbitMQ over Kafka?**

AMQP 0-9-1 is a **command/response** protocol with rich broker-side routing logic - the broker decides where messages go based on exchange type and bindings. Kafka's protocol is a **log-centric append/read** protocol where consumers are responsible for offset tracking and the broker is a dumb log store.

Choose RabbitMQ when: (1) you need complex routing (topic/headers exchanges) without application-layer routing logic, (2) message TTL and per-message expiry matter, (3) you need low-latency point-to-point delivery (<10ms), (4) your team needs simpler ops at moderate scale (<100K msg/s), (5) you need priority queues. Choose Kafka when: you need long-term message retention and replay, throughput >100K msg/s per partition, event sourcing, or real-time analytics with consumer group rebalancing.

**What FAANG expects:** Don't memorize a dogma ("Kafka for everything"). Expect decision-tree reasoning with named tradeoffs, and be able to note that in RabbitMQ 4.x, **Streams** close the append-log gap while quorum queues handle work-queue semantics, so the choice is now within RabbitMQ as often as between it and Kafka.

*Follow-ups:* (a) How would RabbitMQ Streams change your "use Kafka" answer? (b) What if you needed both semantics in one system, how would you route? (c) Name one scenario where neither is correct (hint: request/response RPC).

**Q2: Explain the difference between direct, topic, fanout, and headers exchanges with use cases.**

- **Direct**: Routes to queues where binding key == routing key. Exact match. Use case: task distribution where each task type has a dedicated worker queue (e.g., `billing`, `shipping`).
- **Topic**: Routing key is dot-separated words. `*` matches one word, `#` matches zero-or-more. Use case: log routing (`logs.error.payment` → error handler AND payment monitor).
- **Fanout**: Ignores routing key entirely, and copies message to all bound queues. Use case: cache invalidation broadcast, real-time notifications to multiple downstream systems.
- **Headers**: Routes based on message header key-value pairs. `x-match: all` requires all headers to match, `x-match: any` requires at least one. Use case: routing by multiple attributes simultaneously (region + priority + tenant).

**What FAANG expects:** A strong answer picks **topic** as the default ("most versatile, covers 90% of cases") and justifies why headers is a smell (opaque routing, harder to reason about in ops). Bonus: mention that exchange-to-exchange bindings enable composition without the app knowing.

*Follow-ups:* (a) Why is fanout faster than topic despite both broadcasting? (b) How would you route `payments.eu.high` to both a region-specific queue AND a priority queue atomically? (c) When is headers exchange actually the right choice?

**Q3: What are quorum queues and why are they preferred over classic mirrored queues?**

Quorum queues implement replication using the **Raft consensus algorithm**. A write is confirmed only when a quorum (majority) of replicas acknowledge it. This provides:
1. **No split-brain**: Raft elects a single leader, and minority partitions stop accepting writes rather than diverging.
2. **Strong durability**: Even if the leader crashes immediately after confirming a write, a quorum of followers has the data.
3. **Faster leader election**: Raft elects a new leader within seconds vs. classic mirrors which required manual intervention or complex sync states.

Classic mirrored queues used a custom gossip-based protocol with known issues: unsynchronized mirrors could lose messages during failover, and the sync process (blocking the queue) caused production outages. **They were removed entirely in RabbitMQ 4.0**, existing `ha-mode` policies are silently ignored on 4.x, so queues become single-node classic queues with no replication. You must migrate before upgrading.

**What FAANG expects:** Candidates who can name **Khepri** (the Raft-based metadata store replacing Mnesia in 4.x) and explain why Raft end-to-end (Khepri + QQ + Streams) is the architectural reason RabbitMQ 4.x is dramatically easier to operate during partitions than 3.x.

*Follow-ups:* (a) Walk through the CMQ→QQ migration plan for a running production cluster with zero data loss. (b) What's the performance cost of Raft replication vs a single-node classic queue? (c) When would you still choose a classic (non-replicated) queue?

**Q4: How do publisher confirms work? What's the difference between ack and nack?**

After calling `ch.Confirm(false)`, the broker assigns a monotonically increasing sequence number (`DeliveryTag`) to each published message. After durably writing the message, the broker sends a **Confirmation** frame back on the same channel.

- **Ack** (`confirm.Ack == true`): Broker has accepted and durably stored the message. If the queue has consumers, it has been enqueued.
- **Nack** (`confirm.Ack == false`): Broker could **not** accept the message. Causes: internal error, queue overflow with `x-overflow: reject-publish`, or broker resource alarm. The message was **not** stored.

Production pattern: track pending messages by `DeliveryTag` in a map. On nack, retry with backoff. On mandatory+unroutable, handle via `NotifyReturn`.

**What FAANG expects:** Candidates should describe **asynchronous** confirms (`NotifyPublish`) over synchronous per-message waits (kills throughput), explain the in-flight bookkeeping map keyed by delivery tag, and flag the "publisher crash before confirm" window as a real at-least-once gap that requires an outbox pattern for exactly-once-to-broker semantics.

*Follow-ups:* (a) What happens to in-flight unconfirmed messages if the TCP connection drops? (b) How do you bound the in-flight map's memory? (c) Why is `channel.Confirm(false)` per-channel rather than per-connection?

**Q5: Explain the RabbitMQ prefetch mechanism. How do you choose the right value?**

`basic.qos(prefetchCount, prefetchSize, global)` tells the broker: "do not push more than `prefetchCount` unacknowledged messages to this consumer." When the consumer's unacked count hits the limit, the broker stops delivering until acks arrive.

Choosing the value:
- `prefetch=1`: Safest. Fair dispatch. Only one message in-flight. Use when processing time is highly variable (you don't want slow messages starving new fast ones). Throughput = 1/avg_processing_time.
- `prefetch=10-50`: Good balance. Allows the consumer to pipeline processing. Use when processing time is relatively uniform.
- `prefetch=0` (unlimited): Never use in production. Broker floods the consumer, risking OOM.
- Formula: `prefetch ≈ (throughput_target × avg_processing_time) + safety_margin`.

Test empirically: run consumer at various prefetch values, measure throughput and latency, find the knee of the curve.

**What FAANG expects:** Know the **per-consumer vs per-channel (global)** distinction, in amqp091-go, `Qos(count, size, global=false)` is per-consumer, `global=true` is per-channel. State the mental model: prefetch is the "credit window" that bounds worst-case consumer memory (`prefetch × avg_msg_size`) and tail latency under imbalance.

*Follow-ups:* (a) Consumer A is 10x faster than consumer B on the same queue, what prefetch do you set and why? (b) How does prefetch interact with priority queues? (c) Why is `prefetch=0` sometimes correct for streams but never for quorum queues?

**Q6: How would you implement exponential backoff retry in RabbitMQ without a separate retry library?**

Use the **TTL + DLX chain** pattern (fully implemented in §52G.6):
1. Worker queue has `x-dead-letter-exchange: retry.dlx`.
2. On failure, `Nack(false, false)` → message goes to `retry.dlx`.
3. `retry.dlx` routes to one of several TTL queues: `retry.5s` (TTL=5000ms), `retry.30s` (TTL=30000ms), `retry.5m` (TTL=300000ms).
4. Each TTL queue has `x-dead-letter-exchange: ""` (default exchange) and `x-dead-letter-routing-key: worker.queue` → after TTL, message returns to worker queue.
5. Track `x-retry-count` in message headers. After max retries, route to permanent DLQ.

No plugins required. Delay precision is ±1 second (RabbitMQ checks TTL approximately every second).

**What FAANG expects:** Candidates should mention the **head-of-line blocking** gotcha: per-message TTL only expires from the head of the queue, so a long-TTL message ahead of a short-TTL one blocks expiry. The fix is **per-queue TTL tiers** (one queue per delay bucket). Bonus: reference the `rabbitmq_delayed_message_exchange` plugin as an alternative with pros/cons (precision vs plugin dependency).

*Follow-ups:* (a) After max retries, where does the message go and who alerts? (b) How do you prevent retry storms on downstream outages? (c) Compare with the delayed-message plugin, pros and cons of each.

**Q7: What happens when RabbitMQ runs out of memory? How do you prevent memory alarms?**

When memory usage exceeds the `vm_memory_high_watermark` (default: 40% of RAM), RabbitMQ triggers a **memory alarm** and **blocks all producers** by pausing their TCP connection read loop. Producers hang in `PublishWithContext`. This is a global block - all vhosts and connections are affected.

Recovery happens only when memory drops below the watermark (consumers drain queues).

Prevention:
1. Set `x-max-length` on all queues to prevent unbounded growth.
2. Set `x-message-ttl` to expire old messages.
3. Use lazy queues (store to disk rather than RAM) for high-depth queues.
4. Monitor `mem_used_ratio` and alert at 70% before the alarm triggers.
5. Scale consumers proactively based on queue depth alerts.
6. Tune `vm_memory_high_watermark` based on available RAM and expected load.

**What FAANG expects:** Know that the alarm **blocks publishers, not consumers** (so drain path still works), and that `x-overflow: reject-publish` turns this from "hung producers" into "explicit nacks the app can handle." Senior answer: design for bounded queues from day one, an unbounded queue is a latent outage.

*Follow-ups:* (a) Why does RabbitMQ block producers instead of spilling to disk? (b) Tradeoffs of `reject-publish` vs `drop-head` overflow behavior. (c) How does a disk alarm differ from a memory alarm in effect?

**Q8: How does RabbitMQ handle network partitions in a cluster?**

RabbitMQ uses Erlang's distributed system for cluster communication. When a network partition occurs, nodes on each side can no longer communicate.

Three partition handling modes:
- `pause_minority`: Nodes on the minority side of the partition pause (stop serving traffic). Ensures no split-brain but reduces availability. **Recommended for financial/critical data.**
- `autoheal`: After partition heals, cluster decides which partition "won" and resets the loser(s). Losers lose any writes made during the partition. Suitable when availability > consistency.
- `ignore`: Both sides continue operating, potentially diverging. Dangerous - can lead to duplicate messages and inconsistent queue states. Only safe for truly stateless scenarios.

With quorum queues, partition handling is handled by Raft: the leader can only operate with a quorum of nodes active, so minority partitions automatically stop accepting writes.

**What FAANG expects:** Connect the dots: in 4.x, Khepri + QQ + Streams are all Raft, so `pause_minority` becomes the correct choice nearly universally, the legacy "pick a mode per workload" debate is mostly a 3.x artifact. Mention that odd-number clusters (3, 5) are required for quorum. Even clusters deadlock on partition.

*Follow-ups:* (a) Why are 2-node clusters especially dangerous? (b) What's the behavior of a 3-node cluster after losing 2 nodes? (c) How do you recover if the majority is permanently lost (disaster recovery)?

**Q9: Compare RabbitMQ's message routing with Kafka's partition-based routing.**

RabbitMQ routing: **broker-side, dynamic, content-aware**. The broker evaluates exchange type + routing key (or headers) against bindings at publish time. Routing topology can change without restarting producers or consumers. Consumers express interest through queue bindings.

Kafka routing: **producer-side, static, key-hash-based**. Producer decides which partition to write to (round-robin or `hash(key) % partitions`). Consumer groups get assigned partitions by the coordinator. Routing is purely positional - no content-based routing without application-layer logic.

Practical difference: in RabbitMQ, adding a new consumer type (e.g., a new analytics system) requires only creating a new queue and binding, zero producer changes. In Kafka, you create a new consumer group reading the same topic, but the producer has always been writing to the right topic (assuming you planned for it). For retroactive filtering/routing, you need a stream processing layer.

**What FAANG expects:** Frame the tradeoff as **routing flexibility vs ordering guarantees**: Kafka's partition-key model gives you per-key ordering for free but forces routing decisions upstream. RabbitMQ's binding model gives you runtime routing but single-queue ordering only (within a competing-consumer set, ordering is lost).

*Follow-ups:* (a) How do you get per-key ordering in RabbitMQ? (hint: consistent-hash exchange plugin) (b) Can you add a new Kafka consumer without producer awareness? (c) Which model scales better with 1000 consumer types?

**Q10: What is the difference between persistent messages and durable queues?**

These are orthogonal settings that are often confused:
- **Durable queue** (`durable=true`): The queue definition (name, arguments, bindings) is written to disk and survives a broker restart. **Messages in the queue may not survive restart** if they are not persistent.
- **Persistent message** (`delivery_mode=2`): The message body is written to disk. If the broker restarts, persistent messages in durable queues are restored. Persistent messages in non-durable queues are lost (queue is gone).

**Rule**: For production reliability, use `durable=true` queues AND `delivery_mode=Persistent` messages. One without the other provides false safety.

**What FAANG expects:** Add the third axis: **publisher confirms**. Durable + persistent + confirms is the only combination that gives at-least-once delivery from publisher to disk. Without confirms, a broker crash between accepting the message and fsyncing it loses it silently.

*Follow-ups:* (a) What does the broker actually do when it receives a persistent message? (write-ahead log? synchronous fsync?) (b) In quorum queues, is `delivery_mode` still meaningful? (c) What's the perf cost of persistent vs transient?

**Q11: How would you implement priority queues in RabbitMQ?**

Declare the queue with `x-max-priority` argument (integer 1-255. Values >10 waste memory with minimal benefit):

```go
ch.QueueDeclare("jobs", true, false, false, false, amqp.Table{
    "x-max-priority": int32(10),
})
```

Publish with a priority value in `amqp.Publishing{Priority: uint8(9)}`.

RabbitMQ delivers higher-priority messages first **when multiple messages are ready simultaneously**. This is not strict priority preemption - a message already being consumed is not interrupted. If the queue is empty and a low-priority message is being consumed, a new high-priority message waits for the consumer to ack before the next delivery.

Important caveats: in RabbitMQ 4.x, quorum queues fully support priorities. In older versions, only classic queues supported them.

**What FAANG expects:** Push back on priority queues as a design smell, they mask capacity problems. Senior answer: a priority queue with 90% low-priority traffic is often a sign you need **separate queues per priority** with dedicated consumer pools, which gives better isolation and observability.

*Follow-ups:* (a) How would you prevent low-priority starvation? (b) Why do high priority values waste memory? (internal heap) (c) When is separate queues per priority a better design than one priority queue?

**Q12: Explain the role of the dead letter exchange in reliable message processing.**

The DLX is a safety net that captures messages that cannot be normally processed. A message is dead-lettered when: (1) rejected/nacked with `requeue=false`, (2) TTL expired, (3) queue max-length exceeded.

Without DLX: dead-lettered messages are **silently dropped**.

With DLX: they are re-published to the configured DLX with routing key equal to either the original routing key or the queue's `x-dead-letter-routing-key` argument. This allows:
- **Retry queues**: TTL-based backoff (§52G.6).
- **Forensic DLQ**: Permanent storage for failed messages for manual inspection and replay.
- **Alerting**: A consumer on the DLQ that fires alerts when messages arrive.

The DLX pattern is how you achieve at-least-once processing with bounded retries in RabbitMQ without any external framework.

**What FAANG expects:** Describe the **"parking lot"** pattern explicitly: after N retries, route to a permanent DLQ that requires human decision (replay, discard, or fix-and-replay). A DLQ with no alerting or replay tooling is worse than no DLQ, it's silent data loss with false confidence.

*Follow-ups:* (a) How do you alert on DLQ arrivals without paging on every transient failure? (b) Design a replay tool for DLQ messages. (c) What headers does RabbitMQ add to dead-lettered messages and how do you use them?

**Q13: How do you handle connection recovery in a production Go service?**

Three-layer recovery is required:

1. **Connection-level**: `conn.NotifyClose` returns a channel that signals when the TCP connection drops. Use an exponential-backoff reconnect loop (§52G.7) that iterates over all cluster node URLs.

2. **Channel-level**: Channels close independently of connections on protocol errors (bad ack, wrong argument types, etc.). Each channel has its own `NotifyClose`. Consumer goroutines detect channel close from the deliveries channel becoming closed (`ok == false`) and re-establish a channel on the existing connection.

3. **Consumer re-registration**: After reconnecting, all consumers must re-call `ch.Consume()`. The broker does not automatically re-send messages to reconnected consumers - the channel/consumer relationship is per-connection.

Key pattern: wrap all stateful operations (connection, channel setup, consume/publish setup) in a function `onConnected(*amqp.Connection) error` and re-call it on every reconnection.

**What FAANG expects:** Senior-track: the client library should **NOT** silently auto-reconnect and hide state loss from the app. `amqp091-go` deliberately doesn't auto-reconnect because reconnection is application-semantic (which consumers to restart? what pending publishes to replay?). Be able to explain this design choice as a feature, not a gap.

*Follow-ups:* (a) How do you handle in-flight publisher confirms across a reconnection? (b) What if a channel closes but the connection stays up, do you need a new connection? (c) How do you avoid "thundering herd" reconnect when a cluster node restarts?

**Q14: What are the tradeoffs between ack-multiple=true and per-message acks?**

`d.Ack(multiple=true)` acknowledges all messages with `DeliveryTag <= d.DeliveryTag`. It reduces network round-trips from N acks to 1 ack per batch.

Tradeoffs:
- **Throughput**: Bulk ack can 2-5x throughput for high-rate consumers.
- **Atomicity risk**: If the consumer processes messages 1-10 and crashes before acking 6-10, messages 1-5 with `Ack(multiple=true, tag=5)` are confirmed, but 6-10 are redelivered. This is acceptable for at-least-once but breaks exactly-once assumptions.
- **Out-of-order acks**: If you're using multiple goroutines processing different messages concurrently, `multiple=true` can inadvertently ack messages that another goroutine hasn't processed yet (if delivery tags are not monotonically tracked).

**Recommendation**: Use `multiple=false` for safety by default. Use `multiple=true` only in single-goroutine consumers where you explicitly track the highest confirmed delivery tag.

**What FAANG expects:** Articulate that `multiple=true` is a **batching optimization** with real duplicate-redelivery risk on crash, and that the right question is "is my handler idempotent?" If yes, batch. If no, per-message. Don't default to batching for perf unless measured.

*Follow-ups:* (a) Sketch the goroutine design for safe `multiple=true` with concurrent workers. (b) Under a crash, how many messages max can be redelivered? (c) How do you detect redelivery in the consumer?

**Q15: How would you design a work queue that handles 100K tasks/day with at-least-once processing guarantees?**

100K/day ≈ 1.15 tasks/second at steady state. This is moderate scale. Design:

1. **Queue setup**: Quorum queue with `x-max-length: 500000`, `x-message-ttl: 86400000` (24h), DLX configured.
2. **Producers**: HTTP API → `ConfirmingPublisher` with async confirms. Each publish awaits broker ack before returning 202 to client.
3. **Consumer pool**: 5-10 workers (goroutines) each with `prefetch=20`. This provides headroom for bursts (100K could arrive in 1 hour = 27/s) with `10 workers × 20 prefetch = 200 in-flight`.
4. **Processing**: Manual ack (`autoAck=false`). Ack only after successful processing AND result stored in DB. This is the at-least-once guarantee.
5. **Retries**: DLX + TTL retry queues with 3 levels (5s, 60s, 10m). After 4 total attempts, route to permanent DLQ.
6. **Idempotency**: At-least-once means duplicate processing is possible. Each task handler must be idempotent (check if task ID already processed in DB before acting).
7. **Monitoring**: Alert on queue depth > 10000 (indicates consumer lag), consumers = 0 (all workers down), DLQ depth > 0 (processing failures need attention).

**What FAANG expects:** The winning answer explicitly names **idempotency as the load-bearing design decision**, not prefetch or worker count. At-least-once without idempotent handlers is just "occasionally duplicates your data." Candidates who skip idempotency fail this question regardless of how well they tune the rest.

*Follow-ups:* (a) Sketch the idempotency table, what's the key, TTL, and cleanup strategy? (b) How would you scale this 10x? 100x? (c) What's your runbook when DLQ depth = 5000 at 3 AM?

### Junior → FAANG: Interview Preparation Strategy for RabbitMQ Questions

The 15 questions in this section are organized roughly from fundamental to advanced. Most junior candidates can answer Q1-Q5 with some study. Answering Q6-Q15 well requires having used RabbitMQ in production or having studied the failure modes in detail.

**The questions that filter out unprepared candidates immediately:**

Q3 (quorum queues vs classic mirrored queues) filters out candidates who learned RabbitMQ before 2020 and have not kept up. Classic mirrored queues were removed. If you say "I'd use ha-mode: all for HA," you fail Q3 at a company running 4.x.

Q10 (durable queue vs persistent message) filters out candidates who learned the API without understanding the semantics. Durable queue + transient message = message lost on broker restart. Non-durable queue + persistent message = queue gone on restart, message gone with it. The only correct production combination is durable + persistent + confirms.

Q6 (exponential backoff without a library) filters out candidates who can describe the goal but not the mechanism. You must be able to name TTL queues, DLX chaining, and per-queue TTL before per-message TTL as the implementation path.

**Worked example for preparing answer structure:**

For each question, practice the following structure out loud: state the answer in one sentence, explain the mechanism in two to three sentences, name the failure mode if the wrong choice is made, state a concrete production example or metric. A candidate who uses this structure for all 15 questions demonstrates both depth and communication clarity, which are both assessed separately at FAANG.

### Senior @ FAANG: Bar-Raiser Evaluation Criteria

Bar-raisers at FAANG are looking for signals that distinguish L5 (senior) from L6 (staff) candidates. The 15 interview questions in this section have answers that are sufficient for L5. The bar-raiser signals that elevate answers to L6 are listed here.

**Q1 bar-raiser signal:**

An L6 answer to the RabbitMQ vs Kafka question does not just list tradeoffs. It describes a system where both are present: RabbitMQ handles the task dispatch layer (flexible routing, per-message ack, low latency) and Kafka handles the event log layer (replay, analytics, audit). The L6 candidate can explain where the boundary between these two layers lies and how events flow across it, including the consistency guarantees at each hop. This is system design at the architectural level, not feature comparison.

**Q7 bar-raiser signal:**

An L6 answer to the memory alarm question describes the `x-overflow: reject-publish` configuration as a design choice with explicit tradeoffs documented in an ADR, not just a configuration option. The candidate describes how reject-publish changes the producer's error handling contract (nacks must be handled, not ignored), how it interacts with publisher confirms, and how the operations team is trained to respond to producer nack alerts. The ability to trace a configuration choice through its downstream effects on producer code, consumer behavior, and operations runbooks is an L6 competency.

**Q13 bar-raiser signal:**

An L6 answer to the connection recovery question explicitly defends the `amqp091-go` design choice to not auto-reconnect. The candidate explains that auto-reconnection hides application-level state loss (pending confirms, consumer registrations, channel-level QoS settings) and that the application must be the authority on which state to rebuild. They describe a reconnect architecture where the connection supervisor passes the new connection to an `onConnected` callback that rebuilds all application state explicitly. They can also describe what happens to in-flight publisher confirms during a reconnect (they are lost, and the outbox pattern is required for exactly-once semantics). This depth of protocol understanding distinguishes L6 from L5.

**Q15 bar-raiser signal:**

An L6 answer to the work queue design question names idempotency as the load-bearing design decision, as the question states. But it goes further: the candidate describes the idempotency table schema (job_id as primary key, processed_at timestamp, result column), explains the cleanup strategy (TTL on the idempotency table row, matching the message TTL on the queue so stale idempotency keys are cleaned up after the same window), and describes the 100x scaling path (shard the queue by a consistent hash of the job type, scale consumer pools per shard, use a Kafka-backed idempotency store instead of a relational database to handle 100M jobs/day). The ability to scale a design from 100K to 100M jobs/day while maintaining the same correctness guarantees is an L6 system design competency.

---
