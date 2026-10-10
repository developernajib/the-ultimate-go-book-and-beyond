# Chapter 58: System Design Fundamentals

*System design is not about finding the perfect solution. It's about understanding trade-offs and making informed decisions.*

Every large-scale failure in production - the database that could not handle peak traffic, the monolith that
became impossible to deploy, the caching layer that caused stale data to persist for hours - traces back to a
system design decision made without a clear framework. When engineers skip the fundamentals and jump straight to
implementation, the consequences compound silently until a high-traffic event exposes every skipped trade-off
simultaneously. Understanding how distributed systems actually behave under load, partition, and failure is not
optional at senior level. It is the baseline expectation.

Go is widely adopted for infrastructure and distributed systems because it was designed for this domain. Goroutines
and channels map naturally onto concurrent service architectures. The standard library provides production-grade
HTTP, gRPC, and database tooling without third-party dependencies. The runtime's garbage collector is tuned for
low-latency server workloads. Go's idioms - explicit error handling, interface-based composition, minimal magic -
align with the same clarity that good system design demands: no hidden state, no implicit behavior, no surprises
under load.

This chapter establishes the core conceptual vocabulary of distributed systems design. You will work through
CAP theorem and its practical successor PACELC, consistency models from linearizability to eventual consistency,
horizontal and vertical scaling strategies, database selection frameworks, load balancing algorithms, caching
patterns with proper invalidation, and asynchronous processing with message queues. Each concept is grounded in
real architectural decisions rather than abstract theory, with Go implementation patterns throughout.

**What you'll learn in this chapter:**
- The CAP theorem and PACELC model: what consistency, availability, and partition tolerance mean in practice
  and how to choose between CP and AP systems for different data types
- Horizontal versus vertical scaling strategies, including when each applies and how stateless service design
  enables elastic scale without shared mutable state
- Database selection frameworks: when to choose relational, document, column-family, key-value, or time-series
  stores based on access patterns and consistency requirements
- Load balancing algorithms - round-robin, least-connections, consistent hashing, and weighted routing - and
  how to implement health checking in Go
- Caching architectures: cache-aside, write-through, write-behind, and read-through patterns with appropriate
  invalidation strategies for each use case
- Message queue and event streaming patterns for decoupling services, including backpressure, at-least-once
  delivery, and idempotency requirements
- Sharding and partitioning strategies for databases and distributed caches, including hotspot avoidance and
  online rebalancing without downtime
- How to structure a system design discussion: estimation first, component selection, trade-off articulation,
  and failure mode analysis

**Why this matters at scale:**
Google's Spanner navigates the tension between consistency and global distribution by sacrificing some
availability in exchange for external consistency across datacenters - a decision rooted in the concepts
covered here. Uber's migration from a monolith to microservices, Stripe's database sharding strategy, and
Netflix's resilience engineering all required this same foundational thinking applied at large scale.

**Prerequisites:** Chapters 1-10 (Go fundamentals), Chapter 11 (goroutines and channels), Chapter 43 (gRPC services)

### Junior → FAANG: Getting Your Bearings Before the Whiteboard

The most common failure mode for junior candidates in system design interviews is jumping straight to a specific technology, "I would use Kafka" or "I would use Redis" before understanding what problem needs solving. The fundamentals in this chapter exist to prevent that failure.

Before your first system design screen, internalize two things. First, distributed systems make trade-offs, not choices. Every architecture decision gives something up. Second, the interview is evaluating whether you can reason about trade-offs out loud, not whether you know the perfect answer.

A concrete first-job habit: when you encounter any production incident at your current employer, write down in your own words which CAP property was violated, which consistency model the system assumed, and whether the failure was a scaling failure, a caching failure, or an availability failure. Do this for three or four incidents and the vocabulary in this chapter will become second nature.

Entry-level interview framing: you are expected to know what the CAP theorem states and be able to give two real examples of CP and AP systems with the reason for each classification. You are not expected to have designed a globally distributed database, but you are expected to know why global distribution is hard and which dimension (latency, consistency, or availability) you sacrifice to achieve it.

### Senior @ FAANG: Platform Thinking and Architectural Governance

At L6 and above, you are not evaluated on whether you know these fundamentals. You are evaluated on whether you apply them consistently across a team, a platform, or an organization, and whether you can prevent other engineers from violating them silently.

**Architecture Decision Records for distributed trade-offs.** Every system that makes a CAP choice should have an ADR that records: which model was chosen (CP or AP), under what traffic assumptions, and what the rollback plan is if those assumptions are wrong. Without this record, the team that inherits the system has no way to know whether the eventual-consistency choice was deliberate or accidental. At FAANG scale, accidental eventual consistency in a financial subsystem is a compliance risk, not just a correctness bug.

**Maturity model for system design practices.** A useful framework for evaluating a team's architectural maturity across five levels:
- Level 1: All design decisions are made ad hoc, no documentation, no review process.
- Level 2: Design reviews exist but are informal. Trade-offs are stated verbally and lost.
- Level 3: ADRs are written for major components. Consistency models are documented per data type.
- Level 4: Platform-level tooling enforces constraints. For example, a service mesh enforces timeouts and retry budgets so individual teams cannot accidentally create unbounded retry storms.
- Level 5: Architecture decisions feed back into capacity planning. Consistency model choices are tracked against SLO performance and revisited quarterly.

Most FAANG teams operate at Level 3 to 4. Staff engineers are responsible for moving their domain from one level to the next, which requires writing standards, doing design reviews, and building the tooling that makes the right choice the easy choice.

**Bar-raiser signals in L7 design interviews.** At the senior/staff level, interviewers are looking for unprompted discussion of: failure mode analysis for each component, the cost of the chosen consistency model in terms of latency (cite actual numbers, not just "slower"), explicit mention of which SLOs are affected by each trade-off, and recognition of where the design will break first under 10x load. A candidate who produces a correct architecture diagram but cannot explain what happens when any single component fails is capped at L5.

**Go-specific platform concerns.** Go's standard library and runtime make certain distributed system patterns straightforward, connection pooling via `database/sql`, context propagation for deadline enforcement, goroutines for parallelism. At the staff level, the concern shifts to how these primitives are used consistently across a fleet of services. A common governance concern: teams independently set `http.Transport` parameters (idle connection counts, timeouts, dial timeouts) without coordination, resulting in inconsistent behavior under load. A platform team at L7 builds a shared HTTP client factory with organization-wide defaults, exposes override points only for justified exceptions, and tracks deviations via service mesh telemetry.

---
