## Learning Objectives

1. **Understand AMQP 0-9-1 Protocol Internals**: Learn connection vs channel multiplexing, frame types, heartbeats, and virtual hosts - the foundation every senior engineer must know before touching RabbitMQ in production.
2. **Master Exchange Types and Routing**: Implement direct, topic, fanout, and headers exchanges with idiomatic Go code, understanding when each pattern applies at scale.
3. **Manage Queues for Durability and Scale**: Configure durable/quorum/lazy queues with TTL, max-length, and dead-letter arguments - preventing unbounded memory growth in production systems.
4. **Implement Publisher Confirms for At-Least-Once Delivery**: Build asynchronous confirm handlers in Go that guarantee no message is silently dropped, including nack handling and retry logic.
5. **Tune Consumer QoS and Acknowledgment Strategy**: Choose prefetch values, implement manual ack/nack/reject correctly, and understand how bulk acknowledgment affects throughput and message ordering guarantees.
6. **Design Dead Letter Queues and Exponential Backoff Retry**: Build a full retry pipeline with TTL-based backoff queues, poison message detection, and permanent DLQ routing.
7. **Operate RabbitMQ Clusters with Quorum Queues**: Understand Raft-based quorum queues, network partition handling, and Go-side connection failover for high availability.
8. **Monitor, Tune, and Debug Production RabbitMQ**: Use the Management HTTP API, Prometheus exporter, and structured logging in Go to observe and alert on critical broker metrics.

### Junior → FAANG: Learning Objectives as Interview Anchors

Most junior engineers read learning objectives as a checklist and move on. The more effective approach is to treat each objective as an interview question and practice answering it out loud before writing any code.

**Objective-to-interview mapping:**

Objective 1 (AMQP protocol internals) maps to the interview question "explain the difference between a connection and a channel." The expected answer describes that one TCP connection is shared across many lightweight channels, that channels are not goroutine-safe, and that heartbeats keep the connection alive through firewalls. A candidate who says "a channel is like a connection" fails this immediately.

Objective 4 (publisher confirms) maps to "how do you guarantee a message was received by the broker?" The expected answer names `ch.Confirm(false)`, explains the async confirm loop keyed by `DeliveryTag`, and distinguishes ack from nack. A candidate who says "just check the error from Publish" misses the point entirely.

Objective 5 (consumer QoS) maps to "what happens if you set prefetch to zero?" The answer must include "the broker floods the consumer, causing OOM under any real load." Interviewers at FAANG specifically look for whether you know the failure mode before they ask about the correct value.

**First-job habit:** Before you write any producer or consumer code at a new job, locate the team's existing RabbitMQ library. If there is no shared library, that is a signal the team has technical debt in this area. Understanding the objectives in this chapter tells you what that library should contain.

### Senior @ FAANG: Governance and Skill Investment Strategy

At the senior level, learning objectives are not personal goals but platform capabilities. The question becomes: which of these eight capabilities should be centralized in a shared platform library versus left to individual teams?

**Centralize (platform owns):**

Objectives 3, 6, and 7 (queue management with TTL/max-length, DLX retry topology, cluster connection failover) should be owned by a platform library. The reason is that mistakes in these areas are cluster-wide in impact. A team that omits `x-max-length` on a queue can trigger a memory alarm that blocks every producer on the cluster. The platform library must make the correct behavior the path of least resistance.

**Delegate with constraints (teams own, platform enforces policy):**

Objectives 2 and 5 (exchange type selection, QoS tuning) are application-specific enough that teams must own them. The platform's role is to enforce policy at the broker level: for example, a RabbitMQ operator policy that enforces `x-max-length` on any queue in a vhost, regardless of what the declaring application sets. This is the "pave the path" approach at infrastructure level.

**Maturity signal for L6 bar-raising:**

A strong L6 candidate can distinguish between these two categories without prompting. They propose which objectives become shared infrastructure and which remain local concerns, name the failure modes that justify centralization, and describe a rollout strategy that migrates existing services without downtime. The ability to scope a platform investment at this granularity separates senior engineers who can own a platform from those who can only use one.

---
