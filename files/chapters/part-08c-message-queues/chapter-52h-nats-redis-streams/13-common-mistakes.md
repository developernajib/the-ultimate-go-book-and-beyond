## Common Mistakes

### 1. Using NATS Core for Anything Requiring Persistence

NATS core is at-most-once. If your subscriber is offline, restarting, or slow when a message arrives, the message is permanently lost. Teams that build order processing, payment events, or audit logs on NATS core discover this during their first deployment incident. The fix is always JetStream - the migration is minimal since the publishing API is nearly identical, but the operational implications are completely different.

### 2. Not Setting MaxDeliver on JetStream Consumers

Without `MaxDeliver`, a JetStream consumer retries failed messages forever. A single poison-pill message (malformed JSON, a downstream service that consistently returns 500) will be redelivered indefinitely, consuming AckWait slots and blocking other messages in work queue retention mode. Always set `MaxDeliver` to a finite value (5, 10) and pair it with a dead-letter stream or an alert on `NumPending` stagnation.

### 3. Not Handling NATS Reconnection Callbacks

A NATS connection silently attempts to reconnect when the server is unreachable. Without reconnection handlers, your application has no way to know it is operating in a degraded state - metrics dashboards show normal, while messages are silently buffering or dropping. Always register `ReconnectHandler`, `DisconnectErrHandler`, and `ErrorHandler`. The disconnect handler should increment an alert metric. The reconnect handler should log and clear the alert.

### 4. Not Using XPENDING/XCLAIM for Redis Streams

When a Redis Streams consumer crashes between XREADGROUP and XACK, its messages remain in the Pending Entry List indefinitely - no automatic redelivery occurs. Without XPENDING monitoring and XCLAIM (or XAUTOCLAIM) recovery, a single consumer crash creates a permanent processing backlog. Implement XAUTOCLAIM with a reasonable idle threshold (3, 5x your normal processing time) in every consumer loop.

### 5. Blocking Redis Streams Reads Without Context Timeout

`XREADGROUP ... BLOCK 0` blocks the underlying Redis connection indefinitely. If this goroutine is created without a context timeout, it leaks when the application shuts down - the goroutine never unblocks because the BLOCK call holds the connection open. Always use a bounded block timeout (e.g., 2, 5 seconds) and check `ctx.Done()` between calls. Never pass `Block: 0` in production.

### 6. Not Setting MAXLEN on Redis Streams

Redis Streams grow without bound by default. On a busy system producing 10,000 entries/sec, an unbound stream consumes 1GB+ of RAM per day. Use `MAXLEN ~ N` with approximate trimming for constant-time performance. Size `N` based on your slowest consumer's expected recovery time: if your consumer can fall up to 1 hour behind before alarming, set MAXLEN to `(entries_per_second * 3600)`.

### Junior -> FAANG: Building Habits That Prevent These Mistakes

The six mistakes above share a common root cause: they are invisible during development and only surface under production conditions (load, consumer failure, server restart). Building the habit of testing failure scenarios before a service goes to production is the single most impactful skill for early-career engineers moving toward FAANG-level expectations.

For each mistake listed, create a corresponding integration test:

- Mistake 1: start a subscriber, publish 10 messages, stop the subscriber for 5 seconds, restart it, and verify which messages (if any) it receives.
- Mistake 2: configure a JetStream consumer without `MaxDeliver`, publish a message that your handler always rejects, and observe what happens over 30 minutes.
- Mistake 3: start your service, kill and restart the NATS server, and verify that your reconnection handler fires and your service resumes processing.
- Mistake 4: run a Redis Streams consumer that crashes after reading but before acking, then start a fresh consumer and measure how long it takes for `XAUTOCLAIM` to recover the stuck message.
- Mistake 5: run `XREADGROUP` with `Block: 0`, send SIGTERM to your process, and verify whether the goroutine exits cleanly or leaks.
- Mistake 6: publish to an unbounded stream for 10 minutes at 1,000 msg/sec, then run `XLEN` and calculate the projected daily storage cost.

Each test takes under 30 minutes to write and will catch the failure mode before your first production incident.

### Senior @ FAANG: Mistake Taxonomy and Prevention at the Platform Level

The six common mistakes are symptoms of a missing layer in the platform: golden-path libraries that make the correct behavior the default and the incorrect behavior require explicit opt-in.

A platform library for NATS JetStream consumers would make `MaxDeliver` a required field in the consumer config struct (no default, compile error if absent) and would embed reconnection handlers in the base client rather than requiring each service to add them. A platform library for Redis Streams consumers would embed `XAUTOCLAIM` in the `ProcessLoop` as a scheduled task (run every N seconds, configurable) and would reject `Block: 0` at the API level by enforcing a maximum block timeout.

This approach moves mistake prevention from "engineers must remember" to "the platform makes it structurally impossible." The senior engineer's job is to identify which mistakes are recurring across teams and encode the prevention into shared infrastructure, not to document them in a chapter and hope teams read it.

The missing mistake that belongs on this list for senior engineers: not distinguishing between retriable and non-retriable errors at the consumer level. The `processMessage` function in the notification service acks on parse failure (correct: a malformed message cannot be fixed by retrying) but naks on preference lookup failure (correct: a KV store outage is transient). Many services use a blanket nack-on-error policy, which causes malformed messages to be retried forever (depleting `MaxDeliver`) or a blanket ack-on-error policy, which silently discards all failures. The platform library should provide an `ErrorClassifier` interface that services implement to classify errors as permanent (ack), transient (nak), or throttled (nak with exponential delay), and the base `ProcessLoop` should call the classifier rather than making the retry decision itself.

---
