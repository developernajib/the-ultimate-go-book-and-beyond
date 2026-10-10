## 35.7 Streams

### Consumer Groups

Redis Streams provide durable, ordered message delivery with consumer group support - filling the gap that Pub/Sub leaves by not persisting messages. Pub/Sub is fire-and-forget: if no subscriber is connected when `PUBLISH` fires, the message is gone forever. Streams are append-only logs persisted to disk (AOF/RDB), addressable by ID, supporting replay with `XREAD` from a prior ID, multi-consumer fan-out via consumer groups, and at-least-once delivery via pending-entries tracking. Think of Pub/Sub as a UDP-style broadcast and Streams as a Kafka-lite durable log that lives inside the same Redis instance.

A consumer group tracks which messages each consumer has processed through acknowledgments (`XACK`). If a consumer crashes before acknowledging, the message stays in the pending entries list (PEL) and can be claimed by another consumer after a configurable idle timeout. Cap stream growth with `XADD ... MAXLEN ~ N` (approximate trimming) to bound memory - an unbounded stream will eventually evict your cache dataset under `maxmemory`.

`XGroupCreateMkStream` creates both the stream and consumer group if they do not exist. The `BUSYGROUP` error is expected when the group already exists, so it is silently ignored. `XReadGroup` with `">"` as the stream ID reads only new, undelivered messages. The `Block` parameter causes the call to wait up to 5 seconds for new messages before returning `redis.Nil`, avoiding tight polling loops.

The `claimPendingMessages` function handles failure recovery: it scans the pending entries list for messages idle longer than `minIdleTime`, then uses `XClaim` to reassign them to the current consumer. This pattern ensures that no message is lost even when consumers crash mid-processing.

```go
func setupConsumerGroup(ctx context.Context, rdb *redis.Client, stream, group string) error {
    err := rdb.XGroupCreateMkStream(ctx, stream, group, "0").Err()
    if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
        return err
    }
    return nil
}

func consumeGroup(ctx context.Context, rdb *redis.Client, stream, group, consumer string) {
    for {
        results, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
            Group:    group,
            Consumer: consumer,
            Streams:  []string{stream, ">"},
            Block:    5 * time.Second,
            Count:    10,
        }).Result()

        if err == redis.Nil {
            continue
        }
        if err != nil {
            log.Printf("Error: %v", err)
            continue
        }

        for _, s := range results {
            for _, msg := range s.Messages {
                if err := processMessage(msg); err != nil {
                    log.Printf("Processing failed: %v", err)
                    continue
                }
                // Acknowledge message
                rdb.XAck(ctx, s.Stream, group, msg.ID)
            }
        }
    }
}

// Claim pending messages
func claimPendingMessages(ctx context.Context, rdb *redis.Client, stream, group, consumer string, minIdleTime time.Duration) {
    pending, err := rdb.XPendingExt(ctx, &redis.XPendingExtArgs{
        Stream: stream,
        Group:  group,
        Start:  "-",
        End:    "+",
        Count:  10,
    }).Result()

    if err != nil {
        return
    }

    for _, p := range pending {
        if p.Idle < minIdleTime {
            continue
        }

        // Claim the message
        messages, err := rdb.XClaim(ctx, &redis.XClaimArgs{
            Stream:   stream,
            Group:    group,
            Consumer: consumer,
            MinIdle:  minIdleTime,
            Messages: []string{p.ID},
        }).Result()

        for _, msg := range messages {
            processMessage(msg)
            rdb.XAck(ctx, stream, group, msg.ID)
        }
    }
}
```

### Junior to FAANG: Streams fundamentals and first-job patterns

Streams feel like Kafka and behave like Redis. The key ID is a millisecond timestamp plus a sequence number (`1713200000123-0`), which means IDs are globally ordered and usable as a cursor. Reading from `0` returns every message. Reading from `$` waits for new messages only. Reading with a consumer group and `>` returns only messages not yet delivered to any consumer in the group. Get those three modes straight before anything else.

The thing that surprises newcomers is the pending entries list (PEL). When a consumer reads a message via `XREADGROUP`, Redis records that this consumer owes an `XACK`. Until the ack lands, the message sits in the PEL with the consumer's name and an idle time. If the consumer dies, the PEL is how another consumer finds orphaned work. This is the mechanism that makes at-least-once delivery real. Pub/Sub has nothing like it.

Worked example. You run an image processing pipeline. Uploads land in an S3 bucket, a webhook fires an event, you `XADD` the event to `stream:uploads`. Four workers in a consumer group called `processors` each call `XREADGROUP BLOCK 5000 COUNT 10`. Work is distributed round-robin by Redis. Each worker processes, calls `XACK`. If worker 2 OOMs mid-job, its PEL entries remain unacked. A separate reaper (or any idle worker) runs `XAUTOCLAIM` with `MIN-IDLE-TIME 60000` and takes over. The message is processed exactly as many times as is required for one `XACK` to land, which is at-least-once. Make `processMessage` idempotent.

First-job context. Do not write your own Streams consumer loop from scratch for production unless you have a reason. Libraries like `redis-streams-go` or internal frameworks wrap the boilerplate (consumer creation, PEL reclaim, dead-letter on repeated failures, metrics). If the team has one, use it. If not, the example in this section is the starting point but you will add at minimum: a max-delivery-count check in `XPENDING` output so poison messages move to a dead-letter stream, structured logging with the message ID, and graceful shutdown that drains in-flight messages before exiting.

Interview entry point. "Design an at-least-once job queue on Redis." Key moves: `XADD` for enqueue, consumer group for workers, `XACK` on success, `XPENDING` plus `XAUTOCLAIM` for recovery, max-delivery-count in the PEL drives dead-letter, `MAXLEN ~` to trim. Mention that this is Redis Streams not Pub/Sub and explain why. Mention Kafka as the alternative and why you would reach for it.

### Senior at FAANG: consumer groups, rebalancing, dead letters, and Kafka framing

Consumer group semantics precisely. A group has a last-delivered ID. `XREADGROUP ... >` advances it, distributing each message to exactly one consumer in the group at the moment of delivery. The message enters that consumer's PEL. `XACK` removes it. If you never ack, the message sits in PEL forever and the group's last-delivered ID still advances (the group is not blocked on unacked messages, only the PEL grows). This is different from Kafka where unacked offsets block progress. In Redis you can have an arbitrarily large PEL and still consume new messages. This is a feature and a trap. Feature: no head-of-line blocking. Trap: a silent bug that fails to ack causes unbounded memory growth in the PEL.

Rebalancing. Redis does no automatic rebalancing. If you add a consumer, it starts picking up new messages round-robin. If a consumer dies, nothing claims its PEL entries until someone calls `XAUTOCLAIM` or `XCLAIM`. In production you run a claim loop in every consumer: first read new messages with `>`, then sweep pending with `XAUTOCLAIM MIN-IDLE-TIME 60000`. This makes the consumer self-healing. `XAUTOCLAIM` (since 6.2) is strictly better than the old `XPENDING` plus `XCLAIM` dance, it returns a cursor so you can iterate without racing. Use it unless you are stuck on 6.0 or earlier.

Dead-letter handling. `XPENDING` reports a delivery counter per message. After N failed deliveries (typically 5) move the message to a dead-letter stream: `XADD dlq:stream`, then `XACK` the original. Do this with a Lua script so the ack and the DLQ insert are atomic. Without atomicity you either double-process (ack succeeds, DLQ fails) or lose (DLQ succeeds, ack fails, someone else grabs it and loops again).

Trimming and retention. `XADD MAXLEN ~ 1000000` is approximate trimming. The tilde lets Redis trim to a nearby radix-tree boundary for O(1) amortized cost instead of O(N) exact trimming. Exact trimming (`MAXLEN 1000000`, no tilde) can pause Redis for seconds on large streams. For time-based retention use `XTRIM MINID <ms-timestamp>`. Never leave a stream untrimmed in production, `maxmemory` eviction will evict your cache dataset first and your stream will keep growing until the instance OOMs.

`NOMKSTREAM`. `XADD NOMKSTREAM` fails cleanly if the stream does not exist. Use it in publishers so a typo in a stream name does not silently create a ghost stream that nobody reads. Catch the nil reply and surface a config error.

Streams versus Kafka in 2026. Kafka wins on throughput per partition (hundreds of MB/s), on retention (days to weeks cheaply), on the ecosystem (Connect, Schema Registry, ksqlDB, Flink), and on exactly-once with transactional producers. Redis Streams win on latency (sub-millisecond end to end on local clusters), on operational simplicity (you already run Redis), on cost at small scale, and on the ergonomic fit when events are small and retention is short. The inflection point is roughly one million events per second or one-week retention. Below both, Streams. Above either, Kafka. NATS JetStream sits between them with subject-based routing, useful when your event model is subject-hierarchical and you do not want the Kafka operational footprint.

Cluster considerations. Streams live on a single slot by default. At high throughput a single stream is a hotspot. Shard by hashing a partition key to one of N stream names (`stream:events:0` through `stream:events:15`). Each shard lives on whatever slot it hashes to. Consumers spread across shards. This is Kafka partitioning reinvented in application code, and it is the correct move when you outgrow a single stream but still want to stay on Redis.

Observability. Track PEL size per consumer group, max idle time in PEL, delivery-count histogram, stream length, trim rate, XADD rate, XACK rate, and the delta between XADD and XACK rates (growing delta means you are falling behind). Alert on PEL size above a threshold and on max idle above twice your claim interval.

Staff ADR. The Streams ADR states: the durability guarantee (at-least-once plus idempotent consumer), the retention strategy (MAXLEN approximate), the dead-letter threshold, the claim interval, the shard count if any, and the exit strategy to Kafka. The last point is uncomfortable but honest: most Streams deployments that succeed eventually need Kafka. Plan the migration path from day one by keeping the event schema serializer-agnostic (protobuf or Avro) and the consumer interface abstracted.

---
