## 52C.12 Interview Questions

These questions test whether a candidate understands the practical mechanics of DDD in Go, not just the vocabulary. Strong answers reference specific Go features (implicit interfaces, `internal/` packages, error values) rather than generic DDD theory.

---

**1. How does Go's package system help enforce bounded context isolation?**

Packages are compilation units with explicit import graphs. Each bounded context owns a top-level package (often a separate module or an `internal/<context>/` subtree). `internal/` directories are enforced by the Go toolchain itself - only siblings of the `internal` parent can import from it, so `inventory-service` literally cannot reach into `order-service/internal/domain/order`. Integration happens only through published contracts: integration events, gRPC protos, or a deliberately small `shared/` module. Import linters (`go-arch-lint`) codify rules like "nothing under `internal/domain/` may import `database/sql`".

**What FAANG expects:** The interviewer wants you to recognize that Go's `internal/` mechanism is a *compiler-enforced* boundary, not a convention, and to mention CI-level import linting as the second line of defense. Bonus points for naming trade-offs: a monorepo with many services benefits from one module per context. A monolith uses `internal/` subtrees.

*Follow-ups:*
- "How would you detect architectural drift in a year-old codebase?" (run `go-arch-lint`, grep for forbidden imports, check for cycles with `go mod graph`)
- "When would you split a bounded context into its own Go module vs. leaving it as an `internal/` subtree?" (independent deploy cadence, independent versioning, team ownership boundary)
- "What goes in `shared/`?" (integration event schemas, truly cross-cutting primitives like a Money type, but never domain aggregates)

---

**2. What is the Dependency Inversion Principle and how does Go's implicit interface satisfaction implement it naturally for DDD?**

DIP states that high-level modules should not depend on low-level modules. Both should depend on abstractions. In DDD terms, the domain (high-level) should not depend on infrastructure (low-level). Go's implicit interface satisfaction makes this free: the domain defines `OrderRepository` as an interface, and the PostgreSQL implementation in the infrastructure layer satisfies it without needing an `implements` keyword. The domain package has zero imports of `database/sql`. The arrow of compile-time dependency points from infrastructure into domain, which is exactly the DIP direction.

**What FAANG expects:** Do not just define DIP - show you understand that in Java you need `@Component` / `@Autowired` / XML to make it work, while in Go it is native to the type system. Mention that interfaces live in the consumer package, not the implementer's. A strong candidate also distinguishes DIP from IoC containers and notes that DI frameworks are often not needed in Go.

*Follow-ups:*
- "Where should the `OrderRepository` interface be declared - domain or infrastructure?" (Domain. The domain *consumes* the contract. infrastructure *implements* it.)
- "Show me a code smell that indicates DIP is broken in a Go DDD project." (`import "github.com/lib/pq"` anywhere under `internal/domain/`)
- "How do you test that DIP is not violated?" (import linter in CI, plus compile-time: the domain package must build with only stdlib dependencies)

---

**3. Explain the Outbox Pattern. Why do we need it when we could just publish events directly after saving an aggregate?**

Direct publication is not atomic with the database commit. If you save the aggregate, then call `kafka.Publish()`, the process can crash between the two - aggregate saved, event lost. If you publish first then save and the save fails, downstream consumers see an event for an operation that never happened. The outbox pattern writes events into an `outbox_messages` table in the same transaction as the aggregate, guaranteeing atomicity. A separate worker reads the outbox with `FOR UPDATE SKIP LOCKED`, publishes to the broker, and marks the row published. At-least-once delivery follows, so consumers must be idempotent.

**What FAANG expects:** The interviewer listens for three things: (a) naming the "dual-write problem" as the underlying issue, (b) knowing `FOR UPDATE SKIP LOCKED` for concurrent workers without coordination, (c) acknowledging this is at-least-once, not exactly-once, and that consumers need deduplication. Candidates who claim "exactly-once with outbox" have misunderstood distributed systems.

*Follow-ups:*
- "Why not two-phase commit between Postgres and Kafka?" (Kafka does not support XA. 2PC is slow, fragile, and operationally painful. The outbox is simpler and actually works)
- "How do you handle the backlog if the outbox worker is down for an hour?" (the events are durable in Postgres. The worker catches up. Monitor `lag = now() - min(created_at) where published_at is null`)
- "What is the alternative to polling the outbox?" (logical replication / Debezium CDC - reads the Postgres WAL directly, no polling, but adds operational complexity)

---

**4. What is the difference between a domain error and an infrastructure error? How do you handle each in a Go DDD application?**

A domain error is a business rule violation - `ErrCancellationWindowExpired`, `ErrInsufficientStock`. It is an expected outcome of a legitimate operation and is modeled as a sentinel `error` value or typed error. An infrastructure error is a technical failure - connection refused, context deadline exceeded, JSON unmarshal failure. Domain errors are returned verbatim by application handlers. HTTP handlers match them with `errors.Is` and map to 4xx codes (typically 422 Unprocessable Entity or 409 Conflict). Infrastructure errors are wrapped with `fmt.Errorf("save order: %w", err)`, logged with context, and mapped to 5xx. Never surface a raw `sql.ErrNoRows` to the client. Translate it to `ErrOrderNotFound` inside the repository.

**What FAANG expects:** The candidate must mention `errors.Is` / `errors.As`, the sentinel error pattern, and the translation boundary between layers. A senior candidate also talks about not leaking SQL internals to HTTP (never log an exec error with the SQL text at error level in production) and about the error taxonomy decision: sentinel errors for enumerable cases, typed errors (`*ValidationError`) when carrying structured context.

*Follow-ups:*
- "When would you use a typed error over a sentinel error?" (when the error carries data: invalid field name, retry-after duration)
- "Show me the code path when `sql.ErrNoRows` occurs in `FindByID`." (repository checks `errors.Is(err, sql.ErrNoRows)`, returns `order.ErrOrderNotFound`, and the handler maps that to HTTP 404)
- "How do you prevent error taxonomies from exploding across services?" (keep sentinel errors per bounded context. Do not share error types across contexts - translate at the boundary)

---

**5. Why should query handlers not load domain aggregates?**

Aggregates exist to protect invariants during mutation. Loading them for reads pays the full cost of reconstitution (multiple joins, child collections, value object construction, version tracking) to then discard all of that behavior. Worse, read use cases often need shapes the aggregate does not expose - joined customer names, computed totals, paginated subsets. Aggregates do not contain those by design. The clean answer is CQRS at the repository level: a separate `OrderQueryRepository` returns denormalized `OrderView` DTOs via a single efficient SQL query, bypassing the domain entirely.

**What FAANG expects:** The candidate distinguishes write-side (consistency matters) from read-side (performance matters) and mentions that read models may live in a different store (Elasticsearch for search, Redis for hot cache, a denormalized Postgres view for list pages). Bonus: mentioning that heavy reads at scale often justify projections updated from events - full CQRS with read/write split across databases.

*Follow-ups:*
- "Where do you put the query repository interface - domain or application?" (application layer. Queries are use cases, not domain contracts)
- "What happens to the read model when the aggregate schema changes?" (if projected from events, replay. If same database, update the query and the denormalized columns in the same migration)
- "When would loading the aggregate for a read be justified?" (very rarely - maybe an admin debug endpoint that needs the full state graph including internal invariants)

---

**6. How does the Anti-Corruption Layer pattern differ from the Conformist pattern? Give an example of when you would use each.**

ACL translates an upstream context's model into your context's terms - a Stripe adapter that converts Stripe's `PaymentIntent` into your domain's `Transaction`. You use it when the upstream model is messy, volatile, or semantically different from yours. Conformist accepts the upstream model as-is and uses it directly. Use Conformist only when the upstream is stable, well-designed, and the translation overhead would add no value - typically an internal team whose model matches yours, or a public standard like ISO 4217 currency codes.

**What FAANG expects:** A concrete example in each direction. Payment gateway integrations, legacy mainframe ACLs, and third-party CRMs are canonical ACL cases. Internal shared kernels, standard protocols (OAuth, OIDC token shapes), and inherited stable libraries are conformist cases. Senior candidates also name the middle-ground patterns (Customer/Supplier, Open Host Service, Published Language) from context-mapping theory.

*Follow-ups:*
- "How do you design an ACL so you can swap Stripe for Adyen later?" (the ACL implements a domain-defined `PaymentGateway` interface. Adyen gets its own adapter satisfying the same interface)
- "What if the upstream context publishes events you must consume?" (ACL consumes the raw integration event and translates it into a domain command or internal event)
- "Where does the ACL code live - domain or infrastructure?" (infrastructure - it is an adapter. The interface it implements lives in the domain)

---

**7. Describe a scenario where optimistic concurrency would cause problems in a high-traffic system and explain how you would address it.**

A popular flash-sale product causes thousands of concurrent `ReserveStock` commands on the same `StockItem` aggregate. Optimistic concurrency means most of these fail with a version conflict and retry. Throughput collapses under the retry storm. Fixes: (a) redesign the aggregate so contention is naturally sharded - per-warehouse `StockItem` instead of per-SKU. (b) move the hot operation to a different model - decrement an atomic counter backed by a database sequence or Redis `DECR`, or (c) accept eventual consistency with a reservation queue that serializes operations on the hot key. (d) for the specific flash-sale case, pre-allocate stock into N "buckets" so contention is spread across N aggregates.

**What FAANG expects:** The candidate must not say "just add a retry loop" - that makes it worse. They should talk about aggregate boundary redesign, contention sharding, and the observation that optimistic concurrency is a defensive mechanism, not a scaling strategy. Strong candidates mention that the choice between optimistic (version column) and pessimistic (`SELECT ... FOR UPDATE`) depends on expected conflict rate: optimistic wins at low conflict, pessimistic wins at high conflict, neither wins at extreme contention.

*Follow-ups:*
- "Show me the retry logic in the application handler." (load fresh, re-apply command, save again. Bounded retry count. exponential backoff. Return `409 Conflict` if retries exhausted)
- "What are the drawbacks of pessimistic locking at scale?" (connection held for duration of the transaction, lock timeouts, deadlocks across aggregates, breaks the ability to use connection pooling efficiently)
- "How would event sourcing change the answer?" (append-only log removes most write conflicts. contention moves to the projection side which is easier to shard)

---

**8. How would you structure a Go project that has three bounded contexts that need to share a small set of common types?**

Create a separate Go module (`shared/`) containing only (a) integration event schemas, (b) cross-cutting value types like `Money` that are genuinely the same concept in all contexts, and (c) shared protobuf/OpenAPI definitions. Each bounded context lives in its own module with its own `go.mod`, imports `shared/` as a versioned dependency, and keeps its domain aggregates private under `internal/`. The critical rule: `shared/` contains no domain logic, no repository interfaces, no aggregates. If tempting to put an `OrderCore` or `CustomerBase` in there, stop - that is a bounded context fusion and you will regret it within six months.

**What FAANG expects:** Clear articulation of the difference between Shared Kernel (high-coupling, requires coordinated change) and Published Language (low-coupling, versioned, stable). A good candidate explains that shared kernels must be minimal because every change requires coordinated releases across all consuming teams, and describes the versioning strategy (`v1`, `v2` packages side-by-side during migration).

*Follow-ups:*
- "What happens when the Order context needs to know about Customer?" (not via shared types - either call a Customer service read API, subscribe to Customer integration events, or maintain an ACL that projects the subset of Customer data Order cares about)
- "How do you version `shared/` without breaking consumers?" (semver on the module. Additive changes bump minor. Breaking changes publish `shared/v2` and maintain both for a deprecation window)
- "When is a monorepo better than multi-module?" (small team, cohesive product, shared CI simpler. trade-off is that module boundaries become convention-enforced rather than tool-enforced)

---

**9. You inherit a Go service where the domain package imports `gorm.io/gorm`. What do you change and in what order?**

First, stop the bleeding: add an import linter rule forbidding new ORM imports in `internal/domain/`. Then extract: introduce a domain `Repository` interface that captures the operations currently inlined. Move the GORM struct tags and calls into a new `internal/infrastructure/persistence/` package, leaving the domain struct pure. Write reconstitution functions that build domain aggregates from database rows explicitly, no reflection. Keep the old code path working while you migrate, using the Strangler pattern - new code goes through the repository interface, old code is gradually rewritten. Add unit tests for the domain package that run without GORM at all, proving the decoupling. Commit in small, reviewable steps.

**What FAANG expects:** An incremental refactoring plan, not a big-bang rewrite. Recognition that the domain struct tags (`gorm:"primaryKey"`) are the leak even when code looks clean. Knowledge of the Strangler pattern. Senior answers also cover how to avoid the double-write problem during migration (feature flag, canary, careful cutover).

*Follow-ups:*
- "Why not just replace GORM with sqlc or pgx everywhere in one PR?" (too large, untestable, will regress production. Small PRs, one aggregate at a time)
- "How do you justify this refactor to a product manager?" (the refactor pays off in test speed, bug density, and onboarding time - measure before and after)
- "Is GORM ever acceptable in a DDD project?" (in the infrastructure layer, as an implementation detail of a repository, fine. leaking its types or conventions into the domain, never)

---

**10. Your team debates using google/wire vs. plain manual DI vs. uber-go/fx. How do you decide?**

Start with manual. For a service with 20-30 constructed components, `main.go` is 150 lines and perfectly clear. When the wiring outgrows the human working-memory window - typically 40+ components, multiple entry points (HTTP + gRPC + worker + CLI), or shared wiring across binaries - move to Wire. Wire generates plain Go at build time, zero runtime cost, catches missing providers at compile time. Only reach for Fx if you also need lifecycle-managed modules (fx.Module per bounded context), dynamic module composition, or want to standardize across a large polyglot org that already runs Fx internally. Do not start with Fx unless you genuinely need its features. Its reflective runtime errors are harder to debug than a compile failure.

**What FAANG expects:** Concrete criteria, not a religious preference. The candidate should mention that Wire is compile-time and Fx is runtime, explain why compile-time matters for DDD (layering violations become build errors), and acknowledge when Fx is the right call at organizational scale. Red flag: candidates who cite "best practices" without articulating trade-offs.

*Follow-ups:*
- "How would you test a Wire-wired application?" (tests construct the graph directly with fakes. Production uses the generated wiring. They share constructor signatures)
- "What is wrong with a service-locator pattern (e.g., `container.Get('orderRepo')`)?" (hides dependencies, pushes errors to runtime, breaks refactor tooling, inverts the DI benefit)
- "Where does Fx's lifecycle management help most?" (staged startup: DB pool ready before HTTP server, graceful shutdown in reverse order, health checks that gate traffic until every module is ready)

---

**11. A teammate proposes a `/controllers`, `/services`, `/repositories`, `/models` top-level layout. How do you respond?**


That layout mirrors Spring / Rails conventions and does not carry its weight in Go. Every feature touches four directories and four packages. Finding code becomes a tree-wide search. More seriously, the layout encourages an anaemic model - `models/` becomes a bag of structs with getters, and `services/` accumulates the behavior that should live on the aggregates. The Go idiom is to organize by bounded context first (`internal/order/`, `internal/inventory/`), then by layer *inside* that context. A single feature change stays in one subtree. `models/` as a shared top-level package is the first symptom of a project that will erode.

**What FAANG expects:** Strong opinions, defended with concrete consequences. The candidate must name the anaemic-model risk and explain why cohesion by feature beats cohesion by layer in Go. Saying "that is not idiomatic" without explaining why would fail the bar.

*Follow-ups:*
- "Isn't that just preference?" (no - measure PR scope. Feature-organized layouts produce smaller, more atomic PRs with fewer merge conflicts)
- "What if the team already knows Spring conventions?" (acknowledge the learning curve. compromise on naming while still organizing by context - `internal/order/handler.go`, `internal/order/service.go`, etc.)
- "When is `/cmd`, `/internal`, `/pkg` the right top-level layout?" (almost always - it is the stdlib-aligned Go convention. `/pkg` only if you export libraries consumed by external modules)

---

**12. Describe how you would test a command handler that orchestrates the domain, idempotency store, and outbox writer - without spinning up Postgres or Kafka.**

Define all three dependencies as interfaces in the application layer. For the test, implement fakes: an in-memory repository (map of `OrderID -> *Order`), an in-memory idempotency store (set of request IDs), and an in-memory outbox (slice of events). Construct the handler with the fakes, execute a command, and assert on final state: the aggregate was saved, the events were written, the idempotency key is marked processed. A second test runs the same command twice and asserts the second call is a no-op. The domain runs unchanged through the fake repositories because fakes satisfy the same interface the real Postgres implementation does.

**What FAANG expects:** Distinction between fakes and mocks (prefer fakes - record final state, not call sequence). Recognition that test doubles belong in `_test.go` files or a test-support package, not alongside production code. Senior candidates also describe the second layer: a small number of integration tests using testcontainers that verify the real Postgres repository implements the same contract, so swapping in the fake for unit tests is safe.

*Follow-ups:*
- "How do you ensure the fake repository and real repository stay behavior-compatible?" (interface contract tests: a table-driven suite parameterized by repository factory, run against both implementations)
- "What goes wrong if you use gomock here instead?" (brittleness - tests assert exact call sequences, break on refactor, do not catch a mis-mapped field because the mock does not actually persist anything)
- "When is a fake not enough?" (when the interface hides behavior the real implementation has - transaction semantics, `FOR UPDATE` locking, JSON aggregation correctness - those need testcontainers)

---

### Junior → FAANG: How to Prepare for DDD Go Interview Questions

The twelve questions in this section span a spectrum from "know the vocabulary" to "defend a design decision under adversarial follow-up." Entry-level FAANG interviews typically test questions 1 through 5. Mid-level interviews add questions 6 through 9. Senior interviews include all twelve, with follow-ups that probe whether your answer is memorized or genuinely understood.

The way to prepare is not to memorize model answers. It is to build at least one real DDD Go service, run into at least three of these problems in practice, and have opinions based on what you actually observed. Interviewers at FAANG companies ask follow-up questions specifically designed to distinguish candidates who have read about DDD from candidates who have shipped it.

Specific preparation steps: (a) implement an in-memory fake repository for a domain you care about, run the domain tests against it, then implement the real Postgres repository and verify both pass the same contract tests. This gives you a concrete answer to question 12. (b) Deliberately introduce the GORM mistake (question 9) in a test project, observe what it does to the domain's import graph, then fix it. This gives you a concrete answer to question 9's follow-up about migration strategy. (c) Read the outbox pattern source code in one open-source project (Watermill, EventDriven.io Go examples) and be able to explain `FOR UPDATE SKIP LOCKED` without looking it up.

For system design interviews, practice drawing the e-commerce platform diagram from section 52C.9 from memory: four contexts, Kafka in the middle, arrows labeled with event names. Being able to draw it quickly signals depth of preparation.

### Senior @ FAANG: Bar-Raiser Signals in DDD Go Interviews

A bar-raiser interview at FAANG evaluates whether a candidate raises the bar for the team if hired. For a Staff or Principal engineer role, the bar-raiser questions on DDD Go are not about syntax or pattern names: they are about judgment, trade-offs, and organizational impact.

**Bar-raiser signal: knowing when NOT to use DDD.** A candidate who applies DDD to every problem has not yet developed the judgment to know when it is overkill. DDD is appropriate when: the domain is complex, multiple domain experts are involved, the team has enough people to justify the layering overhead, and the service will live long enough to benefit from the investment. For a simple CRUD service that wraps a PostgreSQL table with five columns, DDD is over-engineering. A bar-raiser candidate can articulate this trade-off without being asked.

**Bar-raiser signal: organizational change management for DDD adoption.** Introducing DDD into an existing Go codebase is a people problem as much as a technical problem. Engineers who have been writing flat Go services for two years will resist layering that feels bureaucratic. A bar-raiser candidate has a strategy: start with one high-value service, demonstrate measurable outcomes (reduced bug rate in domain logic, faster onboarding, easier testing), then use that evidence to socialize the approach. They also know that forcing DDD on a team that does not buy in produces cargo-cult DDD: the folders exist, the layer names are correct, but the domain is anaemic and the application services are fat.

**Bar-raiser signal: evolving context boundaries.** The hardest DDD problem is not designing the initial boundaries: it is knowing when to re-draw them. A bar-raiser candidate can describe a situation where they observed that a bounded context was wrong (two services that should have been one, or one service that should have been split), and explain how they approached the migration. The answer should include: how they identified the boundary was wrong (usually through pain signals: cross-service transactions, chatty inter-service communication, features that required simultaneous changes in two services), how they made the case for the change, and how they executed the migration incrementally without downtime.

**Bar-raiser signal: knowing the limits of the patterns.** The outbox pattern is correct for at-least-once delivery. The candidate knows that exactly-once semantics require either idempotent consumers or a distributed transaction protocol, and that Kafka does support exactly-once at the producer level (idempotent producer plus transactions) but this does not extend to the consumer-side processing. The candidate who says "the outbox gives exactly-once" fails the bar. The candidate who says "the outbox gives at-least-once, consumers must be idempotent, and here is how I would implement idempotency for the downstream inventory reservation" passes it.

---
