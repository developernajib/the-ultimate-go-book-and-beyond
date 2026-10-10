# Chapter 52C: DDD with Go - Patterns and Project Structure

> The question is not whether you will have a layered architecture. The question is whether those layers will be deliberate and enforced, or accidental and eroded - the running theme of Vaughn Vernon's *Implementing Domain-Driven Design*.

Understanding DDD patterns conceptually is necessary but insufficient. The real test is whether you can translate bounded contexts, aggregates, repositories, and domain services into a Go project structure that compiles, tests independently, and deploys reliably. Go's packaging system, interface semantics, and module boundaries serve as the enforcement mechanism: if your domain package imports a database driver, the architecture has already failed. If your HTTP handler instantiates an aggregate directly, the layers have collapsed. A well-structured DDD Go project makes these violations compile errors, not code review comments.

The layered architecture that DDD prescribes - Domain, Application, Infrastructure, and Interface layers - maps naturally to Go packages when designed with deliberate dependency rules. The domain package contains pure business logic: aggregates, value objects, domain events, and repository interfaces. It imports nothing outside the standard library. The application package contains use-case orchestration: command and query handlers that coordinate domain objects and call repository interfaces. The infrastructure package contains concrete implementations of those interfaces: PostgreSQL repositories, message bus adapters, external service clients. The interface package contains transport adapters: HTTP handlers, gRPC servers, CLI commands. Dependencies flow strictly inward. Go interfaces at each boundary make every layer independently testable with lightweight fakes rather than spinning up real infrastructure.

Wiring the layers together with constructor-based dependency injection (no magic containers required in Go) keeps the startup graph explicit and auditable. Integrating with both REST and gRPC transports from the same application layer demonstrates that the domain model is transport-agnostic. This chapter builds a complete, production-structured Go application from directory layout through wiring, with each architectural decision tied to the DDD principles established in the previous chapter.

**What you'll learn in this chapter:**

- Structure a Go project with explicit Domain, Application, Infrastructure, and Interface layers enforced through import rules and Go module boundaries
- Implement aggregate roots, value objects, and domain events as pure Go structs with zero infrastructure dependencies in the domain package
- Define repository interfaces in the domain layer and provide PostgreSQL and in-memory implementations in the infrastructure layer
- Wire all layers with constructor-based dependency injection, keeping the object graph explicit and testable without a DI framework
- Write domain unit tests that run without a database, and integration tests that validate repository implementations against a real PostgreSQL instance
- Implement domain services for operations that span multiple aggregates without belonging to any single one
- Expose the same application layer over both a REST API (using `net/http`) and a gRPC API, demonstrating true transport agnosticism
- Structure a multi-bounded-context system with clear inter-context communication patterns using domain events and ACLs

**Why this matters at scale:**

Teams running many Go microservices benefit from consistent layered package structure because engineers can onboard to any service and understand its layout quickly. When migrating from a monolith to Go services, DDD layering guides the transition: each new Go service takes ownership of one bounded context, with the infrastructure layer providing adapters to legacy databases during the migration period. In financial domains where incorrect aggregate boundaries mean broken transaction invariants, strict separation between domain logic and infrastructure ensures business rules are testable without touching production payment systems.

**A note on dogma.** "Clean Architecture", "Hexagonal", "Onion", "Ports and Adapters" - the Go community has absorbed all of these, and they mostly agree on one thing: dependencies flow inward. Beyond that, every team over-engineers in different directions. The examples in this chapter target Go 1.27 and deliberately avoid mechanical four-layer folders (`/controllers`, `/services`, `/entities`, `/repositories`) that mirror Java/C# conventions without earning their complexity in Go. A small project with one bounded context may collapse application + interface into a single `api/` package. A larger one may split application further into commands and queries. Follow the direction of dependencies, not the folder names.

**Prerequisites:** Chapter 52B (DDD Fundamentals), working knowledge of Go interfaces, packages, and modules, and familiarity with PostgreSQL and basic gRPC concepts.

---

### Junior → FAANG: Understanding Why Structure Matters Before You Write Code

Most developers new to DDD make the same mistake: they read about bounded contexts and aggregates, then immediately try to map those terms onto their existing folder conventions. The result is a project with a `domain/` folder that imports `database/sql` and a `service/` folder that hard-codes business rules. The structure exists cosmetically but not functionally.

The key insight to internalize before reading this chapter is that **the direction of imports is the architecture**. If you can draw a line from any package to its imports and that line points outward toward infrastructure, the architecture is already broken. A passing Go build does not tell you whether the dependency direction is correct. Only deliberate package design and import linting do.

A concrete habit to start now: before writing any new file, ask "which layer does this belong to, and what is it allowed to import?" Write that answer in a comment at the top of the file. When a code reviewer asks you to explain why a function lives where it does, you should be able to answer with one sentence, not with "it felt right."

At a job interview entry point, you will often be asked to walk through the architecture of a past project. Interviewers at senior-track companies listen for whether you can explain why you made a structural choice, not just what the structure is. Practicing that reasoning now, on toy projects, is what separates candidates who can describe layered architecture from those who can defend it under follow-up questions.

### Senior @ FAANG: Platform Governance for DDD Go Services at Scale

A single well-structured DDD service is a solved problem. The hard problem is maintaining that structure across 40 services, 12 teams, and 18 months of feature pressure. At the staff level, your job is not to write the cleanest domain layer: it is to make clean domain layers the path of least resistance for every engineer on the platform.

**Architecture Decision Records for layer boundaries.** Every DDD Go platform should have at least three foundational ADRs: one defining what constitutes a bounded context and when to split a service, one defining the canonical package layout and what each layer is permitted to import, and one defining how inter-context communication works (Kafka topics, schema registry, versioning policy). These ADRs are not suggestions. They are the gate criteria for code review. New services that deviate require an explicit exception ADR, not a quiet divergence.

**Import governance as CI enforcement.** Documenting the rules is not enough. At L6 and above, you are accountable for the rules surviving organizational turnover. That means `go-arch-lint` or an equivalent runs in CI on every PR, with rules encoded as version-controlled configuration. The configuration itself is owned by the platform team. Individual service teams can request exceptions, but exceptions require justification and a plan to fix the deviation. This pattern is visible at companies like Lyft, Cloudflare, and Monzo where bounded context enforcement is a platform concern, not a team convention.

**Maturity model for DDD Go services.** Evaluating a service's architectural health requires a rubric, not a gut feeling. A practical four-level maturity model: Level 1 is "imports are correct" (domain imports nothing outside stdlib). Level 2 is "aggregate boundaries are correct" (no cross-aggregate direct method calls, events used for consistency across boundaries). Level 3 is "read/write paths are separated" (query handlers do not load domain aggregates). Level 4 is "context communication is contractual" (integration events are versioned, consumers are tested against the schema, a deprecation process exists). Most services plateau at Level 1 or 2. A bar-raiser interview question for a Staff or Principal candidate is: "Describe how you would assess the architectural health of a service you just inherited and produce a prioritized remediation backlog."

**Onboarding as an architecture signal.** If a new engineer cannot understand which package to add new code to within their first week, the architecture is too complex or too inconsistent. At the staff level, you measure this. If every new service has a different interpretation of "application layer," you have a documentation problem or a scaffolding problem. Good platforms provide service templates (Go module templates, `cookiecutter`-style generators, or internal scaffolding tools) that pre-wire the correct package structure. The template is the architecture, made concrete and runnable on day one.

**The political dimension.** DDD boundaries often coincide with team ownership boundaries. Re-scoping a bounded context frequently means re-negotiating team responsibility. A Staff engineer navigating this must distinguish between a technical argument (the aggregate boundary is wrong because two aggregates share a consistency requirement) and a political argument (team A does not want to own the new service). Both are real, but conflating them produces bad architecture. Separate the concerns: first establish the correct technical boundary, then negotiate the ownership.

---
