# Chapter 52H: NATS JetStream & Redis Streams

*A message queue is only as reliable as its weakest acknowledgment.*

Not every messaging problem requires Kafka's operational overhead or RabbitMQ's complex protocol. When an edge platform needs to propagate configuration changes to hundreds of locations in under a second, or when a startup needs reliable task queuing without provisioning a dedicated broker cluster, the right tools are NATS JetStream and Redis Streams - purpose-built for different points on the simplicity-to-durability spectrum. Both have gained significant adoption among cloud-native microservices that need more than fire-and-forget pub/sub but less than a full Kafka deployment.

NATS was originally designed as a pure at-most-once pub/sub system - fast but without persistence. JetStream, added in NATS 2.2, layered durable storage, consumer groups, and exactly-once semantics on top of NATS's existing subject hierarchy, giving you Kafka-like guarantees with a fraction of the operational complexity. A three-node NATS JetStream cluster can be provisioned in minutes with a single binary and no external dependencies. Redis Streams, introduced in Redis 5.0, takes the opposite approach: if you already run Redis for caching and session storage, you get a persistent, consumer-group-aware message stream for free - no new infrastructure required.

Go is the native language of NATS - the NATS server itself is written in Go, and the official `nats.go` client library provides a well-designed API that maps directly to Go idioms. Redis Streams integrates naturally through `go-redis`, which exposes `XADD`, `XREAD`, `XGROUP`, and `XACK` commands that map cleanly onto Go struct patterns. This chapter covers both systems in depth: when to choose each, how to tune them for production workloads, and how to implement the reliability patterns - acknowledgment, dead-consumer recovery, and CQRS - that prevent silent data loss.

**What you'll learn in this chapter:**
- Designing NATS subject hierarchies with dot-notation, wildcard tokens (`*`, `>`), and queue groups for horizontally scaled subscribers
- Configuring JetStream streams with retention policies, file vs memory storage backends, and replication factors for production durability
- Implementing both push and pull JetStream consumers with correct ack policies, nak-with-delay backoff, and in-flight message limits
- Building distributed key-value stores and reactive configuration systems using the NATS KV API over JetStream
- Using Redis Streams `XADD`/`XREAD`/`XGROUP`/`XACK` for persistent, ordered, consumer-group-based message processing in Go
- Implementing `XPENDING` and `XCLAIM` patterns for dead-consumer recovery and guaranteed at-least-once delivery guarantees
- Applying CQRS and event sourcing patterns using Redis Streams as an immutable event log with materialized read models
- Selecting the right messaging technology using a decision matrix that compares NATS, Redis Streams, Kafka, and RabbitMQ across key dimensions

**Why this matters at scale:**
Propagating firewall rules and cache purges across a global edge network in milliseconds is exactly the fan-out shape NATS was designed for (Cloudflare built its own Quicksilver store for this job, which tells you how demanding the requirement is). Teams everywhere use Redis Streams to implement background job pipelines that coexist with their existing Redis infrastructure, avoiding a separate broker while maintaining consumer group semantics.

**Prerequisites:** Part VIIIC Overview (message queue fundamentals), Chapter 52F (Kafka deep dive for comparative context), Chapter 11 (Go concurrency patterns)

### Junior -> FAANG: Understanding Why Two Systems Instead of One

A common first-job instinct is to pick one message broker and use it everywhere. This chapter introduces two systems because they occupy genuinely different positions on the simplicity-durability axis, and recognizing that difference is a prerequisite for any production messaging decision.

Start by anchoring on the core distinction: NATS core is a telephone call (both parties must be present), while JetStream and Redis Streams are voicemail (the message waits until someone picks up). Most reliability bugs in early-career messaging code come from treating voicemail like a phone call, publishing to NATS core and assuming the subscriber will always be online.

Before reading further, make sure you can answer these questions from first principles:

- What does "at-most-once" mean in terms of subscriber uptime?
- Why does a message queue need disk persistence to guarantee delivery across a subscriber restart?
- What is the difference between a queue (one consumer gets each message) and a topic (all consumers get each message)?

If any of those are fuzzy, re-read the fundamentals chapter before continuing. The code examples here build directly on those concepts without re-explaining them.

A concrete habit for your first production service: always draw a sequence diagram showing what happens when one component restarts in the middle of a message flow before choosing delivery semantics. That diagram will tell you whether you need NATS core, JetStream, or Redis Streams before you write a single line.

### Senior @ FAANG: Framing Messaging Architecture as a Platform Decision

The introduction sets up a chapter that teaches two specific technologies, but a staff-level engineer reads it as a case study in platform thinking: when does adding a second messaging system to a platform create more value than it creates friction?

The premise of the chapter is that NATS JetStream and Redis Streams are "complementary." That is true at the technical level, but at the organizational level, running two messaging systems means two on-call runbooks, two sets of client libraries to version, two security configurations to audit, and two training paths for new engineers. The bar-raiser question is not "can these systems co-exist?" but "what problem decomposition makes their co-existence worth that cost?"

The answer depends on the access pattern taxonomy. NATS core's sub-millisecond RPC pattern has no equivalent in Redis Streams. Redis Streams' co-location with an existing cache tier has no equivalent in a fresh JetStream deployment. If a platform has neither workload, neither system belongs. If it has both, the two-system architecture is justified and the chapter's content maps directly to an Architecture Decision Record worth writing.

For L6/L7 platform design, the introduction raises a maturity model question: is your organization at the point where a single messaging platform (Kafka) is actually simpler than two moderate-complexity systems, because your Kafka operational expertise already exists and your team size justifies the overhead? The chapter's decision matrix in section 52H.8 is where that question gets answered quantitatively, but the introduction is where engineers should start asking it. Strong bar-raiser candidates flag this tension in system design interviews: "Before I choose between these two, I want to know what messaging systems the team already operates, because operational leverage often beats technical optimality."

The governance implication: a platform team should define a messaging technology tier list (approved, provisional, deprecated) and require an ADR with a workload taxonomy before any new messaging system is introduced. This chapter is best read as supplying the vocabulary for that ADR process, not as a permission slip to add both systems to every service.

---
