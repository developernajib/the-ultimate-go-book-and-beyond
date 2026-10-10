## 42B.10 Interview Questions

### Junior Level

**Q: What is the difference between PUT and PATCH?**

A: PUT replaces the entire resource. The client sends a complete representation. PATCH applies a partial update, the client sends only the fields being changed. PUT is idempotent (calling it twice with the same body gives the same result). PATCH may not be idempotent (for example, PATCH to increment a counter).

**What FAANG expects**: name RFC 9110 as the governing spec for HTTP semantics, know that PUT is defined as idempotent even though many implementations violate this in practice, and mention JSON Patch (RFC 6902) or JSON Merge Patch (RFC 7396) as the two standard PATCH body formats.

Follow-ups:
- If a PATCH sends `{"email": null}`, does that clear the field or leave it unchanged? (Depends on which patch format you chose. JSON Merge Patch treats null as a delete. Plain partial-update JSON usually treats it as "set to null.")
- Can you make PATCH idempotent? (Yes, if the patch body is absolute rather than relative. `{"count": 5}` is idempotent. `{"count": {"$inc": 1}}` is not.)
- Why can't you use PUT to create a resource with a server-generated ID? (PUT targets a specific URI. If the server generates the ID, the client does not know the URI upfront. Use POST on the collection.)

**Q: When should you use 422 vs 400?**

A: 400 Bad Request is for requests that are syntactically malformed (invalid JSON, missing required headers, wrong content-type). 422 Unprocessable Entity is for requests that are syntactically valid but semantically invalid, the JSON parsed fine, but the `email` field does not contain a valid email address, or the referenced `product_id` does not exist.

**What FAANG expects**: know the current status of 422, because the folk answer is now out of date. 422 **originated** in WebDAV (RFC 4918), but RFC 9110 promoted it into core HTTP semantics as **422 Unprocessable Content** (Section 15.5.21), noting it was added "because of its general applicability." So "422 is a WebDAV code we borrowed" is no longer accurate, and saying it signals that your knowledge predates 2022. The useful distinction is that 400 means the request is malformed (bad syntax, unparseable JSON) while 422 means the syntax is fine but the content is semantically invalid (a well-formed JSON body with a negative `amount`). Some teams still collapse both into 400 because older client libraries handle it more consistently. The right answer remains "pick one convention and document it," while being prepared to explain that 422 is standards-track rather than a repurposed borrowing.

Follow-ups:
- Your validation layer finds three invalid fields. Do you return all three errors or just the first? (Return all, with a per-field error array. One round trip per error is a terrible DX.)
- A caller sends a POST that references a `customer_id` belonging to another tenant. 403 or 422? (403. Authorization failures are never validation errors, leaking them as 422 reveals the resource exists.)
- What status for "payment method declined"? (402 Payment Required, or 422 with a `code: card_declined`. Pick one and be consistent.)

**Q: What is idempotency and why does it matter in APIs?**

A: Idempotency means calling an operation multiple times has the same effect as calling it once. It matters because networks are unreliable, a client may not know if a request succeeded (did the server receive it and the response was lost, or did the server never receive it?). Without idempotency, retrying a payment on network failure causes a double charge. Idempotency keys solve this by allowing clients to safely retry.

**What FAANG expects**: name Stripe's design (client-generated UUID in `Idempotency-Key` header, server replays the original response within a TTL, typically 24 hours to 30 days), and be able to sketch the server-side state machine: lookup, lock, execute, store, replay.

Follow-ups:
- Two requests arrive concurrently with the same idempotency key. What happens? (One wins the lock and proceeds. The other returns 409 Conflict, because replaying a response that does not exist yet is worse than making the client retry.)
- The client reuses the same idempotency key for two semantically different payments. What does the server do? (Return the original response. It is the client's bug to use unique keys per intent. Some APIs hash the request body and return 422 on mismatch.)
- How do you size the idempotency store? (Per-merchant partition, TTL-based expiry in Redis or a dedicated Postgres table. Size = peak RPS * TTL * average response size. Budget accordingly.)

### Mid Level

**Q: How would you design pagination for a high-traffic API?**

A: I would use cursor-based pagination. Offset pagination has two critical problems: it causes "page drift" (items can appear on multiple pages or be skipped if the dataset changes between requests), and it requires the database to scan and discard rows (`OFFSET 10000` reads 10,000 rows to discard them). Cursor pagination uses the last seen row's sort key as an opaque token, enabling an efficient `WHERE (created_at, id) < (cursor_created_at, cursor_id)` query that uses an index. The cursor is base64-encoded JSON to keep it opaque to clients.

**What FAANG expects**: discuss the composite index design (`(created_at DESC, id DESC)` to break ties deterministically), reference Relay-style cursor connections as the GraphQL equivalent, and acknowledge when offset is acceptable (internal admin tools with small bounded datasets).

Follow-ups:
- How do you support "jump to page N"? (You do not, on a cursor API. Offer it only if the product truly needs it, and use a separate endpoint with offset semantics and documented O(N) cost.)
- The cursor encodes `(created_at, id)`. What if two rows share the same `created_at`? (The `id` breaks the tie. This is why you always include a unique tiebreaker column in the sort key.)
- A client wants to resume a paginated fetch tomorrow. Is the cursor still valid? (Only if your sort key values are immutable. If you sort by `updated_at`, the cursor is meaningless after edits. Document this explicitly.)

**Q: What constitutes a "breaking change" to a REST API?**

A: Removing or renaming fields, changing field types, changing error response formats, removing endpoints, changing HTTP method semantics, making optional fields required, changing authentication mechanisms, and changing the meaning of existing values. Non-breaking changes include adding new optional fields, adding new endpoints, adding new optional query parameters, and relaxing validation rules. Additive-only changes are safe, while subtractive or mutation changes are breaking.

**What FAANG expects**: mention Hyrum's Law (observable behavior becomes a contract whether or not it is documented), tools like `oasdiff` for automated detection, and the operational side: a `Sunset` header, per-version traffic telemetry, and a deprecation SLA measured in months not weeks.

Follow-ups:
- You add a new enum value to an existing field. Breaking or not? (Breaking for clients that switch on the enum without a default. Safe if clients are told upfront to treat unknown values as opaque. Document the policy in your style guide.)
- You fix a bug where a field was returning a wrong type. Breaking? (Yes. Hyrum's Law: someone depends on the buggy behavior. Ship the fix behind a version gate.)
- How do you detect breaking changes before the PR merges? (`oasdiff` in CI comparing `openapi.yaml` against `main`, failing on `ERR` severity. Combine with `spectral lint` for style violations.)

**Q: Explain the OAuth2 Authorization Code flow and when you'd use it.**

A: Authorization Code flow is used when a third-party application needs to act on behalf of a user without receiving their credentials. The app redirects the user to the authorization server, which authenticates the user and asks for consent. After consent, the server redirects back to the app with a short-lived authorization code. The app exchanges this code (plus its client secret) for access and refresh tokens server-side. The user's credentials never reach the app. I would use this whenever a user grants a third-party app access to their data, for example a fitness app accessing a user's health data from a health platform.

**What FAANG expects**: mention PKCE (RFC 7636) as mandatory for public clients and recommended for confidential ones, the `state` parameter for CSRF protection, and why the flow uses a code exchange rather than returning tokens directly in the redirect (to keep tokens out of browser history and referrer headers).

Follow-ups:
- When would you use Client Credentials instead? (Machine-to-machine with no user present. For example a backend job calling a partner's API on its own behalf.)
- Why does PKCE matter for mobile apps? (Mobile apps cannot keep a client secret. PKCE replaces the secret with a per-request code verifier, preventing authorization code interception on the device.)
- What is the difference between an ID token and an access token? (ID token: proof of authentication, OpenID Connect, JWT. Access token: authorization to call APIs, opaque or JWT, presented as a bearer token. They serve different purposes and should not be confused.)

### Senior Level

**Q: How would you design an API versioning strategy for a platform used by hundreds of clients?**

A: I would use Stripe's date-based versioning approach. Each version is a date (for example `2024-01-15`), set via an `API-Version` request header. New clients default to the latest version. Existing clients are pinned to their original version. All new endpoints appear in all versions. Breaking changes are introduced as new version dates. Clients migrate to newer versions explicitly. This means I maintain transformation logic (not separate code paths) per breaking version boundary. The overhead is manageable via a versioned response mapper pattern where each handler calls a mapper that adapts the output based on the requested version. I would also implement the `Sunset` header for deprecated versions, giving 12+ months notice before removal, and track per-version traffic to know when it is safe to sunset.

**What FAANG expects**: compare URL-path versioning (`/v1/`), header versioning, and media-type versioning (`Accept: application/vnd.example.v2+json`), explain why Stripe's model scales where URL versioning does not (because the application logic is single-tree with version-aware mappers), and quantify the cost: Stripe publicly says maintaining 10 years of backward compatibility has saved tens of millions in migration engineering.

Follow-ups:
- A new breaking change affects only 3 of 200 endpoints. Do you bump the version for all of them? (Yes. Version monotonicity beats granularity. Clients pin one version, not per-endpoint versions.)
- How do you test that a request on version `2020-01-01` produces the same response today as it did in 2020? (Golden-file contract tests per version, run on every PR. When someone changes the `2020-01-01` mapper, the test fails.)
- When is it finally safe to remove a version? (When per-version telemetry shows fewer than 0.1% of requests on that version for 30 consecutive days, and every remaining customer has been contacted personally. Not before.)

**Q: A client reports they're seeing duplicate payments. How would you debug and prevent this?**

A: First, check if idempotency keys are implemented. If not, that is the root cause, add idempotency key support. If idempotency is implemented, check if the client is sending the same key per intent (it should generate a new UUID per payment attempt, not reuse the same key). Review server logs for duplicate key lookups, are they hitting the idempotency store? Check for race conditions in the idempotency lock, if two requests arrive simultaneously with the same key, is there a distributed lock preventing both from proceeding? I would add metrics for idempotency hit rate, implement distributed locking via Redis with SETNX, and add integration tests that simulate concurrent duplicate requests.

**What FAANG expects**: separate the three failure modes (client not sending keys, client reusing keys, server race condition), describe the exact Redis primitives (`SET key value NX PX ttl`), and propose regression tests that spawn concurrent goroutines against a test server.

Follow-ups:
- The idempotency store returns the cached response for a duplicate request. But the payment genuinely failed the first time. Is that correct? (Yes. The contract is "same request, same response." A failed payment replayed returns the same failure, not a new attempt. Clients must generate a new idempotency key to retry a failed payment.)
- How do you prevent an attacker from guessing another merchant's idempotency keys? (Namespace the key by merchant ID or API key ID inside the store. Never trust the raw header as a global key.)
- What if the server crashes mid-request, after charging the card but before storing the idempotency record? (This is why idempotency storage must be part of the same transaction as the side effect. Write the record in the same database transaction as the charge, or use an outbox pattern.)

**Q: Design a rate limiting system for a multi-tenant API where different plans have different limits.**

A: I would implement a layered rate limiter backed by Redis. The layers are: a global IP rate limit (protect against DDoS regardless of auth), a per-API-key limit based on the plan tier (free: 100 req/min, pro: 1000 req/min, enterprise: 10,000 req/min), and per-endpoint limits for expensive operations (for example search: 10 req/sec). The check and the increment must be atomic, which means a Lua script rather than a read followed by a write, or two replicas both observe "under the limit" and both admit.

Be precise about which algorithm you are naming, because interviewers listen for this. `INCR` plus a TTL is a **fixed window** counter, not a sliding window: it is O(1) and trivially correct, and it admits up to 2x the limit across a window boundary (10 requests at 0:59 and 10 more at 1:01 against a 10/min limit). A true sliding window needs either a sorted set of timestamps (exact, O(n) memory per key) or the weighted two-counter approximation (O(1), and what most people mean by "sliding window counter"). Token bucket is a third thing again, and it is the right pick when you want to *allow* bursts up to a configured ceiling rather than smooth them away. Say which one you chose and why, rather than using the terms interchangeably.

The middleware reads the auth context for the plan tier, applies the appropriate limits, and emits the IETF draft headers on every response: `RateLimit-Policy: "pro";q=1000;w=60` and `RateLimit: "pro";r=997;t=42`, where `t` is seconds remaining rather than a timestamp. On a 429, add `Retry-After`. Limits live in a config service backed by the tenant/subscription table and cached with a 60-second TTL, so a plan upgrade takes effect without a deploy.

**What FAANG expects**: compare fixed-window, sliding-window, and token-bucket algorithms with honest trade-offs (fixed-window is cheapest but allows 2x burst at window boundaries, sliding-window is most accurate but most expensive, token-bucket is the usual pragmatic choice), and mention distributed correctness (use Lua scripts on Redis to make the check-and-increment atomic, avoiding race conditions between replicas).

Follow-ups:
- Your Redis cluster has a 50ms p99 latency. Is that acceptable in the request path? (Not really. For a 200ms SLO it is 25% of your budget. Solutions: use local token buckets that sync periodically with Redis, or accept eventual consistency at the edge.)
- A customer argues they were rate-limited unfairly during a burst. How do you prove or disprove it? (Log the rate limit decision with key, limit, remaining, and window at the time of decision. Without that audit trail, you cannot answer the question.)
- How do you avoid the "noisy neighbor" problem where one tenant exhausts shared infrastructure even while staying under their rate limit? (Per-tenant concurrency limits in addition to rate limits, and queue isolation. Rate limits control request arrival. Concurrency limits control in-flight work.)

---

### Junior → FAANG: How to Use Interview Questions as a Study Framework

Reading interview Q&A is not the same as preparing for the interview. The difference is active recall and depth-of-explanation practice.

**Prerequisite gaps to close**

Before attempting any of the senior-level questions, be fluent in these fundamentals: HTTP method semantics (RFC 9110), OAuth2 grant types (RFC 6749), cursor pagination mechanics, and the idempotency key lifecycle. If you stumble on any of those in a FAANG phone screen, the conversation rarely recovers.

Hyrum's Law is referenced in the breaking-changes question but deserves its own study moment. It states that every observable behavior of a system eventually becomes a dependency for someone. This means your API's bugs can become contracts. FAANG engineers cite this by name, and knowing it signals breadth.

**Worked example: practicing with the PUT vs PATCH question**

Do not just read the answer. Close the page and answer the question aloud. Then compare. Pay attention to what you left out. In a real interview, the follow-up questions arrive faster than you expect. Practice answering the follow-ups too: "Can PATCH be idempotent?" requires a concrete example, not just "yes." Say: "If the body is `{\"status\": \"canceled\"}`, calling it twice produces the same state. That is idempotent. If the body is `{\"counter\": {\"$inc\": 1}}`, calling it twice increments twice. That is not idempotent."

**First-job habits built from interview prep**

The pagination follow-up about "why can't you support jump to page N?" is a real product conversation you will have early in your career. The correct professional answer is: "We can, but with documented O(N) cost and a separate endpoint." Knowing the trade-off lets you give a reasoned recommendation instead of guessing.

The 422 vs 403 question on cross-tenant resource access is a pattern that recurs constantly in multi-tenant SaaS. Returning 422 for an authorization failure leaks existence information. Burn this into memory: authorization failures are always 403 or 404, never 422.

**Interview entry-point framing**

For entry-level roles, you will face the junior questions. For L5 roles, expect the mid-level questions and at least one senior question as a stretch probe. Prepare your answers at one level above your target role. If you target L5, prepare L6-quality answers. The bar is rising and preparation depth is the differentiator.

---

### Senior @ FAANG: Deconstructing What Bar-Raisers Actually Measure

The interview questions in this section are not knowledge tests. They are reasoning probes. A bar-raiser is not checking whether you know that `oasdiff` exists. They are checking whether you think systematically about API evolution, operational risk, and platform-scale implications.

**The versioning question: what L6 candidates say differently**

A strong L5 answer names Stripe's date-based versioning and explains header vs URL versioning. An L6 answer goes further on three dimensions.

First, it quantifies the maintenance cost model. Version-aware response mappers grow linearly with the number of breaking changes, not with the number of versions. That is a crucial property. If you introduce 5 breaking changes per year, you accumulate 5 mappers per endpoint per year. Most endpoints change far less often. The cost is manageable.

Second, it addresses the organizational contract. Every breaking change that creates a new version must be logged in a public changelog with a migration guide, a sunset date for the previous version, and a migration support commitment measured in engineer-weeks. The changelog is not a courtesy. It is a contractual obligation to partners who have SLAs with their own customers that depend on your API.

Third, it covers the detection layer. Automated detection via `oasdiff` in CI is table stakes. The L6 answer also includes per-version traffic telemetry in your observability stack, so you know when a version's traffic drops to safe-to-sunset levels. Without that telemetry, the sunset decision is political rather than data-driven.

**The duplicate payments question: the three-failure-mode taxonomy**

The failure modes matter more than the solution. Weak candidates propose Redis idempotency keys as the answer. Strong candidates enumerate the modes first: (1) client not sending keys, (2) client reusing keys across different payment intents, (3) server race condition between concurrent requests with the same key, (4) server crash after charge but before idempotency record written. The Redis solution addresses modes 1 and 3. Mode 4 requires the outbox pattern or transactional idempotency storage. Mode 2 is a client-side education and SDK design problem.

A bar-raiser will ask about mode 4. If you have not thought about it, you have not thought about it deeply enough. The answer involves either writing the idempotency record atomically with the charge in a database transaction, or using an outbox where the worker only commits the charge outcome and the idempotency record together. The key insight is that the idempotency guarantee cannot be stronger than your weakest atomic boundary.

**The rate limiting question: algorithm selection as an ADR**

At L6, the rate limiting answer is an architecture decision record, not an algorithm description. The decision criteria are: accuracy requirement (does the client care if we allow a 2x burst at a window boundary?), infrastructure cost (Redis Lua scripts add 1-3ms to every request), consistency requirement (is per-replica eventual consistency acceptable, or must limits be globally exact?), and operability (can the on-call engineer understand and adjust limits without a code deploy?).

For most APIs, token bucket with per-replica eventual consistency is the right call because it is cheap, understandable, and the burst tolerance it allows is acceptable. For financial transaction limits (fraud prevention), you need globally exact counts, which requires a centralized store and the associated latency cost. Know when to pay that cost and when not to.

The noisy-neighbor follow-up surfaces a distinction that junior engineers miss: rate limits control request arrival rate, but they do not control concurrency. A tenant that stays under their 1,000 req/min limit can still saturate your database connection pool if they send all 1,000 requests in the same second, each holding a connection for 500ms. Concurrency limits (`semaphore.Weighted` in Go) are the complementary control. Govern both.

**Governance signals bar-raisers look for**

Across all three senior questions, bar-raisers are looking for: (1) you mention telemetry and observability before being asked, (2) you frame decisions as ADRs with explicit trade-offs rather than "the right answer," (3) you think about the operational experience of the teams consuming and maintaining the API, not just the code correctness, and (4) you identify the failure modes that exist below the happy-path surface. These signals separate candidates who will make good architectural decisions under ambiguity from those who execute well-defined tasks cleanly.