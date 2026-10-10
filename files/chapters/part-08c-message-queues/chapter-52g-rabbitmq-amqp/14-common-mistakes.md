## Common Mistakes

### Mistake 1: Not Using Publisher Confirms

Publishing without confirms means your producer has no way to know whether the broker received and persisted the message. A broker restart during publishing silently loses data. The following code contrast shows the unsafe fire-and-forget pattern alongside the safe confirm-aware version that every production publisher should use.

```go
// WRONG: fire-and-forget. Message silently dropped if broker is under memory pressure.
ch.PublishWithContext(ctx, "orders", "new", false, false, amqp.Publishing{Body: body})

// RIGHT: enable confirm mode, wait for ack.
ch.Confirm(false)
confs := ch.NotifyPublish(make(chan amqp.Confirmation, 1))
ch.PublishWithContext(ctx, "orders", "new", true, false, amqp.Publishing{Body: body})
conf := <-confs
if !conf.Ack { /* retry */ }
```

### Mistake 2: Prefetch=0 (Unlimited)

`ch.Qos(0, 0, false)` means the broker pushes all ready messages to the consumer immediately. A queue with 100,000 messages will flood a single consumer's memory. **Always set prefetch to a concrete value** (start with 10, tune from there).

### Mistake 3: Not Handling Channel Closure

An AMQP channel closes when a protocol error occurs (e.g., trying to declare a queue with different properties than existing, ack-ing an unknown delivery tag). The channel is permanently closed - you must open a new one.

```go
go func() {
    for chErr := range ch.NotifyClose(make(chan *amqp.Error, 1)) {
        logger.Error("channel closed", "code", chErr.Code, "reason", chErr.Reason)
        // Reconnect logic here.
    }
}()
```

### Mistake 4: Sharing Channels Across Goroutines Without Serialization

`*amqp.Channel` is **not goroutine-safe**. Concurrent publishes on the same channel corrupt the AMQP frame stream, causing the channel to close with a protocol error. Either use one channel per goroutine or wrap channel access with a mutex/channel pool.

### Mistake 5: Forgetting to Acknowledge Messages

If your consumer calls `ch.Consume` with `autoAck=false` but never calls `d.Ack()`, messages remain in `unacknowledged` state. Unacknowledged messages:
- Are not re-delivered while the consumer is alive
- Block prefetch (consumer gets no new messages when prefetch limit is reached)
- Return to `ready` state only when the consumer connection drops

### Mistake 6: Unbounded Queues Without TTL or Max-Length

Without `x-message-ttl` and `x-max-length`, queues grow indefinitely. At 1KB/message, 1M messages = 1GB RAM. RabbitMQ will trigger a **memory alarm** when memory usage exceeds 40% of available RAM, **blocking all producers** until memory recovers. Always set limits.

### Mistake 7: Upgrading to RabbitMQ 4.x Without Migrating Off Classic Mirrored Queues

Classic mirrored queues (`ha-mode: all`) were **removed entirely in RabbitMQ 4.0**. Upgrading a 3.x cluster without first migrating results in your "HA" queues silently becoming single-node classic queues, the `ha-mode` policy is ignored and no warning fires at publish time. You discover it when the node holding the queue crashes and every message is lost.

Classic mirrored queues used a proprietary replication protocol prone to:
- **Unsynchronized mirrors** (broker crash during sync = message loss)
- **Split-brain** during network partitions
- **Performance degradation** under high write throughput (all mirrors must ack)

**Quorum queues** (Raft-based) solve all three and are the only replicated queue type on 4.x. Migration path: either Blue-Green (stand up a 4.x cluster, switch producers, drain old cluster) or in-place with the `migrate-mcq-to-qq` tooling on 3.13 before upgrading. Confirm with `rabbitmqctl list_queues name type` that no classic queues remain before cutting over.

### Mistake 8: Single Connection Without Recovery

A single AMQP connection with no reconnection logic will cause your entire messaging pipeline to stop processing silently when the broker restarts or the network hiccups. The following implementation wraps the connection in a supervisor that detects close notifications and re-establishes the connection with all channel state intact.

```go
// WRONG: one connection, no recovery. Network blip = service restart required.
conn, _ := amqp.Dial(url)
// ... use conn forever

// RIGHT: Use ReliableConnection from §52G.7 with reconnect loop and exponential backoff.
rc := NewReliableConnection(urls, cfg, logger)
rc.RunWithReconnect(ctx, func(conn *amqp.Connection) error {
    // Setup channels, consumers, publishers using this connection.
    return nil
})
```

### Junior → FAANG: Common Mistakes as an Interview Study Guide

The eight mistakes in this section are the eight most common failure modes that appear in RabbitMQ interview questions and code reviews. Practice explaining each one out loud before your interview.

**Mistake pattern: "works in testing, fails in production":**

Mistakes 1 (no confirms), 2 (prefetch=0), and 6 (unbounded queues) all share the same pattern. They work fine in local testing with low message rates and a single consumer, and they fail catastrophically at production load. Fire-and-forget does not lose messages at 10 msg/s but loses them reliably at 10,000 msg/s during a broker restart. Prefetch=0 does not cause OOM with a test queue of 100 messages but causes OOM with a queue of 100,000 during a consumer restart. Always ask "what happens at 100x this load" before accepting any configuration default.

**Mistake 4 is the most common Go-specific bug:**

Channel goroutine-safety is a Go-specific concern. In Python or Ruby, the interpreter-level GIL prevents concurrent access within a single thread. In Go, goroutines are truly concurrent and sharing any non-goroutine-safe object causes data races. The `*amqp.Channel` type is documented as not goroutine-safe. A channel shared across goroutines will eventually produce interleaved AMQP frames, causing the channel to close with a protocol error that appears as an unrelated error in the logs. The race detector (`go test -race`) will catch this if your tests exercise concurrent publish paths.

**Mistake 7 is an upgrade path error, not a runtime error:**

The CMQ removal mistake does not produce a runtime error during normal operation. It produces silent data loss during a broker node failure. After upgrading to 4.x with classic queues remaining, everything appears to work until a node fails. This is why it is the most dangerous mistake on the list: the error window is between the upgrade and the first node failure, which could be months. The fix is verifying queue types with `rabbitmqctl list_queues name type` before upgrading, not after.

### Senior @ FAANG: Mistake Categories and Platform Prevention

At the senior level, the question is not how to fix mistakes after they occur but how to build systems that make these mistakes structurally impossible.

**Category 1: configuration mistakes that require policy enforcement:**

Mistakes 2 (prefetch=0), 6 (unbounded queues), and 7 (CMQ not migrated before upgrade) are configuration mistakes. They are not code bugs. You cannot catch them in a code review. The prevention mechanism is infrastructure policy: RabbitMQ operator policies that enforce `x-max-length` and `x-message-ttl` on all queues, a pre-upgrade checklist that runs `rabbitmqctl list_queues name type` and fails the upgrade script if any CMQ queues remain, and a consumer deployment linter that rejects consumer configurations with `prefetch=0`.

**Category 2: code mistakes that require library enforcement:**

Mistakes 1 (no confirms), 4 (shared channels), and 8 (no reconnection) are code mistakes. They can be prevented by a platform library that makes the correct behavior the default. A platform publisher wrapper that always enables confirm mode means teams cannot accidentally publish without confirms. A platform consumer wrapper that always validates that the delivery channel is not closed means teams cannot accidentally ignore channel closure. The platform library is the enforcement mechanism, not documentation or code review.

**Category 3: operational mistakes that require runbooks and training:**

Mistake 5 (forgetting to ack) and mistake 3 (not handling channel closure) are operational mistakes that require debugging skills to identify in production. The platform should provide a runbook that describes the symptoms of each mistake: a growing `messages_unacknowledged` count with stable consumer count is mistake 5, and a consumer that stops processing messages without any error log is mistake 3. Teams should be able to self-diagnose from the Management API metrics dashboard without requiring platform team involvement.

**Staff-level concern: mistake recurrence rate as a platform health metric:**

A platform team at L7 level tracks how often each category of mistake recurs across teams. If mistake 6 (unbounded queues) keeps appearing in new services despite documentation and code review feedback, the documentation and code review are not working. The correct response is to implement operator policy enforcement that prevents the mistake at the infrastructure level. If mistake 1 (no confirms) keeps appearing, the platform library's default needs to change so that publishing without confirms requires explicit opt-out rather than opt-in. The mistake recurrence rate is a platform health metric, not an individual team accountability metric.

---
