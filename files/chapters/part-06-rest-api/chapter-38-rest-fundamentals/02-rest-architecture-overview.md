## REST Architecture Overview

This overview maps REST API concerns from the transport layer (TLS, HTTP/2, keep-alive) through the routing layer to the handler, service, and repository layers. Cross-cutting concerns such as authentication, rate limiting, and observability are applied as middleware between layers.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         REST API ARCHITECTURE                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┐     ┌─────────────────────────────────────────────────────┐  │
│  │   Client   │     │                   API Gateway                       │  │
│  │ (Browser/  │────►│  ┌─────────┐ ┌──────────┐ ┌───────────┐             │  │
│  │  Mobile/   │     │  │  Auth   │ │Rate Limit│ │  Routing  │             │  │
│  │  Service)  │     │  └─────────┘ └──────────┘ └───────────┘             │  │
│  └────────────┘     └─────────────────────────────────────────────────────┘  │
│        │                                    │                                │
│        │              HTTP Request          │                                │
│        │    ┌───────────────────────────────┘                                │
│        │    │                                                                │
│        ▼    ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        HTTP REQUEST/RESPONSE                            │ │
│  ├─────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                         │ │
│  │  Request:                          Response:                            │ │
│  │  ┌─────────────────────────────┐   ┌─────────────────────────────┐      │ │
│  │  │ GET /api/v1/users/123       │   │ HTTP/1.1 200 OK             │      │ │
│  │  │ Host: api.example.com       │   │ Content-Type: application/  │      │ │
│  │  │ Accept: application/json    │   │   json                      │      │ │
│  │  │ Authorization: Bearer xxx   │   │ X-Request-ID: abc123        │      │ │
│  │  │ X-Request-ID: abc123        │   │                             │      │ │
│  │  │                             │   │ {                           │      │ │
│  │  │                             │   │   "data": { ... },          │      │ │
│  │  │                             │   │   "_links": { ... }         │      │ │
│  │  │                             │   │ }                           │      │ │
│  │  └─────────────────────────────┘   └─────────────────────────────┘      │ │
│  │                                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                       RESOURCE HIERARCHY                                │ │
│  ├─────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                         │ │
│  │  /api/v1                                                                │ │
│  │     │                                                                   │ │
│  │     ├── /users ─────────────────┬── GET    (list)                       │ │
│  │     │      │                    ├── POST   (create)                     │ │
│  │     │      │                    │                                       │ │
│  │     │      └── /{id} ───────────┼── GET    (read)                       │ │
│  │     │            │              ├── PUT    (replace)                    │ │
│  │     │            │              ├── PATCH  (update)                     │ │
│  │     │            │              └── DELETE (delete)                     │ │
│  │     │            │                                                      │ │
│  │     │            └── /posts ────┬── GET    (user's posts)               │ │
│  │     │                           └── POST   (create post for user)       │ │
│  │     │                                                                   │ │
│  │     ├── /posts ─────────────────┬── GET    (list all)                   │ │
│  │     │      │                    └── POST   (create)                     │ │
│  │     │      │                                                            │ │
│  │     │      └── /{id} ───────────┼── GET, PUT, PATCH, DELETE             │ │
│  │     │            │                                                      │ │
│  │     │            ├── /comments ─┬── GET    (post's comments)            │ │
│  │     │            │              └── POST   (add comment)                │ │
│  │     │            │                                                      │ │
│  │     │            └── /publish ──── POST   (action)                      │ │
│  │     │                                                                   │ │
│  │     └── /search ────────────────── GET    (cross-resource search)       │ │
│  │                                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         HTTP METHOD SEMANTICS                           │ │
│  ├─────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                         │ │
│  │  Method   │ Safe │ Idempotent │ Cacheable │ Request Body │ Response     │ │
│  │  ─────────┼──────┼────────────┼───────────┼──────────────┼────────────  │ │
│  │  GET      │  ✓   │     ✓      │     ✓     │      ✗       │ 200 + body   │ │
│  │  HEAD     │  ✓   │     ✓      │     ✓     │      ✗       │ 200 no body  │ │
│  │  OPTIONS  │  ✓   │     ✓      │     ✗     │      ✗       │ 200/204      │ │
│  │  POST     │  ✗   │     ✗      │     ✗     │      ✓       │ 201 + body   │ │
│  │  PUT      │  ✗   │     ✓      │     ✗     │      ✓       │ 200/204      │ │
│  │  PATCH    │  ✗   │     ✗*     │     ✗     │      ✓       │ 200 + body   │ │
│  │  DELETE   │  ✗   │     ✓      │     ✗     │      ✗       │ 204 no body  │ │
│  │                                                                         │ │
│  │  * PATCH can be idempotent if using JSON Patch/Merge Patch correctly    │ │
│  │                                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        STATUS CODE DECISION TREE                        │ │
│  ├─────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                         │ │
│  │  Request ──► Valid? ──No──► 400 Bad Request                             │ │
│  │               │                                                         │ │
│  │              Yes                                                        │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         Authenticated? ──No──► 401 Unauthorized                         │ │
│  │               │                                                         │ │
│  │              Yes                                                        │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         Authorized? ──No──► 403 Forbidden                               │ │
│  │               │                                                         │ │
│  │              Yes                                                        │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         Resource Exists? ──No──► 404 Not Found                          │ │
│  │               │                                                         │ │
│  │              Yes                                                        │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         Validation OK? ──No──► 422 Unprocessable Entity                 │ │
│  │               │                                                         │ │
│  │              Yes                                                        │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         Process ──Error──► 500/502/503/504                              │ │
│  │               │                                                         │ │
│  │             Success                                                     │ │
│  │               │                                                         │ │
│  │               ▼                                                         │ │
│  │         200/201/204 based on method                                     │ │
│  │                                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: reading the diagram like an operator

The layered picture above looks obvious and is therefore easy to skim past. Slow down and walk it end to end, because every interview question about "where would you put X" resolves to a box on this diagram.

Start at the edge. TLS termination usually happens at the load balancer or CDN, not in the Go process. That choice has consequences. Your `net/http` server sees plaintext HTTP/1.1 or HTTP/2 from the LB, the original client IP lives in `X-Forwarded-For`, and the original scheme lives in `X-Forwarded-Proto`. Junior engineers forget this and log the LB's internal IP as the client. The fix is a middleware that reads `X-Forwarded-For` only when the connection came from a trusted proxy range, never blindly.

The API gateway box (cloud providers call this API Gateway, Kong, Envoy, or Caddy) typically owns three responsibilities you do not implement in the service. Authentication token validation (JWT signature check, token introspection against the auth service), global rate limiting (per API key, per IP), and request routing (host and path to upstream). A junior mistake is reimplementing these in the handler. You still need per-endpoint authorization and per-user rate limiting inside the service, because the gateway does not know your domain rules.

The request/response box is the contract surface. The four headers you must learn to read by sight are `Authorization` (who), `Content-Type` (what format is the body), `Accept` (what format does the client want back), and `Idempotency-Key` (has the client seen this request before). Every handler you write in Go will read at least the first three.

The resource hierarchy is the one place juniors consistently go wrong. Notice `/posts/{id}/publish` in the diagram is flagged as an action. Actions are the escape hatch, not the default. Before using one, ask whether the action is really a state transition on the parent resource (`PATCH /posts/{id}` with `{"status":"published"}` or `POST /posts/{id}/publications`) or a legitimate sub-resource. The tiebreaker is idempotency. If clicking publish twice should not re-publish, use a noun sub-resource with an id so the second call is a lookup.

The method semantics table is the flashcard for the rest of your career. Memorize it. The two traps are that PATCH is not idempotent in general (a PATCH that appends to an array will grow the array on each call) and that DELETE is idempotent even though the first call returns 204 and the second returns 404. 404 on a repeated DELETE is fine because the end state is the same.

The status-code decision tree is the order of operations. The order matters. Authentication before authorization, authorization before existence, existence before validation, validation before processing. Getting the order wrong leaks information. A 404 before a 401 tells an unauthenticated attacker which resource ids exist.

Worked example a junior should be able to do in interview. Requirement: allow authenticated users to upload an avatar. Walk the diagram. Gateway validates JWT and rate-limits, router maps `PUT /v1/users/{id}/avatar` to the handler, middleware pulls `traceparent` and `X-Request-ID`, handler checks that the JWT subject matches `{id}` (403 otherwise), reads `Content-Type: image/png`, streams the body to object storage (not into memory), writes the URL to the users table, returns 200 with the updated user resource and a `Location` header pointing at the avatar URL. Every box on the diagram just got touched. That is the level of fluency the picture is trying to build.

### Senior @ FAANG: architecture decisions the diagram hides

The overview above is the shape of a typical single-service deployment. At staff and principal levels the interesting decisions are the ones the diagram does not show, and they dominate the operational behavior of the platform.

Edge versus origin responsibility is the first split. A senior architect treats the LB, CDN, WAF, API gateway, and Go service as a pipeline with explicit contracts. Who terminates TLS. Who owns mTLS for partner callbacks. Who signs and verifies webhook payloads. Who sheds load under pressure. Who strips hop-by-hop headers. The default allocation in 2026 is CDN (Cloudflare, CloudFront, Fastly) terminates TLS and caches GETs with explicit `Cache-Control`, WAF enforces schema-aware rules (often OpenAPI-driven), API gateway handles authn and coarse rate-limits, and the Go service owns authz, domain validation, idempotency, and fine-grained quotas. Write this allocation as an ADR. When an incident happens at 03:00 you want the on-call to know which layer to poke without a call tree.

The second hidden decision is cache governance. REST's cache constraint is a superpower and almost nobody uses it. Read-heavy public resources should set `Cache-Control: public, max-age=60, stale-while-revalidate=300` and a stable `ETag`. The CDN absorbs the traffic, origin sees a trickle, and you get a p99 improvement for free. The catch is invalidation. You need a deterministic purge on writes, which means your write path must know every cache key affected and issue purges (Cloudflare's cache-tag purge API or surrogate keys on Fastly). If you cannot invalidate deterministically, you cannot cache. The staff-level answer is to design resource URIs with cache tags in mind from day one (`tag:customer:42`, `tag:invoice:inv_abc`). This is the kind of decision that is free on day one and nearly impossible on day three hundred.

The third decision is the layering within the Go service. The diagram collapses handler, service, and repository into one box. At scale you want them separated with explicit interfaces. Handler owns HTTP concerns (parsing, validation, status mapping, response shaping). Service owns business rules and orchestrates multiple repositories, external calls, and event publishing. Repository owns data access and is the only layer that knows about the database. The Dependency Inversion principle says handler depends on a service interface, service depends on repository interfaces, and wiring happens in main. The payoff is testability (service unit tests run without HTTP or DB) and replaceability (swap Postgres for DynamoDB without touching handlers). The anti-pattern is fat handlers that call `db.Query` directly. It is fine for a prototype, it does not scale past two engineers.

The fourth decision is the error pipeline. A typed error hierarchy lives in the service layer (`ErrNotFound`, `ErrConflict`, `ErrValidation`, `ErrDependencyFailure`), and a single middleware at the handler boundary maps them to HTTP status and RFC 9457 Problem Details. Every error carries a stable `code` string (`customer.not_found`, `invoice.already_paid`) that clients can switch on, a human `title`, a `detail` that is safe to show, and an `instance` URI that is unique per occurrence (usually the trace id). Clients should never parse the `detail` string. The senior mistake is letting handlers craft ad-hoc error responses. Centralize it.

The fifth decision is the observability contract per request. The canonical log line contains `trace_id`, `span_id`, `route_template` (the template, not the raw URL, so cardinality stays bounded), `method`, `status`, `latency_ms`, `request_bytes`, `response_bytes`, `user_agent_class` (bucketed), `tenant_id`, `actor_id`, `idempotency_key_present`, `idempotency_replayed`, `cache_status` (hit, miss, bypass). Metrics are a RED suite (Rate, Errors, Duration) keyed by `route_template` and `status_class`. Traces propagate W3C Trace Context (`traceparent`, `tracestate`). The gateway injects `traceparent` if absent. Without this contract, SLO measurement and incident response become guesswork.

The sixth decision is backpressure and graceful degradation. When downstream dependencies slow down, the service must shed load instead of queuing requests until the process OOMs. The 2026 defaults in Go are `http.Server.ReadTimeout`, `WriteTimeout`, `IdleTimeout`, and `ReadHeaderTimeout` all set explicitly (never rely on zero-value defaults which are infinite). Per-endpoint concurrency limits via a semaphore, circuit breakers around external calls (`sony/gobreaker`), retries with backoff (`hashicorp/go-retryablehttp`), and a 503 with `Retry-After` when the breaker is open. The gateway layer applies a token bucket per API key. The service layer applies adaptive concurrency based on observed latency (Netflix concurrency-limits-style). Without these, one slow dependency takes down the service.

The seventh decision is multi-tenancy scoping. The diagram shows `/users/{id}` as if tenancy is implicit. In a real SaaS it is not. Either the tenant is in the path (`/orgs/{org}/users/{id}`, GitHub style, best for partner-addressable tenants) or in a header derived from the auth token (`X-Org-Id`, best for user-scoped contexts). Mixing the two in one API is a documentation nightmare. Pick one per product surface and enforce it in the gateway's route templates.

The last decision is versioning and evolution. The diagram shows `/api/v1` but does not show how you get to `/v2`. The staff-level answer is that major versions run in parallel for a documented deprecation window (minimum 180 days for public APIs), the old version proxies through a compatibility shim where possible, the `Sunset` (RFC 8594) and `Deprecation` (RFC 9745) headers are emitted on every response from deprecated endpoints, and the SDK generators produce versioned clients so consumers upgrade at their own pace. Breaking changes without a major version bump are an SLA violation. This is the policy you defend in every product planning meeting.

If you leave this overview able to point at every box and name the ADR that governs it, you are operating at the level the diagram is really trying to teach.

---
