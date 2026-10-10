## 35.6 Pub/Sub

### Publisher

Redis Pub/Sub delivers messages by pushing them immediately to all clients currently subscribed to a channel. There is no persistence or buffering. Because `Publish` returns the number of clients that received the message, a return value of 0 does not indicate an error. It simply means no subscriber was connected at that instant, and the message is gone. This makes Redis Pub/Sub appropriate for ephemeral fan-out (cache invalidation, live notifications) rather than durable event streams where missed messages matter.

```go
func publish(ctx context.Context, rdb *redis.Client, channel string, message any) error {
    data, err := json.Marshal(message)
    if err != nil {
        return err
    }
    return rdb.Publish(ctx, channel, data).Err()
}
```

### Subscriber

Calling `pubsub.Receive` before reading from `pubsub.Channel()` is important: it blocks until the server confirms the subscription, preventing a race where messages published immediately after `Subscribe` arrive before the channel is actually registered on the server. `PSubscribe` extends this to glob patterns, routing all matching channel names to the same handler. This helps when channels are dynamically named (e.g., `orders.*`) and you want a single subscriber to cover the whole namespace.

```go
func subscribe(ctx context.Context, rdb *redis.Client, channels ...string) {
    pubsub := rdb.Subscribe(ctx, channels...)
    defer pubsub.Close()

    // Wait for subscription confirmation
    _, err := pubsub.Receive(ctx)
    if err != nil {
        log.Fatal(err)
    }

    // Process messages
    ch := pubsub.Channel()
    for msg := range ch {
        fmt.Printf("Channel: %s, Message: %s\n", msg.Channel, msg.Payload)
        handleMessage(msg.Channel, msg.Payload)
    }
}

// Pattern subscription
func subscribePattern(ctx context.Context, rdb *redis.Client, pattern string) {
    pubsub := rdb.PSubscribe(ctx, pattern)
    defer pubsub.Close()

    ch := pubsub.Channel()
    for msg := range ch {
        fmt.Printf("Pattern: %s, Channel: %s, Message: %s\n",
            msg.Pattern, msg.Channel, msg.Payload)
    }
}
```

### Junior to FAANG: Pub/Sub mental model and common traps

The single sentence to internalize is "Redis Pub/Sub is fire and forget." If the subscriber is not connected, the message is gone. If the subscriber is slow, the broker eventually disconnects it (the `client-output-buffer-limit pubsub` setting). If the network blips for 200 ms, every message published during the blip is lost to that subscriber. None of these are bugs, they are the design. Pub/Sub is what you pick when losing a message is cheaper than persisting it.

Worked example where Pub/Sub is the right tool. You run a web server with an in-memory LRU cache. When a user updates their profile, every replica must invalidate its cache entry for that user. You publish `user:invalidate` with the user ID, every replica subscribes, every replica drops the entry. If one replica missed the message it will serve stale data for a few seconds until the TTL expires or the next update arrives. That is acceptable. This is cache coherence, not durability, and Pub/Sub fits.

Worked example where Pub/Sub is the wrong tool. You publish "order placed" events so the billing service can charge the card. If billing is restarting during your publish, the charge never happens. You discover this a week later when revenue is missing. Use Streams, Kafka, or NATS JetStream. Anything that sends money, provisions resources, or writes to the source of truth demands durability.

Interview entry point. The classic bait is "design a chat system with Redis Pub/Sub." The correct first move is to separate concerns: Pub/Sub for live presence and typing indicators, a durable store (Streams, Postgres, or Kafka) for the actual messages. Candidates who put message history on Pub/Sub fail. Candidates who identify the durability boundary pass.

### Senior at FAANG: when Pub/Sub wins, when it loses, and what replaces it

Semantic summary. Redis Pub/Sub is at-most-once, no persistence, no replay, no backpressure. Delivery is best-effort to currently-connected subscribers. Under Redis Cluster, Pub/Sub without sharded-pubsub (`SPUBLISH`/`SSUBSCRIBE`, available since 7.0) broadcasts to every node. That is fine at low volume and a disaster at high volume because every publish hits every shard. Sharded Pub/Sub restricts delivery to the shard owning the channel slot, which is the version you want in cluster deployments. Know the difference in a design review, point it out when someone proposes global Pub/Sub in a 12-node cluster.

Versus Streams. Redis Streams give you consumer groups, acknowledgments, and replay. `XADD` appends to a log, `XREADGROUP BLOCK` lets a pool of consumers fan in with load balancing, `XACK` marks a message done, `XPENDING` lists messages that were delivered but not acked, `XAUTOCLAIM` lets a healthy consumer take over work from a dead one. This is the primitive you want for internal event pipelines when you already run Redis and do not want to operate Kafka. Trim with `XADD MAXLEN ~ 1000000` (approximate trimming is much cheaper than exact) or use `XTRIM MINID` to trim by time.

Versus Kafka. Streams are cheaper to run, have lower latency for small clusters, and interop cleanly with the rest of Redis. Kafka wins when retention is measured in days or weeks, when throughput is measured in hundreds of megabytes per second per partition, when you need exactly-once semantics across producers, or when you have a Kafka ecosystem (Schema Registry, Connect, ksqlDB) you want to keep using. Below a million events per second with one-hour to one-day retention, Streams is usually simpler. Above that, Kafka.

Versus NATS JetStream. JetStream is a middle ground: subject-based routing like NATS core, persistence and consumer groups like Kafka, lighter operational burden than either. If your event model is subject-hierarchical (`orders.eu.fr.created`) NATS subjects are more ergonomic than Redis channel globs or Kafka topics. If you already run Redis for caching, adding Streams beats adding JetStream.

Slow consumers and the output buffer. The single most common Pub/Sub outage in production is a slow subscriber. The server buffers outgoing messages per client. When the buffer hits `client-output-buffer-limit pubsub 32mb 8mb 60`, Redis disconnects the client. The subscriber sees an EOF and reconnects, but every message buffered during the disconnect is lost. Go subscribers that do heavy work in the message loop will hit this. The fix is to read from the channel as fast as possible and hand off to a worker pool. Never call a database from inside the `for msg := range ch` loop. Buffer in a bounded Go channel, return immediately, process in workers.

Reconnect and re-subscribe. `go-redis` handles reconnection transparently, but it also re-sends the `SUBSCRIBE` command on reconnect. There is a window during reconnect in which messages can be missed. If you cannot tolerate that, you are not running Pub/Sub, you are running Streams. Do not try to bolt durability onto Pub/Sub by publishing the same message to a list. You have reinvented Streams badly.

Keyspace notifications. Redis can publish notifications for expired keys, evicted keys, and mutations. The config is `notify-keyspace-events`. People reach for this to build "expire at" job queues. It works until you hit scale, then you notice that notifications are Pub/Sub under the hood (fire and forget) and that a restart or a slow subscriber loses them. For scheduled jobs use a sorted set with the fire-time as score and a poller that `ZRANGEBYSCORE` each second. Do not rely on expiry notifications for anything important.

Staff ADR. When you propose Pub/Sub in a design review, the ADR must state the at-most-once acceptance, list the events that will flow through it, justify that each one is acceptable to lose, and describe the replacement plan if the volume grows. If any event on the list fails that test, move that event to Streams or Kafka. Reviewers who have been burned will block the ADR until the durability boundary is explicit.

---
