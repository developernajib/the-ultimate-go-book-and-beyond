# Chapter 90D: Advanced Architecture Patterns - CQRS, Event Sourcing, Saga, Hexagonal

*"Architecture is the decisions that are hard to change."* - Martin Fowler

Every non-trivial service eventually outgrows the simple CRUD model. A single shared database schema becomes a bottleneck when read and write workloads have different performance characteristics. A single transaction boundary becomes a liability when business processes span multiple services or require compensation logic. A layered architecture built around framework conventions becomes a trap when business rules leak into HTTP handlers and SQL queries. The patterns in this chapter - CQRS, Event Sourcing, Saga, and Hexagonal Architecture - are the architectural responses to these pressures. They are not academic abstractions. They are the patterns that production systems at scale are forced to discover, often the hard way, and that this chapter gives you before you have to learn them from incidents.

For Go engineers specifically, these patterns have a unique resonance. Go's explicit interfaces, absence of inheritance, and emphasis on composition are not constraints to work around. They are the mechanism by which these architectures are enforced at compile time. Hexagonal Architecture's Ports and Adapters model maps directly onto Go interfaces at domain boundaries: the domain package defines interfaces (ports), the infrastructure package provides implementations (adapters), and the import graph itself enforces that no infrastructure concern bleeds into domain logic. CQRS command and query buses are straightforward to implement as typed function maps. Event Sourcing aggregates are clean Go structs with a single `Apply` method. The language is not just compatible with these patterns. It makes them less ceremonious than in any other mainstream language.

This chapter is structured as a progression from architectural philosophy to running code. It opens with Hexagonal Architecture - the foundation that makes the other patterns coherent - then introduces CQRS as the technique for separating command and query models, then builds Event Sourcing on top of the command side to replace mutable state with an immutable event log, then addresses Saga patterns for orchestrating distributed transactions across service boundaries, and finally covers the Outbox pattern for reliably publishing events without dual-write races. Each section includes production-grade Go code, pitfall analysis, and explicit guidance on when to apply and when to avoid each pattern.

**What you'll learn in this chapter:**
- Implement Hexagonal Architecture (Ports and Adapters) in Go, enforcing strict inward dependency flow through package structure and interface boundaries
- Separate command and query models with CQRS, building independent read and write stacks that can be scaled and optimized independently
- Design an Event Sourcing aggregate in Go with `Apply`, `LoadFromHistory`, and `UncommittedEvents`, backed by a PostgreSQL append-only event store
- Implement optimistic concurrency control on the event store to prevent lost updates under concurrent writes
- Build aggregate snapshots to bound event replay cost for long-lived aggregates in production
- Implement the Choreography-based Saga pattern using domain events, and the Orchestration-based Saga pattern using a process manager
- Apply the Outbox pattern to atomically publish domain events alongside state changes in the same database transaction, eliminating dual-write races
- Choose between simple CRUD, Level 2 CQRS, and full Event Sourcing based on concrete criteria around audit requirements, query flexibility, and operational complexity

**Why this matters at scale:**

A trip lifecycle at ride-hailing scale is the textbook Event Sourcing workload: regulatory compliance requires reconstructing exactly what happened and when for any trip, years after the fact, which only an immutable state-transition log provides. The Outbox pattern is how event-driven microservice fleets guarantee that database writes and event publications are atomic, ensuring downstream consumers never miss an event even when the publishing service crashes between write and publish. Service frameworks at monorepo-scale companies commonly enforce hexagonal boundaries through mandatory interface layers, which is what makes it possible to swap storage backends and transport protocols without touching domain code.

**Prerequisites:** Chapter 52D (CQRS and Event Sourcing fundamentals), Chapters 52B-52C (DDD Fundamentals and DDD with Go), and familiarity with PostgreSQL transactions and basic message queue concepts.

---
