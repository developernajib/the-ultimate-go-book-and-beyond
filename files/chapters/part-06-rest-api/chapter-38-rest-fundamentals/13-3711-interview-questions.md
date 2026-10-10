## 38.11 Interview Questions

### Question 1: What's the difference between PUT and PATCH?

**Answer:** PUT replaces the entire resource with the request body. Every field must be provided. Missing fields are set to null/default. PUT is idempotent: calling it multiple times with the same data produces the same result.

PATCH applies a partial update, modifying only the specified fields. Other fields remain unchanged. PATCH can be idempotent (with JSON Merge Patch, RFC 7396) or non-idempotent (with JSON Patch per RFC 6902, where an "add" that appends to an array grows it on every replay).

**What FAANG expects:** Name the two PATCH flavors (RFC 7396 Merge Patch vs. RFC 6902 JSON Patch), explain *why* PUT is idempotent even though it mutates state (replaying produces the same final state), and mention ETag/If-Match preconditions to avoid lost updates under concurrent PATCH.

*Follow-ups:* (1) How do you PATCH a field to `null` without Merge Patch treating it as "remove"? (Use JSON Patch, or a sentinel.) (2) If a PATCH is applied twice because the network retried, is the resource corrupted? (Depends on the patch: a Merge Patch that sets fields is idempotent, an RFC 6902 "add" that appends to an array is not.) (3) Why do GraphQL mutations not need PUT vs. PATCH? (Single POST endpoint. The schema encodes partial-update semantics.)

```json
// PUT /users/123 - Must provide all fields
{
    "name": "John Doe",
    "email": "john@example.com",
    "role": "admin"  // If omitted, role becomes null
}

// PATCH /users/123 - Only update specified fields
{
    "email": "newemail@example.com"  // name and role unchanged
}
```

### Question 2: How would you design pagination for an API serving millions of records?

**Answer:** Use cursor-based pagination instead of offset pagination. Offset pagination requires the database to scan and skip rows, which becomes slow for deep pages. Cursor pagination uses indexed columns for efficient "seek" queries.

```json
// Response includes cursor for next page
{
    "data": [...],
    "pagination": {
        "next_cursor": "eyJpZCI6IjEyMzQ1In0=",
        "has_more": true
    }
}

// Cursor is opaque to clients - typically base64-encoded JSON containing:
// - Last seen ID
// - Sort field values
// - Timestamp for consistency

// For complex sorting, encode multiple fields:
type Cursor struct {
    ID        string    `json:"id"`
    CreatedAt time.Time `json:"created_at"`
    Score     float64   `json:"score"`
}
```

**What FAANG expects:** You must articulate that offset pagination is O(offset) on the database because MySQL/Postgres still read and discard every skipped row, while keyset pagination (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`) is O(log n) via the index. Mention *cursor stability* under concurrent writes (inserts at the head do not shift your page), HMAC-signing the cursor to prevent tampering, and the trade-off that cursor pagination precludes random-access deep links.

*Follow-ups:* (1) How do you jump to page 500? (You cannot with pure cursors, that is the trade-off. Provide search/filter instead.) (2) How do you count total results cheaply? (You usually cannot for large tables. Return `has_more` instead of `total_pages`, or use an approximate count.) (3) What happens if the cursor field is not unique? (Tie-break with a secondary key like `id` to guarantee stable ordering.)

### Question 3: How do you handle API versioning?

**Answer:** There are three main approaches:

1. **URL versioning** (`/v1/users`): Most explicit, easy to understand, but pollutes URLs
2. **Header versioning** (`Accept: application/vnd.api.v1+json`): Cleaner URLs, but less visible
3. **Query parameter** (`/users?version=1`): Simple but often overlooked

Stripe and Twilio use URL versioning. GitHub uses header versioning: the `X-GitHub-Api-Version` date header for breaking changes, with media-type previews historically used for beta features.

Best practice: Use URL versioning for major breaking changes, and feature flags or custom headers for gradual rollouts:

```go
r.Route("/v1", func(r chi.Router) {
    r.Get("/users", v1ListUsers)
})

r.Route("/v2", func(r chi.Router) {
    r.Get("/users", v2ListUsers)  // Different response format
})

// Beta features via header
func handler(w http.ResponseWriter, r *http.Request) {
    if r.Header.Get("X-Enable-Beta") == "true" {
        // Return beta response format
    }
}
```

**What FAANG expects:** Separate **wire-format versioning** (breaking changes to request/response schemas) from **feature flags** (additive, opt-in behavior). Explain Stripe's date-based versioning (`Stripe-Version: 2024-04-10`) which pins each customer to a snapshot and lets Stripe ship changes continuously without URL churn. Acknowledge that header versioning breaks browser caching and makes `curl` examples harder, which is why most public APIs ship URL versioning regardless.

*Follow-ups:* (1) How long do you keep v1 alive after v2 ships? (At least 12-24 months for public APIs. Communicate the sunset date via the `Sunset` header per RFC 8594 and the `Deprecation` header per RFC 9745.) (2) How do you avoid a combinatorial explosion of versions? (Cap at 2-3 live majors, use feature flags for small changes.) (3) Can one handler serve both versions? (Yes, via response adapters/DTOs keyed on version, but the translation layer must have its own tests.)

### Question 4: What is idempotency and how do you implement it for POST requests?

**Answer:** Idempotency means multiple identical requests produce the same result as a single request. GET, PUT, and DELETE are naturally idempotent. POST is not - creating a resource twice creates duplicates.

To make POST idempotent, use idempotency keys:

```go
func (h *Handler) CreatePayment(w http.ResponseWriter, r *http.Request) {
    idempotencyKey := r.Header.Get("Idempotency-Key")
    if idempotencyKey == "" {
        response.Error(w, http.StatusBadRequest, "MISSING_KEY",
            "Idempotency-Key header required")
        return
    }

    // Check for cached response
    if cached, found := h.cache.Get(idempotencyKey); found {
        w.WriteHeader(cached.Status)
        w.Write(cached.Body)
        return
    }

    // Process request
    result, err := h.paymentService.Create(r.Context(), input)

    // Cache response (success or client error)
    responseData := CachedResponse{
        Status: http.StatusCreated,
        Body:   marshalJSON(result),
    }
    h.cache.Set(idempotencyKey, responseData, 24*time.Hour)

    w.WriteHeader(responseData.Status)
    w.Write(responseData.Body)
}
```

**What FAANG expects:** Describe the full lifecycle: store `(key, request_fingerprint, response, status, expires_at)` so a replay with a *different body* returns an error instead of serving the cached response (Stripe returns 400 with an `idempotency_error`, the IETF draft recommends 422, and Stripe reserves 409 for a concurrent in-flight request on the same key). Handle the **in-flight** case: two concurrent requests with the same key should serialize via a lock or `INSERT ... ON CONFLICT DO NOTHING RETURNING` so only one creates the resource. TTL is typically 24 hours.

*Follow-ups:* (1) Should you cache idempotency responses for 5xx errors? (No, transient failures should be retried, not memoized.) (2) Where do you store idempotency state in a multi-region deployment? (Region-local with async replication, accept that cross-region retry within the TTL may duplicate, or use a global store like DynamoDB global tables.) (3) Is GET with a query parameter idempotent? (Yes, but the HTTP spec's idempotency is about server state, not response equality. Caching is orthogonal.)

### Question 5: How would you handle rate limiting in a distributed system?

**Answer:** Use a distributed rate limiter with Redis or similar:

```go
// Token bucket algorithm with Redis
func (rl *RateLimiter) Allow(ctx context.Context, key string) (bool, error) {
    script := `
        local key = KEYS[1]
        local rate = tonumber(ARGV[1])
        local capacity = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])
        local requested = tonumber(ARGV[4])

        local tokens = redis.call('GET', key)
        local last_refill = redis.call('GET', key .. ':time')

        if tokens == false then
            tokens = capacity
        else
            tokens = tonumber(tokens)
        end

        if last_refill then
            local elapsed = now - tonumber(last_refill)
            tokens = math.min(capacity, tokens + (elapsed * rate))
        end

        if tokens >= requested then
            redis.call('SET', key, tokens - requested)
            redis.call('SET', key .. ':time', now)
            return 1
        end
        return 0
    `

    result, err := rl.redis.Eval(ctx, script,
        []string{key},
        rl.rate, rl.capacity, time.Now().Unix(), 1).Int()

    return result == 1, err
}
```

Response headers communicate rate limit status:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640000000
Retry-After: 60  // Only on 429 response
```

**What FAANG expects:** Distinguish the three common algorithms: **fixed window** (simple, vulnerable to 2x burst at the boundary), **sliding window log** (accurate, memory-heavy), and **token bucket / leaky bucket** (smooth bursts, production default). Call out the atomicity concern: naive `GET`+`SET` in Redis has a read-modify-write race. Solve it with Lua (as above) or Redis `INCR` with expiry. Mention the `RateLimit` and `RateLimit-Policy` fields being standardized in draft-ietf-httpapi-ratelimit-headers, the `Retry-After` header from RFC 9110, and the need to rate-limit on multiple keys simultaneously (IP *and* user *and* API key) to resist abuse.

*Follow-ups:* (1) How do you rate-limit globally across 100 pods without making Redis a bottleneck? (Local token-bucket with periodic global reconciliation, or sharded counters.) (2) How do you rate-limit an unauthenticated endpoint like login? (By IP with a conservative limit. Add CAPTCHA after N failures. Consider `hashcash`-style proof of work.) (3) Should the rate-limit middleware sit before or after auth? (Before for coarse IP limits, after for per-user limits, usually both, in that order.)

### Junior → FAANG: The Entry-Point Ladder

If you are interviewing at L3 or L4 in 2026, these five questions get asked almost verbatim. The bar is not "did you answer correctly." It is "did you articulate the tradeoff and reach for the RFC." Here is how to train for that.

Per-question drill. Question 1, PUT versus PATCH. The junior answer stops at "PUT replaces, PATCH modifies." The L4 answer names RFC 7396 and RFC 6902, explains the "null versus missing" ambiguity in Merge Patch, and mentions `If-Match` with ETag for concurrent update protection. Drill by implementing both flavors against the same resource and writing a test that shows the null case diverging.

Question 2, pagination at scale. The junior answer says "cursors." The L4 answer writes the SQL on the whiteboard. `WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20` with a composite index on `(created_at, id)`. Explains why the composite index matters (without it, the seek is still a scan). Explains cursor stability under concurrent inserts. Mentions HMAC-signing the cursor so clients cannot tamper.

Question 3, versioning. The junior answer lists three strategies. The L4 answer separates wire-format from feature flags, references Stripe's date-based pinning, and commits to a specific recommendation with a reason. Interviewers want a decision, not a menu.

Question 4, idempotency. The junior answer describes caching by key. The L4 answer covers the lifecycle including the in-flight case, the body-hash check, the 5xx caching decision, and the TTL choice. The bar-raiser will ask what happens when two requests arrive simultaneously with the same key and your cache does not yet have an entry. Answer: serialize via a unique constraint on `(key, tenant_id)` with `INSERT ... ON CONFLICT DO NOTHING RETURNING`, then the losing side polls for the response.

Question 5, rate limiting. The junior answer says "Redis with a counter." The L4 answer names three algorithms, explains the race condition in naive `GET`+`SET`, writes a Lua script or uses `INCR` with TTL, mentions the IETF RateLimit headers, and rate-limits on multiple keys. Drill by implementing a token bucket in Go with `sync/atomic` for single-process and with Redis Lua for distributed.

"Why did this fail" reflex for interview format. When an interviewer asks "imagine this endpoint is getting duplicate charges in production, what do you check," the reflex is not "let me look at the code." It is a decision tree. First, is there an idempotency key? If no, that is the bug. If yes, is the key hashed against the body? If no, different bodies under same key are fighting. If yes, is the key store serializing concurrent requests? If no, you have a thundering herd. Walk the tree aloud. That is the signal interviewers grade on.

First-job context. You will be asked Questions 1 through 3 in your phone screen. You will be asked Question 4 in your onsite if the company handles money. You will be asked Question 5 in your onsite if the company serves a public API. Prepare all five, do not skip the "follow-ups" sections, and for each follow-up have a one-sentence answer rehearsed.

### Senior @ FAANG: Signal Ladder L3 Through L7

Interviews at senior levels are not about correct answers. They are about calibration. The interviewer is placing you on a ladder from L3 (entry) to L7 (principal). Each question has a signal range, and your job is to demonstrate the top of your range without overreaching.

L3 signal. Names HTTP methods correctly, knows 200 versus 201 versus 204, can implement a CRUD endpoint in Go without looking up syntax. Bar for new-grad.

L4 signal. Everything above, plus can articulate the PUT versus PATCH tradeoff with RFC references, can explain cursor versus offset pagination with SQL-level reasoning, can implement an idempotency key middleware correctly including the body-hash check. Bar for two-to-four-year engineer.

L5 signal, senior. Designs an API surface, not a single endpoint. When asked "design Twitter's API," produces a coherent resource model (users, tweets, timelines, follows), assigns auth scopes per resource, picks a pagination strategy and justifies it against the read pattern (timelines need cursor, search needs offset because users want page 5), writes a rate limit tier table, specifies versioning stance up front, and bakes in deprecation from day one. Connects design decisions to operational consequences (cache strategy, fan-out cost, abuse vectors).

L6 signal, staff. Designs an API platform, not a surface. When asked "design a PayPal-style idempotent payments API," produces the design plus the governance. Mentions the API review board, the Spectral ruleset, the contract testing pipeline, the breaking-change detector in CI, the deprecation SLA policy, and the on-call rotation for API stability. Discusses tenancy strategy (URL-embedded versus JWT), data residency as a routing concern, and regulatory implications (PCI DSS, PSD2 strong customer authentication).

L7 signal, principal. Designs the organizational structure that produces good APIs over a decade. Proposes the API platform team charter, the funding model (centralized versus chargeback), the relationship with product teams (consultative versus enforcing), the escalation path for exceptions, the metrics the platform team is measured on (adoption, breaking-change rate, time-to-deprecate, developer NPS). Discusses the multi-year roadmap for migrating off legacy patterns (200-for-everything, enveloped responses) without a rewrite, and the compensation structure for platform engineers to prevent resume-driven migrations.

Bar-raiser prompt, "design a GitHub-scale API serving 100M requests per day." L6 answer shapes the architecture. Edge caching with varnish or CDN, aggressive `ETag`/`If-None-Match` to drive a high 304 ratio, `Link`-header pagination for compatibility with bot ecosystems, per-token rate limits tiered by plan (GitHub's published tiers are 60/hr unauthenticated and 5000/hr authenticated), GraphQL v4 alongside REST v3 for heavy clients, a deprecation policy measured in years, and a public status page with per-endpoint SLOs. L7 answer adds the organizational structure. Who owns the gateway, who owns the schema, who owns the official SDKs across many languages (a full team), who owns the docs pipeline, who owns the abuse-mitigation WAF layer. How does the team fund itself, how does it measure success, how does it fail gracefully when a product team wants an exception.

Bar-raiser prompt, "design a REST API spec review tool." The ask is what platform artifacts you would build. Answer: a CLI that wraps Spectral with an internal ruleset, a GitHub App that comments on PRs with rule violations, an OpenAPI diff bot that blocks merges on breaking changes unless labeled, a consumer-producer contract test runner integrated with Pact Broker, a dashboard that tracks per-team spec compliance over time, and an exception workflow that requires API review board sign-off for rule waivers. Ship this in quarters, not sprints, with a platform PM.

Bar-raiser prompt, "migrate REST to gRPC." Decision framework first, execution plan second. Inventory call patterns (server-server versus client-server), measure payload sizes and latency budgets, identify the 20% of endpoints generating 80% of traffic, stand up gRPC for those first behind a gateway that speaks both, migrate internal callers with generated clients, leave public REST indefinitely, publish gRPC-Web for browser if needed. Sequence: proto definitions first (because they become the new source of truth), then server implementation, then clients, then deprecation of the REST shim. Budget 18 months for a service with 50 endpoints and 10 consumer teams.

Bar-raiser prompt, "audit an API surface of 500 endpoints." Covered in section 38.10 of this chapter, but the interview version emphasizes categorization (P0/P1/P2), mechanization (Spectral plus `openapi-diff` plus contract tests), ownership assignment (every finding has a named owner and a due date), and recurrence (quarterly audit, not one-shot).

Bar-raiser prompt, "design an API for multi-tenant SaaS at 10K tenants scaling to 1M." Tenancy decision is load-bearing. URL-embedded (`/tenants/{id}/...`) is auditable but ugly. JWT-claim is clean but requires defense in depth. Pick JWT with the tenant ID also echoed in a response header for log correlation. Rate limits per tenant and per endpoint, enforced at gateway with Redis-backed sliding window, fail-open on Redis outage with local fallback. Data residency at the gateway level, with a tenant-region map in a fast store and routing rules encoded in the gateway config. Schema isolation strategy (shared-schema with tenant_id column, schema-per-tenant, database-per-tenant) driven by compliance requirements, not engineering preference.

Principal-level signal to avoid overreach. Do not propose a rewrite. Do not propose a new protocol for a problem HTTP solves. Do not propose a solution that requires every product team to adopt a new pattern by Q3. Principal answers propose incremental paths with exit ramps at each quarter boundary. That restraint is the signal.

---
