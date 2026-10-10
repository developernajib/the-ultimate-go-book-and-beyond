## Summary

- **BFF definition and purpose**: A Backend for Frontend is a thin server-side layer that aggregates, transforms, and tailors microservice data to the exact shape a specific client needs, removing the burden of orchestration from both the client and the individual services.
- **One BFF per client type**: Each distinct client surface (web, iOS, Android, third-party API) should have its own BFF so that changes to one client's contract never risk breaking another's, and each can evolve at its own pace.
- **Aggregating multiple microservices**: Issue upstream calls in parallel using goroutines and `errgroup`, and apply graceful degradation so a partial upstream failure returns useful data rather than a complete error response.
- **Handling auth at the BFF layer**: Validate the user-facing token (e.g., OAuth2 access token) at the BFF boundary, then issue scoped, short-lived service-to-service tokens for each downstream call - never forward the raw user token to internal services.
- **Caching strategies**: Cache completed aggregated responses at the BFF level using a short TTL for hot endpoints. Use `Cache-Control` headers and ETag validation to let CDN or client-side caches absorb repeat reads without reaching the BFF at all.
- **BFF vs dedicated API gateway**: An API gateway handles cross-cutting concerns (TLS termination, rate limiting, routing), while a BFF handles client-specific shaping and aggregation. Use both together: the gateway sits in front, the BFF sits behind it per client type.
- **Circuit breaking upstream calls**: Wrap each downstream service call with a circuit breaker. When a service is degraded, open the circuit and return a cached or default response immediately instead of queuing up latency that degrades the entire BFF.
- **Mobile vs web BFF differences**: Mobile BFFs must aggressively minimize payload size and round trips due to constrained bandwidth and battery. web BFFs can afford richer payloads and rely more on browser caching and HTTP/2 multiplexing.
- **Testing BFF layers**: Unit-test aggregation and transformation logic with mocked service clients. Use contract tests (e.g., Pact) to verify that BFF assumptions about upstream response shapes remain valid as services evolve independently.
- **Team ownership model**: The team that owns the client should also own its BFF - this keeps the client-server contract under one team's control, avoids cross-team coordination overhead, and ensures the BFF evolves in lockstep with client requirements.

### Junior -> FAANG: Turning This Chapter Into Interview Fluency

The ten summary points above are the chapter's entire value compressed into ten sentences. Before your next system design interview, read them aloud, then close the page and reproduce them from memory. Anything you cannot reproduce is a gap to study.

The two points that most distinguish strong junior candidates from average ones are the aggregation point ("Issue upstream calls in parallel using goroutines and `errgroup`") and the auth point ("Validate the user-facing token at the BFF boundary, then issue scoped, short-lived service-to-service tokens for each downstream call"). These two are the most technically specific and the most commonly tested.

The team ownership point is the one that surprises junior candidates who come from backend backgrounds. "Why does the frontend team own a backend service?" The answer is that the BFF's API contract is driven by the frontend's rendering requirements, changes at the same pace as the frontend, and requires the frontend team's domain knowledge to design correctly. Putting it under platform team ownership creates coordination overhead that negates the main benefit of the pattern.

### Senior @ FAANG: Chapter Retrospective for System Design Mastery

At senior level, a chapter like this should generate three outputs: a set of design patterns you can apply immediately, a set of trade-offs you can articulate fluently in design reviews, and a set of platform improvements you can propose to your team.

Immediately applicable patterns: parallel fan-out with `errgroup` and graceful degradation, shared service client with circuit breaker and typed errors, cache key tiering by data staleness class, and scoped service-to-service token issuance at the BFF boundary.

Trade-offs to articulate fluently in design reviews: BFF versus GraphQL Federation (client divergence versus service divergence as the determining factor), BFF versus general-purpose API (one client versus multiple clients as the threshold), shared BFF versus separate BFFs (team ownership clarity as the deciding factor, not technical factors alone), and monorepo versus polyrepo for BFF organization (build infrastructure as the deciding context).

Platform improvements to propose: a shared `bffkit` library if one does not exist, contract testing integration in CI for all BFF-to-backend relationships, a BFF starter template that includes health probes, tracing middleware, circuit breaker setup, and standard error types, and a BFF capability review process that evaluates new client surfaces against the documented threshold criteria for BFF adoption. These improvements compound over time, making the entire BFF ecosystem more reliable and easier to extend without requiring every team to re-learn the same lessons independently.

---
