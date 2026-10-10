## API Versioning & Documentation Architecture

This architecture overview shows how versioning strategy (URL path, `Accept` header, or query parameter) affects routing, handler reuse, and backward compatibility. Documentation generation is integrated into the build pipeline so that the OpenAPI spec always reflects the deployed contract.

Read the deprecation headers at the bottom carefully, because their formats are different and easy to get wrong. `Deprecation` (RFC 9745) carries the moment the deprecation took effect, as a Unix timestamp with an `@` prefix, and it points at a time in the **past**. `Deprecation: true` is not valid: that value predates the RFC and still circulates in blog posts. `Sunset` (RFC 8594) carries the future removal date as an HTTP-date, and its day-of-week must actually match the date, which is a detail that hand-written examples get wrong constantly. Generate it with `time.Time.Format(http.TimeFormat)` rather than by typing it. `Link` with `rel="successor-version"` is Web Linking (RFC 8288) and is what lets a client discover the replacement automatically.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                   API VERSIONING & DOCUMENTATION ARCHITECTURE                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                      VERSIONING STRATEGIES                             │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │  │
│  │  │  URL PATH       │  │  HEADER         │  │  CONTENT TYPE   │         │  │
│  │  │                 │  │                 │  │                 │         │  │
│  │  │ /api/v1/users   │  │ X-API-Version:1 │  │ Accept:         │         │  │
│  │  │ /api/v2/users   │  │ X-API-Version:2 │  │ vnd.api.v1+json │         │  │
│  │  │                 │  │                 │  │                 │         │  │
│  │  │ ✓ Explicit      │  │ ✓ Clean URLs    │  │ ✓ RESTful       │         │  │
│  │  │ ✓ Cacheable     │  │ ✓ Flexible      │  │ ✓ Per-resource  │         │  │
│  │  │ ✗ URL pollution │  │ ✗ Hidden        │  │ ✗ Complex       │         │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘         │  │
│  │                                                                        │  │
│  │  Recommendation: URL Path for public APIs, Header for internal APIs    │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                       VERSION ROUTING FLOW                             │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Request ──► Version Resolver ──► Route to Version ──► Response        │  │
│  │                                         │                              │  │
│  │                                         ▼                              │  │
│  │                            ┌───────────────────────┐                   │  │
│  │                            │   Version Router      │                   │  │
│  │                            ├───────────────────────┤                   │  │
│  │                            │ v1 (deprecated)       │                   │  │
│  │                            │ ├── handlers/v1/      │                   │  │
│  │                            │ ├── models/v1/        │                   │  │
│  │                            │ └── Sunset: 2025-06   │                   │  │
│  │                            │                       │                   │  │
│  │                            │ v2 (current)          │                   │  │
│  │                            │ ├── handlers/v2/      │                   │  │
│  │                            │ ├── models/v2/        │                   │  │
│  │                            │ └── Stable            │                   │  │
│  │                            │                       │                   │  │
│  │                            │ v3 (beta)             │                   │  │
│  │                            │ ├── handlers/v3/      │                   │  │
│  │                            │ └── X-Beta-Features   │                   │  │
│  │                            └───────────────────────┘                   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                      DOCUMENTATION ECOSYSTEM                           │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                     OpenAPI Specification                       │   │  │
│  │  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐     │   │  │
│  │  │  │   Paths   │  │  Schemas  │  │ Security  │  │ Examples  │     │   │  │
│  │  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘     │   │  │
│  │  └────────────────────────────────┬────────────────────────────────┘   │  │
│  │                                   │                                    │  │
│  │                  ┌────────────────┼────────────────┐                   │  │
│  │                  ▼                ▼                ▼                   │  │
│  │           ┌───────────┐    ┌───────────┐    ┌───────────┐              │  │
│  │           │ Swagger   │    │  Redoc    │    │ SDK Gen   │              │  │
│  │           │    UI     │    │           │    │           │              │  │
│  │           │           │    │           │    │ • Go      │              │  │
│  │           │ • Try it  │    │ • Clean   │    │ • Python  │              │  │
│  │           │ • Execute │    │ • Three-  │    │ • JS/TS   │              │  │
│  │           │ • Params  │    │   column  │    │ • Java    │              │  │
│  │           └───────────┘    └───────────┘    └───────────┘              │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        DEPRECATION TIMELINE                            │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  v1 GA ───► v2 Beta ───► v2 GA ───► v1 Deprecated ───► v1 Sunset       │  │
│  │    │          │            │              │                 │          │  │
│  │    │          │            │              │                 │          │  │
│  │  Year 1    +6 months    +3 months     +6 months        +6 months       │  │
│  │                                                                        │  │
│  │  Headers During Deprecation:                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │ Deprecation: @1733011200                                        │   │  │
│  │  │ Sunset: Sun, 01 Jun 2025 00:00:00 GMT                           │   │  │
│  │  │ Link: </api/v2>; rel="successor-version"                        │   │  │
│  │  │ X-Deprecation-Notice: Migrate to v2 in 180 days                 │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading This Diagram In Order

The diagram is arranged top-down for a reason. Start at versioning strategies, because that decision cascades into every box below it. If you pick URL path versioning, the version router at step two has a literal string prefix to match on, the OpenAPI spec at step three has separate `servers` entries per version, and the deprecation headers at step four attach to a whole subtree of routes. If you pick header-based versioning instead, the router needs a middleware that parses the header before matching routes, the OpenAPI spec uses a single base URL with a request parameter, and the deprecation attaches at the per-endpoint level inside one route tree. The choice is not cosmetic, it restructures the whole stack.

A prerequisite that trips up junior engineers is understanding why cacheability shows up as a tradeoff at all. HTTP caches key on URL plus a small set of headers (typically `Accept`, `Accept-Language`, and anything listed in `Vary`). URL path versioning gives each version a unique URL, so CDN caching just works. Header-based versioning requires every response to emit `Vary: X-API-Version` so caches know to split cache entries by header value, and if any intermediate proxy drops that header you get cache poisoning where v1 callers receive v2 responses. The "cacheable" checkmark in the URL path box is not marketing, it is an acknowledgment that you do not have to think about Vary. That alone is enough to pick URL path for a public API behind a CDN.

A worked example for your first job. You inherit a service with `/users` (no version), and product wants to add a breaking change. The diagram says version the new one as `/api/v2/users` and leave the original responding. But `/users` has no version prefix, so you cannot magically call it v1. The right move is to leave `/users` in place forever as an alias for v1, add `/api/v1/users` as the canonical v1 path (documented, with deprecation headers), and add `/api/v2/users` as the new path. You announce that `/users` is the legacy alias and will not receive new features. Clients migrate to `/api/v1/users` on their own schedule, then to `/api/v2/users` when they are ready. This is the most common real-world starting point and the diagram does not show it because it is an embarrassment that predates versioning discipline.

The interview entry-point for an architecture diagram question is to walk it top to bottom, naming one tradeoff per layer. Versioning strategy: URL for cacheability vs header for clean URLs. Routing: shared handlers with thin version adapters vs duplicated handlers per version. Docs: code-first for speed vs spec-first for contract discipline. Deprecation: Sunset header plus personal outreach vs passive signal only. That is a complete answer in two minutes and it shows you understand the shape of the problem rather than one implementation.

### Senior @ FAANG: What Is Missing From This Diagram At Scale

This diagram is accurate for a single service owned by one team. At FAANG scale there are four layers missing that are load-bearing and belong in your mental model even though they are not drawn here. Understanding what the diagram omits is the difference between shipping a versioned service and owning the versioning platform.

The first missing layer is the gateway. In a real FAANG deployment, requests do not hit your Go service directly, they hit an API gateway (Envoy, Kong, AWS API Gateway, or a homegrown equivalent) that does auth, rate limiting, observability, and version routing. The gateway is where URL path versioning is actually enforced, because it is the layer that can cleanly route `/api/v1/*` to the v1 service fleet and `/api/v2/*` to the v2 fleet, potentially running different binaries. This matters because it lets you run v1 and v2 as separate deploys, with separate on-call rotations and separate rollout cadences, rather than bundling both into one binary. The tradeoff is operational overhead (two deploys per service per version) vs blast radius (a bad deploy of v2 cannot take down v1). For high-traffic public APIs the separation is worth it.

The second missing layer is the spec-to-gateway-config pipeline. The OpenAPI spec in the diagram is drawn as input to docs and SDK generation, but at scale it is also input to the gateway configuration. Every path in the spec generates a gateway route entry with the right auth policy, rate limit, and CORS config attached. This is how you keep the spec and the runtime in sync: the spec is the source of truth, and if it is not in the spec, the gateway rejects it with a 404. The senior project is the generator that takes the spec and emits Envoy config (or equivalent), run in CI on every spec change, deployed via the standard config rollout pipeline. Without this pipeline, specs drift from runtime within weeks.

The third missing layer is versioned SDK publishing. The SDK Gen box in the diagram treats SDK generation as a single step, but at FAANG scale it is a multi-repo publish pipeline. Each language SDK lives in its own repo (for language-native tooling: crates.io for Rust, PyPI for Python, npm for TypeScript, Maven Central for Java). Each repo has its own release cadence and its own semver. When the API spec gets a new version, all SDK repos get a new release, ideally coordinated so that `v2.0.0` across all SDKs corresponds to API v2. This requires tooling: Stainless and Fern both handle the multi-repo fan-out, but you still need a release orchestrator that can roll back one language if its publish fails without blocking the others. Budget an engineer-quarter for this pipeline if you are building it yourself.

The fourth missing layer is the deprecation telemetry backplane. The deprecation timeline at the bottom of the diagram shows headers, but the headers are passive signals. The active part is the usage data: for every request to a deprecated endpoint, you emit a structured log entry with the customer ID, the endpoint, the version, and the user-agent (which often identifies the SDK and SDK version). That stream feeds a data warehouse (BigQuery, Snowflake, or equivalent), and the deprecation dashboard runs scheduled queries against it. The queries that matter are: total daily calls per deprecated version (trending down?), per-customer call counts ranked by contract tier (who do we need to contact?), and per-user-agent breakdown (which SDK versions are still stuck?). The senior deliverable is the dashboard plus the alerting on deprecation timelines (if 30 days before sunset the top 10 callers are still on the old version, page someone). This is the backplane that converts sunset from an announcement into an operation.

The diagram also elides the API review board. At scale, public-facing breaking changes do not ship because one team decides to ship them. They ship because a cross-team review board, composed of platform engineers and consumer representatives, approves the change after reviewing the migration guide, the usage data, and the deprecation timeline. The review board is a meeting (or an async review queue) and its output is a signed-off RFC document attached to the deprecation ticket. If your org does not have an API review board and you own more than three public endpoints, the first staff-level project is to propose and stand one up. The ROI is measured in averted customer-breaking deploys, which is a hard number to quantify until the first one happens, at which point the ROI is infinite.

---
