## 52C.11 Common Mistakes

These mistakes erode DDD layering over time. Each one is easy to introduce and hard to spot in code review without explicit import rules and architectural tests.

**1. Fat application services.**

If your application service contains `if` statements checking domain rules, you have moved business logic out of the domain. Application services should read like pseudocode: load, delegate, save.

**2. Repository methods that return too much.**

`FindAll()` on a production database is not a repository method - it is a time bomb. Repository methods should be specific: `FindByCustomer`, `FindPendingOlderThan`. Design them for specific use cases.

**3. Importing infrastructure in the domain.**

The domain package must have zero imports of database drivers, HTTP clients, or message broker libraries. If you see `import "github.com/lib/pq"` in a domain file, something is wrong.

**4. Mixing domain errors and infrastructure errors.**

Domain errors (`ErrOrderNotFound`) should be distinct from infrastructure errors (`sql.ErrNoRows`, `context.DeadlineExceeded`). The repository translates infrastructure errors: `sql.ErrNoRows` becomes `ErrOrderNotFound`. Infrastructure errors that are not domain concerns (connection failures) bubble up as wrapped errors.

**5. Command handlers that make multiple aggregate saves without a saga.**

If a command handler saves two different aggregates in sequence, you have an implicit distributed transaction. What happens if the second save fails? Use domain events and sagas for cross-aggregate consistency.

**6. Interfaces declared in the same package as the implementation.**

Go style is "accept interfaces, return structs". The consumer declares the interface it needs. The producer returns the concrete type. Declaring `OrderRepository` in the infrastructure package and having the domain import it inverts the dependency direction and creates a cycle. The interface lives in the package that consumes it - which for repositories is the domain (for contract) or application (for transaction-aware wrappers).

**7. A single `models` or `types` package shared across contexts.**

This fuses bounded contexts at the type system level. The moment the Order context and the Inventory context both reference the same `Product` struct, changes to `Product` block both teams. Each context should have its own `Product` (or `OrderProduct` / `InventoryProduct` if names collide), with translation happening at the integration event boundary.

**8. Using `interface{}` / `any` for domain types "for flexibility".**

If a domain method takes `any`, the domain is no longer a model. It is a bag of untyped data. Types are the documentation. Typed value objects catch entire classes of bug at compile time - `Money` cannot be confused with `Quantity` even though both wrap `int64`.

**9. Letting the ORM drive the aggregate design.**

If you structure aggregates around GORM auto-migration ease or around table joins, you have given up DDD. The aggregate boundary is a consistency boundary, not a storage convenience. Map aggregates to tables manually. Accept that a single aggregate may write to three tables in one transaction, and that two tables may reconstruct into one aggregate on read.

**10. "Rich domain model" that is actually an anaemic data-carrier with getters.**

`order.GetLines()` plus application-service-side iteration and validation is the anaemic model in disguise. The test: can an outside caller put the aggregate into an invalid state by calling its public API? If yes, behavior lives in the wrong place. Real aggregate methods mutate state atomically and refuse invalid transitions. They do not expose mutable internals.

---

### Junior → FAANG: Using This List as a Code Review Checklist

The ten mistakes listed here are not hypothetical. Every one of them appears regularly in Go DDD codebases written by developers who understood the theory but had not yet built the muscle memory for the practice. Using this list as a code review checklist before submitting a PR is a habit that will make your reviews faster and more substantive.

A practical exercise: take a DDD codebase you have access to (your own, an open-source project, or a tutorial project) and run through the ten points. For each one, ask "does this codebase have this problem? Where?" Then try to fix one of the problems in a focused PR. The act of fixing a real instance of mistake #4 (mixing domain and infrastructure errors) is worth more than reading about it ten times.

For interview preparation: be ready to discuss mistake #5 (multiple aggregate saves without a saga) in depth. This is a common system design follow-up question. The interviewer will ask: "In your e-commerce system, when a customer places an order, you need to save the order, reserve inventory, and initiate payment. How do you ensure consistency?" The correct answer is: you do not try to ensure consistency in one transaction. You save the order with a domain event, use the outbox to publish the event, and let the downstream services react to it. Compensation handles failures. Trying to do all three in one database transaction is the wrong answer, and the interviewer knows it.

### Senior @ FAANG: Architectural Decay as an Organizational Signal

The ten mistakes in this section are symptoms. The underlying disease is organizational: layers decay when there is no enforcement mechanism, no ownership, and no cost to violating the rules.

**Mistake #1 (fat application services) at scale.** In a large organization, fat application services are a signal that the domain modeling effort was abandoned under delivery pressure. A sprint deadline arrived, the product manager asked for the feature, and the engineer put the business rule in the service "just this once." One year later, the service has 1,200 lines of if-else business logic that nobody wants to touch. The Staff engineer's response is not to rewrite it: it is to establish a refactoring culture where every PR that touches a fat service moves at least one business rule into the domain layer. Gradual improvement, tracked as a metric (lines of domain logic in application handlers, measured by an AST linter), is more durable than a one-time cleanup sprint.

**Mistake #7 (shared `models` package) as a bounded context violation.** The shared `models` package is usually created before anyone on the team has thought about bounded contexts. It exists because it was the path of least resistance. Removing it requires identifying which types belong to which context, which types are genuinely shared (and belong in the shared kernel), and which types are duplicated in multiple contexts (and need separate context-specific versions). This is a multi-week refactoring project with significant coordination overhead. A Staff engineer prevents it by making the alternative easy: the service template has no `models/` package, the import linter forbids it, and the architecture ADR explains why. Prevention is one day of work. Remediation is two sprints.

**Mistake #9 (ORM-driven aggregate design) and migration strategy.** In a mature system with GORM in the domain layer, the migration strategy must be incremental and reversible. A Staff engineer approaches this with the Strangler Fig pattern: (a) add the new `internal/infrastructure/persistence/` package alongside the existing GORM-infused domain, (b) implement the repository interface for one aggregate at a time, (c) add an import linter rule that enforces no new GORM imports in the domain package (new code is clean, old code is tolerated until migrated), (d) migrate aggregates in order of business criticality starting with the most tested (so the risk of regression is lowest). The "never touch the strangler" principle applies: the old GORM code is not modified, only replaced. This reduces the risk that the migration itself introduces bugs.

**Measuring architectural health continuously.** A Staff engineer does not evaluate architectural health only during incident retrospectives or quarterly reviews. Architectural health metrics run in CI on every PR: import rule violations, package dependency depth, cyclomatic complexity per aggregate method, test coverage for the domain package, and the ratio of domain tests to integration tests. These metrics are displayed in a team dashboard. Trends are more informative than absolute values: a rising count of import violations is an early warning signal even if the absolute count is small. Catching the signal early means a conversation, not a crisis.

---
