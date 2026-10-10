## Summary

Production REST API design and implementation in Go centers around several core tenets:

1. **HTTP Methods** carry semantic meaning. GET is safe and idempotent, PUT replaces a full resource idempotently, POST creates without idempotency guarantees, PATCH applies partial updates, and DELETE removes a resource. Using the wrong method breaks caching, retry logic, and client expectations.
2. **Status Codes** tell clients what happened and what to do next. Return 201 for creation, 204 for deletion, 404 for missing resources, 422 for validation failures, and 409 for conflicts. Never return 200 for errors.
3. **URL Design** uses plural nouns (`/users`, `/posts`), shallow nesting for ownership (`/users/{id}/posts`), and query parameters for filtering and sorting. Verbs belong in HTTP methods, not paths.
4. **Request/Response handling** requires body size limits (`http.MaxBytesReader`), strict JSON decoding (`DisallowUnknownFields`), and consistent response envelopes with `data`, `meta`, and `_links` fields.
5. **Content Negotiation** selects the response format based on the `Accept` header and validates the `Content-Type` of incoming request bodies. Return 406 for unsupported accept types and 415 for unsupported content types.
6. **Middleware** implements cross-cutting concerns (logging, panic recovery, CORS, request IDs, and timeouts) as composable `func(http.Handler) http.Handler` wrappers that chain without modifying handler logic.
7. **HATEOAS links** embed navigation URLs in responses so clients can discover related endpoints without hardcoding paths.
8. **Pagination** should use cursor-based tokens for large or frequently updated datasets. Offset pagination is simpler but degrades at high page numbers because the database must scan and skip rows.
9. **Idempotency keys** make POST requests safe to retry by caching the response for a given key and replaying it on duplicate requests.
10. **Real-world API patterns** from Stripe (expansion, idempotency), GitHub (conditional requests, Link header pagination), Twilio (account-scoped URLs, webhooks), and Netflix (backend-for-frontend, graceful degradation) provide tested blueprints for production API design.

### Junior → FAANG: What This Chapter Actually Buys You

This summary is ten bullets. Your first job interview will test three of them in depth and the other seven in passing. If you internalize only the bullets, you pass the phone screen. If you internalize the reasoning behind each bullet, you pass the onsite.

The three load-bearing reflexes from this chapter. First, method-and-status semantics as a native language. When you read `POST /users` returning 200, your skin crawls because it should be 201 with `Location`. When you read `PUT /users/{id}` that calls `INSERT` unconditionally, your skin crawls because `PUT` must be idempotent. Develop this revulsion. It is the single fastest way to level up review judgment.

Second, validation as a layered discipline. Body size at the gateway. Content-Type at the router. Schema at the decoder (`DisallowUnknownFields`). Business rules at the service. Authorization at the service again (defense in depth). Each layer has a distinct job and a distinct failure mode. Learn to ask "which layer would have caught this" for every bug you see.

Third, idempotency as a contract, not a feature. The client's job is to send an idempotency key on every mutation. The server's job is to honor it. Both sides must agree, which means the contract must be documented in the OpenAPI spec and enforced by middleware. If you can write an idempotency middleware from memory in forty-five minutes, you are interview-ready.

Prerequisite reading for each summary bullet. Bullet 1, RFC 9110 (HTTP semantics). Bullet 2, RFC 9110 plus RFC 9457 (problem+json). Bullet 3, Zalando RESTful API guidelines. Bullet 4, RFC 7578 (multipart) plus Go `net/http` source for `MaxBytesReader`. Bullet 5, RFC 9110 section 12 (content negotiation). Bullet 6, Go stdlib `net/http/httptest` and middleware patterns. Bullet 7, RFC 8288 (Link header) plus HAL spec. Bullet 8, Stripe pagination doc plus SQL keyset pagination articles by Markus Winand. Bullet 9, Stripe idempotency doc plus Shopify engineering blog on idempotency at scale. Bullet 10, the actual public API docs for Stripe, GitHub, Twilio, Netflix, Shopify, Heroku. Read one per week.

First-job context. You will use three of these ten patterns on day one. Method-and-status. Validation. Middleware. The other seven are for the month-three through year-two arc as you grow from "add an endpoint" to "own a resource" to "design a surface."

Interview entry-point. If an interviewer asks "summarize REST best practices in two minutes," do not list ten bullets. Pick three that connect a narrative. "I design REST around three invariants. HTTP semantics as contract, validation as layered defense, idempotency as retry safety. Everything else is detail." That answer signals L4 calibration.

### Senior @ FAANG: The Chapter as a Platform Contract

At staff level this chapter is not a summary of techniques. It is a reference for what the API platform must enforce. Each bullet maps to a platform control, a governance body, and a metric.

Platform controls per bullet. Method-and-status: Spectral rule banning 200-with-error-body, banning verbs in URLs, requiring 201 on POST-create. Validation: gateway-level body size limit, middleware stack with mandatory `MaxBytesReader`, `DisallowUnknownFields` as the default in the framework. Content negotiation: gateway-level content-type allow-list, 406 and 415 as default for unsupported types. Middleware: a required middleware chain in the framework (request ID, logging, recovery, timeout, auth, rate limit, idempotency) that cannot be bypassed. HATEOAS: optional but encouraged, with a response adapter in the framework. Pagination: required library, lint rule against raw `LIMIT` in handlers, Spectral rule requiring pagination schema on list endpoints. Idempotency: required middleware on all mutating endpoints, lint rule that fails the build if `Idempotency-Key` header is not declared in the OpenAPI.

Governance bodies and cadence. API review board weekly, bar-raiser for new top-level resources, quarterly audit of the full API surface, annual deprecation cycle. Security review gate on new authentication paths, new authorization scopes, new data-sensitive fields. Architecture review gate on new gateways, new protocols, cross-service contracts.

Metrics the platform team owns. Breaking-change rate per quarter (target: zero on public, zero on partner without sign-off, tolerated on internal with notice). Spec-compliance percentage per team (target: 95%+). Time-to-deprecate from announcement to 410 (target: under 18 months). Idempotency coverage on mutating endpoints (target: 100% on public). Median PR-review turnaround for API changes (target: under 24 hours). Developer NPS on internal API surface (target: positive, measured quarterly).

Maturity model summary. L1 ad-hoc. L2 documented. L3 governed (linter + review board). L4 platform (gateway controls + contract tests + breaking-change detector). L5 product (public SLA, deprecation policy, versioned SDKs, business KPIs wired to endpoints). Your org's level determines your staff roadmap for the next year.

ADR stance for each chapter concept. Method-and-status: enforced at the linter level, no exceptions. Validation: enforced at the middleware level, exceptions require security sign-off. Content negotiation: enforced at the gateway, exceptions are impossible. Middleware chain: required, bypassing is a build failure. HATEOAS: recommended, not required, because the ROI is team-dependent. Pagination: required on all list endpoints. Idempotency: required on all public mutating endpoints, optional on internal with a recorded waiver.

Cross-chapter connections. This chapter defines REST. The next chapter covers authentication at depth. The chapter after covers gateways and rate limiting. The chapter after that covers observability. The arc is cumulative. You cannot design an API platform without all four. Read them together, not in isolation.

Principal-level reframe. This chapter's ten bullets are not techniques. They are the minimum common vocabulary your org must share before API conversations become productive. If your L5 engineers do not speak these fluently, no amount of tooling rescues the platform. Invest in training, in onboarding docs, in internal tech talks, in a written style guide that every new hire reads in week one. The organizational work is the leverage. The technical work is the downstream effect.

---
