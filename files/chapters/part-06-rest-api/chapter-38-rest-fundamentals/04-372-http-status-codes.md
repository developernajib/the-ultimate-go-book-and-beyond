## 38.2 HTTP Status Codes

### Status Code Categories

The authoritative reference is RFC 9110 (HTTP Semantics, 2022), which obsoleted RFC 7231 and consolidated the HTTP spec across HTTP/1.1, HTTP/2, and HTTP/3. The status code decision tree in the architecture diagram above covers the most common cases. Use the `net/http` constants directly (`http.StatusOK`, `http.StatusCreated`, etc.), there is no need to re-alias them.

### When to Use Each Code

**2xx Success**

| Code | Constant | Use when |
|------|----------|----------|
| 200 | `StatusOK` | GET succeeded and a body is returned. PUT/PATCH succeeded and updated representation is returned. |
| 201 | `StatusCreated` | A new resource was created. Always set the `Location` header to the new resource's URL. |
| 202 | `StatusAccepted` | Request accepted for asynchronous processing. Return a job URL the client can poll. |
| 204 | `StatusNoContent` | Success with no body (typical for DELETE, or PUT/PATCH when the client already has the state). |

**4xx Client Errors**

| Code | Constant | Use when |
|------|----------|----------|
| 400 | `StatusBadRequest` | Syntactically malformed request (invalid JSON, missing required header). |
| 401 | `StatusUnauthorized` | Authentication is missing or invalid. Must include a `WWW-Authenticate` header per RFC 9110. |
| 403 | `StatusForbidden` | Authenticated, but the principal lacks permission for this resource. |
| 404 | `StatusNotFound` | Resource does not exist (or you want to hide its existence from unauthorized users). |
| 409 | `StatusConflict` | State conflict: duplicate email on create, version mismatch on update, ETag precondition failure on PUT. |
| 422 | `StatusUnprocessableEntity` | Request is well-formed JSON but fails domain validation (e.g., `email` field is not a valid email). |
| 429 | `StatusTooManyRequests` | Rate limit exceeded. Include `Retry-After` and `X-RateLimit-*` headers. |

**5xx Server Errors**

| Code | Constant | Use when |
|------|----------|----------|
| 500 | `StatusInternalServerError` | Generic "we broke it": unhandled exception, programmer error. Do not leak stack traces. |
| 502 | `StatusBadGateway` | Upstream returned an invalid response (API gateway/proxy scenario). |
| 503 | `StatusServiceUnavailable` | Service is down or intentionally shedding load. Include `Retry-After`. |
| 504 | `StatusGatewayTimeout` | Upstream timed out while this service was waiting on it. |

The classic mistake is collapsing 401/403 ("who are you?" vs. "I know who you are, you are not allowed") and 400/422 ("I could not parse this" vs. "I parsed it, the data is invalid"). Keep them distinct: logs, dashboards, and client retry logic all depend on the distinction.

### Error Response Structure

A consistent error envelope gives API consumers a machine-readable `code` they can branch on (e.g., `VALIDATION_ERROR` vs. `RATE_LIMITED`) without parsing the human-readable `message`, which may change between releases. The optional `details` slice lets a single 422 response report every invalid field in one round-trip rather than forcing clients into a request-fix-retry loop. Including `trace_id` in the response body ties the client-visible error directly to the server-side log entry, dramatically reducing mean time to diagnose production incidents.

```go
// ... imports omitted for brevity (encoding/json, net/http)

// APIError represents a standard error response
type APIError struct {
    Status  int           `json:"status"`
    Code    string        `json:"code"`
    Message string        `json:"message"`
    Details []ErrorDetail `json:"details,omitempty"`
    TraceID string        `json:"trace_id,omitempty"`
}

type ErrorDetail struct {
    Field   string `json:"field,omitempty"`
    Code    string `json:"code"`
    Message string `json:"message"`
}

// Common error codes
const (
    ErrCodeValidation    = "VALIDATION_ERROR"
    ErrCodeNotFound      = "NOT_FOUND"
    ErrCodeUnauthorized  = "UNAUTHORIZED"
    ErrCodeForbidden     = "FORBIDDEN"
    ErrCodeConflict      = "CONFLICT"
    ErrCodeRateLimited   = "RATE_LIMITED"
    ErrCodeInternal      = "INTERNAL_ERROR"
)

func WriteError(w http.ResponseWriter, status int, code, message string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(APIError{Status: status, Code: code, Message: message})
}

// Example validation error response:
// {
//   "status": 422,
//   "code": "VALIDATION_ERROR",
//   "message": "Validation failed",
//   "details": [
//     {"field": "email", "code": "INVALID_FORMAT", "message": "Invalid email format"},
//     {"field": "name", "code": "REQUIRED", "message": "Name is required"}
//   ]
// }
```

### RFC 9457 Problem Details (application/problem+json)

If you are building a new public API, prefer the IETF-standard error format defined in **RFC 9457, Problem Details for HTTP APIs** (July 2023, obsoletes RFC 7807). It gives your consumers a single schema they already know from dozens of other APIs, and it sets `Content-Type: application/problem+json` so clients and proxies can distinguish error bodies from success bodies at the transport layer.

The standard members are:

- `type`: a URI that identifies the problem type (human-readable docs live there).
- `title`: a short, human-readable summary (should not change per occurrence).
- `status`: the HTTP status code, duplicated in the body for logging pipelines that only see the body.
- `detail`: human-readable explanation specific to this occurrence.
- `instance`: a URI (often the request path or a trace ID) identifying this specific occurrence.

Extension members (any additional fields) are explicitly allowed, so put your domain-specific data like `errors[]` or `trace_id` there.

```go
// ProblemDetails implements RFC 9457.
type ProblemDetails struct {
    Type     string         `json:"type"`
    Title    string         `json:"title"`
    Status   int            `json:"status"`
    Detail   string         `json:"detail,omitempty"`
    Instance string         `json:"instance,omitempty"`
    // Extensions:
    Errors   []ErrorDetail  `json:"errors,omitempty"`
    TraceID  string         `json:"trace_id,omitempty"`
}

func WriteProblem(w http.ResponseWriter, r *http.Request, p ProblemDetails) {
    if p.Type == "" {
        p.Type = "about:blank" // RFC 9457 default
    }
    if p.Instance == "" {
        p.Instance = r.URL.Path
    }
    w.Header().Set("Content-Type", "application/problem+json")
    w.WriteHeader(p.Status)
    _ = json.NewEncoder(w).Encode(p)
}

// Example validation response body:
// {
//   "type": "https://api.example.com/problems/validation",
//   "title": "Your request parameters did not validate.",
//   "status": 422,
//   "detail": "The 'email' field is not a valid email address.",
//   "instance": "/api/v1/users",
//   "errors": [
//     {"field": "email", "code": "INVALID_FORMAT", "message": "Invalid email format"}
//   ],
//   "trace_id": "abc123"
// }
```

Teams with an established custom envelope (Stripe-style `{error: {code, message}}`) usually keep it for consistency with existing SDKs. New services without that constraint should ship Problem Details from day one.

### Junior → FAANG: the status codes you will be asked about in every screen

Status codes look like trivia. They are actually a proxy for "does this candidate understand HTTP." Memorize the list below and you will pass the status-code portion of any backend interview.

200 OK for successful reads and for PUT/PATCH when you return the updated resource. 201 Created for POST that created a resource, with a `Location` header pointing at the new URL. 202 Accepted for async work that will complete later. 204 No Content for successful deletes and for updates when you do not return a body. 301 Moved Permanently for URL changes you want cached forever. 304 Not Modified when `If-None-Match` matches the current `ETag`. 400 for malformed syntax. 401 for missing or invalid credentials. 403 for authenticated but not authorized. 404 for not found (or to hide existence). 409 for state conflict. 422 for validation failure on a parsed body. 429 for rate limit. 500 for server bug. 503 for overload or maintenance.

The traps that separate juniors from seniors. Returning 200 with `{"error":"..."}` is wrong because caches, SDKs, and middleware cannot detect it. Returning 500 for a validation error is wrong because it pages the on-call. Returning 404 before 401 leaks resource existence. Returning 401 without `WWW-Authenticate` violates RFC 9110. Returning 201 without `Location` ignores an RFC 9110 SHOULD and breaks clients that follow it. Returning 429 without `Retry-After` forces clients to guess a backoff. Learn these six and you are ahead of most candidates.

Worked example. "Design the response for a duplicate-email signup." The junior answer is 400. The better answer is 422 if the email parsed but failed the uniqueness rule, or 409 if you model the collision as a state conflict on the users collection. The best answer picks one, documents it, and is consistent platform-wide. The worst answer is 200 with `{"error":"email taken"}`, which is unfortunately the most common real-world shipping code.

A concrete upgrade to the `WriteError` function above. Add a `trace_id` field read from the request context (injected by the observability middleware), log the server-side error with the same trace id, and return the trace id to the client in both the body and an `X-Trace-Id` header. When a user reports "I got error 422," support can grep one trace id and find the full request, response, downstream calls, and SQL queries in under a minute. Without this, support takes hours.

Entry-point interview question. "A user sends a GET with `If-None-Match: "abc"`. The current resource has ETag `"abc"`. What do you return." The answer is 304 Not Modified, no body, and the `ETag` header echoed. Bonus points if you mention that `Cache-Control` and `Vary` should also be present on the 304. This is the most common "can you actually read RFC 9110" probe.

### Senior @ FAANG: status-code governance, the 409 vs 422 debate settled, and async semantics

Status-code choices feel local. They are actually platform governance. A single service that returns 500 for validation errors poisons the SLO for every service behind the same gateway because the gateway's error-rate dashboard aggregates `status_class=5xx`. Fix it once at the platform level.

The 4xx vs 5xx taxonomy is the single most important line to draw. 4xx means "the client sent something this server will never accept." 5xx means "the server failed to handle a request it should have accepted." The operational consequence is that 5xx pages on-call and counts against the SLO error budget, 4xx does not. A classification mistake is expensive both ways. A 4xx that should be 5xx hides real bugs (the silent-failure class). A 5xx that should be 4xx burns error budget and causes alert fatigue. The staff-level control is a typed error hierarchy in the service layer and a single mapper at the handler boundary. Never let individual handlers pick status codes by hand.

The 409 versus 422 debate is the one that never dies. The defensible split is straightforward once you pick a mental model. 422 is "the payload parsed as JSON but violated a business rule that only depends on the payload" (invalid email format, negative quantity, unknown enum value). 409 is "the payload is fine in isolation but conflicts with current server state" (email already taken, optimistic concurrency mismatch, duplicate idempotency key with a different body, resource in wrong lifecycle state). 400 is reserved for "the payload is not even well-formed JSON or violates the Content-Type." Write this in your style guide and enforce it in code review. The anti-pattern is using 400 for everything, which is what frameworks default to and what clients cannot distinguish.

202 Accepted is the underused status code. For any operation that takes longer than a few hundred milliseconds (file processing, bulk import, email delivery, ML inference), 202 is the correct response. The required companions are a `Location` header or a body field pointing at the operation resource (`/operations/{id}`), and a documented polling contract (`GET /operations/{id}` returns `{status, progress, result_url}`). Google's AIP-151 is the canonical reference for long-running operations. Without 202, clients hold HTTP connections open for minutes, your LB timeout kills them, and you build a queue of zombie requests. The senior answer to "should this be synchronous" is almost always "no, return 202."

Idempotency status codes deserve explicit treatment. When a client sends `Idempotency-Key: abc123` and the key matches a previous successful request, the correct response is the original status code with an added `Idempotent-Replayed: true` header. If the key matches a previous request but the body differs, return 422 with a specific code (`idempotency_key_reuse`) because replaying with a different body is a client bug. If the original request is still in flight, return 409 with `Retry-After`. These three cases are the failure modes the IETF draft-ietf-httpapi-idempotency-key-header codifies.

RFC 9457 Problem Details is the correct default in 2026. The extension fields your platform must standardize are `trace_id` (W3C trace id), `code` (stable machine-readable string that clients switch on), `errors` (array of per-field validation errors with `pointer` per RFC 6901 JSON Pointer), `retry_after` (integer seconds, duplicating the header for clients that cannot read headers), and `doc_url` (URL to human documentation for this error class). Do not invent ad-hoc fields per service. Publish a JSON Schema for your Problem Details and lint OpenAPI specs against it.

Deprecation and sunset signaling. RFC 8594 defines the `Sunset` header (`Sunset: Sat, 31 Dec 2026 23:59:59 GMT`) and RFC 9745 defines the `Deprecation` header (`Deprecation: @1717200000`). Emit both on any endpoint scheduled for removal, along with a `Link: <https://docs.example.com/migrations/v1-to-v2>; rel="deprecation"` pointing at migration docs. The gateway can strip and aggregate these headers into a "deprecated API usage by consumer" dashboard, which is how you know who needs a nudge before shutoff.

Rate limiting response design. 429 is the status. The `Retry-After` header is mandatory (integer seconds or HTTP-date). The `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` triple is the de-facto standard but is also being formalized in IETF draft-ietf-httpapi-ratelimit-headers, whose recent drafts consolidate to structured `RateLimit` and `RateLimit-Policy` fields. In 2026 emit both during the transition window. The algorithmic choice (token bucket, sliding window log, sliding window counter, leaky bucket) affects the semantics of `Remaining` and must be documented. GitHub publishes this, and every serious public API should.

5xx taxonomy matters more than juniors realize. 500 is "we had an unhandled error, probably a bug." 502 is "we called an upstream and got nonsense back." 503 is "we are intentionally shedding or under maintenance, retry later," and it must include `Retry-After`. 504 is "we called an upstream and it timed out." These four codes route through different alerting policies. 500 pages on-call immediately. 503 is expected during deploys and load shedding. 502/504 page only if sustained. Classify correctly and your on-call rotation becomes tolerable.

Health check endpoint status codes are a separate contract. `/livez` returns 200 if the process is alive and can be 503 if it wants to be killed (rarely useful). `/readyz` returns 200 if the service can handle traffic, 503 if it cannot (dependency down, warming up, shutting down). Kubernetes uses these to decide whether to send traffic and whether to restart. Do not return 200 from readiness while the database is down, or traffic will pour into a broken service.

The testing contract for status codes. Every error path must have a unit test that asserts the status, the `Content-Type`, the Problem Details `type` and `code`, and the presence of `trace_id`. Table-driven tests are the idiomatic Go pattern. Contract tests (Pact, schemathesis) verify the client's expected status set against the served spec. Fuzz tests at the gateway level feed random payloads and assert that every response is 4xx or 5xx with a valid Problem Details body, never a panic, never an empty body, never `text/plain`. Without these tests you will ship a 500 for a missing field the day before Black Friday.

One last lever. Do not leak information via status codes. A 404 for a resource the caller is not allowed to see is correct (and better than 403, which confirms existence). A 500 that includes a stack trace in the body is a security incident. A 400 that echoes the raw input back unsanitized is an XSS reflection vector. The middleware that writes error responses must sanitize, truncate, and strip sensitive fields before serialization. This is the kind of default a senior engineer sets once for the whole platform, not per service.

---
