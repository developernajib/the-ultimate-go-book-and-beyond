# Chapter 42D: Beyond REST and gRPC: GraphQL, Webhooks, and AsyncAPI

*"APIs are the connective tissue of the modern web. Choose the wrong API style and you'll spend years paying the interest on that decision."*

REST is the right default for most public APIs, and gRPC is the right default for most internal service-to-service communication. But modern systems routinely encounter requirements that neither style handles well. A mobile client that needs to fetch a user profile, their last three orders, and their unread notification count in a single round trip is a poor fit for REST's resource-per-endpoint model. Each resource requires a separate request, or you build a bespoke aggregation endpoint that exists only for that client. A payment platform that needs to notify thousands of merchant systems the moment a transaction settles cannot do so with REST's request-response model at all. An event-driven microservices architecture that publishes to Kafka cannot be documented with OpenAPI because it has no HTTP endpoints to describe.

GraphQL, webhooks, and AsyncAPI are not replacements for REST. They are complementary tools for use cases REST was not designed to handle. GraphQL lets clients declare exactly what data they need and receive it in a single request, eliminating over-fetching and under-fetching. Webhooks invert the HTTP model so servers push events to clients in real time, enabling integrations that are impossible with polling. AsyncAPI brings the same rigorous contract-first design discipline that OpenAPI brought to REST APIs to message queues, event streams, and pub/sub systems. Each adds significant complexity, and choosing the wrong one, or introducing one before your team is ready, is a form of technical debt that is expensive to unwind.

This chapter gives you both the theory and the production Go implementation for each API style. You will build a GraphQL server with gqlgen, solve the N+1 query problem with dataloaders, implement real-time subscriptions over WebSocket, secure your schema against depth and complexity attacks, design a webhook delivery system with HMAC signing and exponential backoff retries, document an event-driven system with AsyncAPI, and apply a structured decision framework to choose the right API style for any given requirement.

**What you'll learn in this chapter:**
- Building a production GraphQL server in Go with gqlgen: schema-first design, resolvers, and type mapping
- Solving the N+1 problem with DataLoader batching and caching for efficient database access
- GraphQL subscriptions over WebSocket for real-time data push to connected clients
- Schema security: query depth limits, complexity analysis, and rate limiting for GraphQL endpoints
- Webhook delivery infrastructure: HMAC-SHA256 signing, at-least-once delivery, and dead-letter queues
- AsyncAPI specification: documenting Kafka, NATS, and RabbitMQ event contracts with the same rigor as OpenAPI
- Hypermedia APIs: HATEOAS, HAL, and JSON:API for self-describing, discoverable resource representations
- API style selection framework: when to use REST, gRPC, GraphQL, webhooks, or event streaming

**Why this matters at scale:**
GitHub runs a public GraphQL API alongside its REST API, and its design is the reference example for the trade-off at the heart of this chapter: because clients compose their own queries, GitHub cannot price a request by counting it, so it scores each query's potential node count into points and budgets 5,000 points per hour. That is the tax GraphQL charges. You gain the single round trip, and you lose the ability to reason about cost per endpoint, which means you must build a cost model instead. Stripe's webhook system is the reference for the other half: at-least-once delivery, HMAC signature verification with a timestamp to defeat replay, and retry with exponential backoff. Both architectures are what you will implement in Go in this chapter.

**Prerequisites:** Chapter 38 (REST fundamentals), Chapter 42B (API design philosophy), Chapter 42 (rate limiting for GraphQL security)

### Junior → FAANG: Understanding Why Multiple API Styles Exist

A common early-career mistake is treating REST as a universal tool and viewing GraphQL or webhooks as merely fashionable alternatives. Before writing any code in this chapter, understand the concrete problem each style solves.

REST was designed around the HTTP resource model: a URL identifies a resource, HTTP verbs describe the operation, and status codes convey the outcome. That model maps well to server-driven CRUD and benefits from HTTP caching at every layer. The problem is that it requires clients to make multiple requests for related data, and it cannot push data to clients without polling.

GraphQL exists because Facebook's mobile clients needed heterogeneous data shapes per screen without the latency of sequential REST calls. The key insight is that the client, not the server, defines the response shape. That is a meaningful inversion: the server declares what data exists (the schema), and the client declares what it needs (the query).

Webhooks exist because polling is wasteful at scale. If you are checking an order status endpoint every five seconds, you generate thousands of requests per day that return "nothing changed." Webhooks invert the contract: the server calls you when something changes, not the other way around.

AsyncAPI fills the documentation gap that OpenAPI cannot: when your system communicates through Kafka topics or NATS subjects rather than HTTP endpoints, you need a contract format that describes message schemas, channels, and protocol bindings. AsyncAPI is that format.

**First-job habits to build:**
- Before proposing a new API style, write down the specific requirement that REST does not serve well. If you cannot articulate it, REST is probably the right choice.
- GraphQL has real costs: the N+1 problem, per-field authorization complexity, and the absence of HTTP-level caching. Understand these before advocating for GraphQL.
- Interview entry point: expect to be asked "when would you choose GraphQL over REST?" The answer is not "GraphQL is newer and better." The answer is "when clients need heterogeneous data shapes, when multiple client types exist with different field requirements, or when you are building a BFF over microservices."

### Senior @ FAANG: API Style Governance and Platform-Level Decision Authority

At senior and staff level, the question is not which API style to use for one endpoint. The question is how the organization makes consistent API style decisions across dozens of teams, and how those decisions are enforced without becoming a bureaucratic bottleneck.

**Architectural Decision Record framing.** Every API style adoption should produce an ADR that documents the context (what requirement drove the decision), the options considered (REST, gRPC, GraphQL, webhooks, event streaming), the decision made, and the consequences including costs and known risks. ADRs are not about getting permission. They are about creating a searchable record that prevents future teams from re-litigating settled decisions and allows new engineers to understand the reasoning behind the current architecture.

**Platform maturity model for API diversity.** A useful mental model has four stages. At stage one, the organization ships REST for everything, including cases REST handles poorly. At stage two, individual teams adopt GraphQL or gRPC in isolation, creating inconsistent patterns. At stage three, the platform team establishes approved patterns with reference implementations, shared middleware, and tooling. At stage four, the API surface is governed by a schema registry, breaking changes require approval, and SLOs are enforced per API style. Most FAANG-scale organizations operate between stage three and stage four. Your job as a senior or staff engineer is to move your organization toward stage four without blocking velocity.

**Cross-cutting concerns that apply at every layer.** Regardless of API style, the following concerns must be solved once at the platform level and not re-implemented by each team: authentication token validation, rate limiting, request tracing with correlation IDs, structured logging, circuit breaking for downstream calls, and observability integration. The architecture diagram in this chapter shows a single router dispatching to multiple handlers. In a mature platform, that router is where the cross-cutting concerns live, not inside individual handlers.

**Staff-level concern: the cost of API style proliferation.** Every additional API style in your stack adds a maintenance surface. Client libraries must support it, monitoring dashboards must handle its metrics, oncall engineers must understand it, and security reviews must account for its threat model. A staff engineer evaluating whether to introduce GraphQL at their organization should ask: what is the operational cost of training every SRE on GraphQL query complexity attacks, DataLoader cache poisoning, and subscription connection management? Sometimes the honest answer is that REST with a well-designed BFF layer is less expensive to operate even if GraphQL would technically perform better.

**Bar-raiser interview signal.** A candidate answering "when would you introduce GraphQL at scale?" who only discusses the technical benefits of GraphQL is giving a junior answer. A strong senior answer addresses the organizational readiness question: do you have DataLoader expertise on the team, do you have complexity analysis in your WAF, do you have a schema registry for federation governance, and is your oncall rotation prepared for subscription connection leak incidents? The ability to reason about organizational and operational costs, not just technical capabilities, is what distinguishes L5 from L6 thinking.

---
