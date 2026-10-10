## Summary

Core layers of a production Go web service:

1. **Server configuration.** Always set `ReadTimeout`, `WriteTimeout`, and `IdleTimeout` on `http.Server`. Use graceful shutdown to drain in-flight requests on deploy.
2. **Routing.** Go 1.22+ stdlib routing handles method dispatch and path parameters natively. Chi and Gorilla Mux add route grouping, regex constraints, and host-based routing for more complex needs.
3. **Middleware.** Chain middleware in the correct order: recovery first, then request ID, logging, CORS, rate limiting, authentication, and finally timeouts. Order determines which concerns run before others.
4. **Request handling.** Use typed helpers for JSON parsing, query parameter extraction, form data, and file uploads. Centralize response formatting in shared functions to enforce a consistent envelope.
5. **Validation.** Validate at the handler boundary before data reaches business logic. Return all violations at once so clients can fix issues in a single round trip.
6. **Error handling.** Map custom error types to HTTP status codes. Log internal details server-side. Return generic messages to clients.
7. **Sessions and cookies.** Set `HttpOnly`, `Secure`, and `SameSite` on all session cookies. Store session data server-side with automatic expiration cleanup.
8. **WebSocket support.** The Hub pattern manages client connections centrally. Separate read/write goroutines per client prevent the Hub's event loop from blocking.
9. **Testing.** Use `httptest.NewRecorder` for unit tests and `httptest.NewServer` for integration tests. Table-driven tests cover valid inputs, validation failures, and error paths efficiently.

### Junior to FAANG: Reading This Summary as a Checklist

Treat each of the nine summary points as a binary checkbox. For each item, ask "can I demonstrate this on a blank laptop in 30 minutes." Gap analysis done. Ten hours of focused practice on your weakest points beats ten weeks of passive re-reading.

Minimum production skeleton you should be able to produce from memory. `http.Server` with the five timeouts. Graceful shutdown with `signal.NotifyContext`. Router (stdlib mux or chi) with group-based auth. Five middlewares in the canonical order. JSON decode with `MaxBytesReader` and `DisallowUnknownFields`. RFC 7807 error envelope. A `/healthz` and `/readyz` split onto an admin listener. A table-driven handler test. That skeleton, shipped on a laptop, is the bar for "can you write a Go web service."

### Senior at FAANG: The Chapter as Platform Strategy

The nine summary items map onto nine platform contracts.

1. Server configuration becomes `platform/httpserver` library with one hardened constructor.
2. Routing becomes an ADR pinning stdlib plus chi, codemod for legacy frameworks.
3. Middleware becomes a typed builder enforcing canonical order with platform-supplied middlewares for every cross-cutting concern.
4. Request handling becomes `platform/request.Decode[T]` with schema-registry integration.
5. Validation becomes validator.v10 plus the org error-code registry.
6. Error handling becomes RFC 7807 problem+json org-wide with typed SDK clients generated from the registry.
7. Sessions become an ADR per surface, substrate operated by the identity platform team.
8. WebSockets become `platform/ws` with fan-out via Redis pubsub or NATS and a reconnect protocol.
9. Testing becomes a CI pyramid with contract tests, load tests, chaos tests, and fuzz tests as gates.

Each contract has an owning staff engineer, a roadmap, an adoption dashboard, and a drift report. Publish them as a platform handbook. Review quarterly. Retire old contracts when they converge on a better successor. This is the staff-to-principal playbook for HTTP platform work.

Key org-level metrics to track. Incident rate per 1000 deploys. p99 latency burn-rate. Adoption rate of platform libraries per service. Drift score per service against the anti-pattern catalog. Error-budget consumption per service per quarter. Cost per request (cloud spend plus engineering amortized). Every metric ties to a specific chapter concept. Measuring these is how you turn "we have a chapter on web services" into "we have a provably-reliable HTTP fleet."

Year-ahead priorities for a staff engineer landing in an org with 200 Go services. Quarter 1, assess (drift report, incident taxonomy, tech-debt census). Quarter 2, decide (publish the ADRs for router, error envelope, server template). Quarter 3, deliver (land the platform libraries, first 20 services onboarded). Quarter 4, drive adoption (80 percent target, codemod existing services, CI gates). Year 2, scale (observability, security, performance). Year 3, retire legacy and harvest the reliability gains.

Closing framing. The difference between a mid-level engineer and a staff engineer reading this chapter is that the mid-level writes one correct handler and the staff engineer writes the platform that makes every team's handler correct by default. Internalize that difference and the promotion path becomes clear.

---
