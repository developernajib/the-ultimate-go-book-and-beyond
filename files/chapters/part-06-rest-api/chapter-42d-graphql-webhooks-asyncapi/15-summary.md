## Summary

GraphQL, webhooks, and AsyncAPI address different API communication patterns that REST and gRPC don't optimally handle.

**GraphQL** shines when clients have heterogeneous data needs. Mobile apps, web dashboards, and data science tools all query the same schema but get exactly what they need. The N+1 problem is universal and DataLoaders are the universal solution. Security requirements are non-trivial: disable introspection in production, implement complexity-based limits, consider persisted queries for mobile apps, and rate limit by query cost not request count.

**Webhooks** are the right tool when your system must notify external services about events. The critical architectural decisions: always use the outbox pattern for guaranteed delivery, sign every payload with HMAC-SHA256 including a timestamp (prevents both tampering and replay), implement full jitter backoff (prevents thundering herd after mass failures), and build a delivery log with replay capability from day one, because customers will need it for debugging.

**AsyncAPI** brings documentation rigor to event-driven systems. Kafka topics without AsyncAPI specs are like REST endpoints without OpenAPI - discoverable only by reading source code. The investment in AsyncAPI pays off with generated type-safe consumers/producers, schema evolution validation in CI, and centralized event catalogs.

**The decision framework:**
- Client-chosen fields from complex nested data → GraphQL
- Server push events to external HTTP endpoints → Webhooks
- Real-time updates in browser/mobile → SSE (simpler) or WebSocket (bidirectional)
- High-performance internal RPC → gRPC
- Standard CRUD public API → REST
- Documenting Kafka/AMQP event streams → AsyncAPI

### Junior → FAANG: Consolidating the Chapter into Interview-Ready Mental Models

Three mental models cover 90% of what interviewers ask about GraphQL, webhooks, and AsyncAPI.

**Mental model 1: who controls the response shape?**

GraphQL exists because mobile clients at Facebook needed a different subset of data than desktop clients, and REST's fixed response shapes forced either over-fetching or multiple round trips. Whenever an interviewer describes a scenario where different clients need different subsets of the same data, GraphQL is the answer to consider. Whenever the response shape is fixed and server-driven, REST is simpler. Do not pick GraphQL to be modern. Pick it when client-controlled field selection solves a real problem in the scenario.

**Mental model 2: delivery durability is a separate concern from transport**

HTTP can fail. Customer servers go down. Network partitions happen. Webhooks exist to push server-side events to external systems, but the naive implementation (POST in the request handler) couples your reliability to the receiver's reliability. The outbox pattern decouples them: write the event durably first, deliver it later. This same principle applies to any async delivery: Kafka producers that write to the topic synchronously in the request path have the same coupling problem. Durability requires writing to the durable store before acknowledging the originating operation.

**Mental model 3: async API contracts need the same rigor as sync API contracts**

OpenAPI for REST, AsyncAPI for events. A Kafka topic without a schema spec is not a feature, it is technical debt. The debt compounds every time a consumer parses the message with assumptions that break when the producer changes the format. The investment in AsyncAPI pays off the first time schema evolution validation in CI catches a breaking change before it reaches production.

For interview situations: if you can draw the failure mode of each naive approach and name the pattern that solves it, you are prepared. N+1 without DataLoader, dual-write without outbox, HMAC without timestamp, events without AsyncAPI spec. Each failure mode has a named solution. Knowing the pairing is the minimum bar.

### Senior @ FAANG: Platform Maturity and the Governance Layer

This chapter covers three distinct API paradigms. At staff level, the interesting question is not "how do I implement GraphQL" but "how do I make GraphQL the right choice across 20 teams without creating 20 incompatible GraphQL implementations."

**GraphQL platform governance:**

A mature GraphQL platform has three components beyond the runtime: a schema registry that validates composition and evolution, a complexity budget system that is configurable per customer tier, and a usage analytics system that makes field-level deprecation safe. None of these are optional if you are running GraphQL at scale for external developers. They are the difference between a GraphQL API and a GraphQL platform.

The governance question is who owns these components. In most organizations, they belong to a platform or API team, not to the product teams that own individual schemas. This creates a two-layer ownership model: product teams own their subgraph schemas, the platform team owns the supergraph composition and the governance tooling. Document this boundary explicitly. Ambiguous ownership of the schema registry is a source of significant operational friction.

**Webhook platform governance:**

A mature webhook platform has a defined service level objective for delivery latency and success rate, published to customers. Without a published SLO, customers have no baseline for filing a support ticket, and your team has no clear threshold for what constitutes an incident. Stripe publishes its retry schedule. GitHub publishes its auto-disable policy. These are trust signals that make enterprise customers comfortable depending on your webhooks for business-critical workflows.

The delivery infrastructure maturity model: level 1 is delivery with retry. Level 2 is delivery with retry and a customer-facing delivery log. Level 3 is delivery with retry, delivery log, dead-letter queue, and customer notification on persistent failure. Level 4 adds per-endpoint health monitoring in the customer dashboard. Level 5 adds a published SLO with automated alerting tied to that SLO. Most teams ship level 1 and discover the cost of missing level 2 and 3 after the first enterprise customer escalation.

**AsyncAPI governance:**

The spec requirement is only effective if it is enforced. "Teams should write AsyncAPI specs" is a guideline that decays. "PRs that add or modify a Kafka producer fail CI if they do not include a corresponding AsyncAPI spec update in the central schema registry" is an enforceable rule. The difference is whether the governance is in a document or in the pipeline.

Schema compatibility validation belongs in the producer's CI pipeline, not the consumer's. A breaking schema change that reaches the Kafka topic causes consumer failures that are hard to diagnose and require coordinated rollbacks. Catching the break in the producer's PR is the correct place, because the producer owns the contract.

**The synthesis:**

GraphQL, webhooks, and AsyncAPI are each solutions to the same underlying problem: how do different systems communicate their data contracts across team and organizational boundaries. The technical implementations are well-covered in this chapter. The staff-level work is making those implementations consistent, discoverable, and governable across an organization where individual teams make local decisions. That requires schema registries, enforcement in pipelines, published SLOs, and team ownership models. Building the technology is the easier part.
