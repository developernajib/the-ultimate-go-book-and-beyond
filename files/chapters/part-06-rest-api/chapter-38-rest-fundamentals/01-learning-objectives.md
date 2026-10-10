## Learning Objectives

After completing this chapter, you will be able to:

- **Master REST constraints** and apply them to design scalable, maintainable APIs that use HTTP semantics correctly
- **Implement proper HTTP method semantics** including idempotency guarantees, safe methods, and appropriate status code usage
- **Design resource-oriented URLs** following industry best practices used by Stripe, Twilio, GitHub, and other API-first companies
- **Build production-ready request/response handling** with proper validation, content negotiation, and error responses
- **Create reusable middleware patterns** for logging, authentication, rate limiting, and request tracing
- **Apply HATEOAS principles** to build self-documenting, discoverable APIs
- **Handle pagination, filtering, and sorting** at scale with cursor-based pagination and efficient query patterns

### Junior → FAANG: the specific skills hiring managers check for

The objectives above are outcomes. In an interview loop they compress to five concrete probes you must pass.

1. Given a feature ("allow users to cancel subscriptions"), can you produce a resource-shaped URL, a correct verb, a status code, and a response envelope in under two minutes. The right answer is roughly `POST /subscriptions/{id}/cancellations` returning 202 with a `Location` header, because cancellation often involves dunning and proration that are not instant. A weaker but acceptable answer is `DELETE /subscriptions/{id}` returning 200 with the updated resource. Either is fine if you can defend it. "`POST /cancelSubscription`" fails the probe.

2. Given a failing request, can you pick the right 4xx status without guessing. 400 for malformed JSON, 401 for missing or invalid auth, 403 for authenticated but unauthorized, 404 for the resource does not exist or the caller is not allowed to know it exists, 409 for state conflict, 422 for validation failure on a parsed body, 429 for rate-limited.

3. Given two requests that both succeed but return different bodies because the client retried, can you explain why that is an idempotency bug and how `Idempotency-Key` solves it.

4. Given a list endpoint, can you explain why `?page=1` is insufficient for production and describe at least one cursor-based alternative.

5. Given a JSON payload, can you write a Go struct with correct tags (`json`, `validate`) and parse it with `json.NewDecoder(r.Body).Decode` including `DisallowUnknownFields` for strict mode.

If you can clear those five, you are ready for a junior backend screen at any FAANG-tier company. The worked examples in the remainder of this chapter map one-to-one onto each probe.

### Senior @ FAANG: the objectives you own across the org, not just the service

At staff and principal levels the learning objectives shift from "can I implement" to "can I set platform-wide defaults that twenty teams will live with for five years." The concrete artifacts you are expected to produce and maintain are the following.

An API style guide document, versioned in a central repo, that fixes naming (plural kebab-case paths, field casing, timestamp format as RFC 3339 with timezone, monetary amounts as minor units with currency code), versioning policy (URL `/v1/` for public, `API-Version` header for internal, deprecation via `Sunset` header per RFC 8594), error envelope shape (RFC 9457 Problem Details, the successor to RFC 7807, is the default in 2026, with extensions for `trace_id` and `idempotency_replay`), and the list of forbidden anti-patterns (verbs in URLs, 200 with error body, boolean query params without an explicit false value). The guide is not advisory. CI linters (spectral rules, vacuum, or a custom spectral ruleset) enforce it on every OpenAPI diff.

An idempotency and retry policy that applies uniformly to every mutation endpoint. `Idempotency-Key` is required on all POST endpoints that create resources or trigger side effects. Keys are stored with the response for 24 hours at minimum, 7 days for payment-adjacent surfaces. Replays return the original response with an `Idempotent-Replayed: true` header so clients and observability can distinguish.

A pagination and filtering standard. Pick one pagination scheme (cursor by default) and one filter dialect (RSQL, OData, or JSON:API filter). Document which fields are filterable, sortable, and selectable per resource in the OpenAPI spec via vendor extensions (`x-filterable: true`). The payoff is that SDK generators and API gateways can enforce the allowlist without per-endpoint code.

A deprecation and breaking-change policy. In 2026 the minimum notice is 180 days for public APIs with automated `Sunset` and `Deprecation` headers, and partners receive structured emails triggered by the gateway. Breaking changes require a new major version with dual-running for the notice window. The senior responsibility is defending this policy against product pressure to "just ship it."

A status-code taxonomy document with explicit mappings from domain errors to HTTP codes. This is the single artifact that eliminates the "why did this return 500" incident class. It lists every typed error in the platform, its HTTP code, its Problem Details `type` URI, whether it pages on-call, and whether it counts against SLO error budget.

A protocol boundary map. For each external surface (public REST, partner REST, webhooks) and internal surface (gRPC, pub/sub, batch) the map shows which protocol is the source of truth, which teams own it, and the ADR that justified the choice. This is the document that prevents a well-meaning team from re-inventing REST in GraphQL next quarter.

A testing and contract-verification pipeline. Every service ships consumer-driven contract tests (Pact or schemathesis against the OpenAPI spec), fuzz tests against the public surface, and a scheduled job that runs the full SDK integration suite against staging nightly. The senior objective is that no client integration is a surprise.

An observability contract for the API layer. Every request emits a structured log with `method`, `route_template` (not the raw URL, because cardinality), `status`, `latency_ms`, `idempotency_key_present`, `trace_id`, `tenant_id`. Metrics are keyed by `route_template` and `status_class`. Traces propagate `traceparent` per W3C Trace Context. Without this contract, incident response relies on grep and luck.

If you leave this chapter able to produce the artifacts above (not just code), you are operating at staff level on API platform work. The sections that follow give you the vocabulary and the code patterns, but the objective at your level is documents and defaults, not handlers.

---
