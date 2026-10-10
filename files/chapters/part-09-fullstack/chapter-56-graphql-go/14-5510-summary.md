## Core Concepts Recap

gqlgen's schema-first workflow turns GraphQL SDL into strongly-typed Go interfaces, catching mismatches at compile time rather than in production. The patterns in this chapter - dataloaders for batching, directives for authorization, structured error codes, and channel-based subscriptions - address the specific operational challenges that surface when GraphQL moves beyond prototyping into production traffic.

### Key Takeaways

1. **Schema-First Development**: Define your API contract in SDL first, generate Go code, then implement resolver interfaces. The schema is the source of truth shared between frontend and backend teams.
2. **Dataloaders Are Non-Negotiable**: Without batching, a list of 20 items with one related field generates 21 database queries. Dataloaders collapse these into 2 queries using `WHERE id IN (...)` with request-scoped caching and deduplication.
3. **Authentication via Context**: Middleware extracts the JWT, validates it, and stores the user principal in `context.Context`. Resolvers retrieve it with a helper function - no auth parameters threaded through every signature.
4. **Directive-Based Authorization**: Schema directives like `@hasRole(role: ADMIN)` make access control visible in the schema itself, enforced by gqlgen middleware before the resolver executes.
5. **Structured Error Handling**: GraphQL responses can contain both `data` and `errors`. Map domain errors to typed error codes in the `extensions` field so clients can handle them programmatically.
6. **Integration Testing**: gqlgen's `client` package sends real GraphQL operations to an `httptest.Server`, testing the full stack from HTTP parsing through resolver execution to JSON serialization.

### When to Choose GraphQL

- Multiple clients with different data needs
- Complex relationships between entities
- Need for real-time subscriptions
- Frontend teams want API independence
- Aggregating multiple backend services

### When to Stick with REST

- Simple CRUD operations
- HTTP caching is critical
- Public API with many consumers
- Team expertise is in REST
- Simpler debugging and monitoring

### Junior -> FAANG: Consolidating the Chapter Into Interview Answers

Six concepts from this chapter that interviewers test directly:

One: schema-first development. Explain that gqlgen generates type-safe Go resolver interfaces from the SDL, and the schema is the contract between frontend and backend. Changing the schema without regenerating causes a compile error, which is a feature not a bug.

Two: the N+1 problem. Be able to reproduce the diagnosis: list query returns N items, each item's field resolver issues a database call, total database calls equal N+1. Dataloaders fix this by collecting all keys within a tick and issuing one `WHERE id IN (...)` query.

Three: context-based auth. JWT is validated in HTTP middleware, user principal is stored in context, resolvers retrieve it with `auth.UserFromContext(ctx)`. Auth state is never passed as a function argument.

Four: directive-based authorization. Schema directives like `@hasRole` enforce access control before the resolver runs, making the authorization model visible in the schema SDL.

Five: structured error handling. GraphQL supports partial success: both `data` and `errors` can be non-empty. Map domain errors to typed error codes in `extensions`. Never expose raw Go error strings to clients.

Six: complexity limiting. Without it, any authenticated user can issue a query that fans out exponentially. `extension.FixedComplexityLimit` is the minimum viable protection.

### Senior @ FAANG: What This Chapter Does Not Cover That You Will Need

This chapter covers the implementation mechanics of a single GraphQL service well. What it leaves out is the organizational and operational layer that distinguishes a toy service from a production platform.

**Schema registry and schema versioning.** A production GraphQL platform requires a schema registry that tracks every schema version, detects breaking changes between versions, and enforces a deprecation policy before fields are removed. Tools: Apollo Studio, Hive (open source), or a custom registry built on a document database.

**Federation composition pipeline.** Multiple subgraphs composing into a supergraph requires a CI step that runs the federation composition check before any subgraph is deployed. A subgraph with a schema that fails to compose with its peers must not deploy. This requires the gateway to use a schema composition artifact (a supergraph SDL) that is built and published separately from the subgraph deployments.

**Field-level analytics.** Knowing which fields are requested, at what volume, and by which clients is prerequisite to safe deprecation. This requires field-level instrumentation in the gateway, aggregation into a time-series store, and a dashboard that shows usage per field with a timeline. Without this, deprecation decisions are guesses.

**Query allowlisting for production security.** Automatic persisted queries (APQ) reduce payload size. Query allowlisting takes this further: only pre-registered queries (by hash) are accepted in production. Ad-hoc queries are rejected. This eliminates schema exploration by attackers and guarantees that every query the server processes has been reviewed by an engineer. The trade-off is that every new client query requires a registration step in the deployment pipeline.

**The federation entity resolution performance problem.** Cross-subgraph entity references add network hops. If the order subgraph needs the full `User` object from the user subgraph for each order, and a query returns 100 orders, the gateway may issue 100 entity resolution calls to the user subgraph. The correct fix is entity resolution batching (all 100 user IDs are sent in one `_entities` query), which Apollo Router and the reference gateway implementation support but which requires correct `@key` configuration on the entity type.

---
