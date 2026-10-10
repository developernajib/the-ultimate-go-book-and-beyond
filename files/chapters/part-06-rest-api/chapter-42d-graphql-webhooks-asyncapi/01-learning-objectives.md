## Learning Objectives

1. **Master GraphQL in Go** - Build production GraphQL servers with gqlgen, solve the N+1 problem with dataloaders, implement subscriptions, and harden schemas against DoS attacks
2. **Architect GraphQL at scale** - Understand schema federation vs stitching, persisted queries, and when GraphQL outperforms REST vs when it doesn't
3. **Build reliable webhook infrastructure** - Implement at-least-once delivery, HMAC-SHA256 signature verification, exponential backoff retry, and dead-letter queues in Go
4. **Design webhooks for scale** - Build a Hookdeck-style queue-backed delivery service handling millions of events with retries and observability
5. **Master AsyncAPI** - Document event-driven APIs like OpenAPI documents REST, and generate Go code from AsyncAPI specs
6. **Implement hypermedia APIs** - Understand HATEOAS, HAL, JSON:API, and when hypermedia discoverability justifies the complexity
7. **Apply API evolution patterns** - Master expand-contract, consumer-driven contracts, sunset headers, and Go deprecation middleware
8. **Choose the right API style** - Apply a decision framework to select REST, gRPC, GraphQL, or webhooks for any given use case

### Junior → FAANG: Reading Learning Objectives as an Interview Map

Learning objectives are not just a table of contents. At the junior-to-mid level, they function as a checklist of the concepts an interviewer at a senior-hiring bar expects you to know well enough to discuss trade-offs, not just name.

Scan the eight objectives above and identify which ones you can currently explain from first principles versus which ones you can only name. The gaps are your study targets. Concrete gaps that appear frequently in FAANG system design interviews for Go engineers:

- Objective 1 (gqlgen): Can you explain what schema-first code generation buys you over reflection-based binding? The answer is compile-time schema-resolver drift detection, not "it generates code."
- Objective 3 (webhook infrastructure): Can you explain why at-least-once delivery requires idempotency keys on the receiver? If you say "to avoid duplicates" without explaining that HTTP delivery acknowledgment and business logic execution cannot be made atomic without a two-phase protocol, you are missing the depth the interviewer is probing for.
- Objective 5 (AsyncAPI): Can you explain the difference between an AsyncAPI channel and an OpenAPI path? A channel is a logical address on a message broker. It may correspond to a Kafka topic, a NATS subject, or an AMQP exchange. An OpenAPI path is an HTTP endpoint. The conceptual difference is request-response versus publish-subscribe.

**First-job habit:** After completing any technical chapter, write one paragraph per learning objective explaining it without consulting the text. Where you cannot produce a fluent paragraph, re-read and repeat. This is the technique that converts passive reading into interview-ready knowledge.

### Senior @ FAANG: Turning Objectives into Platform Deliverables

At senior and staff level, each learning objective maps to a deliverable that a platform or infrastructure team owns on behalf of the organization. The objective is not a personal skill to acquire. It is a capability the team must provide with an SLA, documentation, and an oncall runbook.

**Objective 1 and 2 (GraphQL server and scale):** The platform deliverable is a reference gqlgen service template with DataLoader wiring, complexity analysis pre-configured, and federation metadata already included. No product team should have to figure out how to plug DataLoader into the request context from scratch. That is solved once, documented, and provided as a cookiecutter.

**Objective 3 and 4 (webhook infrastructure):** The platform deliverable is a shared webhook delivery library or service. Individual product teams declare event types and subscribe endpoint configurations. The platform handles signing key management, retry scheduling, dead-letter queue routing, and delivery dashboards. This is exactly what Svix sells as a managed product. If your organization builds it in-house, the senior engineer owns the reliability contract: at-least-once delivery with a defined SLO (e.g., 99.9% of events delivered within 30 seconds of emission under normal conditions).

**Objective 5 (AsyncAPI):** The platform deliverable is a schema registry that validates AsyncAPI documents on merge, generates consumer SDKs, and enforces backward compatibility rules. Confluent Schema Registry covers this for Avro and Protobuf over Kafka. For JSON Schema events with AsyncAPI documentation, the tooling is less mature and often custom-built. A staff engineer deciding whether to invest in this capability must weigh the cost of runtime schema drift (a producer changes a field name and breaks every consumer silently) against the cost of maintaining the registry infrastructure.

**Objective 8 (API style decision framework):** The platform deliverable is a decision document that teams reference before opening an architecture review. It encodes the organization's current approved API styles, the criteria for choosing each one, and the process for proposing a new style. Without this document, every architecture review re-litigates the same trade-offs, which wastes senior engineer time and produces inconsistent outcomes. Writing and maintaining this document is a concrete L6-level contribution.

**Bar-raiser signal:** A candidate who treats learning objectives as personal skills to acquire is thinking at individual contributor scope. A candidate who asks "what is the organizational capability behind this objective, who owns it, and how is its reliability measured?" is thinking at the scope required for principal and staff roles.

---
