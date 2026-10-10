## Summary

- **Schema-first vs code-first**: Schema-first (gqlgen's default) treats the SDL as the source of truth, making the contract explicit and tooling-friendly. code-first generates the schema from Go structs, reducing duplication but coupling schema evolution to implementation changes.
- **Resolver design**: Organize resolvers by domain object rather than by query/mutation to keep files focused. Each resolver should delegate to a service layer and contain no business logic itself.
- **N+1 problem with dataloaders**: Every nested list field that triggers an individual DB query multiplies requests exponentially. dataloaders batch and deduplicate those per-field calls into a single round trip per request cycle, restoring O(1) database calls per query.
- **Subscriptions**: Implement subscriptions over WebSocket using a per-topic fan-out pattern backed by buffered channels. Always cancel the subscription goroutine when the client disconnects to prevent goroutine leaks.
- **Authentication and authorization in resolvers**: Attach the authenticated principal to the request context in middleware, then enforce field-level permissions inside resolvers or via reusable directives - never rely solely on query-level guards, as clients can craft arbitrary queries.
- **Persisted queries**: Store pre-approved query hashes server-side so production clients send only a hash instead of the full query string, reducing payload size and eliminating the risk of ad-hoc schema exploration by attackers.
- **Complexity limits**: Assign a cost to each field and reject queries whose total cost exceeds a configurable threshold. Combine with depth limits and query timeouts to prevent denial-of-service via deeply nested or wide queries.
- **Federation**: Split a large graph across independently deployable subgraphs using Apollo Federation. The gateway stitches subgraph schemas at runtime, allowing teams to own their domains without a shared monolithic schema repository.
- **gqlgen vs alternatives**: gqlgen generates type-safe Go code from the schema, eliminating reflection overhead and catching schema-resolver mismatches at compile time - prefer it over runtime-reflection libraries for production services where performance and type safety matter.
- **GraphQL vs REST**: Choose GraphQL when clients have diverse, unpredictable data-shape requirements or when over-fetching/under-fetching is a measurable pain. Prefer REST when the API surface is stable, caching at the HTTP layer is critical, or the team is unfamiliar with GraphQL's operational complexity.

### Junior -> FAANG: Using This Summary as a Self-Assessment

Read each bullet in this summary and ask: can I implement this from memory? For schema-first development, can you describe the three-step workflow (write SDL, run generate, implement interfaces) and explain what happens if you modify `generated.go` by hand? For dataloaders, can you describe the batching window mechanism and explain why results must be returned in key order?

The bullets where you hesitate are the topics to revisit before your interview. Prioritize: dataloaders (universal N+1 question), auth via context (universal GraphQL auth question), and complexity limiting (universal security question). Resolver design and integration testing are important but secondary to these three.

A useful interview preparation drill: close the book and spend 15 minutes writing pseudocode for a `categoryBatcher` function. Include the `WHERE id IN (...)` query, the map for O(1) lookup, and the key-ordered result construction. If you can do this without references, you have genuinely internalized the dataloader pattern.

### Senior @ FAANG: This Summary as a Platform Readiness Checklist

Treat each bullet as a capability that must be provided at the platform level, not the service level.

Schema-first development and `autobind` configuration belong in a platform-provided `gqlgen.yml` base configuration that services extend. Dataloaders belong in a platform SDK with a standard `ManagedLoader[K, V]` generic that handles batching, timing, and per-request scoping correctly. Authentication via context belongs in a platform auth middleware that services mount, not reimplementing JWT validation per-service. Directive-based authorization belongs in a platform directive library that the security team owns and the penetration testing team validates.

Structured error handling belongs in a platform error taxonomy with canonical codes, a `DefaultErrorPresenter` that maps domain errors to those codes, and a logging contract that ensures every error is recorded with correlation ID, field path, and operation name. Integration testing belongs in a platform test harness that provides `SetupTestServer(t, seedFn)` so every service uses the same test pattern without boilerplate.

Complexity limiting, query depth limiting, and execution timeouts belong in the platform's `NewGraphQLServer` factory as required configuration values, not optional fields.

Federation belongs in a platform team's charter: schema composition checks in CI, subgraph health monitoring in the gateway, and a schema registry with a deprecation workflow. When all of these are platform defaults, individual service teams can focus on their domain logic rather than reinventing infrastructure.

---
