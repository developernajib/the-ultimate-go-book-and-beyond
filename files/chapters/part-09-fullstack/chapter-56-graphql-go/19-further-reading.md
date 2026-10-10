## Further Reading

- **gqlgen Documentation** (gqlgen.com) - Schema-first code generation, resolver patterns, directive implementation, and subscription transport configuration for Go.
- **GraphQL Specification** (spec.graphql.org) - The formal language specification covering type system, introspection, validation, and execution semantics.
- **"Production Ready GraphQL" by Marc-André Giroux** - Covers schema design conventions, pagination patterns, error handling, and the operational concerns of running GraphQL at scale.
- **Apollo Federation Specification** (apollographql.com/docs/federation) - The subgraph composition model, entity resolution via `_entities` queries, and the `@key`/`@external`/`@requires` directives.
- **GraphQL Best Practices** (graphql.org/learn/best-practices) - Official guidance on serving over HTTP, pagination, caching, and global object identification.
- **Netflix Tech Blog: "Our learnings from adopting GraphQL"** - Persisted queries, query cost analysis, and dataloader optimizations at Netflix scale.
- **GitHub Engineering Blog: "The GitHub GraphQL API"** - Node-based complexity limiting, rate limiting by query cost, and the migration path from REST v3 to GraphQL v4.
- **Shopify Engineering: "Federated GraphQL at Shopify"** - Schema stitching across hundreds of services, gateway query planning, and cross-service entity resolution.

### Junior -> FAANG: Building a Reading Plan From This List

The two highest-value resources for interview preparation are "Production Ready GraphQL" (the book) and the GitHub Engineering Blog post on the v4 API migration. The book covers schema design conventions and operational concerns in depth, while the GitHub post explains the node-based complexity model that interviewers cite as the reference implementation.

Read the gqlgen documentation with a specific question in mind: how does directive implementation work? The documentation's directive section is short but dense. Reading it while the `@hasRole` example from this chapter is fresh will make both clearer.

The Apollo Federation spec is important context even if your team does not use federation today. Understanding `@key`, `@external`, and `@requires` gives you vocabulary for system design interviews that involve multi-service GraphQL.

### Senior @ FAANG: Extending This Reading List for Platform Thinking

Beyond this list, the resources that address platform-level GraphQL concerns:

"Hive" (the open-source GraphQL schema registry by The Guild) has extensive documentation on schema versioning, breaking change detection, and usage analytics. Reading its architecture documentation gives you a concrete implementation model for the schema governance capability described throughout this chapter.

The OpenFGA documentation (openfga.dev) explains the Zanzibar-derived authorization model that FAANG companies use for fine-grained access control. Understanding how to express authorization rules as relationship tuples ("user A is an editor of document B") prepares you to replace static RBAC directives with data-driven ABAC policies when authorization complexity grows past what directives can express.

The GraphQL over HTTP specification (graphql.github.io/graphql-over-http) formalizes the request and response format, including the `application/graphql-response+json` media type and the rules for when a response should be 200 vs 400 vs 500. This is relevant for gateway implementations and for client interoperability testing.

The OWASP GraphQL Security Cheat Sheet (cheatsheetseries.owasp.org) catalogs the security vulnerabilities specific to GraphQL: introspection disclosure, field suggestion leakage, batch attack via aliased fields, and query depth attacks. Reading this before a security review of your GraphQL service gives you a structured checklist rather than an improvised one.
