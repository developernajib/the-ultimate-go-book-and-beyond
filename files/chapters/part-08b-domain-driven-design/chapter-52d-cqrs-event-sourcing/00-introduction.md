# Chapter 52D: CQRS and Event Sourcing

> "Instead of storing just the current state of the data in a domain, use an append-only store to record the full series of actions taken on that data." - Martin Fowler, *Event Sourcing Pattern*

Most databases store the present. They record what an order's current status is, what a user's current balance is, what a product's current price is. Queries and commands share the same model, the same tables, and the same schema - which means read performance is constantly competing with write throughput, and every schema change must serve both concerns simultaneously. Command Query Responsibility Segregation (CQRS) breaks this coupling by maintaining separate models for writes (commands that change state) and reads (queries that return views). The write model is optimized for enforcing invariants and persisting decisions. The read model is optimized for the specific queries the UI and API consumers actually make, often denormalized and pre-computed into projection tables that require no joins at query time.

Event Sourcing takes this further by changing what the write model stores. Rather than persisting the current state of an aggregate, an event-sourced system persists the sequence of domain events that caused that state - every `OrderPlaced`, `ItemAdded`, `PaymentReceived`, and `OrderShipped` event is appended to an immutable event log. The current state is a derived view, reconstructed by replaying the event history through the aggregate's `Apply` method. This means you never lose business history, you can reconstruct any past state by replaying up to a point in time, and adding a new read projection is a matter of replaying the event log through a new handler - no migration required. The trade-off is real complexity: optimistic concurrency control, snapshot strategies for long-lived aggregates, and projection rebuilds must all be handled carefully.

Together, CQRS and Event Sourcing form the architectural backbone of systems where auditability, temporal queries, and independent read/write scaling are non-negotiable - financial platforms, e-commerce order management, healthcare records, and any system where "what happened and why" is as important as "what is the current state." This chapter implements both patterns in Go against a PostgreSQL event store, integrates them with the DDD aggregate model from the previous chapters, and addresses the operational realities - snapshot management, projection consistency guarantees, and saga orchestration - that separate toy implementations from production systems.

**What you'll learn in this chapter:**

- Design a CQRS architecture with a command bus, command handlers, and separate read model projection tables that are independently queryable without joins
- Implement a query bus in Go that routes queries to dedicated handlers, keeping read logic completely isolated from write logic
- Build event-sourced aggregates in Go with `Apply`, `LoadFromHistory`, and `UncommittedEvents` methods following the aggregate pattern established in Chapter 52B
- Implement a PostgreSQL event store with append-only writes, optimistic concurrency control via version numbers, and transactional event publishing
- Build read model projectors that consume domain events and maintain denormalized views for fast queries, with idempotent event processing
- Implement aggregate snapshots - periodic state checkpoints stored alongside the event log - to keep replay time bounded as event counts grow
- Design and implement a process manager (saga) using event sourcing to coordinate multi-step business workflows across aggregate boundaries
- Combine CQRS, Event Sourcing, and DDD aggregates into a coherent architecture and reason about the trade-offs at a Staff Engineer level

**Why this matters at scale:**

Axon Framework (widely used in Java DDD communities) and EventStoreDB exist because CQRS and Event Sourcing are standard architecture at financial institutions: Monzo, Starling Bank, and N26 all use event-sourced ledgers where every financial transaction is an immutable fact appended to an event log, with current balances derived as projections. LinkedIn's activity feed - billions of events per day - uses a CQRS model where write throughput and read query patterns are completely decoupled, enabling each to scale independently. Microsoft's Azure Cosmos DB and AWS EventBridge both provide native event-sourcing primitives because the pattern has moved firmly into mainstream enterprise architecture.

**Prerequisites:** Chapters 52B and 52C (DDD Fundamentals and DDD with Go), solid understanding of PostgreSQL transactions, and familiarity with Go interfaces and the repository pattern.

### Junior → FAANG: Getting Your Bearings Before Writing a Single Line

The introduction is dense, and it is easy to nod along while missing the prerequisite concepts that everything else builds on. Before continuing, make sure you can answer these questions without looking them up:

- What is an aggregate in DDD, and why does it exist?
- What is the difference between a command (intent to change state) and a query (intent to read state)?
- What does "eventual consistency" mean in plain English, and why does it require different product thinking than strong consistency?

If any of those felt shaky, reread Chapters 52B and 52C. This chapter stacks directly on top of them.

The other trap for junior engineers is treating CQRS and Event Sourcing as a bundle. The introduction already signals they are two independent decisions. Practice writing them out separately: "I am using CQRS because read and write models have different shapes. I am also using Event Sourcing because the regulator requires a full audit trail." That sentence structure forces you to justify each pattern on its own merits. If you cannot complete the sentence honestly, you may not need one or both patterns.

A first-job habit worth building now: before touching any of the code examples in this chapter, sketch the data flow on paper. Command arrives, handler loads aggregate, aggregate fires events, repository saves events, projector updates read model, query reads read model. Draw boxes and arrows. This physical act of diagramming turns passive reading into active understanding and will save you hours of debugging later.

For FAANG entry-level interviews, you will be expected to explain what CQRS is and name a real-world system that uses it. LinkedIn's activity feed and Monzo's ledger are covered here and are solid examples. Know one of them well enough to describe the read/write split concretely, not just abstractly.

### Senior @ FAANG: What the Introduction Is Really Signaling

The introduction frames CQRS and Event Sourcing with three real-world anchors: financial ledgers, e-commerce order management, and Azure/AWS native primitives. That framing is deliberate. These patterns crossed the threshold from niche to mainstream precisely because the domains that need them (regulated, high-write, audit-required) have enough engineering budget to absorb the complexity. Your job as a staff-level engineer is to make an explicit, documented judgment about whether your domain qualifies.

The phrase "non-negotiable" in the introduction ("auditability, temporal queries, and independent read/write scaling are non-negotiable") is the ADR trigger. Before a team adopts CQRS or Event Sourcing, you should author an Architecture Decision Record that captures: (1) which specific non-negotiable requirements are in play, (2) what simpler alternatives were considered (a normalized write schema with a few denormalized read views, change data capture via Debezium, a simple append-only audit table), (3) why those alternatives are insufficient, and (4) what the accepted operational costs are (projection lag, replay complexity, snapshot discipline). An ADR without this structure is just a preference document.

The maturity model implied by the introduction has three levels. At level one, the team can implement the patterns from this chapter. At level two, the team can operate them in production: they have projection lag SLOs, snapshot fallback tests, and event schema evolution procedures. At level three, the team governs them across an organization: they have published standards for when to adopt each pattern, event schema registries, shared libraries for the command and query buses, and runbooks for projection rebuilds. Senior ICs are expected to operate at level two. Staff engineers are expected to operate at level three.

Bar-raiser signal: when a candidate says "we used Event Sourcing everywhere," probe what that cost them. The answer reveals whether they made a deliberate architectural choice or followed a template. Strong L6 and L7 answers describe a specific domain requirement that justified the pattern, the trade-offs they accepted explicitly, and what they would have done differently with hindsight. The introduction's Greg Young and Oskar Dudycz references are not name-dropping: they represent the current pragmatic consensus that pushes back on the "Event Sourcing as a default" narrative. A staff engineer who is current in this space will know that consensus.

Platform thinking: if your organization has multiple teams evaluating CQRS and Event Sourcing independently, the staff-level contribution is not implementing it again but building the shared infrastructure (a vetted event store client library, a projection framework with built-in checkpointing and idempotency, a command bus with standardized middleware) that makes the right path the easy path. The introduction's mention of Axon Framework is a hint at what that shared infrastructure looks like at scale. In Go, the opportunity is to provide something similar without the annotation magic, leveraging explicit wiring and interface satisfaction.

---
