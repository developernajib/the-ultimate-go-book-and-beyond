## 52D.2 CQRS Architecture

### The Two Sides

CQRS splits the application into a write side (Commands → Command Bus → Handler → Aggregate → Repository) and a read side (Queries → Query Bus → Handler → Read Model), allowing each to be scaled and optimized independently. The diagram traces a full request cycle: a command mutates aggregate state and emits domain events to the event bus, which asynchronously updates the denormalized read models that power the query side.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CQRS Architecture                               │
│                                                                         │
│   HTTP/gRPC                                                             │
│   Request                                                               │
│      │                                                                  │
│      ├─── Command ──────────────────────────────────────────┐           │
│      │                                                       │          │
│      │    ┌─────────────────────────────────────────────┐   │           │
│      │    │           COMMAND SIDE (Write)              │   │           │
│      │    │                                             │   │           │
│      │    │  Command ─► Command Bus ─► Command Handler  │   │           │
│      │    │                               │             │   │           │
│      │    │                               ▼             │   │           │
│      │    │                         Domain Aggregate    │   │           │
│      │    │                               │             │   │           │
│      │    │                               ▼             │   │           │
│      │    │                         Repository.Save()   │   │           │
│      │    │                               │             │   │           │
│      │    │                               ▼             │   │           │
│      │    │                         Domain Events ──────┼───┘           │
│      │    └─────────────────────────────────────────────┘               │
│      │                               │                                  │
│      │                               ▼                                  │
│      │                    ┌──────────────────┐                          │
│      │                    │  Event Store /   │                          │
│      │                    │  Write Database  │                          │
│      │                    └────────┬─────────┘                          │
│      │                             │                                    │
│      │                             ▼                                    │
│      │                    ┌──────────────────┐                          │
│      │                    │  Projection      │                          │
│      │                    │  Process         │                          │
│      │                    └────────┬─────────┘                          │
│      │                             │                                    │
│      │                             ▼                                    │
│      │                    ┌──────────────────┐                          │
│      │                    │  Read Store      │                          │
│      │                    │  (Read Models)   │                          │
│      │                    └────────┬─────────┘                          │
│      │                             │                                    │
│      └─── Query ──────────────────►│                                    │
│           ─► Query Bus             │                                    │
│           ─► Query Handler ────────┘                                    │
│           ─► Read Model View                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Eventual Consistency

When the command and query sides use separate data stores, the query model is **eventually consistent** with the command model. After a write, the read model is updated asynchronously. There is a brief window - milliseconds to seconds - where the read model may not reflect the most recent write.

This is often acceptable, but you must design for it:

1. **Optimistic UI updates**: After a user places an order, show them the new order immediately in the UI without waiting for the read model to update (optimistic display).
2. **Read-your-writes consistency**: For the user who just performed a write, redirect them to a page that reads from the write model for a short window (e.g., 5 seconds) to avoid showing stale data.
3. **Explicit staleness indicators**: Show the user the "as of" timestamp on read models where staleness is visible.
4. **Saga timeouts**: If an eventually consistent operation takes too long (projection lag), surface this as a system alert.

### Junior → FAANG: Reading Architecture Diagrams as Code Contracts

The architecture diagram in this section is not decorative. Each arrow in that diagram represents an interface boundary: a place where one component depends on another via an abstraction, not a concrete type. Before writing any implementation, read the diagram and write out the Go interfaces implied by each arrow.

For example, the arrow from "Command Handler" to "Domain Aggregate" implies the aggregate has public methods the handler can call. The arrow from "Domain Aggregate" to "Repository.Save()" implies a `Repository` interface with a `Save` method. The arrow from "Event Store" to "Projection Process" implies the event store exposes a way to stream events to consumers. Naming and writing these interfaces before you write implementations is the single most valuable habit you can build for systems design.

Eventual consistency is the concept that trips up new engineers most often. The key framing: eventual consistency is a product concern, not just an engineering concern. "The balance is updated within 500ms" is a product requirement, not an implementation detail. When you see eventually consistent systems in production, ask your team what the documented SLO for projection lag is, how it is measured, and what the alerting threshold is. If nobody knows, that is a gap worth filling.

The four strategies for handling eventual consistency (optimistic UI, read-your-writes, explicit staleness, saga timeouts) are your toolkit for the interview question "how do you handle eventual consistency in CQRS?" Memorize the strategy names and be ready to explain each with a concrete UI scenario. Optimistic UI (show the user their write immediately before the projection confirms it) is by far the most common production approach.

### Senior @ FAANG: Consistency Models, SLOs, and Cross-Region Architecture

The architecture diagram presents a single-region view. At FAANG scale, the first complication is multi-region: the write side may be in a primary region, read models may be replicated across regions, and projection lag compounds with replication lag. The design strategies described here (optimistic UI, version tokens, read-your-writes windows) all need to be re-evaluated in a multi-region context because "read from the same source you just wrote to" is no longer trivially achievable.

The distinction between causal consistency and eventual consistency is load-bearing here. A CQRS system with optimistic UI gives the individual user a causally consistent view of their own actions. But if user A's write affects what user B sees, and B reads from a lagging projection, B has a stale view. This is the class of bug that causes "I see the old price" reports in e-commerce and "the money is gone but the balance shows incorrect" reports in fintech. Understanding which reads require causal consistency and which are fine with eventual consistency is a design decision that belongs in the service contract, not the implementation.

Projection lag as an SLO: the correct framing is not "projection lag should be low" but "projection lag must be below X ms at P99 during normal load, and alerts fire at Y ms." The numbers are domain-specific: a financial balance view might require sub-second lag, a reporting dashboard might tolerate minutes. Staff engineers set these numbers based on product requirements, publish them as service commitments, and build the monitoring to verify them. A projector that has no lag SLO will accumulate silent drift over time as load grows.

The saga timeout point in this section is underdeveloped for production use. In a real system, saga timeouts require a scheduler (distributed cron, a delayed-event mechanism, or a polling loop) and a documented compensation policy. What happens when the timeout fires: does the saga fail, retry, escalate to human review, or emit a compensating event? The architecture diagram shows a single synchronous path. The saga timeout path is the ugly distributed systems truth that the clean diagram hides. Surfacing it in design reviews is a staff-level contribution.

Blue/green deployments of projectors deserve a mention here. When you deploy a new version of a projector that changes the SQL schema of a read table, the safe path is: create the new table, deploy the new projector pointing at it, wait for catch-up, flip the read path, decommission the old table. This is zero-downtime projection evolution. Teams that do in-place schema migrations on live projection tables under load discover the failure mode the hard way.

---
