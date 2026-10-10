## Exercises

### Exercise 1: GraphQL API with DataLoaders and Auth

**Task**: Build a blogging platform GraphQL API with:
1. Schema: `User`, `Post`, `Comment` types with Relay cursor pagination
2. Auth: JWT token in HTTP header, decoded into context via middleware
3. DataLoaders: `userByID` and `commentsByPostID` with 2ms batch window
4. Authorization: users can only see their own drafts, published posts are public
5. Complexity limiting: posts list = 10x child, comments = 5x child, max complexity 200
6. Subscriptions: `commentAdded(postId: ID!)` using Redis pub/sub for multi-instance scale
7. Tests: verify N+1 prevention by asserting SQL query count in integration tests

**Verification:**
```go
// N+1 test: 10 posts with authors should fire exactly 2 DB queries (not 11)
func TestPostsNoPlusOne(t *testing.T) {
    queryCounter := &QueryCounter{}
    // Execute: posts(first: 10) { author { username } }
    // queryCounter.Count() should be 2: one for posts, one batched for all authors
    assert.Equal(t, 2, queryCounter.Count())
}
```

### Exercise 2: Webhook Delivery Service with Tests

**Task**: Build a production webhook delivery system:
1. Database schema: `webhook_subscriptions`, `webhook_events`, `webhook_deliveries`, `webhook_dead_letters`
2. `WebhookService.Emit(ctx, eventType, data)` - outbox pattern (atomic write)
3. `DeliveryWorker.Run(ctx)` - processes pending deliveries with retry
4. Retry policy: 5 attempts with backoff ~5s, 25s, 2m, 10m, 50m
5. Dead-letter queue: after 5 failures, write to `webhook_dead_letters`
6. Integration test: use testcontainers-go for PostgreSQL, mock HTTP server for endpoint, verify: (a) delivery succeeds on first try, (b) retry fires on 503, (c) DLQ receives event after 5 failures

### Exercise 3: GraphQL Federation with Two Services

**Task**:
1. **User Service** (port 4001): `User` type, `Query.user(id: ID!): User`
2. **Order Service** (port 4002): `Order` type referencing `User` via `@extends`
3. **Gateway** (port 4000): Apollo Federation Router combining both schemas
4. Query through gateway: `order(id: "o1") { totalCents customer { email } }` - gateway routes to Order Service for order, User Service for customer

```graphql
# Order Service
type Order @key(fields: "id") {
  id: ID!
  totalCents: Int!
  customerId: ID!
  customer: User
}
extend type User @key(fields: "id") {
  id: ID! @external
  orders: [Order!]!
}
```

### Exercise 4: AsyncAPI Consumer with Contract Tests

**Task**: Given an AsyncAPI spec for a payment service:
1. Generate Go types from the spec using `asyncapi-codegen`
2. Implement Kafka consumer: `payment.succeeded` → update order status to "paid", `payment.failed` → update to "payment_failed" + queue refund
3. Idempotency: `ON CONFLICT (event_id) DO NOTHING` on the processed events table
4. Consumer group tests with testcontainers-go: publish test events, assert database state changes correctly, verify idempotency by publishing the same event twice and asserting single DB update

---

### Junior → FAANG: Getting Full Value from These Exercises

These four exercises are not portfolio projects. They are deliberate practice on the specific mechanics that appear in technical screens at L4/L5. Work through them in order, because each one builds on concepts from the previous.

**Exercise 1 (GraphQL with DataLoaders and Auth)** is the most important for interview preparation. The N+1 test that counts SQL queries is exactly the kind of test an interviewer will ask you to write on a whiteboard or shared editor. Practice explaining why the count must be exactly 2 for 10 posts with authors: one query for the posts list, one batched query for all 10 author IDs. If you cannot explain the count, you do not yet understand DataLoader batching.

The complexity-limiting requirement is frequently skipped by candidates who are unfamiliar with it. Do not skip it. Implement the complexity middleware and write a test that sends a query over the limit and asserts a 400 response. This is a 30-minute addition that makes a strong impression.

**Exercise 2 (Webhook Delivery Service)** teaches the outbox pattern by making you implement the atomic write yourself. The most common mistake candidates make is writing the event to the outbox in a separate transaction from the business record. This defeats the purpose. Verify your implementation by killing the process after the transaction commits but before the delivery worker runs, then restarting and confirming the event is still delivered.

**Exercise 3 (Federation)** is the hardest to set up because it requires running three services simultaneously. Use `docker-compose` for local development. The goal is not a production-ready federation. The goal is understanding why a query for `order { customer { email } }` results in two separate HTTP calls from the gateway: one to Order Service and one to User Service, joined by the `@key` reference.

**Exercise 4 (AsyncAPI Consumer)** teaches the spec-first workflow. Write the AsyncAPI spec before writing any Go code, generate the types, then implement against the generated interface. This is the order that matters. If you write the Go types first and then write a spec that describes them, you have missed the point.

First-job habit from these exercises: always write the idempotency test before the happy-path test. If your consumer processes a duplicate event and updates the database twice, the idempotency test catches it immediately. If you only have a happy-path test, the bug ships to production.

### Senior @ FAANG: Extending These Exercises to Production-Readiness

The exercises as written produce working implementations. A senior engineer extends them with the production concerns that the exercises deliberately omit, because including everything in an exercise would obscure the core concept.

**Exercise 1 extensions:**

Add a schema snapshot test that serializes the SDL and compares against a committed baseline. This prevents accidental breaking schema changes from merging without review. In CI, run `go generate ./...` before the test suite and fail the build if it produces any changes. Schema drift between the SDL and the generated resolver stubs is a common source of production breakage that is undetectable at runtime until a specific field is queried.

Add per-resolver tracing spans using OpenTelemetry. The span data lets you build a per-field latency heatmap that identifies which resolvers are contributing to tail latency. This is the production observability that makes DataLoader regressions detectable before they appear in customer complaints.

Implement the complexity budget as a per-API-key configuration stored in the database, not a compile-time constant. This allows you to grant trusted partners higher budgets without a deploy. Document the approval process for budget increases as an ADR.

**Exercise 2 extensions:**

Add a circuit breaker per destination endpoint. An endpoint that returns 5xx on every attempt should trip the circuit after 5 consecutive failures, pause delivery for 60 seconds, and try a single probe request. This prevents a broken destination from consuming delivery worker capacity indefinitely.

Add a delivery metrics exporter that emits per-endpoint success rate, p99 delivery latency, and DLQ depth to Prometheus. Write a Grafana dashboard definition for these metrics. This is not optional for a production webhook system. Customers cannot diagnose integration failures without it, and your on-call team cannot diagnose infrastructure failures without the fleet-wide view.

Implement the auto-disable policy as a configurable parameter rather than a hardcoded threshold. The policy should specify: failure count threshold, failure window, notification template, and re-enable requirement (manual vs automatic after a success probe). Store the policy as a database record so it can be adjusted per customer tier without a code deploy.

**Exercise 3 extensions:**

Add per-subgraph timeout configuration to the gateway. A slow User Service should not block an Order Service query that does not need user fields. Implement partial result tolerance: if a subgraph fails and its fields are marked nullable in the supergraph, return the partial result with an error extension rather than failing the entire query.

Add composition validation to CI. Use `rover subgraph check` (Apollo) or the equivalent for your federation implementation to validate that a subgraph schema change does not break the composed supergraph before merging. This is the CI gate that prevents federation breakage from reaching production.

Document the entity ownership model as an ADR. Which team owns `User`? Which team owns `Order`? What is the process for a team that needs to add a field to an entity they do not own? Who approves cross-service `@requires` directives? These governance questions determine whether federation scales organizationally, and they need answers before you have 10 subgraphs.

**Exercise 4 extensions:**

Add schema compatibility validation to the consumer's CI pipeline. When the AsyncAPI spec for `payment.succeeded` is updated, the CI pipeline should run a compatibility check against the previous spec version and fail if the change is breaking (field removed, type changed). This prevents consumer breakage from a producer's schema update reaching the Kafka topic before consumers are updated.

Implement a dead-letter consumer that reads from the DLQ topic and writes to a database table with the raw event payload, the error message, and the consumer group that failed. Build a simple admin endpoint that lists DLQ entries and allows replaying them into the original topic. This is the operational surface area that makes the system debuggable by on-call engineers who were not involved in the original implementation.
