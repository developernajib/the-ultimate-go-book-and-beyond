## Company Case Studies

### GitHub - Webhooks at Scale

GitHub delivers billions of webhook events daily across millions of repositories.

**Challenge:** Millions of repositories, each sending multiple events per push. Customer servers are frequently slow, down, or behind firewalls.

**Solution:**
- Queue-backed delivery with per-repository rate limiting to prevent one busy repo from starving others
- Exponential backoff up to 72 hours before giving up (longer than any maintenance window)
- Auto-disable endpoints after 10 consecutive days of failures, which prevents infinite retry queues
- Webhook delivery log UI - customers can see every delivery attempt, status code, and response body, and can replay failed deliveries with one click
- `X-GitHub-Delivery` UUID header for deduplication in receiving systems

**Go lesson:** Build a delivery log UI with replay capability before going live. It's the first thing customers ask for when debugging integration issues.

### Shopify - GraphQL as Primary API

Shopify migrated their partner API from REST to GraphQL as their primary interface.

**Challenge:** 8,000+ Shopify app developers built wildly different apps. Some needed product data, some needed order data, some needed both. REST APIs led to massive over-fetching on mobile and complex multi-request patterns for complex UIs.

**Solution:**
- Cost-based rate limiting: each query has a calculated cost (not request count). Budget: 1000 cost units per 1 second, refilling at 100/second
- Bulk operations: async GraphQL mutations for large data exports. Submit a mutation, poll for completion, download JSONL results
- `@deprecated` directive on fields with migration guidance in the deprecation message
- Admin API and Storefront API are separate GraphQL schemas with different authorization models

**Go lesson:** For public developer APIs, implement cost-based rate limiting from day one. Request-count limiting punishes efficient clients who batch queries.

### Stripe - Webhook Infrastructure

Stripe's webhook system is the gold standard for webhook design.

**Challenge:** Payment events are business-critical. A missed `payment_intent.succeeded` webhook might mean a merchant ships an order they'll never get paid for.

**Solution:**
- Retry with exponential backoff for 72 hours: 1m, 5m, 30m, 2h, 8h, 24h+ attempts
- HMAC-SHA256 signature with timestamp: `Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a05bd539ba74dd4efd15d6`
- 5-minute tolerance window on timestamp (replay attack prevention)
- Webhook endpoint health monitoring in the Stripe dashboard, showing success rate, p99 latency, and failure patterns
- Event versioning: `api_version` field in every event payload indicates which API version generated the event
- Test mode and live mode webhook endpoints are separate, so test events never reach production

**Go lesson:** Include the API version in every webhook payload. When you change event schemas, customers can handle both old and new formats during migration.

### AsyncAPI for Event Governance at Thousand-Service Scale

A fleet like Netflix's, a thousand-plus microservices with hundreds producing Kafka events, hits "event sprawl" fast: nobody can say what events exist or what their schemas are. AsyncAPI is the specification the industry converged on for exactly this governance problem.

**Solution:**
- Central schema registry with AsyncAPI specs for every event
- Generated Go/Java/Python consumer and producer stubs from AsyncAPI - teams never write Kafka serialization code by hand
- Schema evolution validation in CI: new specs must be backward-compatible (adding fields OK, removing or changing types fails the build)
- Internal event catalog: auto-generated documentation site from AsyncAPI specs, searchable by event name, producer team, and data field
- Automated alerts when producers publish events not matching their registered spec

**Go lesson:** Treat your async API as a first-class API artifact. A Kafka topic without an AsyncAPI spec is like a REST endpoint without OpenAPI - discoverable only by reading source code.

---

### Junior → FAANG: Reading Case Studies as Engineering Blueprints

Most engineers read case studies and absorb the headline: "GitHub uses exponential backoff." FAANG interviewers want you to extract the *why* behind each design choice and connect it to a general principle you can apply in a new context.

Work through each case study using this pattern: identify the constraint, name the trade-off it forced, and state the general rule. For GitHub: the constraint is that customer servers go down unexpectedly. The trade-off forced is between indefinite retries (noisy queues) and giving up too fast (lost events). The rule is: pick a retry window that covers your longest expected customer maintenance window, then auto-disable to protect yourself.

First-job habits to build from these cases:

- When you build any async delivery feature, add a delivery log UI before you go to production. GitHub treats this as table stakes. Customers can not debug integrations without it.
- When you design a public API, prototype cost-based rate limiting from day one. Adding it after launch requires negotiating with existing clients who built around request-count assumptions.
- Treat every Kafka topic as a published API. If you would not ship a REST endpoint without an OpenAPI spec, do not ship a Kafka producer without an AsyncAPI spec.
- Interview entry point: if asked "how would you design a webhook delivery system," start with the outbox pattern and delivery log, not the HTTP client. Interviewers want to see that you understand durability before you talk about transport.

Entry-level interview framing: these companies did not build their webhook or GraphQL infrastructure correctly on the first try. The patterns you see are the result of incident postmortems. When you are asked a design question, the interviewer is asking whether you know the failure modes before you have to experience them personally.

### Senior @ FAANG: Extracting Architecture Decision Records from Published Case Studies

Published engineering case studies are a filtered view. Companies share the solution, rarely the failed attempts, the political constraints, or the organizational debt that shaped the final design. A staff-level engineer reads between the lines.

**GitHub: auto-disable is an organizational decision, not just a technical one**

Auto-disabling endpoints after 10 days of continuous failure sounds like a reliability feature. It is also a product decision about where the obligation boundary sits. GitHub decided that maintaining an infinitely growing retry queue on behalf of a broken customer endpoint is not their responsibility. This is a service contract decision that required alignment between engineering, product, and legal. The technical mechanism is simple. Getting the company to agree on the policy is the hard part.

When you design a webhook platform, document the equivalent policy as an ADR before writing code. The ADR should specify: what constitutes a permanent failure, what the notification path is, what the re-enable process requires, and what SLAs apply during the retry window.

**Shopify: cost-based rate limiting is a pricing model in disguise**

Shopify's query-cost budget (1000 units per second, refilling at 100/second) is not just a DoS defense. It is an implicit pricing tier. High-volume apps that need large bulk queries pay more by consuming more of their budget. Shopify Bulk Operations (async GraphQL mutations) exist to give cost-sensitive apps a separate path that does not compete with real-time budgets.

A staff engineer designing a rate-limit system should treat the budget parameters as product requirements, not engineering constants. Document them in an ADR, socialize with platform economics, and build tooling so the parameters can be adjusted per customer tier without a code deploy.

**Stripe: versioned event payloads as an organizational maturity signal**

Including `api_version` in every webhook event means Stripe can change event schemas across API versions without forcing all webhook consumers to migrate simultaneously. This requires the webhook delivery infrastructure to know which API version each subscription was created under and render the event payload against that version's schema.

This is operationally expensive to maintain. Most companies never build it because it requires a central event schema registry with per-version rendering logic. The fact that Stripe built it reflects their volume: they have customers who have pinned to old API versions for years and cannot migrate quickly. A platform at smaller scale may reasonably choose a simpler model (one event schema, additive-only changes) and accept the constraint that breaking changes require a forced migration.

The governance question is: at what customer count or contract sensitivity does per-version event rendering become worth the operational cost? Document that threshold in an ADR and revisit it when you cross it.

**Netflix: event catalogs are a platform team product**

Netflix's auto-generated event catalog (searchable AsyncAPI documentation from a central registry) is not a tooling choice. It is a platform team's core product offering to internal consumers. The catalog makes the platform team visible and useful to 1,000 service teams without requiring manual coordination.

A platform team without a catalog is forced to answer "what events exist and where do I find their schemas?" repeatedly. Answering that question manually does not scale. The catalog is the scalable answer.

Bar-raiser signal: if asked about developer experience for an internal event platform, the answer that distinguishes L6 from L5 is "we make event discovery self-service through a searchable catalog generated from specs, so teams never need to file a ticket to find out what events a service produces."

**Cross-case pattern: the operational surface area always grows**

Every case study shows the same arc. Initial delivery: simple synchronous webhook or a basic GraphQL endpoint. Post-launch: delivery log, retry monitoring, auto-disable, cost-based limits, versioned schemas, schema validation in CI. The operational surface area grows to match customer expectations and incident frequency.

A senior engineer accounts for this in the initial design by building extension points rather than final solutions. Design the outbox table with a status column that can express states you have not invented yet. Design the rate-limit system with parameterizable tiers. Design the schema registry with a validation hook interface so you can plug in new compatibility rules without rewriting the registry.

Maturity model for each capability:

- Level 1: Feature works in the happy path.
- Level 2: Feature has monitoring and alerts.
- Level 3: Feature has a customer-facing self-service surface (delivery log, replay button, usage dashboard).
- Level 4: Feature has governance tooling (auto-disable policies, schema evolution enforcement, deprecation workflows).
- Level 5: Feature has a published SLA and a runbook for every failure mode.

Most teams ship at level 1 or 2 and discover the cost of missing level 3 and 4 only after customer escalations. A staff engineer pushes to define the maturity target before sprint planning, not after the first incident.
