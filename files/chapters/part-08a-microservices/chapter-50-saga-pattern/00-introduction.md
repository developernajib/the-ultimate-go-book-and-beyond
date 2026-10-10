# Chapter 50: Saga Pattern for Distributed Transactions

*In a distributed system, you can't have both perfect consistency and high availability. The saga pattern lets you achieve eventual consistency while maintaining system resilience.*

Every non-trivial business operation touches multiple services. Placing an order requires reserving inventory, processing payment, scheduling fulfillment, and triggering notifications - and all of these must either succeed together or fail cleanly without leaving the system in an inconsistent state. In a monolith, a single database transaction handles this atomically. In a microservices architecture, each service owns its own database, and there is no transaction coordinator that spans them all. The classic solution - two-phase commit - scales poorly, introduces a single point of failure in the coordinator, and holds locks across service boundaries for the duration of the transaction, destroying throughput under load.

The Saga pattern replaces the distributed transaction with a sequence of local transactions, each performed by a single service and each paired with a compensating transaction that semantically undoes its effect if a later step fails. The result is eventual consistency rather than strict ACID atomicity - but for most business operations, eventual consistency is sufficient, and the availability and throughput gains are dramatic. The pattern comes in two forms: choreography, where each service listens for events and decides independently what to do next, and orchestration, where a central coordinator drives the workflow and knows the full sequence. Both have their place, and production systems often use both depending on the complexity of the workflow.

This chapter covers both saga variants in complete Go implementations: choreography-based sagas using Kafka events, orchestration-based sagas with a Go coordinator, compensating transaction design, and integration with Temporal for durable, fault-tolerant workflow execution that survives coordinator crashes.

> **Senior track**: In 2026 the practical question is rarely "choreography or orchestration" in the abstract. It is "do I build a hand-rolled orchestrator or adopt a durable-execution engine like Temporal, Restate, or Netflix Conductor." If your workflow has more than three steps, non-trivial compensation, or any human-in-the-loop timers, reach for Temporal first. You only hand-roll when the workflow is truly small, when you cannot add operational surface area, or when you need saga semantics inside an existing event bus that already carries domain events.

**What you'll learn in this chapter:**
- Why two-phase commit fails in microservices environments and how the Saga pattern addresses its limitations
- Implementing choreography-based sagas using Kafka events with idempotent consumers and at-least-once delivery
- Building orchestration-based saga coordinators in Go with explicit state machines and step sequencing
- Designing compensating transactions that correctly undo partial work while handling idempotency and partial failures
- Managing saga state persistence so workflows survive coordinator restarts and process crashes
- Integrating with Temporal for durable, fault-tolerant workflow execution with automatic retries and timeouts
- Implementing saga monitoring with state transition logging, stuck-saga detection, and alerting
- Choosing between choreography and orchestration based on workflow complexity, team boundaries, and observability needs

**Why this matters at scale:**
Uber's trip lifecycle (matching, routing, payment, driver payout, receipt generation) runs through saga-like workflows processing millions of transactions per day, where each step can fail independently and compensating actions must unwind partial state across separate microservices. Amazon's order fulfillment pipeline uses similar patterns to maintain consistency across inventory, payment, and logistics services without distributed locking.

**Prerequisites:** Chapter 47 (Microservices Architecture), Chapter 49 (Event-Driven Architecture), Chapter 11 (Go concurrency)

### Junior -> FAANG: Framing the Saga Pattern Before Your First Interview

Most engineers first encounter the saga pattern through a job posting that lists it as a required skill. Before you read any code in this chapter, commit to two facts. First, the saga pattern exists because microservices cannot share a database transaction, not because engineers wanted complexity. Second, eventual consistency is not a weaker guarantee. It is a deliberate engineering trade-off with precise semantics that a FAANG interviewer expects you to articulate.

Before an interview, make sure you can answer these questions without hesitation:

- Why does two-phase commit fail in a microservices architecture? (Coordinator crash leaves participants in uncertain state, locks held across service boundaries destroy throughput, network partitions make the outcome indeterminate.)
- What is the difference between a compensating transaction and a rollback? (A rollback undoes a change atomically within the same database connection. A compensation is a new, separate transaction that semantically reverses a committed change at the application level.)
- What does idempotent mean and why must compensations be idempotent? (Calling the function twice produces the same result as calling it once. Compensations must be idempotent because network retries, timeouts, and orchestrator restarts will cause them to execute more than once.)

A worked example that grounds the theory: you place an order. Step 1 creates the order record. Step 2 reserves inventory. Step 3 charges payment. If step 3 fails, you cannot call `ROLLBACK` across all three databases. Instead, compensation runs in reverse: release the inventory reservation, then cancel the order record. Each of these is itself a new transaction that commits locally.

The first-job habit to build: every time you write a saga step, write its compensation immediately in the same pull request. Never merge a forward action without a compensation. Reviewers at FAANG will ask "where is the compensating transaction for this step" and expect the answer to be in the same diff.

### Senior @ FAANG: Staff-Level Framing for Saga Architecture Decisions

By L6 the question is never "what is a saga." The question is "how do you choose the right saga infrastructure for a given team and product maturity level, and how do you govern that choice across an organization." The three dimensions that drive this decision are workflow complexity (step count, branching, human-in-the-loop gates), operational surface area (what your team is willing to own and on-call for), and blast radius (what happens when the coordination layer fails).

**ADR template for saga infrastructure selection:**

The Architecture Decision Record for choosing between hand-rolled orchestration, Temporal, and choreography should capture at minimum: (1) the maximum number of saga steps expected in the next 12 months, (2) whether any steps require human approval gates or long-running timers (days or weeks), (3) whether the team has operational experience with the candidate infrastructure, (4) what the replay and determinism constraints mean for your workflow code, and (5) the cost of migrating to a different engine once workflows are in production (extremely high, because workflow history is written in the engine's internal format).

**Governance: preventing saga proliferation:**

At scale, the problem is not building one saga, it is preventing 40 teams from each building a different saga engine with incompatible observability, different idempotency disciplines, and no shared runbooks. Staff engineers establish a platform recommendation: one approved engine (typically Temporal at FAANG scale), one saga library with shared base types for saga state and compensation results, one canonical dashboard template, and mandatory alerting rules checked in CI. Any team that deviates needs an approved ADR.

**Maturity model for saga implementations:**

Level 1 (prototype): in-memory state, no idempotency checks, no timeout handling, no monitoring. Acceptable in a hackathon, never in production.

Level 2 (basic production): persistent state, idempotent compensations, saga-level timeouts. Minimum bar for any team going live.

Level 3 (production hardened): distributed locking for orchestrator HA, dead-letter state with alerting, per-saga-type SLO on convergence time, compensation failure escalation to a human review workflow, saga history queryable by operators.

Level 4 (platform): shared saga library used by 10 or more teams, centralized Temporal namespace governance, per-namespace isolation boundaries, workflow versioning policy enforced in CI, cost attribution per workflow type, auto-detection of non-determinism errors in worker logs.

**Bar-raiser interview signals:**

An L6 candidate presenting a saga design is expected to: name the pivot transaction and justify its placement in the workflow, explain how the compensation of a non-refundable purchase differs from a refundable one and what the system does about it, describe how they would detect a stuck saga without polluting the on-call queue with false positives from legitimately long workflows, and explain how they would safely update a running Temporal workflow definition without breaking in-flight executions (workflow versioning with `workflow.GetVersion`).

The L7 signal is moving from design to governance: "how would you roll this out to 20 teams over 6 months, what would you measure to know it is working, and what would cause you to stop the rollout."

---
