## Summary

This chapter translated DDD concepts into idiomatic Go code:

- Go's implicit interfaces, value semantics, and lack of inheritance support DDD architecture without framework overhead
- Package structure follows the bounded context boundary, with `internal/` enforcing it at the compiler level
- The layered architecture (domain → application → infrastructure → interfaces) follows the Dependency Rule: dependencies point inward
- Application commands and query objects make the use case contract explicit
- The Outbox Pattern ensures reliable event delivery without two-phase commit
- Manual dependency injection in `main.go` is explicit, testable, and idiomatic Go
- Domain logic is tested in pure unit tests with zero infrastructure dependencies
- HTTP and gRPC handlers are thin adapters that translate protocols to application commands
- The ACL pattern appears at every boundary: Stripe ACL in infrastructure, error translation in HTTP handlers
- Small, consumer-defined interfaces beat Java-style all-in-one repository interfaces. Declare them where they are used, not where they are implemented
- Fakes beat mocks for application-layer testing. testcontainers give production parity for repository integration tests
- Avoid service-locator DI containers and top-level `/controllers` + `/services` + `/models` layouts imported from Java/Rails ecosystems
- Domain events stay internal to a context. Integration events are versioned, stable, language-neutral schemas published on the bus
- The choice between Wire, Fx, and manual DI is about scale and lifecycle needs, not correctness. For most DDD services, manual or Wire is the answer

Next: Chapter 52D covers CQRS and Event Sourcing - architectural patterns that build on DDD and enable independent scaling of read and write workloads.

### Junior → FAANG: What to Take Away and Practice First

The summary above is a checklist. Before moving to Chapter 52D, verify that you can demonstrate each item with working code, not just recognize it when described.

The three highest-priority items to practice if you have limited time: (a) write a pure domain package with no third-party imports, a repository interface, and table-driven unit tests that run in milliseconds. This proves you understand the dependency direction. (b) Write a fake repository that satisfies the interface and use it in an application handler test. This proves you understand why fakes beat mocks for DDD. (c) Draw the package structure for a single bounded context from memory, label the import direction arrows, and explain what belongs in each layer. This proves you can explain the architecture in an interview without notes.

The items that trip up junior developers in interviews: the difference between domain events (internal, rich, named after something that happened in the domain) and integration events (public, versioned, stable, published to the bus). Confusing the two leads to unstable cross-service contracts. Understand why the translation layer exists in the outbox writer, and you will answer this class of question correctly.

### Senior @ FAANG: Turning This Chapter Into Platform Standards

At the staff level, reading this chapter should produce a set of actions, not just a set of understandings. The concrete outputs of reading this chapter for a Staff or Principal engineer at a company with existing Go services:

**Audit the existing services.** Take the ten common mistakes from section 52C.11 and score your three most critical services against each one. Produce a one-page architectural health report per service, with a prioritized remediation backlog. This is the input to the next quarterly planning conversation.

**Define or update the platform ADR.** If your platform does not have an ADR defining bounded context package structure, dependency direction rules, and integration event governance, write it this quarter. Use the patterns from this chapter as the baseline. If an ADR exists, update it to reflect current best practices and close any gaps (import linting in CI is the most commonly missing piece).

**Build or update the service template.** Every new Go service created at your company should start from a template that pre-wires the correct package structure, includes import linting configuration, has a `Makefile` target for running domain tests separately from integration tests, and embeds a sample outbox worker with the correct shutdown sequence. If this template does not exist, its absence is creating architectural inconsistency with every new service. Building it is a one-sprint investment that pays dividends for years.

**Establish a domain modeling practice.** The most important thing this chapter does not cover in detail is how to have a domain modeling conversation with non-engineers. Event Storming (Alberto Brandolini's workshop format) is the standard tool: a facilitated session with domain experts, product managers, and engineers using sticky notes to map domain events, commands, and aggregates on a wall. A Staff engineer who can facilitate an Event Storming session is rare and disproportionately valuable. If you have not facilitated one, invest in learning the format before the next major feature design.

**Measure and report.** Architectural quality is not self-reporting. Set up monthly reporting on: import rule violation counts per service (trend over time), domain test coverage per service, ratio of fast tests to slow tests, and outbox delivery lag p99 in production. Present this data in engineering all-hands or equivalent. Visibility creates accountability without requiring surveillance.

---
