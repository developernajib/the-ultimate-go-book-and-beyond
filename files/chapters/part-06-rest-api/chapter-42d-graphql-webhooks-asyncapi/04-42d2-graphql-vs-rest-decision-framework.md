## 42D.2 GraphQL vs REST Decision Framework

### The One-Line Decision Rule

Ship GraphQL when the shape of the data is **client-driven** (mobile app with variable fields per screen, BFF aggregating microservices, analytics UI that builds queries at runtime). Ship REST when the shape is **server-driven and benefits from HTTP semantics** (cacheable reads, public third-party API, file upload/download, webhook receivers). Most teams who regret their GraphQL decision picked it for server-driven CRUD where its costs (N+1 risk, auth-per-field, cost-based rate limiting, POST-only caching) outweighed the benefits a fixed response shape would have had.

### When GraphQL Wins

| Scenario | Reason |
|----------|--------|
| Multiple client types (mobile, web, TV) | Each client requests only needed fields |
| Rapidly evolving APIs | Add fields without versioning |
| Complex nested data | Single query instead of N REST calls |
| Real-time via subscriptions | Built-in subscription support |
| Aggregating multiple microservices | BFF/federation pattern |

### When REST Wins

| Scenario | Reason |
|----------|--------|
| Simple CRUD API | GraphQL complexity not justified |
| File upload/download | REST handles binary data better |
| Public API with caching | HTTP caching works naturally with REST |
| Webhooks/callbacks | REST endpoints are simpler receivers |
| Simple client needs | No over-fetching problem to solve |

### Hybrid Approach (BFF Pattern)

Many companies use GraphQL for client-facing BFF and REST/gRPC for internal services:

```
Mobile/Web Client
      ↓ GraphQL
   BFF Layer (Go + gqlgen)
   ↙           ↘
gRPC            REST
User Svc        Order Svc
```

The BFF resolver is where the composition happens: a single `Order` query fans out to two downstream gRPC calls, joins the results in memory, and returns a unified model to the client, eliminating the multiple round-trips that a mobile app would otherwise need to make against individual REST endpoints. The `mapGRPCError` helper translates gRPC status codes into GraphQL errors so the client receives a consistent error contract regardless of which backend service failed.

```go
// BFF pattern - GraphQL resolvers call downstream services
func (r *queryResolver) Order(ctx context.Context, id string) (*model.Order, error) {
	// Call order service via gRPC
	resp, err := r.orderClient.GetOrder(ctx, &orderv1.GetOrderRequest{Id: id})
	if err != nil {
		return nil, mapGRPCError(err)
	}

	// Call user service via gRPC
	user, err := r.userClient.GetUser(ctx, &userv1.GetUserRequest{Id: resp.UserId})
	if err != nil {
		return nil, mapGRPCError(err)
	}

	return &model.Order{
		ID:         resp.Id,
		TotalCents: resp.TotalCents,
		Status:     model.OrderStatus(resp.Status),
		User:       mapUser(user),
	}, nil
}
```

### Schema Federation vs Stitching

Schema stitching requires the gateway to actively fetch and merge remote schemas at startup, which creates a centralized bottleneck and breaks when any upstream service is unavailable. Apollo Federation inverts this responsibility: each service owns and annotates its own types with `@key` directives, allowing the gateway to act as a thin router that reads federation metadata rather than maintaining a full merged copy. This lets individual services evolve their schemas independently without redeploying the gateway.

```
Schema Stitching (gateway combines):
  Gateway ← schema from User Svc
  Gateway ← schema from Order Svc
  Gateway merges them, routes queries

Apollo Federation (services declare ownership):
  User Svc: owns User type (@key)
  Order Svc: owns Order type, extends User (@extends)
  Gateway: thin router, reads federation metadata
```

```graphql
# Federation: Order Service owns Order, extends User
type Order @key(fields: "id") {
  id: ID!
  customerId: ID!
  customer: User
  totalCents: Int!
}

extend type User @key(fields: "id") {
  id: ID! @external
  orders: [Order!]!
}
```

### Junior -> FAANG: Using the Decision Framework in Practice

The one-line decision rule in this section ("ship GraphQL when the shape is client-driven, ship REST when the shape is server-driven and benefits from HTTP semantics") is the correct starting point, but junior engineers often misapply it by focusing on what GraphQL can do rather than what the specific requirement needs.

Work through a concrete example to build the habit. Imagine you are building a dashboard for an e-commerce admin. The dashboard has three panels: recent orders, top customers by revenue, and inventory alerts. Each panel needs different fields. A junior engineer might immediately reach for GraphQL because "different panels need different fields." A more disciplined analysis asks: are these panels driven by different clients with different runtime data needs, or are they three fixed views on the server? If the dashboard is a single-page app built by your team and the fields per panel are fixed at build time, three REST endpoints with fixed response shapes are simpler, easier to cache, and straightforward to secure. GraphQL's benefit materializes when an external developer or a mobile client defines the query at runtime.

**Common first-job mistakes:**
- Picking GraphQL because the team read a positive blog post, not because the use case requires client-driven queries.
- Assuming GraphQL replaces REST entirely. Most mature systems run both: GraphQL for the client-facing BFF layer and REST or gRPC for internal service-to-service calls.
- Underestimating the operational complexity difference. A REST API failure is diagnosed by looking at an HTTP endpoint's logs. A GraphQL failure may require correlating a complex nested query with multiple resolver traces to identify which downstream call failed.

**Interview entry point:** "When would you not use GraphQL?" is a question designed to test whether you understand trade-offs rather than just capabilities. The answer should include: simple CRUD where the response shape is fixed and benefits from HTTP caching, file upload and download (GraphQL's multipart handling is awkward compared to REST), and teams without DataLoader expertise where the N+1 problem would go undetected until production load hits.

### Senior @ FAANG: BFF Architecture and Federation Governance

**The BFF pattern as an organizational boundary.** The Backend for Frontend pattern in this section is not just a technical pattern for aggregating microservices. It is an organizational boundary that determines who is responsible for the client API contract. In a BFF architecture, the team that owns the client (mobile, web, or partner integrations) also owns the BFF. This means the client team controls the GraphQL schema and can evolve it without coordinating with every backend service team. The backend services expose stable gRPC or REST APIs that the BFF composes. This separation of concerns reduces coordination overhead at the cost of an additional service layer to operate.

**Federation vs stitching: the operational trade-off that matters.** Schema stitching requires the gateway to actively fetch and merge remote schemas. This creates a startup-time dependency: if any upstream service is unavailable when the gateway starts, the gateway cannot build its merged schema and fails to start. Apollo Federation inverts this: each service publishes its subgraph schema to a registry, and the gateway uses a pre-composed supergraph SDL that is generated offline by the CI/CD pipeline. The gateway can start without any upstream service available because it is reading a static file, not fetching live schemas. At FAANG scale, this difference is critical: a gateway that cannot start independently of its upstreams creates an availability coupling that violates the principles of microservices architecture.

**Schema evolution and the breaking change problem.** GraphQL's additive evolution model (add fields without breaking clients) is a genuine advantage over REST versioning, but it requires discipline. Removing a field, changing an argument type, or changing a non-nullable field to nullable are all breaking changes. At scale, tracking which clients use which fields requires field-level usage analytics. Apollo Studio and Cosmo provide this through operation reporting: clients send operation signatures with each request, and the registry correlates them with schema fields to report which fields are in active use. Without this tooling, removing a deprecated field is a guess. With it, you can see exactly how many clients queried a deprecated field in the last 30 days before making the removal.

**Per-resolver authorization as a security requirement.** The BFF pattern aggregates data from multiple backend services, each with its own authorization model. The BFF resolver is the only point where the caller's identity and the field they are requesting are both available. Middleware-level authorization (checking auth before the request reaches the GraphQL handler) can only enforce endpoint-level access, not field-level access. A user who has permission to query orders but not to see the customer's PII fields requires field-level resolver checks. At FAANG, this is enforced by a permission middleware injected into each resolver via the context, not by individual resolver authors remembering to add auth checks manually. The platform provides a `RequirePermission(ctx, "orders:read")` helper that returns an error if the viewer lacks the permission, and code review enforces that every resolver that touches sensitive data calls it.

**Federated schema governance: the review process for schema changes.** At FAANG scale, a schema change to a federated subgraph that breaks composition (for example, removing an entity key field that another subgraph extends) fails every other service's deployment that depends on the supergraph. The review process must include automated composition checks on every pull request, with the composition result posted as a check status. Additionally, field removals and type changes require a deprecation period (typically 30-90 days) during which the old and new fields coexist, monitored by field-level usage analytics. A staff engineer who proposes removing a field without showing usage data for the past 90 days is not following the process.

**Bar-raiser interview signal.** A candidate discussing the BFF pattern who only describes the technical aggregation mechanism is giving an incomplete answer. A strong senior answer addresses the organizational ownership question (which team owns the BFF), the schema governance question (how do breaking changes get detected and reviewed), and the operational question (how does the BFF degrade gracefully when a downstream service is unavailable, and what does the client experience during partial degradation). The candidate who raises all three unprompted is demonstrating the systems thinking required at L6 and above.

---
