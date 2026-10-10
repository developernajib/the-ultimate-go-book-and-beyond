## 52D.12 Company Case Studies

### Event Sourcing in Ticketing Systems

Ticketing is a canonical event-sourcing domain (an Eventbrite-scale workload makes the case vividly; see *Eventbrite Engineering, "Moving Towards an Event-Driven Architecture"* and Martin Fowler's canonical *Event Sourcing* pattern specifications), because the complete history of ticket state changes is critical. Every ticket goes through multiple states: created, reserved, sold, transferred, refunded. In the traditional model, you could only see the current state. With event sourcing, the platform can answer questions like "was this ticket ever refunded and then re-sold?" - critical for fraud detection and customer support.

Key architectural decisions:
- Events are stored in PostgreSQL with stream-per-aggregate pattern
- Projections are maintained in Elasticsearch for fast full-text and faceted search
- Snapshots are taken every 100 events for high-volume event streams (popular concerts can have thousands of ticket state changes)
- The event store serves as the primary pub/sub mechanism - downstream services subscribe to the event stream

### CQRS at Microsoft (Azure Service Bus)

Microsoft Azure Service Bus applies CQRS architectural separation internally (documented in *Microsoft Learn, "Command and Query Responsibility Segregation (CQRS) Pattern"* and Azure Architecture Center blueprints) to decouple the management plane (control operations: create namespace, create queue) from the data plane (message send/receive). The management plane uses a consistent, strongly-typed domain model with full validation. The data plane uses read models optimized for throughput and low latency.

Key design decisions:
- Management commands go through a rich domain model with validation
- Operational metrics are projected into time-series read models for the monitoring dashboard
- The separation allows independent scaling: data plane handles millions of messages/second while management plane is relatively low traffic

### CQRS + Event Sourcing Concepts in Axon (Applied to Go)

The Axon Framework by AxonIQ (documented in *Axon Framework Reference Guide: CQRS and Event Sourcing Architecture*) popularized CQRS + Event Sourcing in the JVM ecosystem. Their patterns translate directly to Go:

| Axon Concept | Go Equivalent |
|---|---|
| `@Aggregate` | Event-sourced struct with `apply()` method |
| `@CommandHandler` | `CommandHandler[C Command]` interface |
| `@EventHandler` (projection) | `Project(ctx, event)` on projector structs |
| `AggregateRepository` | `AccountRepository` using `EventStore` |
| `EventStore` | `PostgresEventStore` with stream-per-aggregate |
| `Snapshot` | `Snapshot` struct + `TakeSnapshot()` method |

The key difference in Go: no annotations, no reflection, no magic. All wiring is explicit, which makes Go implementations easier to debug and reason about.

### Junior → FAANG: Using Case Studies in Interviews

Case studies are interview ammunition. "Eventbrite uses event sourcing for ticketing with snapshots every 100 events and Elasticsearch projections" is a concrete, defensible example. When an interviewer asks "have you seen CQRS or Event Sourcing used in practice?" you should not say "I read about it in a book." You should describe a real system's design decisions and the trade-offs it made.

For each case study, practice answering: "what problem made CQRS or Event Sourcing worth the complexity?" For Eventbrite, it is fraud detection and customer support requiring full ticket history. For Azure Service Bus, it is independent scaling of the management plane (low traffic, high consistency) from the data plane (high throughput, low latency). For Axon, it is Java ecosystem standardization. These "why" answers are more valuable than the "what" descriptions.

The Axon-to-Go mapping table is useful for conversations with Java engineers. If you join a team that has Java DDD expertise and is building a new Go service, this table helps you communicate in their vocabulary while explaining Go's explicit wiring approach. Being able to bridge ecosystems is a junior engineer superpower that is often underestimated.

The "no magic" point about Go is worth internalizing early. Annotation-based frameworks (Spring, Axon) hide wiring behind metadata. Go's approach is to wire explicitly in `main.go` or a `wire.go` file. The trade-off: more code to write upfront, but every dependency is grep-able, every registration is visible, and debugging does not require understanding framework magic. This aligns with Go's design philosophy and is why Go is increasingly chosen for infrastructure and financial systems.

### Senior @ FAANG: What the Case Studies Do Not Tell You

Case studies in conference talks and blog posts describe the architecture after it worked. They omit the failures, the migrations, the on-call incidents, and the complexity costs. Reading them as a senior engineer means asking the questions that the author did not answer.

For Eventbrite: what does a projection rebuild look like at the scale of "thousands of ticket state changes per popular concert?" If an event has 50,000 attendees and each ticket goes through 5 state changes, that is 250,000 events per event (in the domain sense). A projection rebuild for a single concert is manageable. A rebuild of the entire event history is a multi-day job. What is their strategy: incremental checkpointed rebuilds, blue/green tables, or accepting downtime windows for the search index? The talk does not say. Asking this in a design review is a staff-level contribution.

For Azure Service Bus: the separation of management plane and data plane is a pattern that appears throughout Microsoft Azure (it is also the design of the control plane/data plane split in Azure Kubernetes Service, Azure SQL, and Azure Event Hubs). The pattern is not CQRS-specific: it is the principle that administrative operations (low-frequency, high-consistency) and operational traffic (high-frequency, high-throughput) have fundamentally different reliability and scaling requirements. Recognizing this pattern across systems and being able to articulate it at an architecture review is L6-level systems thinking.

For Axon and Go: the explicit wiring advantage compounds as the system grows. Annotation-based wiring means the framework owns the object graph. When something goes wrong at startup, the error message often points into framework internals. In Go's explicit wiring model, the error points to the line in your `main.go` where the dependency was not satisfied. This matters most in on-call situations at 3am. The organizational argument for explicit wiring is: it makes the dependency graph auditable by anyone with a Go compiler, not just engineers who know the framework. This is a governance consideration for large teams.

The missing case study is one that failed. An honest analysis of Event Sourcing adoption includes projects that added it to simple CRUD services, accumulated projector debt, struggled with rebuild times, and eventually migrated back to current-state storage. These stories exist (Uber Engineering and Martin Kleppmann have written about the costs of event-driven complexity at scale) but are underrepresented in pattern-advocacy literature. Being aware of them calibrates your judgment when evaluating whether a new system needs Event Sourcing.

---
