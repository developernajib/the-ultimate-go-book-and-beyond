## 47.1 Microservices Fundamentals

### What Are Microservices?

The five core characteristics of microservices (single responsibility, independent deployability, decentralized governance, decentralized data, and design for failure) directly shape how Go services are structured. Each characteristic maps to a concrete Go decision: single responsibility means one `main` package per binary, and design for failure means every inter-service call wraps context deadlines and circuit breakers. The team-size and domain-coupling heuristics listed here are practical filters for avoiding premature decomposition.

```go
package main

/*
Microservices Characteristics:

1. Single Responsibility
   - Each service does one thing well
   - Aligned with business capabilities
   - Clear ownership and boundaries

2. Independent Deployability
   - Deploy without affecting other services
   - Different release cycles
   - Technology freedom

3. Decentralized Governance
   - Each team owns their service
   - Choose appropriate technologies
   - Define own APIs

4. Decentralized Data Management
   - Each service owns its data
   - No shared databases
   - Data consistency via events/sagas

5. Design for Failure
   - Assume network is unreliable
   - Implement circuit breakers
   - Graceful degradation
*/

/*
When to Use Microservices:

✓ Large teams (>20 developers)
✓ Need independent scaling
✓ Different parts evolve at different rates
✓ Technology diversity required
✓ Strong domain boundaries exist

When NOT to Use:

✗ Small team or product
✗ Simple, well-understood domain
✗ Tight coupling between features
✗ Limited DevOps capability
✗ Low latency requirements
*/
```

### Monolith vs Modular Monolith vs Microservices (the honest tradeoff)

There are three architectures on the spectrum, not two, and in 2026 the middle one is the default most teams should start with:

1. **Classic monolith** - one binary, one database, no enforced internal boundaries. Fast to build, eventually painful to scale both technically (everything redeploys together) and organizationally (every team steps on every other team's code).
2. **Modular monolith** - one binary, one deployment pipeline, but with *strictly enforced* internal module boundaries (separate packages, no cross-module imports, frequently separate schemas within the same database). You keep in-process calls (nanoseconds instead of milliseconds), one observability story, one deployment, and no distributed-systems complexity - while preserving the *option* to extract modules into services later when a real boundary forces the issue. Shopify and Basecamp run this at billion-dollar scale.
3. **Microservices** - multiple independently deployable services, each owning its own data, communicating over the network. You pay network latency on every interaction, you build distributed tracing, service discovery, saga orchestration, and API gateways, and you eat the operational complexity of N deployments, N pipelines, and N databases. You earn independent deploy cadence, independent scaling profiles, and independent team ownership.

Only move from modular monolith to microservices when the pain of *not* doing so is concrete and measurable: a module that needs 20x the scale of the rest of the app, a team that is blocked weekly on unrelated deploys, a compliance boundary (PCI, HIPAA) that demands isolation, or polyglot requirements that the monolith cannot accommodate. The diagram below contrasts the two endpoints of the spectrum.

```go
package main

/*
Monolith:
┌────────────────────────────────────┐
│            Application             │
│  ┌──────┐ ┌──────┐ ┌──────────┐    │
│  │ User │ │ Order│ │ Inventory│    │
│  └──────┘ └──────┘ └──────────┘    │
│         Shared Database            │
└────────────────────────────────────┘

Microservices:
┌─────────┐  ┌─────────┐  ┌────────────┐
│  User   │  │  Order  │  │ Inventory  │
│ Service │  │ Service │  │  Service   │
└────┬────┘  └────┬────┘  └─────┬──────┘
     │            │              │
     ▼            ▼              ▼
┌─────────┐  ┌─────────┐  ┌────────────┐
│ User DB │  │Order DB │  │Inventory DB│
└─────────┘  └─────────┘  └────────────┘
*/
```

### Red flags: the distributed monolith

If any of the following are true, you have a distributed monolith - the worst of both worlds, with monolith coupling *and* microservices operational cost:

- **Shared database** across services (even "only for analytics" or "temporarily for the legacy migration").
- **Synchronous call chains** where a single user request fans through four or more services before returning.
- **Deploy-together requirement** - you cannot release service B without also releasing service A, because their API contract drifts on every sprint.
- **Shared library versioning** where a bump to `common-utils` triggers coordinated redeploys across every service.
- **Distributed transactions with two-phase commit** instead of sagas with compensations.
- **Cross-service joins** resolved in the calling service by issuing N+1 lookups.

The fix is not more services - it is fewer, better-bounded ones. Consolidate back to a modular monolith, re-draw the bounded contexts, then extract again only where a true axis of change demands it.

### Junior → FAANG: The Five Characteristics as Interview Anchors

The five characteristics of microservices (single responsibility, independent deployability, decentralized governance, decentralized data, design for failure) are not trivia. They are the vocabulary interviewers use to probe whether you understand the pattern or have only worked inside one.

Single responsibility maps to the interview question "how do you decide what belongs in a service?" The correct answer is not "small enough for one engineer to understand" but "aligned to one business capability with one team owning it end-to-end."

Independent deployability maps to "how does service A deploy without breaking service B?" The correct answer requires API versioning (add fields, never remove or change types), backwards-compatible event schemas, and consumer-driven contract testing.

Decentralized data maps to "your order service needs the customer's name. How do you get it?" This is one of the most common junior-level microservices questions. Know the three options: sync API call (coupling, latency), subscribe to user events and maintain a local read model (eventual consistency, best for scale), or batch fetch (acceptable for reporting). Know the tradeoffs.

Design for failure maps to "what happens when the inventory service is down during checkout?" The correct answer involves circuit breakers, graceful degradation (show the product, queue the order, process inventory reservation when the service recovers), and timeout propagation.

On the distributed monolith red flags: memorize these six signals. If you can recite them in an interview and explain why each one recreates monolith coupling in a distributed system, you have demonstrated senior-adjacent judgment at a junior level.

### Senior @ FAANG: Organizational Diagnosis and Forcing-Function Governance

At staff level, the five characteristics are a diagnostic framework for auditing an existing microservices organization. Each characteristic has an observable failure mode and a corrective lever.

**Single responsibility failure: service sprawl.** When a single business capability is split across three services for historical reasons (org reorg, different team ownerships, "we thought it was separate but it wasn't"), you get a distributed monolith fragment that deploys together. The lever is team consolidation before service consolidation. Merging services owned by different teams without first aligning the teams produces political conflict, not cleaner code. Staff-level work here is organizational: make the case to engineering leadership that team structure should drive service structure, not the other way around.

**Independent deployability failure: shared library coupling.** The most insidious form of shared dependency is a `common` or `shared` package that is imported by every service. When the package bumps a major version, every service must update simultaneously or the organization pins to the old version indefinitely. The governance fix is to treat `common` libraries as internal SDKs with a formal compatibility policy: no breaking changes without a deprecation cycle, dual versions supported for N weeks, and a migration guide. Go module versioning (`v2`, `v3` paths) enforces this structurally.

**Decentralized data failure: the analytics exception.** The most common shared-database violation is the data warehouse exception: "we only read from the other service's database for analytics." This creates a hidden schema dependency. When the owning service renames a column, the analytics pipeline breaks. The correct pattern is for the owning service to publish a Debezium CDC stream or a dedicated analytics projection into the warehouse. The owning service controls the analytics schema, not the consumer.

**Design for failure at the platform level.** L6/L7 engineers do not just implement circuit breakers in their own service. They establish the platform policy: every service that calls an external dependency must register that dependency in the service dependency manifest, which is used to generate the service's chaos engineering runbook and to auto-provision circuit breaker configuration in the service mesh. This is failure design as a governance practice, not an individual implementation detail.

**The forcing-function governance checklist.** When a team proposes a new service, the architecture review should ask: (1) which forcing function from the approved list (scale, team boundary, compliance, polyglot) triggers this split? (2) who owns the new service's on-call rotation? (3) what is the new service's SLO, and does it cascade an SLO change to the services that depend on it? (4) what is the data migration plan if we need to merge this service back? If a team cannot answer all four questions, the proposal is not ready.

---
