## Summary

In this chapter, you learned:

**CQRS:**
- CQRS separates the write model (commands, aggregates) from the read model (queries, projections)
- The command bus routes commands to handlers, and the query bus routes queries to handlers
- Middleware (logging, tracing, recovery) wraps all command handlers transparently
- Read models are denormalized, query-optimized views updated by projections
- Eventual consistency is inherent in asynchronous projections - design your API and UI accordingly

**Event Sourcing:**
- The event store records events, not state - events are the source of truth
- Aggregates apply events to change state, both for new events and historical replay
- `LoadFromHistory` + `apply()` + `UncommittedEvents()` are the core event sourcing aggregate pattern
- The PostgreSQL event store uses a unique constraint on `(stream_id, stream_version)` for optimistic concurrency
- Snapshots optimize load performance for long-lived aggregates

**CQRS + Event Sourcing + DDD:**
- All three compose naturally: DDD provides the domain model, CQRS separates read/write, Event Sourcing makes events the source of truth
- Domain events drive both the event store append and the projection updates
- Sagas/process managers coordinate multi-step distributed workflows using event sourcing

**Go-specific:**
- Go generics enable type-safe command and query buses
- Implicit interface satisfaction keeps the domain independent of infrastructure
- Explicit event serialization (no magic) makes event schema evolution visible and controlled
- All layers are testable independently - domain tests without any infrastructure

### Junior → FAANG: Consolidating the Chapter into Interview Answers

The summary gives you the bullet points, but interview answers need to be sentences. Practice converting each bullet into a spoken explanation.

"The event store records events, not state" becomes: "Instead of storing `status = 'canceled'` in a row, the event store stores `OrderCanceled` with a timestamp. The current state is derived by replaying events. This means you can reconstruct any past state and never lose history."

"Eventual consistency is inherent in asynchronous projections" becomes: "After a write, the read model is updated asynchronously by a projector. There is a window, typically milliseconds to seconds, where the read model does not reflect the latest write. Design your API to handle this by returning the new state from the command response, using optimistic UI, or showing the user an explicit 'processing' indicator."

The Go-specific bullets are your technical differentiators. Most candidates can explain CQRS conceptually. Fewer can explain why Go generics are useful for the command bus (type-safe registration and dispatch without `interface{}`), or why implicit interface satisfaction keeps the domain independent of infrastructure (the domain defines a `Repository` interface, the infrastructure implements it, no import cycle). Being able to answer "how do you implement this in Go specifically?" is the difference between a pattern-aware candidate and a Go-fluent one.

Create a personal summary that connects the three patterns: DDD gives you the right aggregate boundaries and domain language. CQRS separates the models so reads and writes can evolve independently. Event Sourcing makes events the source of truth so history is never lost. Each pattern is independently useful, and they compose to cover the full set of requirements for audit-required, high-read systems.

### Senior @ FAANG: The Chapter's Place in the Larger Architectural Landscape

This summary is a technically accurate recap of the patterns, but it does not situate them in the larger landscape of architecture decisions that staff engineers navigate.

The three patterns covered in this chapter (DDD aggregates, CQRS, Event Sourcing) are the write-side of a larger architecture. The read-side has its own concerns: search (Elasticsearch or OpenSearch for full-text and faceted queries), analytics (a data warehouse or lakehouse for historical aggregations), real-time dashboards (a time-series database like InfluxDB or TimescaleDB for metrics), and machine learning features (a feature store for model inputs derived from event history). Each of these read-side systems is a CQRS projection target. The staff-level skill is reasoning about which queries go to which store, who owns each projection, and how the overall data architecture evolves over time without service-to-service coupling.

The "domain tests without any infrastructure" bullet is the foundation for a test strategy that scales. The aggregate tests are pure and fast. The application service tests use mock repositories and mock event stores. The infrastructure tests use a real Postgres instance but no external services. The end-to-end tests use a real deployed environment. This pyramid means the slowest tests are the rarest, and the fastest tests catch the most domain bugs. Staff engineers enforce this pyramid by reviewing test layer assignments in PRs and pushing back on application-layer tests that reach into the database.

The long-term governance concern for this architecture is schema evolution coordination across teams. As the number of event types grows and multiple teams produce and consume events, the serialization contract becomes a shared dependency. A change to `MoneyDeposited` by the accounts team may require updates in the fraud team's projector, the analytics pipeline, and the compliance reporting service. Without a schema registry and a compatibility policy (no field removals without a major version bump, backward-compatible additions only for minor versions), schema changes become coordination problems that slow every team down. The staff-level contribution is building or adopting a schema registry before the coordination cost becomes visible as missed sprint commitments.

---
