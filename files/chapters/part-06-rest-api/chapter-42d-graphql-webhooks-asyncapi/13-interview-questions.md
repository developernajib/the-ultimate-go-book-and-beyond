## Interview Questions

**Q1: What problem does GraphQL solve that REST doesn't?**

A: The over-fetching and under-fetching problems. With REST, a fixed endpoint returns a fixed response shape - mobile clients get 50 fields when they need 5 (over-fetching), and complex pages require multiple round trips (under-fetching). GraphQL lets clients declare exactly what data they need in a single query. Additional benefits: a strongly typed schema serves as both documentation and contract, adding fields is backward-compatible without versioning, and subscriptions are built-in. GraphQL doesn't replace REST - for file uploads, binary data, simple CRUD with good HTTP caching, REST remains the better choice.

**What FAANG expects:** You frame the answer as a shape mismatch between server and client, not as "GraphQL is better." Bonus points for naming the BFF pattern and noting that Facebook's mobile-vs-desktop fetch divergence is what actually produced the language. Downgrade if you mention "simpler than REST", GraphQL is not simpler, it trades one set of problems for another.

*Follow-ups:*
- What's the runtime cost of that flexibility? (Per-field resolver dispatch, DataLoader coordination, complexity-based rate limiting instead of per-endpoint.)
- Why don't CDNs cache GraphQL responses the way they cache REST? (POST bodies, query variability, you need persisted queries + CDN rules to approximate it.)
- If I'm building a payments API with 4 endpoints, should I pick GraphQL? (No. The flexibility has no value when the response shape is fixed.)

---

**Q2: Explain the N+1 problem in GraphQL and how DataLoaders solve it.**

A: N+1 occurs when a GraphQL query resolves a list of N items, and each item's sub-resolver makes a separate database query. Example: `posts` returns 10 posts, and each post's `author` resolver calls `SELECT * FROM users WHERE id = ?` - 1 query for posts + 10 queries for authors = 11 queries.

DataLoaders solve this through batching: instead of executing immediately, each `Load(key)` call is deferred for a brief window (e.g., 2ms). When the window closes, all accumulated keys are fetched in a single `SELECT * FROM users WHERE id IN (?)`. The key Go detail: DataLoaders work because GraphQL resolvers run concurrently - the 2ms wait allows all concurrent `author` resolutions to accumulate before executing the batch query.

**What FAANG expects:** You can explain *why* the 2ms wait works (concurrent resolver execution in gqlgen's exec engine), scope DataLoaders per-request (never global, cross-request caching leaks auth), and name the caching layer (DataLoader has both batching AND per-request memoization). Mention the failure mode: if a resolver calls `Load` then `Wait` synchronously in a loop, you've re-serialized into N+1.

*Follow-ups:*
- Why are DataLoaders scoped per-request rather than global? (Auth, user A's loader cache must not leak data to user B.)
- What if one key in the batch fails? (The batch function returns `[]Result[T]`, one per key. Partial failure is the norm.)
- How do you verify DataLoaders are actually working in prod? (Count SQL queries in integration tests. Trace spans per resolver field. Alert on query-count/request ratio spikes.)

---

**Q3: How do you prevent GraphQL DoS attacks?**

A: Three complementary defenses:
1. **Complexity analysis** - assign complexity scores per field (list fields multiply by expected result count), reject queries over a budget (e.g., 200 points). Prevents expensive queries regardless of depth.
2. **Depth limiting** - reject queries deeper than N levels (e.g., 10). Prevents infinite nesting.
3. **Persisted queries** - in production, only allow pre-registered query hashes. Attackers can't inject arbitrary query strings.

Additionally: rate limit by IP and API key, disable introspection in production (hides schema from attackers), validate HTTP body size (reject queries > 64KB), and set query execution timeouts via context cancellation.

**What FAANG expects:** You treat persisted queries as the *primary* defense in a first-party-client world, and complexity/depth limits as defense-in-depth. You know that disabling introspection only slows attackers (the schema is still in the binary and recoverable via field probing) but is still table stakes for public endpoints. Bonus: mention Apollo's Automatic Persisted Queries (APQ) for how clients register hashes.

*Follow-ups:*
- Why is depth limiting alone insufficient? (A 3-deep query against a million-edge list is still a DoS.)
- How do you calculate complexity for `users(first: 100) { posts(first: 10) }`? (Multiplicative: 100 × 10 × child cost.)
- Persisted-only vs allowing arbitrary queries with caps, when is each right? (Persisted-only for production clients you control. caps-only for internal tools and partner APIs where you can't enumerate every query upfront.)

---

**Q4: How do you guarantee webhook delivery?**

A: At-least-once delivery via the outbox pattern:
1. In the same database transaction as the business operation, write: the business record + an outbox event record
2. A background worker polls the outbox for unsent events and POSTs to subscribed endpoints
3. On HTTP 2xx: mark delivered
4. On transient failure (5xx, timeout, network error): schedule retry with exponential backoff + jitter
5. On permanent failure (4xx except 429): send to dead-letter queue, notify customer
6. After N retries (e.g., 10 over 72 hours): DLQ + auto-disable endpoint

The outbox pattern ensures no events are lost if the process crashes between DB write and HTTP delivery - on restart, the worker re-processes pending outbox entries.

**What FAANG expects:** You distinguish *at-least-once* delivery from *exactly-once* (exactly-once is only achievable with idempotency on the receiver), explain the outbox pattern in terms of the dual-write problem, and mention the polling vs CDC (change-data-capture via Debezium) tradeoff for how the worker discovers new events. For scale, you mention sharding the outbox table or using a partitioned topic in Kafka as the durable queue instead.

*Follow-ups:*
- What's the CDC alternative to polling the outbox? (Debezium streams Postgres logical replication into Kafka. The worker consumes from Kafka.)
- How do you prevent the outbox from becoming unbounded? (Trim after successful delivery + retention window. Alert on oldest-unsent age.)
- What happens if the receiver returns 200 but crashed before processing? (Lost event from their side. That's why you sign + include event ID: receiver dedups on restart.)

---

**Q5: How does HMAC-SHA256 webhook signature verification prevent replay attacks?**

A: HMAC alone prevents tampering but not replay. A replay attack: attacker captures a valid signed request, stores it, and resends it later. HMAC still verifies - the signature is still valid. Prevention: include the event ID and timestamp in the signed material (`id.timestamp.body`) so the signature covers them. Receiver checks: `now - timestamp < 5 minutes`, then recomputes the HMAC over `id.timestamp.body` and constant-time-compares. An attacker can't edit the timestamp without invalidating the signature, and the receiver's idempotency store on `id` catches replays inside the window. This matches both Stripe's `Stripe-Signature` format and the standardwebhooks.com spec (Svix), which is the emerging cross-vendor standard.

**What FAANG expects:** You name *both* the timestamp window (bounds replay) and the idempotency store keyed on event ID (catches replays inside the window). You mention `hmac.Equal` / constant-time comparison by name. You distinguish symmetric HMAC from asymmetric signing (Ed25519, used by Slack) and know when each applies. Bonus: mention key rotation via multiple signature entries in the header (`v1,<sig1> v1,<sig2>`).

*Follow-ups:*
- Why `hmac.Equal` and not `==`? (Timing attacks, byte-by-byte compare leaks signature prefix length.)
- How do you rotate the signing secret without a delivery gap? (Sign with both old and new secrets for one rotation window. Receivers accept either.)
- When would you use asymmetric (Ed25519) over HMAC? (Third-party receivers shouldn't hold a shared secret you also use to sign, e.g., Slack's signing because thousands of apps verify.)

---

**Q6: What is schema federation in GraphQL?**

A: Federation (Apollo Federation, now on v2) allows multiple independent GraphQL services to each own part of the schema, and a gateway combines them into a unified graph. Example: User Service owns `User` type, Order Service owns `Order` type and extends `User` with an `orders` field. The gateway routes `user { ... }` queries to User Service and `order { customer { ... } }` queries to both services, joining on `@key` directives. Services declare ownership with `@key`, `@extends`, `@external`, `@requires`, `@provides`. Benefits: each team owns their schema independently and deploys on their own cadence. Alternative: schema stitching, the gateway fetches and merges remote schemas at startup, which centralizes the failure domain.

**What FAANG expects:** You can draw the request flow: gateway parses the query, builds a query plan that splits it across services, executes subqueries in parallel, and stitches results via `@key` references. You mention Federation v2's composition model (composed supergraph schema built by a schema registry like Apollo Studio or self-hosted Router) and the cost: every cross-service join is a network hop, so entity references need to be usage-aware.

*Follow-ups:*
- Stitching vs Federation, why did the industry pick Federation? (Ownership: services author their slice, gateway is a thin router. No centralized schema merging on startup.)
- What's an `@key` directive and why does it matter? (Declares the entity's primary key. Lets the gateway resolve references across services.)
- What are the failure modes of a federated graph? (A slow subgraph blocks the whole query, you need per-subgraph timeouts, partial-result tolerance, and circuit breakers.)

---

**Q7: When would you choose REST over GraphQL?**

A: REST wins when the response shape is server-driven and HTTP semantics earn their keep:
- Simple CRUD where per-endpoint rate limiting and HTTP caching are the whole point.
- Public APIs consumed by non-programmatic callers (curl, SDK generators, Postman collections).
- File uploads/downloads, GraphQL requires multipart workarounds.
- Webhook receivers, you want a POST handler, not a query language.
- Services with stable response shapes where GraphQL's per-field resolver overhead and complexity-based rate limiting have no upside.

**What FAANG expects:** You describe the choice in terms of *who controls the response shape*. REST = server-driven (good for CDN-cacheable reads, stable public contracts). GraphQL = client-driven (good for mobile with variable fields per screen, BFF aggregation). You do *not* claim REST is "simpler", it has its own costs (versioning, endpoint sprawl for nested data).

*Follow-ups:*
- You could cache GraphQL at the CDN with persisted queries, does that change the answer? (Partly. But per-URL cache keys plus `Vary: Authorization` is still more natural for REST.)
- Can you mix them? (Yes, many shops run REST for third-party public API and GraphQL as an internal BFF for first-party mobile/web.)
- What about gRPC? (Internal service-to-service where both sides are yours. Avoid for public APIs: clients hate code-gen dependencies.)

---

**Q8: How does AsyncAPI differ from OpenAPI?**

A: OpenAPI describes synchronous request/response APIs (REST HTTP). AsyncAPI describes asynchronous event-driven APIs (Kafka, RabbitMQ, NATS, MQTT, WebSocket, Redis Streams). Key AsyncAPI 3.0 concepts: `channels` (topics/queues), `operations` (`send`/`receive`, decoupled from channels since 3.0), reusable `messages`, `bindings` (protocol-specific config like Kafka partition key), `servers` with protocol field. Both use JSON Schema for payload definitions and both support code generation and documentation. They're complementary: a service might expose a REST API (OpenAPI) AND publish Kafka events (AsyncAPI). In 2026, write new specs against AsyncAPI 3.0 or 3.1, most tooling has migrated off 2.x.

**What FAANG expects:** You name AsyncAPI 3.0's big change (operation-channel decoupling) and can describe the codegen workflow (`asyncapi-codegen` for Go produces publisher and consumer types). You know that AsyncAPI does NOT dictate delivery semantics, those come from the broker (Kafka's retention and consumer groups, RabbitMQ's ack modes).

*Follow-ups:*
- Can one service have both an OpenAPI spec and an AsyncAPI spec? (Yes, and it's the normal pattern for any service with a REST API and a Kafka producer.)
- How do you version an AsyncAPI schema? (Same as OpenAPI: additive changes are safe. Breaking changes ship as a new topic or `vN` schema ID in a schema registry.)
- What's the relationship to Schema Registry (Confluent, Apicurio)? (AsyncAPI describes the contract. Schema Registry enforces it at message serialization time, typically with Avro/Protobuf.)

---

**Q9: How do you implement API versioning without breaking existing clients?**

A: Preferred order, least to most disruptive:
1. **Expand-contract**: add new fields alongside old ones, migrate clients over time, then remove old fields after monitoring shows zero usage.
2. **Sunset headers** (RFC 8594): add `Sunset` and `Deprecation` headers to old endpoints, alerting client developers without immediately breaking them.
3. **Dated API versions** (Stripe-style `Stripe-Version: 2026-04-01`): behavior-changing updates ship behind the header. Old clients pinned to older dates keep old behavior.
4. **URL versioning** (`/v1/`, `/v2/`): cleanest for major breaking changes, but requires maintaining multiple versions simultaneously.
5. **GraphQL schema evolution**: add fields with `@deprecated` directive. Old queries continue working indefinitely.

The rule: never remove a field, endpoint, or behavior without a documented deprecation period and monitoring to confirm zero usage.

**What FAANG expects:** You distinguish *shape changes* (add field) from *behavior changes* (same shape, different semantics). Behavior changes are the dangerous ones and require either dated versions or feature flags. You name Stripe's dated versioning as the canonical implementation.

*Follow-ups:*
- Why is GraphQL's `@deprecated` not enough? (It only signals. Clients still use the field. You need usage monitoring to actually remove.)
- How long should a deprecation window be? (Depends on client audience, internal: weeks. Public API: 12+ months. enterprise SaaS: 24+ months, sometimes forever.)
- What's the downside of `/v2` URL versioning? (Double maintenance. Bug fixes in v2 often need backporting to v1 for long-tail customers.)

---

**Q10: What is the outbox pattern and why is it essential for webhooks?**

A: The dual-write problem: writing to a database AND publishing an event. If the process crashes between the DB write and the event publish, you have inconsistent state (DB updated, event lost). The outbox: write the business record AND an outbox event in a single atomic transaction. A separate relay service reads the outbox and publishes events. On relay crash and restart, unpublished outbox entries are retried, no events are lost. The outbox pattern is essential for webhooks because webhook delivery is inherently unreliable (customer's server might be down) and retry must be decoupled from the HTTP request path.

**What FAANG expects:** You frame it explicitly as a dual-write problem and mention both implementation styles: *polling* the outbox table or *CDC* streaming from Postgres logical replication / MySQL binlog into Kafka (Debezium). You know the tradeoff: polling is simpler but adds latency and DB load. CDC is operationally heavier but scales further.

*Follow-ups:*
- Why can't you just publish after the transaction commits? (Crash window between commit and publish loses the event.)
- Exactly-once semantics, is the outbox enough? (No. Receiver must dedup on event ID. Outbox gives at-least-once on the sender side.)
- How do you handle outbox-table growth? (TTL-based pruning after successful publish. Or move to partitioned table and drop old partitions.)

---

**Q11: How do you handle webhook endpoint failures gracefully?**

A: Three-layer strategy:
1. **Retry with exponential backoff + jitter**: temporary failures get retried with increasing delays. Full jitter (random in `[0, exp_cap]`) prevents thundering herd.
2. **Dead-letter queue + UI**: after N attempts, move to DLQ, notify customer, provide dashboard to view failed events and trigger manual replay.
3. **Auto-disable**: after consecutive failures over a time period (GitHub: 10 days of continuous failure), auto-disable the endpoint to prevent queue buildup, alert customer, require manual re-enable.

Monitoring: alert on endpoints with >50% failure rate over a 1-hour window, track DLQ growth rate, and expose per-endpoint metrics in the customer dashboard.

**What FAANG expects:** You can cite a real retry schedule (Stripe: 3 days, ~17 retries with exponential backoff. GitHub: 10 days, auto-disable after that). You name the jitter algorithm (full jitter vs equal jitter vs decorrelated jitter) and pick one. You mention the customer-facing replay UI as a product feature, not just a backend concern.

*Follow-ups:*
- Why full jitter and not equal jitter? (Full jitter de-correlates retry times better. lower peak load when many webhooks fail simultaneously.)
- What HTTP status codes are retriable? (5xx, 408, 429, network errors. 4xx (except 429) is permanent.)
- How do you prevent a slow customer endpoint from blocking other deliveries? (Per-endpoint concurrency limits, separate worker pools per subscription tier, or a per-endpoint circuit breaker.)

---

**Q12: What are the tradeoffs of GraphQL subscriptions vs SSE vs polling?**

A:

| | GraphQL Subscriptions | SSE | Polling |
|--|--|--|--|
| Transport | WebSocket (bidirectional) | HTTP/1.1 or HTTP/2 (server→client) | HTTP request/response |
| Real-time latency | Instant | Instant | Up to poll interval |
| Server state | Per-connection state | Per-connection state | Stateless |
| Auto-reconnect | Manual | Built-in | N/A |
| HTTP/2 multiplexing | No (hijacks connection) | Yes | Yes |
| Use case | Chat, collaborative editing | Live feeds, progress bars, notifications | Status checks where delay is OK |

For most "live update" use cases, SSE is simpler and more scalable than WebSocket/subscriptions. Reserve subscriptions for genuinely bidirectional use cases.

**What FAANG expects:** You default to SSE for server→client push and justify WebSocket only when you need client→server on the same connection. You know the scaling problem (connection state per subscriber) and the answer (pub/sub fan-out via Redis or NATS with connection affinity via sticky sessions or consistent hashing).

*Follow-ups:*
- How do you scale subscriptions to 1M concurrent clients? (Fan-out tier separate from resolver tier. Pub/sub broker (Redis/NATS). Sticky connections.)
- Why doesn't HTTP/2 multiplex WebSocket? (WebSocket hijacks the TCP connection post-Upgrade. HTTP/2's stream multiplexing doesn't apply.)
- Is gRPC streaming an alternative? (Yes, for service-to-service. Terrible for browser clients, grpc-web has limits, and the typed-client dependency rules it out for public APIs.)

---

**Q13: How do you test GraphQL resolvers?**

A: Three levels:
1. **Unit tests**: call resolver functions directly with mocked repositories. Test business logic, authorization checks, error cases, input validation. Fast, no I/O.
2. **Integration tests**: POST actual GraphQL queries to a test HTTP server with real database (testcontainers-go). Verify the full stack including DataLoaders, middleware, and schema.
3. **Schema tests**: serialize the schema SDL and compare against a snapshot, which prevents accidental breaking schema changes.

```go
// Unit test
func TestUserQuery(t *testing.T) {
    resolver := &graph.Resolver{UserRepo: &mockUserRepo{user: testUser}}
    result, err := resolver.Query().User(context.Background(), "user-123")
    assert.NoError(t, err)
    assert.Equal(t, "user-123", result.ID)
}

// Integration test - counts SQL queries to verify DataLoader prevents N+1
func TestPostsQueryNoPlusOne(t *testing.T) {
    var queryCount int
    db = wrapWithQueryCounter(db, &queryCount)
    // Execute: posts(first: 10) { author { username } }
    // Assert: queryCount == 2 (one for posts, one batched for authors)
}
```

**What FAANG expects:** You write integration tests that *count SQL queries* to catch DataLoader regressions, the most common GraphQL performance bug. You snapshot the schema to catch accidental breaking changes in PR review. You run gqlgen's `go generate` in CI to catch schema-resolver drift before it hits prod.

*Follow-ups:*
- How do you test subscriptions? (Spawn test server, connect WebSocket, publish event via in-process bus, assert message received within timeout.)
- What's the best way to test authorization? (Table-driven tests: for each (user role, operation) pair, assert allowed/denied.)
- How do you catch schema breaking changes in CI? (`graphql-inspector` or a snapshot-diff of SDL that requires manual override for intentional breaks.)

---

**Q14: How does cost-based rate limiting work for GraphQL?**

A: Instead of counting requests (which treats `{ user(id: "1") { name } }` the same as a query returning 10,000 records), assign each field a complexity cost. Lists multiply child complexity by their expected size.

```
Query complexity calculation:
users(first: 100) { posts(first: 10) { comments(first: 5) } }
= 100 * (10 * (5 * 1)) = 5,000 cost units
```

Rate limit bucket: each API key gets N cost units per time window (e.g., 10,000 per minute). On each request, deduct the query cost, and return 429 if budget is exhausted. Return remaining budget in response headers (`X-RateLimit-Cost`, `X-RateLimit-Remaining`). This is exactly Shopify's approach, it rewards efficient queries and penalizes expensive ones regardless of request count.

**What FAANG expects:** You know the mechanic (static analysis of the query AST to estimate cost) and the failure mode (estimated cost ≠ actual cost for queries that touch sparse data, you need a post-execution correction). Bonus: mention leaky-bucket for the refill algorithm.

*Follow-ups:*
- What if the estimate is wrong? (Charge actual cost after execution. Next request sees the adjusted bucket.)
- How do you communicate cost to clients? (Response headers + a query cost explorer endpoint that returns estimated cost without executing.)
- Shopify exposes this publicly, why is that safer than a secret limit? (Predictable client behavior. Hidden limits force clients to guess and retry, creating more load.)

---

**Q15: What security considerations apply to webhook delivery systems?**

A: Sender side:
- Sign `id.timestamp.body` with HMAC-SHA256 (Standard Webhooks / Stripe format), and support multiple signature entries for key rotation.
- Use HTTPS for all webhook delivery endpoints (reject HTTP or at minimum warn).
- Reasonable timeout (30s) to prevent slow-receiver attacks against worker pools.
- Per-endpoint concurrency limits to prevent overwhelming customer servers.
- Validate endpoint URLs at subscription time (reject `localhost`, RFC1918 ranges, metadata endpoints like `169.254.169.254`, SSRF prevention).

Receiver side:
- Verify signature AND timestamp before processing. Reject timestamps outside tolerance window.
- Reject payloads over a size limit (e.g., 1MB) before verification.
- Idempotency using the event ID (replay protection inside the tolerance window).
- Return 200 quickly, process asynchronously if processing is slow (otherwise sender retries unnecessarily).
- Log all received webhooks for audit trail.

**What FAANG expects:** You name SSRF prevention (sender-side URL validation) as a distinct concern beyond signing, it's the vulnerability that has taken down several webhook products. You mention `hmac.Equal` by name and explain the timing attack. You treat the tolerance window (~5 min) plus idempotency store as a *pair*, not alternatives.

*Follow-ups:*
- Why reject `localhost` and RFC1918 as subscription endpoints? (SSRF, an attacker registers `http://169.254.169.254/...` to make your infrastructure fetch cloud metadata.)
- How do you prevent a customer from using you as a DDoS amplifier? (Per-destination rate limits, aggregate delivery caps per customer, deny lists.)
- The tolerance window is 5 minutes, why not 30 seconds? (Clock skew. NTP drift and intermediate queues can legitimately delay delivery by minutes.)

---

**Q16: When would you use AsyncAPI over OpenAPI?**

A: Use AsyncAPI when your communication pattern is event-driven: one party publishes a message, another subscribes and processes it asynchronously, with no immediate response expected. Common triggers: Kafka topics, RabbitMQ/AMQP queues, NATS subjects, MQTT topics, Redis Streams/Pub-Sub, WebSocket events. Use OpenAPI when a client makes a request and waits for a response: REST APIs, synchronous HTTP RPC. Hybrid systems use both: REST APIs get OpenAPI specs, event streams get AsyncAPI specs. Both support code generation, making the choice clear: whichever generates the right client/server stubs for your protocol.

**What FAANG expects:** You explicitly call out that this is *not* an either/or, one service typically has both specs. You mention AsyncAPI 3.0's request/reply support, which shrinks the gap for protocols like NATS that carry correlation IDs natively.

*Follow-ups:*
- Request/reply over Kafka, AsyncAPI or OpenAPI? (AsyncAPI 3.0 with the `reply` operation object.)
- Can AsyncAPI describe WebSocket? (Yes, with the `ws` binding. Often used for GraphQL subscriptions or custom message protocols.)
- What's the schema-registry relationship? (AsyncAPI is the human-readable contract. The registry holds the wire-level schema, Avro/Protobuf/JSON Schema, that serializers enforce.)

---

**Q17: How would you implement GraphQL schema deprecation?**

A: Four-step process:
1. Add `@deprecated` directive: `name: String @deprecated(reason: "Use firstName and lastName instead")`.
2. Monitor usage: log deprecated field access with the calling client identifier (extensions, user-agent, or API key).
3. Contact clients: reach out to clients still using deprecated fields, provide migration guide and timeline.
4. Remove after zero usage: verify with monitoring that no clients query the deprecated field, then remove in a scheduled release.

In Go with gqlgen, deprecated fields still resolve normally, the `@deprecated` directive only affects tooling (GraphiQL shows strikethrough, codegen emits warnings). Removal is the only way to enforce migration, and it must be preceded by the monitoring confirmation step.

**What FAANG expects:** You treat the monitoring step as non-negotiable, removing a field without usage data is the mistake that breaks customers. You know that `@deprecated` is purely advisory in runtime terms and that enforcement requires tombstoning the field (empty response) as a halfway step before removal.

*Follow-ups:*
- How do you monitor per-client usage? (Field-level instrumentation in the resolver. Log an access metric keyed by authenticated identity.)
- What's a tombstone field? (Field declared in schema but returns null/error with a migration message, breaks clients louder than removal but keeps the schema well-formed.)
- Deprecation across a federated graph, who owns the timeline? (Subgraph owner declares it. gateway propagates the directive. A central schema registry tracks usage across all subgraphs.)

---

**Q18: What is the difference between webhooks and WebSocket for real-time server push?**

A:
- **Webhooks**: Server-to-server push over standard HTTP POST. Receiver is a service with a public URL and handler code. Works through NAT, load balancers, and stateless deployments. Durable, can retry. Best for: payment events, CI/CD notifications, third-party integrations.
- **WebSocket**: Persistent bidirectional TCP connection. Client initiates, connection stays open, both sides can send messages. Requires connection state, stateful server or pub/sub fan-out for horizontal scaling. Best for: chat applications, collaborative editing, live game state, real-time dashboards.

The key distinction: webhooks are server-to-server where the receiver is a service you control. WebSockets are for browser/mobile clients where the "receiver" is a user's app.

**What FAANG expects:** You don't just list the mechanics, you know the operational difference: webhooks have durability guarantees (retries, DLQ), WebSocket deliveries are ephemeral. If you disconnect and reconnect, you need a resync mechanism (missed-event query, cursor-based catch-up). Bonus: mention SSE as the simpler one-way alternative to WebSocket.

*Follow-ups:*
- What happens if a WebSocket client disconnects briefly? (Missed messages, you need reconnect + cursor-based replay or accept data loss.)
- Why can't you use webhooks to notify a browser directly? (Browsers don't have public URLs. Some products relay via push services like FCM/APNS.)
- Server-Sent Events, when over WebSocket? (One-way push, HTTP/2-friendly, built-in reconnect. Pick SSE unless you genuinely need client→server on the same connection.)

---

**Q19: How do you implement GraphQL pagination correctly?**

A: Use Relay cursor-based pagination, not offset-based. Offset pagination is broken for live data (page 2 shifts when page 1 inserts a new item). Cursor pagination uses an opaque cursor derived from a stable ordering (typically `(created_at, id)` composite).

```graphql
users(first: 10, after: "cursor_abc") {
  edges { node { id name } cursor }
  pageInfo { hasNextPage endCursor }
}
```

Implementation: cursor = base64(`created_at + ":" + id`). SQL: `WHERE (created_at, id) > (cursor_ts, cursor_id) ORDER BY created_at, id LIMIT first + 1` (fetch one extra to determine `hasNextPage`). Never use `SELECT ... OFFSET` for large tables, O(n) scan.

**What FAANG expects:** You default to cursor pagination for mutable data and mention offset is *only* acceptable for small, stable result sets (admin UIs over fixed data). You know why `(created_at, id)` beats `id` alone (`id` alone requires `id` to be monotonic with insertion order, which UUIDs break).

*Follow-ups:*
- Why `(created_at, id)` and not just `id`? (UUIDs aren't monotonic. Rows with the same created_at need a tiebreaker.)
- How do you paginate backward? (`last`/`before` with reverse-ordered query. Relay spec mandates both directions.)
- What if the user sorts by an arbitrary column? (Cursor must encode all sort keys. tie-break on primary key.)

---

**Q20: How do you monitor webhook delivery health in production?**

A: Five key metrics:
1. **Delivery success rate per endpoint** (alert if < 90% over 1 hour).
2. **P99 delivery latency** (time from event creation to first successful delivery).
3. **Retry queue depth** (total pending + retrying deliveries. Alert if growing).
4. **Dead-letter queue growth rate** (events that exhausted all retries).
5. **Endpoint-specific failure rate** (identify problematic customer endpoints).

Operational procedures:
- Alert on endpoints with 100% failure for > 1 hour (customer's server likely permanently down).
- Auto-disable endpoints after N consecutive failures. email customer.
- Expose delivery logs in customer dashboard with replay capability.
- Distributed tracing: propagate trace ID in `X-Webhook-ID` or a dedicated `traceparent` header to correlate webhook events with the original business operation.

**What FAANG expects:** You distinguish *fleet-wide* metrics (retry queue depth, DLQ growth, your health) from *per-endpoint* metrics (success rate, latency, customer's health). You mention the customer-facing dashboard as a product requirement, not just internal tooling, customers cannot integrate webhooks without visibility into failures.

*Follow-ups:*
- How do you distinguish "our infrastructure is down" from "one customer's endpoint is broken"? (Aggregate vs per-endpoint success rate. If the aggregate drops but per-endpoint rates are stable across many endpoints, it's you.)
- How do you test the monitoring itself? (Chaos-inject 5xx from a fake receiver. Assert alerts fire and DLQ metrics populate.)
- What's the SLO for webhook delivery? (Stripe-class: 99.9% delivered within 24 hours. Internal ops: 99% within 1 minute on first try. Always publish it.)

---

### Junior → FAANG: How to Use These Questions in Preparation

These 20 questions cover every concept an L4/L5 candidate is expected to know about GraphQL, webhooks, and AsyncAPI. The goal of preparation is not to memorize the answers. The goal is to internalize the reasoning structure so you can reconstruct the answer to a question you have not seen.

Each answer in this chapter follows the same structure: state the core trade-off, name the canonical solution, identify the failure mode of the naive approach. Practice producing that structure for any question, not just the ones listed here.

Common entry-level gaps that show up in FAANG screen calls:

- Candidates who describe DataLoaders correctly but cannot explain why they are scoped per-request lose points. The "why" (auth isolation: loader cache must not leak data between users) is as important as the "what."
- Candidates who say "HMAC-SHA256 prevents replay attacks" without mentioning the timestamp window have described only half the solution. HMAC prevents tampering. The timestamp window and idempotency store together prevent replay.
- Candidates who choose GraphQL for every API design question have not internalized the trade-off. The correct answer to "should I use GraphQL here" depends on whether the response shape is client-driven or server-driven.
- Candidates who know the outbox pattern but cannot distinguish at-least-once from exactly-once delivery need to study that distinction. At-least-once is what the outbox gives you. Exactly-once requires receiver-side idempotency in addition.

Interview practice routine for each question: close the book, state the answer aloud, then check which points you missed. The points you consistently miss are your preparation gaps. Focus there, not on questions you already answer confidently.

For coding-round preparation, the most frequently tested implementation is webhook signature verification with timestamp validation. Write it from memory, then check it against the correct version in the common mistakes chapter. Do this until you write it correctly on the first attempt.

### Senior @ FAANG: What Bar-Raisers Evaluate Beyond Correctness

A bar-raiser at L6/L7 is not checking whether you know the answer. They assume you know the answer. They are evaluating whether your reasoning demonstrates platform thinking, organizational awareness, and calibrated judgment about trade-offs.

**Signals a bar-raiser listens for:**

On Q1 (GraphQL vs REST): An L6 answer situates the choice in an organizational context. "We run GraphQL as an internal BFF and REST for our public API because our first-party mobile clients have heterogeneous field needs, but third-party integrators need a stable contract that does not change with our internal schema evolution." This answer shows ownership of the architectural boundary and awareness of the different stakeholder needs on each side.

On Q3 (DoS prevention): An L6 answer includes the operational decision about who can authorize raising the complexity limit for a specific customer and how that is tracked. "Persisted queries are the primary control for production clients. For partner API customers with known query patterns, we maintain an allowlist of query hashes with per-partner complexity overrides, approved through a change management process." This connects the technical control to the organizational process that governs exceptions.

On Q4 (webhook delivery guarantees): An L6 answer names the failure mode of the polling outbox at scale and presents CDC as the alternative with its operational cost. "At our volume, polling adds read load to the primary database. We migrated to CDC via Debezium into Kafka for event relay. The operational cost is running Debezium and maintaining the Kafka connector, but the database read load is eliminated and delivery latency dropped from seconds to under 500ms." This is a decision with trade-offs, not a prescription.

On Q6 (federation): An L6 answer includes the governance model for schema composition. "We run Apollo Router with schema checks in CI against the Apollo schema registry. Any subgraph that ships a composition-breaking change requires a schema review from the platform team and a migration plan for the services that consume the affected entity type. This is enforced at the CI level, not by convention." This shows ownership of the governance process, not just the technology.

**What distinguishes L7 from L6:**

An L7 answer to any of these questions includes the meta-question: "how do we prevent this class of problem from recurring, and who owns that prevention." L6 answers the question. L7 answers the question and then establishes the system that makes the question less likely to be asked again.

On Q17 (schema deprecation): An L6 answer describes the four-step process. An L7 answer describes the four-step process and then describes the platform tooling that automates steps 2 and 3 (usage monitoring dashboards that automatically notify client owners, migration deadline tracking integrated with the team's planning process) and the policy decisions that govern step 4 (who has authority to override a deprecation deadline for an enterprise customer and what that approval process looks like).

**On answering questions you are uncertain about:**

FAANG interviewers respond positively to calibrated uncertainty. "I know the DataLoader batching mechanism well, but I have not benchmarked the actual latency of the 2ms collection window under high concurrency. My assumption is that it is dominated by scheduler jitter at that scale, but I would validate that with a load test before committing to the parameter." This demonstrates intellectual honesty and shows you distinguish "I know the concept" from "I have measured this in production." Both are valued. Presenting confident answers for things you have not verified is a bar-raiser failure signal.
