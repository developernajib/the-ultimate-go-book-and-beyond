# Chapter 52B: Domain-Driven Design Fundamentals

> "The heart of software is its ability to solve domain-related problems for its users. All other features, vital as they may be, support this basic purpose." - Eric Evans, *Domain-Driven Design*

As software systems grow in complexity, the most dangerous thing that can happen is for the code to stop reflecting the business it models. Databases accumulate tables whose names mean nothing to domain experts. Service classes become God objects that mix persistence, validation, orchestration, and business rules indiscriminately. Engineers spend more time reverse-engineering what a module does than adding value. Domain-Driven Design (DDD) is Eric Evans's answer to this entropy: a set of strategic and tactical patterns that keep the code aligned with the domain it models, the language used by the engineers aligned with the language used by the business, and the system's internal boundaries aligned with the natural seams in the problem space.

DDD operates at two levels. Strategic DDD addresses the large-scale structure of a system: how to decompose a complex domain into Bounded Contexts - autonomous sub-domains with their own models and teams - and how those contexts communicate through well-defined integration patterns such as Shared Kernel, Customer-Supplier, or Anti-Corruption Layer. Tactical DDD provides the building blocks within a Bounded Context: Entities (objects with a continuous identity that persists through state changes), Value Objects (immutable descriptors defined entirely by their attributes), Aggregates (consistency boundaries that group related objects under a single Aggregate Root), Domain Events (facts about things that happened in the domain), and Repositories (the abstraction that decouples the domain model from its persistence mechanism). Together these patterns give you a vocabulary for designing systems where the code is a faithful, executable model of the business.

Go is an unusually good language for DDD despite - or because of - its simplicity. Its structural typing and interface system enforce the Dependency Inversion Principle without ceremony. Its absence of inheritance prevents the fragile base-class hierarchies that plague DDD implementations in Java or C#. Explicit error returns force you to model domain failures as first-class concepts rather than exceptions. And the language's emphasis on composition over inheritance maps naturally to the aggregate-and-value-object model that DDD prescribes. This chapter lays the conceptual and practical foundation, and subsequent chapters apply it to a full Go project.

**What you'll learn in this chapter:**

- Distinguish between strategic DDD (Bounded Contexts, Context Maps, integration patterns) and tactical DDD (Entities, Value Objects, Aggregates, Domain Events)
- Define and apply Ubiquitous Language so that struct names, method names, and package names mirror the vocabulary used by domain experts
- Identify Bounded Context boundaries by analyzing linguistic ambiguity - the same word meaning different things in different parts of the business is a reliable seam signal
- Implement Entities with stable identity and Value Objects with immutability and structural equality in idiomatic Go
- Design Aggregates as transactional consistency boundaries, selecting Aggregate Roots that enforce invariants across the entire cluster
- Emit Domain Events from Aggregate state transitions and route them through an in-process dispatcher to interested handlers
- Implement the Repository pattern with a clean interface that keeps the domain model completely ignorant of persistence technology
- Build an Anti-Corruption Layer (ACL) to translate between an external model (third-party API, legacy system) and your clean domain model

**Why this matters at scale:**

Amazon's microservices architecture follows Bounded Context thinking: each service owns a single subdomain and speaks its own model, communicating with others only through published contracts. Uber's engineering blog credits DDD patterns with enabling their move from a monolith to hundreds of independent services without rewriting business logic. Spotify's squad model maps to strategic DDD: each squad owns a Bounded Context and integrates with other squads only through defined interfaces. Without these foundations, large codebases accumulate coupling that makes every change a system-wide risk.

**Canonical references used throughout this chapter:**

- Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software* (2003) - the "Blue Book" that introduced strategic and tactical DDD and is still the definitive primary source.
- Vaughn Vernon, *Implementing Domain-Driven Design* (2013) - the "Red Book" that turned Evans's concepts into concrete implementation patterns (aggregates, events, CQRS).
- Vlad Khononov, *Learning Domain-Driven Design* (O'Reilly, 2021) - the current go-to introduction, reframing DDD around business subdomain types (Core / Supporting / Generic) and aligning it with modern architecture (microservices, event-driven, data mesh).
- Alberto Brandolini, *EventStorming* - the collaborative modeling technique that, by 2026, is the default facilitation tool most teams use to discover bounded contexts before they write a line of code.
- The [DDD Crew](https://github.com/ddd-crew) resources, maintained by Nick Tune and others, for context mapping cheat sheets, bounded-context canvases, and the modern Starter Modeling Process.

**Prerequisites:** Solid Go fundamentals (structs, interfaces, goroutines), plus familiarity with relational databases and basic REST API design.

### Junior → FAANG: Getting Oriented in DDD Before Your First PR

Most engineers encounter DDD for the first time mid-project, not before it starts. The gap is usually not knowing which layer owns which concern. Before touching any code in a DDD codebase, answer three questions: Where is the domain package? What does the repository interface look like, and where is it declared? What naming convention does the team use for domain events?

A common first-job mistake is placing validation in the HTTP handler because "that's where the data arrives." In DDD codebases that logic belongs in either the aggregate constructor or the value object constructor. If you see input being checked in a handler file and the same check missing from the domain type, that is a defect waiting to happen, and flagging it in a code review will mark you as someone who understands the architecture.

For interviews at the entry-to-mid level, the question you are most likely to encounter is: "What is the difference between an entity and a value object?" Have a concrete answer ready with examples from the domain being discussed in the interview. Then expect a follow-up about how you enforce immutability in Go for value objects, since Go has no `final` keyword. The answer involves unexported fields, a validating constructor that returns an error, and value receivers on all methods.

The FAANG entry bar also expects you to understand why the repository interface is declared in the domain package and implemented in the infrastructure package. If you can explain that in terms of the Dependency Inversion Principle without hesitation, you will pass the conceptual screen.

### Senior @ FAANG: Architectural Governance and Platform Maturity for DDD at Scale

At the senior and staff level, DDD work shifts from implementation to governance. The questions you face are no longer "how do I write this aggregate?" but "how do we prevent the next team from putting domain logic in the HTTP handler?" and "how do we evolve integration event schemas without breaking twelve downstream consumers?"

**Bounded context ownership as an ADR.** Before a new bounded context is created, a senior engineer should author an Architecture Decision Record capturing: the linguistic boundary justification (which words mean different things on each side), the team ownership model, the integration pattern with each adjacent context (Customer-Supplier, ACL, Open Host Service), and the Core/Supporting/Generic classification. That classification directly drives staffing and build-vs-buy decisions. A Generic subdomain that a team is hand-building from scratch is a funding conversation.

**Context map as a living governance artifact.** A context map drawn once and filed is worthless. At companies like Shopify and Uber, the context map is maintained as a machine-readable artifact (sometimes a YAML registry, sometimes a service catalog entry) and reviewed in architecture forums when a new dependency is proposed between contexts. The review question is always: "Which integration pattern should this be, and does the proposed implementation match?" A team that hard-codes a gRPC call from Orders to Inventory without an ACL when Inventory is a separate team's context is creating an undocumented Conformist relationship, which typically means the downstream team gets broken whenever Inventory changes its proto.

**Aggregate boundary decisions as load tests for your consistency model.** Senior engineers at FAANG-scale learn that aggregate boundaries are not just a modeling concern, they are a latency and throughput concern. An aggregate that spans too many entities serializes writes: every concurrent order update on the same customer's aggregate requires a row-level lock or an optimistic concurrency retry. The right signal to split an aggregate is when your version conflict rate under load testing exceeds one to two percent. Below that threshold the simplicity of a unified aggregate is worth it. Above it, you model eventual consistency via domain events.

**Schema governance for integration events.** Domain events inside a bounded context can be refactored freely. Integration events published to a message bus are a public API. Senior engineers establish a schema registry (Confluent Schema Registry for Avro, Buf Schema Registry for Protobuf) and enforce backward-compatibility rules in CI. The governance rule is: you may add optional fields to an existing event version, you may never remove or rename fields, and breaking changes require a new topic or event type with a parallel-publish period and a deprecation timeline communicated to all consumers. The ADR for a new integration event should include a deprecation plan written before the event is shipped.

**EventStorming facilitation as a staff-level skill.** The most valuable pre-design activity for a complex domain is an EventStorming workshop. At the L6/L7 level, you are expected to facilitate this, not just participate. Facilitation means: ordering post-its on the timeline, identifying the "hot spots" (areas of confusion or disagreement that signal a boundary), naming the bounded contexts that emerge, and translating the output into a context map and a set of aggregate candidates. Teams that skip EventStorming and go straight to microservice diagrams routinely discover six months later that they drew the boundaries in the wrong place, and refactoring context boundaries in production is an order of magnitude more expensive than getting them right before the first deployment.

**DDD maturity model for code review and hiring.** When raising the bar in code review or interviewing at the senior level, use this progression: Level 1 (novice) is an anemic model with all logic in service classes. Level 2 is rich domain objects but no consistent use of ubiquitous language. Level 3 is rich domain objects with ubiquitous language enforced in code, but aggregates are too large and context boundaries are unclear. Level 4 is well-bounded contexts, small aggregates, domain events used for cross-context integration, and repositories tested with in-memory fakes. Level 5 (staff) is all of Level 4 plus: integration event schemas governed in a registry, EventStorming used before design, context map maintained as a governance artifact, and aggregate boundary decisions informed by observed concurrency conflict rates. A bar-raiser interview at L6 expects the candidate to describe work they have done at Level 4 and show awareness of Level 5 concerns.

---
