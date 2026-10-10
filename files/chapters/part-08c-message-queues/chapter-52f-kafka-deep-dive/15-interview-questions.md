## Interview Questions

**Q1: How does Kafka achieve its high throughput compared to traditional message brokers?**

Kafka's throughput advantage comes from several complementary design decisions working together. First, **sequential I/O**: brokers append messages to log segments on disk sequentially, which on spinning disks is 3-10x faster than random I/O, and on SSDs eliminates seek overhead entirely. Second, **zero-copy transfers**: Kafka uses the OS `sendfile()` syscall (Java `FileChannel.transferTo()`) to transfer data from page cache directly to the network socket without copying through userspace - this alone cuts CPU overhead by 60%+ for read-heavy workloads. Third, **batching**: producers accumulate messages into batches before sending, and `linger.ms` + `batch.size` control the trade-off between latency and throughput. Fourth, **compression**: batch-level LZ4/Snappy/ZSTD compression reduces network I/O while the CPU cost is amortized across the batch. Finally, **pull-based consumption**: consumers pull at their own pace, so brokers never need to track consumer state for flow control - the broker just serves sequential reads, and the OS page cache handles hot data caching automatically.


**What FAANG expects:** Name the four mechanisms (sequential I/O, zero-copy, batching, pull model) in under 30 seconds, then quantify the win for whichever one the interviewer probes. "Zero-copy saves ~60% CPU on reads" beats hand-waving.

*Follow-ups you should expect:*
- Does zero-copy still apply when TLS is enabled? (No. TLS forces userspace encryption, which breaks `sendfile`. Measure before paying the TLS cost.)
- How does tiered storage change the I/O story? (Hot segments stay on local disk with the zero-copy path. Cold segments stream from object storage, costing CPU and latency.)
- Why does RabbitMQ not match this throughput? (Per-message routing, ack tracking, and a push model that requires per-consumer state on the broker.)

---

**Q2: What is the difference between a topic and a partition, and how do you choose the right partition count?**

A **topic** is a logical category or feed name - conceptually similar to a database table. A **partition** is the physical unit of parallelism: an ordered, immutable sequence of records stored as a log segment on a broker's disk. Each topic has 1+ partitions. Partitions enable horizontal scaling: different partitions can live on different brokers, and different consumer instances in a group can read different partitions simultaneously. The number of consumer instances that can actively consume in parallel is bounded by the partition count - 24 partitions means at most 24 active consumers. For partition count, a common formula is: `max(throughput_MB/target_MB_per_partition, num_consumers * 2)`. LinkedIn's rule of thumb: start with 3x your expected peak consumer count. Over-partitioning has costs: more open file handles, longer rebalance times, more memory per broker. Under-partitioning limits your ability to scale consumers. For most production topics, 24-48 partitions is a reasonable starting point. You can increase partitions later but cannot decrease them.


**What FAANG expects:** A formula, not a number. Candidates who blurt "100 partitions" without justifying it fail. Tie the partition count to target throughput per partition (10, 40 MB/s is typical) AND to consumer parallelism.

*Follow-ups you should expect:*
- What happens if you need to add partitions later? (Producers using key-hash routing will remap keys to new partitions, breaking per-key ordering. Pre-size instead.)
- Can a single broker host 100,000 partitions? (Not on ZooKeeper-era Kafka. KRaft in 4.x supports millions cluster-wide, but per-broker is still limited by file handles and controller heartbeat load.)
- How does partition count affect end-to-end latency? (More partitions means smaller batches per partition, which can hurt batching efficiency. Diminishing returns past a few hundred.)

---

**Q3: Explain Kafka's replication mechanism and what happens when a partition leader fails.**

Each partition has one **leader** broker and 0+ **follower** replicas. Producers write to the leader, and followers fetch from the leader and replicate the log sequentially. Kafka maintains an **In-Sync Replicas (ISR)** list: followers that are caught up within `replica.lag.time.max.ms` (default 30s). When a producer sends with `acks=all`, the leader waits for all ISR members to acknowledge before responding. When a leader broker fails, the Kafka controller (in KRaft mode, the active controller. Previously managed by ZooKeeper) detects the failure via missed heartbeats and elects a new leader from the ISR. This election happens within `leader.election.ms` (typically 5-30 seconds). Consumers experience a brief pause while the new leader is elected, then reconnect. If `unclean.leader.election.enable=true`, Kafka may elect an out-of-sync replica as leader to restore availability at the cost of potential data loss - this is almost always `false` in production.


**What FAANG expects:** Correctly state the ISR model, `acks=all` + `min.insync.replicas=2`, and the `unclean.leader.election.enable=false` tradeoff. Bonus: mention KRaft controller election is sub-second vs ZooKeeper's 30s+.

*Follow-ups you should expect:*
- What is the difference between `min.insync.replicas=2` and `replication.factor=3`? (RF is total copies. min ISR is the write quorum. RF=3 with min ISR=2 tolerates one replica being slow or down without blocking writes.)
- What does `unclean.leader.election.enable=true` actually lose? (Any records the failed leader acked that had not replicated, silent data loss. Only enable if availability beats durability, rare.)
- How does KRaft change leader election? (Metadata is a Raft-replicated topic. The active controller has a pre-computed leader map and can publish a new leader in milliseconds.)

---

**Q4: What problems does consumer group rebalancing cause at scale and how do you solve them?**

At scale, the default **eager rebalancing** strategy causes stop-the-world pauses: when any consumer joins, leaves, or crashes, *all* consumers in the group stop processing, revoke all partitions, and wait for the coordinator to reassign. With 100 consumers and complex processing state (e.g., in-memory aggregations), this can mean 10-30 seconds of complete processing stoppage multiple times during a rolling deploy. **Solutions in order of impact**: (1) **Cooperative Sticky rebalancing** (`CooperativeStickyAssignor`): only partitions that must move are revoked, and unaffected partitions continue processing during rebalance - this is the biggest improvement. (2) **Static group membership** (`group.instance.id`): consumers have stable identities, and a restart within `session.timeout.ms` is treated as a temporary disconnect without triggering full rebalance. (3) **Tune `session.timeout.ms`** and `heartbeat.interval.ms` to reduce false-positive failure detection. (4) **Increase `max.poll.interval.ms`** if slow processing causes consumers to miss the poll deadline. (5) **Minimize consumer fleet churn** - use rolling deploys with preStop hooks to gracefully drain.


**What FAANG expects:** Name `CooperativeStickyAssignor` and `group.instance.id` (static membership). Candidates who only say "increase session timeout" show surface-level knowledge. The KIP-848 next-gen consumer group protocol (broker-side assignment, GA in Kafka 4.x) is a bonus.

*Follow-ups you should expect:*
- What is KIP-848 and why does it matter? (Broker-side assignment. Clients no longer participate in assignment computation, eliminating the JoinGroup/SyncGroup round-trips that caused stop-the-world pauses.)
- Why does static membership alone not fix rebalance storms? (It only helps restarts within `session.timeout.ms`. A pod OOM-killed for 60s still triggers rebalance.)
- How do you detect a rebalance-storm incident in production? (Spike in `kafka_consumer_rebalance_total`, correlated lag spike, and fetch rate dropping to zero during the pause window.)

---

**Q5: When do you actually need exactly-once semantics versus at-least-once being sufficient?**

**At-least-once is sufficient** for most use cases: sending notifications (duplicate is minor annoyance), updating analytics counters (idempotent increment), writing logs/audit trails (duplicates are benign or easily deduplicated), and any operation where downstream systems are naturally idempotent. **Exactly-once is required** when: (1) financial transactions - charging a user twice is catastrophic. (2) inventory deductions - overselling physical goods. (3) state machine transitions - transitioning an order from `pending` to `paid` twice corrupts state. (4) external API calls with side effects that cannot be rolled back. The practical implementation of exactly-once end-to-end almost always uses the **transactional outbox pattern** rather than Kafka's native exactly-once transactions, because exactly-once in Kafka only covers the broker layer - if your consumer writes to a database, you need idempotency at the database layer as well. The combination of Kafka idempotent producers + transactional consumers + database `ON CONFLICT DO NOTHING` gives true end-to-end exactly-once.


**What FAANG expects:** The explicit acknowledgment that Kafka EOS is **Kafka-to-Kafka only**, plus the outbox or idempotent-consumer pattern for external sinks. Candidates who claim "Kafka transactions give end-to-end exactly-once with my database" are wrong and should be corrected.

*Follow-ups you should expect:*
- Walk me through the transactional outbox. (Write business row + outbox row in one DB transaction. A Debezium or poll-based relay ships the outbox to Kafka. Consumers dedupe on the outbox event ID.)
- When is Kafka's native transactional API enough? (Consume-transform-produce where input, output, and offsets are all Kafka topics. Kafka Streams runs on this model.)
- What is the cost of EOS? (Roughly 3, 10% throughput hit and extra latency from transaction coordinator round-trips. Measure before enabling globally.)

---

**Q6: What is log compaction, when would you use it, and what are the operational gotchas?**

**Log compaction** is a retention mode where Kafka keeps only the *latest* value for each message key, similar to a key-value store. Instead of deleting entire segments after `retention.ms`, the compaction process scans segments and removes superseded records, keeping the most recent value per key. Use cases: (1) user profile snapshots - consumers that restart can read the latest state without replaying all history. (2) configuration changes - system configuration stored as Kafka records. (3) materialized views rebuilt from a compact topic. **Tombstone records**: to delete a key from a compacted topic, produce a message with that key and a `null` value. Kafka will eventually clean up both the tombstone and all prior records for that key after `delete.retention.ms`. **Operational gotchas**: (1) compaction is not instantaneous - `min.compaction.lag.ms` controls the minimum age before a record is eligible, so stale data may persist longer than expected. (2) log compaction and time-based retention can be combined with `cleanup.policy=compact,delete`. (3) compacted topics can still grow unbounded if keys keep changing (e.g., using timestamp as key defeats compaction). (4) consumers must handle seeing only the latest value per key - there is no guarantee all historical values are visible on a new consumer startup.


**What FAANG expects:** Tombstones, `min.compaction.lag.ms`, and knowing that compacted topics can still grow unbounded with poor key design. Use case must be concrete (config, profiles, materialized state).

*Follow-ups you should expect:*
- What if I need both time-based retention AND compaction? (`cleanup.policy=compact,delete`. Useful for CDC topics where you want latest-per-key but also cap total retention.)
- How do you rebuild a consumer's in-memory state from a compacted topic on startup? (`seek(earliest)`, consume until you reach the high-water mark, then switch to live tailing. This is how Kafka Streams state stores bootstrap.)
- What breaks if your key cardinality is unbounded? (Compaction cannot collapse anything. The topic grows forever. Use a stable key, for example user_id, not event_id.)

---

**Q7: When would you choose Kafka vs Redis Streams vs RabbitMQ?**

| Criteria | Kafka | Redis Streams | RabbitMQ |
|---|---|---|---|
| Throughput | Millions/sec | Hundreds of thousands/sec | Tens of thousands/sec |
| Retention | Days/weeks (disk) | Memory-bound | Until ACK |
| Replay | Yes, by offset | Yes, by ID | No |
| Consumer groups | Yes | Yes | Competing consumers |
| Routing/Priority | No | No | Yes (exchanges) |
| Operational complexity | High | Low | Medium |
| Best for | Event streaming, audit, high throughput | Ephemeral queues, real-time, small scale | Task queues, routing, priority |

**Quick decision**: If you need event replay, audit trails, or >100K msg/sec - Kafka. If you're already using Redis and need basic pub/sub or simple consumer groups at modest scale - Redis Streams. If you need message routing, priority queues, dead-lettering with easy ops - RabbitMQ. If you need request-reply or low-latency pub/sub - NATS.


**What FAANG expects:** Clear decision criteria tied to throughput, retention, and routing needs. Mentioning Pulsar or NATS JetStream as additional contenders is a plus.

*Follow-ups you should expect:*
- When would you pick Pulsar over Kafka? (Tiered storage was native from day one, geo-replication is cleaner, and multi-tenancy is built in. Downside: smaller ecosystem.)
- Is Redis Streams durable? (Persistence depends on Redis config. AOF everysec can lose up to 1s on crash. RDB loses more. Not comparable to Kafka's replicated log.)
- What does RabbitMQ Streams add? (RabbitMQ 3.9+ added a log-based streams type to compete with Kafka for replay. Still not at Kafka's throughput per node.)

---

**Q8: What is KRaft mode and why is it replacing ZooKeeper?**

**KRaft** (Kafka Raft) is Kafka's native consensus protocol that replaces the dependency on Apache ZooKeeper for cluster metadata management. In the ZooKeeper architecture, Kafka relied on an external ZooKeeper ensemble to store broker registrations, topic configurations, partition leadership, and consumer group offsets. This created operational complexity (running two distributed systems), a scalability ceiling (~200K partitions per cluster due to ZooKeeper write bottlenecks), and slower failover (ZooKeeper session timeout + controller election could take 30-60 seconds). **KRaft benefits**: (1) single system to operate. (2) metadata is stored in a Kafka topic (`__cluster_metadata`), making it replicated and queryable like any other topic. (3) controller failover in sub-second vs 30+ seconds. (4) supports millions of partitions per cluster. (5) simplified security model - one set of TLS certificates. KRaft became production-ready in Kafka 3.3 and ZooKeeper mode was deprecated in Kafka 3.5. New deployments should use KRaft exclusively.


**What FAANG expects:** The migration path (3.5/3.6 bridge release, `zookeeper.metadata.migration.enable=true`) and the fact that **Kafka 4.0 removed ZooKeeper entirely** (March 2025). Candidates still saying "KRaft is coming" are behind.

*Follow-ups you should expect:*
- How does the Raft quorum layout differ from a ZK ensemble? (Controllers are Kafka brokers running a Raft replica of `__cluster_metadata`. Typically 3 or 5 dedicated controller nodes in production.)
- Can I run combined mode (controller + broker) in production? (Supported but not recommended. A runaway broker workload can starve the controller. Isolate.)
- What breaks on upgrade from 3.x ZK mode to 4.x? (Nothing if you migrated to KRaft first. Skipping the bridge release is a hard block, the 4.x broker refuses to start against ZK.)

---

**Q9: How do Kafka Streams and Apache Flink compare, and what does Go use instead?**

**Kafka Streams** is a Java library for stream processing that reads from Kafka topics, processes records with stateful operations (windowing, joins, aggregations), and writes back to Kafka. It runs inside your application process - no separate cluster needed. **Apache Flink** is a full distributed stream processing engine with its own cluster, supporting complex event processing, exactly-once stateful processing at massive scale, and both batch and streaming modes. **When to use which**: Kafka Streams for moderate complexity processing within the Kafka ecosystem, Flink for complex stateful processing at petabyte scale or when you need SQL-based stream analytics. **Go's approach**: The Go ecosystem does not have a direct Kafka Streams equivalent. Go engineers typically implement stream processing patterns manually using goroutines and channels: fan-out consumers, per-partition processing goroutines, Redis or PostgreSQL for state storage, and explicit windowing logic. Libraries like `benthos` (now `redpanda-connect`) and `watermill` provide higher-level stream processing primitives for Go. For production-grade stream processing in Go, the pragmatic choice is to use Flink or Kafka Streams for complex processing and write lightweight Go consumers for simpler transformations.


**What FAANG expects:** Honest positioning. Kafka Streams embeds in your JVM app. Flink is a standalone cluster with superior state management at scale. ksqlDB is SQL-over-Kafka-Streams (Confluent-only stack). Go has no first-class equivalent, you either call out to Flink or write manual pipelines with goroutines/channels.

*Follow-ups you should expect:*
- What is RisingWave and why does it matter? (Postgres-wire-compatible streaming database, strong 2026 contender against ksqlDB and Materialize.)
- Why doesn't Go have a Kafka Streams port? (Kafka Streams relies heavily on JVM-specific state stores (RocksDB via JNI), interactive queries, and Java's type system for DSL. A real port is a multi-year effort, nobody has done it.)
- If I need windowed joins in Go, what do I do? (Watermill + a state store, or offload the windowed logic to Flink/RisingWave and have Go do lightweight pre/post processing.)

---

**Q10: What is the Confluent Schema Registry, why is it important, and what is the buf.build alternative?**

The **Confluent Schema Registry** is a standalone service that stores and manages Avro, Protobuf, or JSON Schema schemas for Kafka topics. Producers register schemas and embed a schema ID in message headers, and consumers fetch the schema by ID and deserialize accordingly. This solves the **schema evolution problem** at scale: without a registry, schema changes require coordinating all producers and consumers simultaneously, which is impossible in large organizations. The registry enforces **compatibility rules** (BACKWARD, FORWARD, FULL) so incompatible schema changes are rejected at produce time, preventing consumers from breaking. **buf.build** is an alternative for Protobuf-centric organizations: it provides a hosted schema registry for `.proto` files, schema compatibility checks via the `buf` CLI, generated SDK publishing, and breaking change detection in CI. For Go teams using Protobuf, buf.build integrates naturally: `buf push` publishes schemas, and `buf generate` creates Go code. The buf.build approach is often preferred in Go shops because Protobuf is more Go-idiomatic than Avro, and the buf toolchain provides better developer experience than Confluent's Avro-heavy ecosystem.


**What FAANG expects:** The three registry options, **Confluent, Apicurio (open source, CNCF), Buf (Protobuf-native)**, and the compatibility modes. The wire format detail (magic byte + 4-byte schema ID) is a strong signal.

*Follow-ups you should expect:*
- What is in the first five bytes of a Confluent-formatted message? (Magic byte 0x00, then big-endian uint32 schema ID. The rest is the serialized payload.)
- Why is Apicurio preferred in some shops? (Apache 2.0 licensed, runs standalone without Confluent platform, supports Avro/Protobuf/JSON Schema/OpenAPI/AsyncAPI.)
- How do you enforce schema compatibility in CI? (`buf breaking` for Protobuf, or hit the registry's `/compatibility/subjects/.../versions/latest` endpoint before allowing a merge.)

---

**Q11: Your Kafka consumer is falling behind and lag is growing. What are your options?**

Diagnose first: is the bottleneck in message fetching, deserialization, business logic, or downstream I/O? Use pprof and consumer metrics to identify the hotspot. Options in order of invasiveness:

1. **Optimize the consumer code** - profile and fix slow business logic, use connection pooling for DB writes, batch downstream inserts. Cheapest option, try first.
2. **Increase consumer instances** - add more instances to the consumer group, up to the partition count. Requires enough partitions.
3. **Increase partition count** - more partitions allow more parallelism. Requires re-balancing producers and consumers. Cannot decrease later.
4. **Use parallel processing within a partition** - process messages from a single partition concurrently if ordering is not required, or use a worker pool with per-key ordering (map of channels by key).
5. **Redesign the consumer** - split the topic into multiple topics (e.g., separate high-volume and low-volume event types), or move expensive processing to a downstream async system and have Kafka consumer do only lightweight routing.


**What FAANG expects:** Diagnosis before action. Candidates who jump to "add more consumers" before checking if downstream is the bottleneck fail. Show the order of operations: profile, isolate, then scale.

*Follow-ups you should expect:*
- What if CPU is fine but lag is growing? (Downstream I/O bottleneck, DB writes, external API, or GC pauses. pprof the goroutine and block profiles.)
- How do you scale beyond partition count? (You can't for ordered processing. For unordered, use parallel worker pool within one consumer per partition with explicit offset tracking.)
- What metrics tell you the processing is stuck vs slow? (Stuck: zero `messages_consumed_rate` with nonzero lag. Slow: lag grows linearly at a steady consume rate.)

---

**Q12: What problem do idempotent producers solve, and what are their limitations?**

Without idempotent producers, a network timeout after a broker receives a message but before the producer receives the ACK causes the producer to retry, resulting in **duplicate messages** in the topic. Idempotent producers solve this: each producer instance is assigned a **Producer ID (PID)** by the broker, and each message batch has a monotonically increasing **sequence number**. If the broker receives a batch with a sequence number it has already seen for that PID, it silently deduplicates the batch and returns success. This provides exactly-once delivery *within a single producer session to a single partition*. **Limitations**: (1) **Single session**: if the producer process restarts, it gets a new PID - duplicates are possible across sessions, so use transactional producers for cross-session exactly-once. (2) **Single partition**: idempotency is per-partition, so a producer writing to 100 partitions has 100 independent deduplication scopes. (3) **No cross-topic exactly-once**: committing offsets and producing to another topic atomically requires Kafka transactions, not just idempotent producers. (4) **Slight latency increase**: waiting for sequence number acknowledgment adds ~1ms overhead.


**What FAANG expects:** Per-partition, per-session scope of idempotence, plus the jump to transactions for cross-partition atomicity. In 2026 clients, `enable.idempotence=true` is the default, candidates who talk about "enabling it" are outdated.

*Follow-ups you should expect:*
- What is the Producer Epoch and why does it matter? (Every `initTransactions()` call increments the epoch, fencing off zombie producers from a previous crash. Without it, a restart can cause duplicates with the same PID.)
- Why does `max.in.flight.requests.per.connection` matter for idempotence? (Up to 5 in-flight batches can retain order under idempotence. Older clients capped at 1, modern ones handle 5 correctly via sequence-number reordering.)
- Can idempotent producers deduplicate across topic changes? (No. PID+seq is scoped per topic-partition.)

---

**Q13: What is the "thundering herd" problem with Kafka consumers and how do you prevent it?**

The thundering herd occurs when many consumers start simultaneously - for example, after a deployment or incident recovery. All consumers join the group at nearly the same time, triggering rapid-fire rebalances as each new consumer joins. With 50 consumers starting in a tight window, you can get 50 sequential rebalances, each causing a stop-the-world pause. The cluster may spend more time rebalancing than processing. **Prevention strategies**:

```go
// 1. Staggered startup: add jitter to consumer startup
func startWithJitter(consumerIndex int) {
    // Spread 50 consumers over 30 seconds
    jitter := time.Duration(consumerIndex) * 600 * time.Millisecond
    jitter += time.Duration(rand.IntN(500)) * time.Millisecond
    time.Sleep(jitter)
    startConsumer()
}

// 2. Static group membership: prevents rebalance on restart within session timeout
config.Consumer.Group.InstanceId = fmt.Sprintf("consumer-%s-%d",
    os.Getenv("HOSTNAME"), consumerIndex)

// 3. Cooperative sticky rebalancing: only moved partitions are revoked
config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
    sarama.NewBalanceStrategyCooperativeSticky(),
}
```


**What FAANG expects:** Jitter + static membership + cooperative rebalancing, as a combination. Showing the code for any one of them without mentioning the others is incomplete.

*Follow-ups you should expect:*
- How is this different from a retry storm on an HTTP API? (Same shape, same fix, exponential backoff + jitter. But Kafka's rebalance state machine is what amplifies it.)
- What does `group.initial.rebalance.delay.ms` do? (Broker-side knob that delays the first rebalance to batch all startups into one. Useful for rolling deploys.)
- Why is `sarama.NewBalanceStrategyCooperativeSticky()` not enough on its own? (It reduces the impact of each rebalance, but N rebalances still cost more than 1 rebalance. Combine with startup jitter.)

---

**Q14: Walk me through diagnosing a production incident where consumer lag is growing at 10,000 messages per minute.**

**Step 1 - Quantify the problem**: Check `kafka_consumer_lag` per partition. Is lag uniform across partitions (processing too slow) or isolated to specific partitions (hot partition or failed consumer)?

**Step 2 - Check consumer health**: Are all expected consumer instances running? Check Kubernetes pod status, consumer group membership via `kafka-consumer-groups.sh --describe`. A crashed pod means fewer consumers than partitions.

**Step 3 - Profile the consumer**: Enable pprof endpoint. Check CPU (computation bottleneck?), goroutine count (goroutine leak?), heap allocations (GC pressure?).

**Step 4 - Check downstream dependencies**: Is the database accepting connections? Is connection pool exhausted? Is an external API rate-limiting you? The consumer may be healthy but its downstream is the bottleneck.

**Step 5 - Check broker metrics**: Is the broker under disk pressure? Are there under-replicated partitions (ISR shrinkage) causing producer backpressure that affects consumer fetching?

**Fixes in order**: (1) If consumer died - restart it. (2) If processing too slow - add consumer instances up to partition count. (3) If downstream bottleneck - add connection pooling, batching, or circuit breaker. (4) If hot partition - implement partition key sharding (see Mistake 2). (5) Emergency relief - temporarily increase `fetch.max.bytes` and `max.poll.records` to process more messages per poll cycle.


**What FAANG expects:** Structured incident narrative. Five distinct diagnosis steps with a specific metric at each step. Candidates who just say "I would check the logs" fail.

*Follow-ups you should expect:*
- What is a hot partition and how do you detect it? (Per-partition lag skew: 99% of lag on one partition, others healthy. Usually a bad partition key, a single tenant hashing to one partition.)
- How do you fix a hot partition without adding partitions? (Re-key the producer to include a salt for the hot tenant, or introduce a secondary shard key and route hot tenants to a dedicated topic.)
- What's the difference between consumer lag in messages vs in bytes vs in time? (Messages: misleading with variable payloads. Bytes: storage-centric. Time: `records_lag_max` translated via timestamp, most user-facing.)

---

**Q15: What are Kafka message headers used for in production, and show a Go example.**

Kafka message headers are key-value byte pairs attached to messages, not part of the message payload. Five production uses:

1. **Distributed trace propagation** (most common) - pass OpenTelemetry/Jaeger trace context
2. **Schema version** - indicate which schema version the payload uses
3. **Event type routing** - route to different handlers without deserializing the body
4. **Retry metadata** - track retry count and original topic for DLQ patterns
5. **Security context** - pass tenant ID or JWT claims for multi-tenant consumers

```go
// Propagate OpenTelemetry trace context via Kafka headers
func produceWithTracing(ctx context.Context, writer *kafka.Writer, payload []byte) error {
    headers := []kafka.Header{}

    // Inject trace context into headers using OTel text map propagator
    propagator := otel.GetTextMapPropagator()
    carrier := KafkaHeaderCarrier{}
    propagator.Inject(ctx, carrier)

    for k, v := range carrier.headers {
        headers = append(headers, kafka.Header{Key: k, Value: []byte(v)})
    }

    return writer.WriteMessages(ctx, kafka.Message{
        Value:   payload,
        Headers: headers,
    })
}

// On the consumer side: extract trace context
func consumeWithTracing(ctx context.Context, msg kafka.Message) context.Context {
    carrier := KafkaHeaderCarrier{}
    for _, h := range msg.Headers {
        carrier.headers[h.Key] = string(h.Value)
    }
    propagator := otel.GetTextMapPropagator()
    return propagator.Extract(ctx, carrier)
}

type KafkaHeaderCarrier struct {
    headers map[string]string
}

func (c KafkaHeaderCarrier) Get(key string) string        { return c.headers[key] }
func (c KafkaHeaderCarrier) Set(key, val string)          { c.headers[key] = val }
func (c KafkaHeaderCarrier) Keys() []string {
    keys := make([]string, 0, len(c.headers))
    for k := range c.headers { keys = append(keys, k) }
    return keys
}
```


**What FAANG expects:** At least three distinct production uses (tracing, schema version, routing) and a correct OpenTelemetry propagation example. Bonus for mentioning header size limits (default 1MB per message, including headers).

*Follow-ups you should expect:*
- Why not put trace context in the payload? (Couples serialization format to tracing. Headers are schema-independent and consumers can extract without deserializing.)
- What's the W3C Trace Context header name convention? (`traceparent` and `tracestate`, use them verbatim so OpenTelemetry propagators work across languages.)
- How do you pass tenant ID securely? (Signed JWT in a header, verified by consumer. Don't trust unsigned headers for authorization.)

---

**Q16: Explain Kafka's storage internals - how are messages physically stored and how does offset seek work?**

Each partition is stored as a **log directory** on the broker's disk. The directory contains a series of **segment files**, each consisting of three files:

- `00000000000000000000.log` - the raw message data, append-only
- `00000000000000000000.index` - sparse index mapping offset → byte position in `.log`
- `00000000000000000000.timeindex` - sparse index mapping timestamp → offset

The filename prefix is the base offset of that segment (the offset of the first message in it). There is always one **active segment** (the one being written to). All others are **inactive** (immutable, eligible for retention deletion or compaction).

**How seek works in O(log n)**:
1. Consumer requests offset 5,432,100
2. Broker does binary search over segment filenames to find the segment whose base offset ≤ 5,432,100 (segment filenames are sorted)
3. Within that segment, binary search the `.index` file to find the nearest indexed offset ≤ 5,432,100
4. Seek to the byte position from the index entry in the `.log` file
5. Scan forward sequentially from there to find the exact offset

**Retention mechanics**: A background thread checks inactive segments. If `retention.ms` has elapsed since the segment's last-modified time, or the total log size exceeds `retention.bytes`, the segment files (all three) are deleted atomically. The active segment is never deleted.


**What FAANG expects:** The three files (`.log`, `.index`, `.timeindex`), base offset naming, sparse index, and O(log n) seek. Candidates who cannot explain how a consumer finds offset 5,432,100 fail the internals bar.

*Follow-ups you should expect:*
- Why is the index sparse? (One entry per 4KB of log by default, `index.interval.bytes`. Dense index would cost too much memory. Binary search + sequential scan is the tradeoff.)
- What happens to `.timeindex` during log compaction? (Rebuilt alongside the compacted `.log`. Timestamp ordering is preserved but gaps appear.)
- How does tiered storage change seek? (Local segments seek as described. Remote segments require a metadata lookup and a range-read from S3, which costs 10s of ms.)

---

**Q17: Show me a complete implementation of exactly-once Kafka processing with PostgreSQL using the transactional outbox pattern.**

```go
// ExactlyOnceProcessor ensures each Kafka message is processed exactly once
// by using PostgreSQL as the idempotency store within the same transaction
// as the business operation.
type ExactlyOnceProcessor struct {
    db     *pgxpool.Pool
    reader *kafka.Reader
}

// schema:
// CREATE TABLE processed_kafka_events (
//     idempotency_key TEXT PRIMARY KEY,
//     topic           TEXT NOT NULL,
//     partition       INT  NOT NULL,
//     offset          BIGINT NOT NULL,
//     processed_at    TIMESTAMPTZ DEFAULT NOW()
// );

func (p *ExactlyOnceProcessor) ProcessMessage(ctx context.Context, msg kafka.Message) error {
    idempotencyKey := fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset)

    conn, err := p.db.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquire connection: %w", err)
    }
    defer conn.Release()

    tx, err := conn.Begin(ctx)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback(ctx)

    // Attempt to record this message as being processed.
    // ON CONFLICT means it was already processed - safe to skip.
    tag, err := tx.Exec(ctx, `
        INSERT INTO processed_kafka_events (idempotency_key, topic, partition, offset)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (idempotency_key) DO NOTHING
    `, idempotencyKey, msg.Topic, msg.Partition, msg.Offset)

    if err != nil {
        return fmt.Errorf("idempotency insert: %w", err)
    }

    if tag.RowsAffected() == 0 {
        // Already processed - this is a duplicate delivery, skip safely
        return nil
    }

    // Decode and apply business logic within the same transaction
    var event struct {
        OrderID     string `json:"order_id"`
        UserID      string `json:"user_id"`
        AmountCents int64  `json:"amount_cents"`
    }
    if err := json.Unmarshal(msg.Value, &event); err != nil {
        return fmt.Errorf("unmarshal: %w", err)
    }

    _, err = tx.Exec(ctx, `
        INSERT INTO orders (id, user_id, amount_cents, status, created_at)
        VALUES ($1, $2, $3, 'pending', NOW())
        ON CONFLICT (id) DO NOTHING
    `, event.OrderID, event.UserID, event.AmountCents)
    if err != nil {
        return fmt.Errorf("insert order: %w", err)
    }

    // Commit both the idempotency record and the business logic atomically
    if err := tx.Commit(ctx); err != nil {
        return fmt.Errorf("commit: %w", err)
    }

    // Only commit offset AFTER successful DB commit
    return p.reader.CommitMessages(ctx, msg)
}
```


**What FAANG expects:** The idempotency key derived from `topic:partition:offset`, the `ON CONFLICT DO NOTHING` dedupe, and commit-after-DB-commit ordering. Candidates who commit offsets before DB commit fail correctness review.

*Follow-ups you should expect:*
- What happens if the DB commits but the Kafka offset commit fails? (Next poll redelivers the message. The `ON CONFLICT` branch detects the duplicate and skips. Correct.)
- Why not use a DB-level unique constraint on `order_id`? (You should, as defense in depth. But `processed_kafka_events` also handles non-insert side effects, like "mark existing order as paid", where order_id already exists.)
- How do you garbage-collect the idempotency table? (Partition it by day, drop partitions older than your max reprocessing window, usually 7, 30 days.)

---

**Q18: What production metrics should every Kafka consumer expose? Show the Go Prometheus implementation.**

```go
var (
    consumerLag = prometheus.NewGaugeVec(prometheus.GaugeOpts{
        Name: "kafka_consumer_lag_messages",
        Help: "Current consumer lag in number of messages",
    }, []string{"topic", "partition", "consumer_group"})

    messagesProcessed = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "kafka_messages_processed_total",
        Help: "Total number of messages successfully processed",
    }, []string{"topic", "consumer_group", "status"}) // status: success|error

    processingDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "kafka_message_processing_duration_seconds",
        Help:    "Time spent processing a single Kafka message",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 12), // 1ms to ~4s
    }, []string{"topic", "consumer_group"})

    rebalanceTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "kafka_consumer_rebalance_total",
        Help: "Total number of consumer group rebalances",
    }, []string{"consumer_group", "type"}) // type: assigned|revoked

    commitErrors = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "kafka_commit_errors_total",
        Help: "Total number of offset commit failures",
    }, []string{"topic", "consumer_group"})

    dlqMessages = prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "kafka_dlq_messages_total",
        Help: "Total number of messages sent to dead-letter queue",
    }, []string{"topic", "consumer_group", "failure_reason"})
)

func init() {
    prometheus.MustRegister(
        consumerLag, messagesProcessed, processingDuration,
        rebalanceTotal, commitErrors, dlqMessages,
    )
}

// Alert rules (Prometheus/AlertManager):
// - KafkaConsumerLagHigh: lag > 10000 for 2m → warning
// - KafkaConsumerLagCritical: lag > 100000 for 5m → critical (page)
// - KafkaProcessingErrorRate: rate(kafka_messages_processed_total{status="error"}[5m]) /
//     rate(kafka_messages_processed_total[5m]) > 0.05 → warning (5% error rate)
// - KafkaProcessingLatencyHigh: histogram_quantile(0.99, ...) > 5 → warning
// - KafkaDLQGrowing: rate(kafka_dlq_messages_total[5m]) > 10 → critical
```


**What FAANG expects:** The five metrics (lag, processed total with status label, processing latency histogram, rebalance count, DLQ count) plus alert thresholds. Candidates who only list lag miss the observability maturity bar.

*Follow-ups you should expect:*
- Why lag in messages and not lag in time? (Start with messages because it's cheap. Add time-based lag for user-facing SLOs, consumer must compute `now() - record.timestamp` on each message.)
- What's the right histogram bucket layout? (Exponential from 1ms to a few seconds. Linear buckets waste cardinality on the fast path where most traffic lives.)
- How do you alert on DLQ growth? (`rate(dlq_messages_total[5m]) > 0` as warning, with a separate critical on absolute count. A growing DLQ means a bug that will not self-heal.)

---

**Q19: How does Kafka fit into CQRS and Event Sourcing patterns?**

In **CQRS (Command Query Responsibility Segregation)**, Kafka serves as the event bus between the write model (command side) and read models (query side). The command service processes commands, updates its write store, and publishes domain events to Kafka. Multiple read model services consume from Kafka and maintain their own optimized projections (denormalized views, search indexes, caches). Kafka's consumer group model means each read model gets its own independent copy of every event, and read models can be rebuilt from scratch by resetting consumer offsets to the beginning of the topic.

In **Event Sourcing**, Kafka can serve as the event store itself: every state change is an event appended to a Kafka topic. The current state is reconstructed by replaying all events for an aggregate (e.g., all events with `order_id=123` as the partition key). **Limitations**: (1) Kafka's default retention may not cover the full event history - use log compaction + extended retention. (2) replaying millions of events per aggregate on every read is slow - use snapshotting (periodically write aggregate state to a snapshot store). (3) Kafka's event log is ordered per-partition, not globally - multi-aggregate transactions require saga patterns or process managers. (4) Kafka's consumer API is stream-oriented, not document-oriented - querying specific aggregates requires an external projection store (PostgreSQL, Elasticsearch).


**What FAANG expects:** Correct CQRS and Event Sourcing distinction, plus honest limitations (global ordering, replay cost, no document queries). Candidates who pitch Kafka as a general-purpose event store without caveats lose credibility.

*Follow-ups you should expect:*
- Why not use a dedicated event store like EventStoreDB? (EventStoreDB has per-aggregate streams and optimistic concurrency built in. Kafka partitions are shared across aggregates, which forces you to build these on top.)
- How do snapshots work in Kafka-backed event sourcing? (Separate snapshot topic, log-compacted, keyed by aggregate ID. On load: read snapshot + replay events since snapshot offset.)
- What's the replay cost of 10M events per aggregate? (Unbounded. Snapshot every N events, N tuned so replay is under 1s at p99.)

---

**Q20: How do you handle backpressure in a Go Kafka consumer?**

Kafka's **pull-based model** is inherently backpressure-friendly: consumers only fetch messages when they call `ReadMessage()` or `FetchMessage()`. If the consumer stops polling, messages accumulate on the broker (within retention limits) - the broker is never overwhelmed by pushing to a slow consumer. **Implementing backpressure in Go**:

```go
func (c *Consumer) runWithBackpressure(ctx context.Context) {
    // Bounded channel acts as the backpressure buffer
    // When full, the fetch goroutine blocks - naturally throttling consumption
    workCh := make(chan kafka.Message, 100) // 100-message buffer

    // Fetch goroutine: reads from Kafka into the buffered channel
    go func() {
        for {
            msg, err := c.reader.FetchMessage(ctx)
            if err != nil {
                if errors.Is(err, context.Canceled) { return }
                continue
            }
            // This blocks when workCh is full - backpressure applied to fetching
            select {
            case workCh <- msg:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Worker pool: process messages from the channel
    sem := make(chan struct{}, 10) // max 10 concurrent processors
    for msg := range workCh {
        sem <- struct{}{}
        go func(m kafka.Message) {
            defer func() { <-sem }()
            if err := c.process(ctx, m); err == nil {
                c.reader.CommitMessages(ctx, m)
            }
        }(msg)
    }
}
```

**Consumer lag as autoscaling signal**: In Kubernetes, use KEDA (Kubernetes Event-Driven Autoscaling) with the Kafka scaler. KEDA reads `kafka_consumer_lag` and scales the consumer Deployment from 0 to N replicas based on lag thresholds. This provides automatic backpressure handling: lag grows → more consumers spin up → lag decreases → consumers scale down. **When overwhelmed**: if processing is too slow to keep up even at maximum consumer count, the options are: increase partition count (allows more parallelism), optimize the processing code, scale the downstream dependency (database, external API), or implement shedding (route low-priority messages to a separate low-priority topic and process them only when capacity is available).


**What FAANG expects:** Pull-model backpressure as the default, plus a KEDA-based autoscaling story. Candidates who reach for `pause()`/`resume()` show they understand client APIs but miss the cheaper-first pull-model answer.

*Follow-ups you should expect:*
- What does KEDA's Kafka scaler actually poll? (Consumer group lag via the admin API. Scales based on lag-per-replica target.)
- When would you call `pause(partitions)`? (Per-partition backpressure, one partition is fast, another is slow and you want to stop fetching from the slow one temporarily without stopping the consumer entirely.)
- What is load shedding in this context? (When autoscaling hits its cap, route low-priority traffic to a separate topic, consumed by a separate group with its own SLO. Keeps critical path healthy.)

### Junior -> FAANG: Structuring Kafka Interview Answers for Maximum Clarity

Interview answers about Kafka systems fail in one of two ways: too shallow (you name a concept without explaining it) or too broad (you explain everything and lose the thread). The questions in this section show the expected depth. Practice the following structure for each answer:

**Name the mechanism, quantify the behavior, describe a failure mode it prevents.**

For Q1 (high throughput): "Zero-copy transfers via the `sendfile` syscall eliminate two memory copies and two context switches per read. This saves roughly 60% CPU overhead for read-heavy workloads. Without it, at 500 MB/s throughput, the broker CPU is saturated just copying bytes."

**Anticipate the follow-up and address it proactively.**

If you explain ISR mechanics for Q3, anticipate "what happens to durability if you set `unclean.leader.election.enable=true`?" and address it in your answer: "I would keep this false in production because enabling it allows an out-of-sync replica to become leader, silently losing messages that the old leader acknowledged but had not replicated."

**Use numbers from real systems when possible.**

The questions in this section each reference specific data points from LinkedIn, Uber, and Netflix. Incorporating real scale numbers ("Uber processes GPS events on the order of a million per second") makes your answer credible and demonstrates that you have studied how these systems work at scale, not just read the Kafka documentation.

For entry-level interviews, the expectation is correctness on Q1-Q4. For senior interviews, the expectation is correctness plus tradeoff awareness: you should be able to describe not just what the mechanism does but when you would choose not to use it.

### Senior @ FAANG: Bar-Raiser Signals in Kafka Interview Responses

Bar-raisers in Kafka interviews are looking for a specific quality of thinking that goes beyond reciting documentation. The signals that distinguish L5 from L6 responses:

**Signal 1: Scope the guarantee correctly.** When asked about exactly-once semantics, an L5 answer describes the transactional producer API. An L6 answer immediately scopes the guarantee: "Kafka's transactional API provides exactly-once within the Kafka broker layer. The moment you write to an external system, you need the transactional outbox pattern or idempotent consumer design to extend that guarantee." Scoping a guarantee without being prompted demonstrates that you have encountered the failure mode in practice.

**Signal 2: Lead with the tradeoff, not the feature.** When asked "should you use cooperative sticky rebalancing?" the wrong answer is "yes, it's better." The right answer is: "Cooperative sticky rebalancing is the correct default for most production fleets because it eliminates stop-the-world pauses during rolling deploys. The one case where eager rebalancing is acceptable is a very small consumer group (under 5 instances) where the rebalance overhead is negligible. In all other cases, the cost of a few minutes of rebalancing configuration is worth eliminating the risk of SLA breaches during deployments."

**Signal 3: Connect the technical decision to the business outcome.** "ISR shrinks are a leading indicator of broker disk I/O saturation" is a technical statement. "ISR shrinks that are not caught early lead to under-replicated partitions, which means the next broker failure can cause offline partitions, which means write failures for producers, which means order processing downtime" is a business impact chain. Bar-raisers specifically probe for this chain of consequence. If you cannot connect a technical metric to a user-visible or business-visible outcome, you have not fully understood the system.

**Signal 4: Propose alternatives and explain when NOT to use Kafka.** An L6 candidate who can say "for this use case, Kafka is overcomplicated. NATS JetStream would give you the same durability guarantees with 90% less operational overhead" is demonstrating the judgment that distinguishes senior from staff-level thinking. The ability to argue against the technology you specialize in is a bar-raiser signal that you optimize for the right outcome rather than for the technology you happen to know best.

---
