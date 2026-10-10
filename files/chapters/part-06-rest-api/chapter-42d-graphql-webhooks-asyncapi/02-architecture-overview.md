## Architecture Overview

A single Go service can expose multiple API styles simultaneously because each style targets a different consumer contract. The router acts as the single ingress point and dispatches to specialized handlers: gqlgen resolves client-driven queries with schema validation and DataLoader batching, the REST handler handles cacheable CRUD paths, and the Webhook Sender signs outgoing payloads with HMAC-SHA256 and routes failures through a dead-letter queue. The outbox pattern at the bottom ensures webhook events survive process restarts by persisting them to the database before the relay worker attempts delivery.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    API Style Decision Framework                           │
│                                                                           │
│  Client-driven queries?  ──→  GraphQL (gqlgen)                            │
│  Server push events?     ──→  Webhooks / SSE / WebSocket                  │
│  High-perf internal?     ──→  gRPC (protobuf)                             │
│  Public CRUD API?        ──→  REST (OpenAPI)                              │
│  Event-driven docs?      ──→  AsyncAPI                                    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────┐       │
│  │                    Go Service Architecture                     │       │
│  │                                                                │       │
│  │  HTTP/2      ┌─────────────┐    ┌──────────────────────────┐   │       │
│  │  ──────────→ │  Router     │──→ │  GraphQL Handler (gqlgen)│   │       │
│  │              │  (chi/echo) │    │  - Schema validation     │   │       │
│  │              │             │    │  - Resolver dispatch     │   │       │
│  │              │             │    │  - DataLoader (N+1 fix)  │   │       │
│  │              │             │    │  - Subscription WS       │   │       │
│  │              │             │    └──────────────────────────┘   │       │
│  │              │             │    ┌──────────────────────────┐   │       │
│  │              │             │──→ │  REST Handler            │   │       │
│  │              │             │    └──────────────────────────┘   │       │
│  │              │             │    ┌──────────────────────────┐   │       │
│  │              │             │──→ │  Webhook Sender           │  │       │
│  │              └─────────────┘    │  - HMAC signing           │  │       │
│  │                                  │  - Retry + DLQ              ││      │
│  │                                  └──────────────────────────┘  │       │
│  └────────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  Webhook Delivery Pipeline:                                               │
│  Event → Outbox Table → Relay Worker → HTTP POST → Retry Queue → DLQ      │
└───────────────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading Architecture Diagrams as Trade-off Maps

The diagram above looks like a routing diagram, but it is actually a trade-off document encoded as ASCII art. Each box represents a decision about which API style to expose to which consumer type. Reading architecture diagrams as trade-off maps is a skill that distinguishes candidates who can design systems from candidates who can only implement them.

Walk through each routing decision and understand the reasoning:

- "Client-driven queries" routes to GraphQL because the alternative is building bespoke REST endpoints for each client's data shape, which creates an unbounded maintenance burden as clients evolve.
- "Server push events" routes to Webhooks/SSE/WebSocket because REST has no native push primitive. Polling is the workaround, but it is wasteful when events are infrequent.
- "High-perf internal" routes to gRPC because protobuf serialization is smaller and faster than JSON, and the generated client stubs enforce the contract at compile time across service boundaries.
- "Public CRUD API" routes to REST because HTTP semantics (caching, status codes, content negotiation) are well understood by every HTTP client in every language, and CDNs can cache GET responses without custom logic.

**The outbox pattern** in the diagram is worth understanding before your first job. The naive webhook implementation writes to the database and then makes the HTTP delivery call in the same request handler. If the process crashes after the database write but before the HTTP call, the event is lost. The outbox pattern writes the event to an outbox table in the same database transaction as the business data change, then a separate relay worker reads undelivered outbox rows and makes the HTTP call. This makes delivery eventual but guarantees the event is never silently dropped.

**Interview entry point:** When asked "how do you ensure reliability in an event-driven system?" the outbox pattern is a concrete, implementable answer that demonstrates understanding of distributed systems failure modes.

### Senior @ FAANG: Multi-Style API Architecture Governance

The architecture diagram shows a single Go service exposing multiple API styles through a shared router. At FAANG scale, this pattern raises four governance questions that a senior engineer must have considered before the architecture review.

**Question 1: Who owns the schema registry?** A single service with a GraphQL schema, REST OpenAPI spec, and AsyncAPI document has three API contracts to version and govern. Each has a different tooling ecosystem: gqlgen for GraphQL, oapi-codegen for REST, and asyncapi-generator for event contracts. At scale, these schemas live in a central registry, and changes that break existing consumers require an approval step. The platform team owns the registry, and individual service teams own the schemas they publish. The architecture must define who is responsible for detecting breaking changes before they reach production.

**Question 2: How are cross-cutting concerns applied consistently across API styles?** Authentication, tracing, rate limiting, and request logging must work identically regardless of whether the request arrives as a GraphQL POST, a REST GET, or a WebSocket upgrade. The router in the diagram is where these concerns are applied via middleware. The governance question is: does every team add their own middleware and inevitably diverge, or does the platform team provide a standard router configuration that applies all cross-cutting concerns by default? The correct answer at scale is the latter, with opt-out requiring a documented exception.

**Question 3: What is the failure model for the outbox relay worker?** The outbox pattern introduces an asynchronous delivery gap: events are stored durably but not delivered immediately. The SLO question is: what is the maximum acceptable delivery latency, and what monitoring alerts when the relay worker falls behind? At Stripe's scale (100 million webhook events per day), the relay worker is not a single process but a horizontally scaled fleet with consumer group semantics. Each service team using this architecture must understand the delivery latency SLO and instrument the outbox table depth as a metric.

**Question 4: How are signing keys rotated without downtime?** The architecture uses HMAC-SHA256 signing keys to authenticate webhook deliveries. Keys must be rotatable (for security hygiene and in response to suspected compromise) without dropping deliveries during the rotation window. The Standard Webhooks spec handles this by allowing multiple signatures per delivery (space-separated in the header), so receivers can accept either the old or new key during a transition period. This rotation protocol must be designed and documented before any external consumers register their webhook endpoints, because changing the signature format retroactively breaks every integration.

**Staff-level addition:** At L7 and above, the architecture diagram is not the output of an individual engineer's thinking. It is the output of a collaborative process that includes SRE input on operational complexity, security team input on the threat model for each API style, and product engineering input on the consumer requirements that drove the API style choices. A staff engineer's role is to facilitate that process and produce an architecture that the entire organization can operate safely, not just one that is technically correct.

---