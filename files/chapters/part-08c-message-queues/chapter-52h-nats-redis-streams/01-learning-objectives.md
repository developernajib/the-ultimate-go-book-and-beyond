## Learning Objectives

By the end of this chapter, you will be able to:

- **Design NATS subject hierarchies using dot-notation, wildcards (`*`, `>`), and queue groups for load-balanced subscribers**
- **Configure JetStream streams with appropriate retention policies, storage backends, and replication for production workloads**
- **Implement both push and pull JetStream consumers with correct ack policies and backoff retry strategies**
- **Build distributed key-value stores and reactive configuration systems using the NATS KV API**
- **Use Redis Streams XADD/XREAD/XGROUP/XACK for persistent, ordered, consumer-group-based message processing**
- **Implement XPENDING and XCLAIM for dead-consumer recovery and at-least-once delivery guarantees**
- **Apply CQRS and event sourcing patterns using Redis Streams as the immutable event log**
- **Select the correct messaging technology from a decision matrix covering NATS, Redis Streams, Kafka, and RabbitMQ**

### Junior -> FAANG: Turning Objectives into Interview Checkpoints

Learning objectives are most useful when you treat them as interview checkpoints rather than a reading list. For each bullet above, ask yourself whether you could explain it on a whiteboard to someone who has never used NATS or Redis Streams. If you can define the concept but cannot draw a sequence diagram or write a 10-line code sketch, the knowledge is not yet interview-ready.

The objectives that entry-level candidates most often fail to convert into hands-on fluency are XPENDING/XCLAIM and the JetStream consumer delivery policies. Both require running actual code against a real broker before the semantics click. Set up a local NATS server with JetStream enabled (`nats-server -js`) and a local Redis (or Valkey) instance, and work through each objective against live infrastructure before treating it as understood.

### Senior @ FAANG: Mapping Objectives to Staff-Level Competencies

The objectives list is written for engineers building services that use these systems. A staff engineer also needs to evaluate them, so the competency map looks different.

Beyond being able to implement each objective, senior engineers at FAANG are expected to know the failure boundary of each guarantee. For example, "implement XPENDING and XCLAIM for at-least-once delivery" requires understanding the edge cases where XAUTOCLAIM creates a duplicate delivery window and what makes that window wider or narrower. "Configure JetStream streams with replication" requires knowing how Raft quorum interacts with AZ topology and what a split-brain scenario looks like in a 3-node cluster across 2 AZs.

The objective most underweighted in the list for senior engineers is the decision matrix. At L6/L7, the skill is not choosing from the four options listed, it is recognizing when none of them fits and framing that as an ADR with explicit trade-offs documented for future engineers. That meta-skill is what bar-raisers test in system design rounds.

---
