## Architecture Overview

The diagram below contrasts request-response and event-driven communication, shows the pub/sub and event sourcing + CQRS flow patterns, compares broker capabilities, and illustrates the transactional outbox pattern for reliable event publishing.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      EVENT-DRIVEN ARCHITECTURE                                    │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  ┌────────────────────── Request-Response vs Event-Driven ─────────────────┐      │
│  │                                                                          │     │
│  │   Request-Response:                  Event-Driven:                       │     │
│  │   ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐        │      │
│  │   │Service A│─────►│Service B│      │Service A│      │Service B│        │      │
│  │   │         │◄─────│         │      │         │      │         │        │      │
│  │   └─────────┘ sync └─────────┘      └────┬────┘      └────┬────┘        │      │
│  │                                          │                │              │     │
│  │   - Tight coupling                       ▼                ▼              │     │
│  │   - Blocking calls              ┌─────────────────────────────┐         │      │
│  │   - Both must be up             │       Event Broker          │         │      │
│  │                                 │  (Kafka/RabbitMQ/NATS)      │         │      │
│  │                                 └─────────────────────────────┘         │      │
│  │                                 - Loose coupling, async                  │     │
│  │                                 - Non-blocking, buffered                 │     │
│  │                                 - Temporal decoupling                    │     │
│  └──────────────────────────────────────────────────────────────────────────┘     │
│                                                                                   │
├───────────────────────────────────────────────────────────────────────────────────┤
│                            EVENT FLOW PATTERNS                                    │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  1. Pub/Sub Pattern:                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                          │     │
│  │   ┌──────────┐   Event    ┌───────────────┐   Event   ┌──────────┐       │     │
│  │   │ Producer │──────────► │    Topic      │─────────► │Consumer A│       │     │
│  │   └──────────┘           │ (e.g. orders) │           └──────────┘        │     │
│  │                          └───────────────┘                               │     │
│  │                                 │                                        │     │
│  │                                 └────────────────► ┌──────────┐          │     │
│  │                                                    │Consumer B│          │     │
│  │                                                    └──────────┘          │     │
│  └──────────────────────────────────────────────────────────────────────────┘     │
│                                                                                   │
│  2. Event Sourcing + CQRS:                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────┐     │
│  │                                                                          │     │
│  │   Commands                              Queries                          │     │
│  │      │                                     │                             │     │
│  │      ▼                                     ▼                             │     │
│  │   ┌───────────┐                      ┌───────────┐                       │     │
│  │   │  Command  │                      │   Query   │                       │     │
│  │   │  Handler  │                      │  Handler  │                       │     │
│  │   └─────┬─────┘                      └─────┬─────┘                       │     │
│  │         │                                  │                             │     │
│  │         ▼                                  ▼                             │     │
│  │   ┌───────────┐                      ┌───────────┐                       │     │
│  │   │  Event    │ ──────────────────►  │  Read     │                       │     │
│  │   │  Store    │      Project         │  Model    │                       │     │
│  │   └───────────┘                      └───────────┘                       │     │
│  │   (Write Model)                      (Materialized Views)                │     │
│  └──────────────────────────────────────────────────────────────────────────┘     │
│                                                                                   │
├───────────────────────────────────────────────────────────────────────────────────┤
│                           BROKER COMPARISON                                       │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│   ┌────────────────┬────────────────┬────────────────┬────────────────┐           │
│   │    Feature     │     Kafka      │   RabbitMQ     │     NATS       │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Throughput     │ Very High      │ Medium         │ Very High      │           │
│   │                │ (millions/sec) │ (10K+/sec)     │ (millions/sec) │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Latency        │ Low            │ Low            │ Very Low       │           │
│   │                │ (5-15ms)       │ (1-5ms)        │ (<1ms)         │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Persistence    │ Yes (log)      │ Yes (optional) │ JetStream only │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Ordering       │ Per partition  │ Per queue      │ Per subject    │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Replay         │ Yes            │ No             │ JetStream only │           │
│   ├────────────────┼────────────────┼────────────────┼────────────────┤           │
│   │ Best For       │ Event Stream   │ Task Queues    │ Real-time      │           │
│   │                │ Log Agg        │ Complex Route  │ Microservices  │           │
│   └────────────────┴────────────────┴────────────────┴────────────────┘           │
│                                                                                   │
├───────────────────────────────────────────────────────────────────────────────────┤
│                         TRANSACTIONAL OUTBOX PATTERN                              │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│   Problem: How to update database AND publish event atomically?                   │
│                                                                                   │
│   ┌─────────────────────────────────────────────────────────────────────────┐     │
│   │                                                                         │     │
│   │   ┌──────────┐   1. Begin TX    ┌───────────────────────────────────┐   │     │
│   │   │  Service │─────────────────►│          Database                 │   │     │
│   │   │          │   2. Insert data │  ┌─────────┐  ┌─────────────────┐ │   │     │
│   │   │          │   3. Insert event│  │  Data   │  │  Outbox Table   │ │   │     │
│   │   │          │   4. Commit TX   │  │  Table  │  │  (events)       │ │   │     │
│   │   └──────────┘◄─────────────────│  └─────────┘  └────────┬────────┘ │   │     │
│   │                                 └────────────────────────│──────────┘   │     │
│   │                                                          │              │     │
│   │   ┌──────────┐   5. Poll outbox                          │              │     │
│   │   │  Relay   │◄──────────────────────────────────────────┘              │     │
│   │   │ Process  │                                                          │     │
│   │   │          │   6. Publish to broker                                   │     │
│   │   │          │──────────────────────► ┌──────────────┐                  │     │
│   │   │          │   7. Mark as sent      │ Event Broker │                  │     │
│   │   └──────────┘◄──────────────────────│              │                   │     │
│   │                                       └──────────────┘                  │     │
│   │                                                                         │     │
│   └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                   │
│   Guarantees: At-least-once delivery (consumers must be idempotent)               │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams as a Learning Tool

Architecture diagrams are often the first thing skipped and the most valuable thing studied. Each section of this diagram represents a question you should be able to answer in an interview.

The request-response vs event-driven diagram answers: "why does synchronous coupling hurt availability?" The math is simple: if Service A and Service B each have 99.9% uptime, the chain has 99.8% uptime. With a broker in the middle, Service A's availability is independent of Service B's availability as long as the broker is running.

The pub/sub pattern diagram answers: "how does a producer not knowing its consumers enable independent deployment?" The producer writes to a topic. Consumer A and Consumer B are deployed, updated, or scaled without any change to the producer. This is the core organizational benefit.

The event sourcing and CQRS diagram answers: "why would I use a separate write model and read model?" The write model (event store) is optimized for appending events with concurrency checks. The read model (materialized views) is optimized for the specific query patterns of a UI or API. Trying to use the same data model for both usually means doing both poorly.

The transactional outbox diagram answers: "how do I publish an event only if the database transaction commits?" The relay process reads from the outbox only after the row has been durably committed. The event can never be published for an order that was rolled back.

**Study habit.** Before writing any code in this chapter, draw each of these diagrams from memory. If you cannot, re-read that section. Diagrams encode the conceptual model that makes the code make sense.

**Interview entry point.** Many junior interviews on distributed systems use diagrams as a starting point. Being able to draw the outbox pattern flow (service writes to both business table and outbox in one transaction, relay polls outbox, relay marks as sent) and explain each step concisely signals that you understand the problem, not just the solution.

### Senior @ FAANG: Using Architecture Diagrams in Design Reviews

At the staff level, you produce these diagrams rather than consume them. Here is how to make them more useful in a real design review.

The broker comparison table in this chapter is a reasonable starting point but lacks the dimensions that actually drive production decisions: operational footprint (how many engineers need to understand broker internals to keep it running), managed service availability (Confluent Cloud, Amazon MSK, Google Pub/Sub, CloudAMQP), compliance implications (can you use a managed service or must you run on-prem for data residency), and cost model at your specific volume (Kafka on MSK is priced per broker-hour plus storage, which has very different break-even points than Pub/Sub's per-message pricing).

For a production architecture review, the outbox diagram should also show: what monitors the outbox row count and oldest unprocessed row age, what the alerting threshold is, what happens during a relay process outage (rows accumulate, lag grows, but no data is lost), and how the relay handles transient Kafka broker unavailability (it backs off and retries, the outbox row stays unprocessed until the broker recovers).

The CQRS diagram should show projection lag: the time between an event being committed to the event store and the projection reflecting it in the read model. In a system under load, this lag can be several seconds, and your API must decide whether to return stale read-model data or block and wait for the projection to catch up. Documenting this explicitly in the design review prevents the "stale data" bug report from surprising the team six months later.

**ADR consideration.** Every architecture diagram should be accompanied by an ADR that records what alternatives were considered and why they were rejected. The outbox diagram implies a choice over three alternatives: synchronous dual-write (rejected because a Kafka failure would fail the HTTP request), two-phase commit (rejected because it is complex, slow, and not supported by all Kafka client versions), and Kafka transactions (rejected because they do not cover the Kafka-to-Postgres atomicity problem). Recording these rejections prevents the team from relitigating the same decisions six months later.

---
