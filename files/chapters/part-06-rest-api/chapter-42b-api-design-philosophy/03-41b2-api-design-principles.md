## 42B.2 API Design Principles

### Consistency

Consistency is the most impactful API design quality. A consistent API is learnable: once you understand one part, you understand the rest.

**Naming consistency**:
```
# Bad: mixed conventions
GET /getUser/{id}
POST /create_order
DELETE /products/{id}/removeTag
PATCH /UpdateUserEmail

# Good: consistent nouns, plural, lowercase-hyphenated
GET  /users/{id}
POST /orders
DELETE /products/{id}/tags/{tag_id}
PATCH /users/{id}
```

**Response shape consistency**:
```go
// Every list endpoint returns the same envelope
type ListResponse[T any] struct {
    Data       []T            `json:"data"`
    Pagination PaginationMeta `json:"pagination"`
}

type PaginationMeta struct {
    Total      int    `json:"total"`
    Page       int    `json:"page"`
    PerPage    int    `json:"per_page"`
    NextCursor string `json:"next_cursor,omitempty"`
}

// Every single-resource endpoint returns the same envelope
type SingleResponse[T any] struct {
    Data T `json:"data"`
}
```

**Error format consistency**:

Errors should follow a single shape across every endpoint. Two standards dominate modern API design, and both are worth knowing:

- **RFC 9457 Problem Details** (July 2023, which **obsoletes** RFC 7807 rather than merely updating it: cite 9457, not 7807). The IETF standard. `Content-Type: application/problem+json`. Fields: `type` (URI), `title`, `status`, `detail`, `instance`, plus custom extensions.
- **Stripe-style errors**. The de facto standard for commercial APIs. Pragmatic extensions like `code`, `param`, and `doc_url` that RFC 9457 does not mandate.

A hybrid is common: RFC 9457 compliant on the wire, with Stripe-style extension fields for machine-readable codes and documentation links.

```go
// RFC 9457 compliant, with pragmatic extensions.
// Serve as Content-Type: application/problem+json.
type APIError struct {
    Type     string            `json:"type"`              // URI identifying the error class
    Title    string            `json:"title"`             // short human summary (stable)
    Status   int               `json:"status"`            // HTTP status
    Detail   string            `json:"detail,omitempty"`  // specifics for this occurrence
    Instance string            `json:"instance,omitempty"`// URI of this occurrence
    // Extensions (Stripe-style, machine-readable)
    Code     string            `json:"code,omitempty"`    // e.g. "card_declined"
    Param    string            `json:"param,omitempty"`   // offending field
    Details  map[string]string `json:"details,omitempty"`
    DocURL   string            `json:"doc_url,omitempty"` // correction guidance
}
```

Errors should include correction guidance. "The `amount` field must be a positive integer in the smallest currency unit (for example, 2000 for USD $20.00)" is ten times more useful than "invalid amount." The `doc_url` field carries the rest.

**Timestamp consistency**:
```
# Always ISO 8601, always UTC, always the same field names
{
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T11:00:00Z"
}
```

### Predictability

Your API should do what users expect. Surprises are bugs, even when they are documented.

**HTTP method semantics**: GET should be safe (no side effects). PUT should be idempotent (calling it twice has the same effect as calling it once). POST is for non-idempotent creation. These are not opinions, they are defined normatively by RFC 9110 (HTTP Semantics, June 2022, the current HTTP baseline). Violating these contracts breaks caches, proxies, retrying clients, and every reader of your traffic.

**Status code semantics**: `200 OK` means success with a body. `201 Created` means a resource was created, `Location` header has the URI. `204 No Content` means success with no body. Using `200` for everything is unpredictable.

**Null vs absent fields**: Pick one convention and stick to it. Returning an explicit `null` for optional fields that are not set means clients can always reach for the field and simply check for `null`. Omitting the field entirely is equally valid, but the two must not be mixed within one API. In Go this choice has a direct consequence: `omitempty` silently drops zero values, so a `Count int` field with `omitempty` disappears when it is legitimately 0, and a client that expected the key sees absence where it should have seen zero. If your convention is "always present," use pointers or drop `omitempty`, and let the linter enforce it rather than hoping reviewers catch it.

**Array vs null**: When a list is empty, return `[]`, not `null`. This is the single most common API "bug" that breaks client code.

### Simplicity

Simple to start. Powerful when needed.

The 80/20 rule of API design: 80% of use cases should be achievable with the simplest possible call. The other 20% (advanced filtering, field selection, bulk operations) should be available but not required.

```
# Simple: just works
GET /orders

# Powerful: available when needed
GET /orders?status=pending&created_after=2024-01-01&sort=-created_at&fields=id,status,total&cursor=abc123&limit=50
```

### Robustness: Postel's Law

"Be conservative in what you send, be liberal in what you accept."

Practical implications:

- Accept both `application/json` and `application/x-www-form-urlencoded` for POST bodies
- Accept both `user_id` and `userId` in query params (normalize internally)
- Ignore unknown fields in request bodies instead of returning 400
- Accept both `true` and `"true"` and `1` for boolean fields

```go
// Robust boolean parsing
func parseBool(v any) (bool, error) {
    switch val := v.(type) {
    case bool:
        return val, nil
    case string:
        return strconv.ParseBool(val)
    case float64:
        return val != 0, nil
    default:
        return false, fmt.Errorf("cannot parse %T as bool", v)
    }
}
```

### Composable Primitives

Great APIs expose small, orthogonal primitives that compose into workflows, rather than one giant endpoint per use case. Stripe's `PaymentIntent` + `PaymentMethod` + `Customer` compose into subscriptions, one-off charges, saved-card flows, and SCA-compliant 3DS without the API surface growing per feature. Twilio's `Message`, `Call`, and `Conference` resources compose into IVR flows.

The heuristic: if adding a new customer use case forces a new bespoke endpoint, your primitives are too coarse. If the same use case can be expressed by combining existing resources in a new order, they are the right size.

> **Senior track**: Consistency beats cleverness. If you find yourself defending a design choice with "but this case is special," you are almost always wrong. Clients have to hold your whole API in their head. A uniform, predictable surface, even a slightly suboptimal one, outperforms a collection of individually clever endpoints.

### Evolvability

Design for change from day one.

- Use versioning from the start, even if you only have v1
- Make all new fields optional with sensible defaults
- Use string enums instead of integer enums (easier to add values)
- Prefer additive changes: add fields, never remove or rename
- Document which fields are stable vs experimental

### Junior → FAANG: Applying Design Principles When the Codebase Fights Back

The principles in this section are easy to agree with and hard to follow when you are under deadline pressure and the existing codebase is inconsistent. Here is how to handle each gap concretely.

**Consistency under inconsistency.** When you join a team whose existing API mixes `camelCase` and `snake_case` field names, your job is not to immediately standardize everything. That is a breaking change. Your job is to be consistent within any new surface you add, document the inconsistency as a known issue in the API changelog, and propose a migration path when you have credibility. The interview question version: "You've joined a team with an inconsistent API. What do you do?" Wrong answer: "I'd refactor it." Right answer: "I'd establish a new convention for new endpoints, lint-enforce it in CI, document the existing inconsistency, and propose a versioned migration plan."

**Postel's Law in practice.** The robust boolean parser in this section is a real pattern. Build the habit of writing input normalization as a separate layer from validation. Normalization accepts the liberal input Postel's Law describes. Validation rejects what cannot be normalized. Keep them separate so each is testable independently.

**String enums vs integer enums.** This is a frequent interview question disguised as a trivial choice. String enums (`"pending"`, `"processing"`, `"completed"`) are self-documenting in logs, safe to add values to without breaking existing clients (they just ignore the unknown value if you handle that case), and readable in database queries. Integer enums (`1`, `2`, `3`) require a lookup table to interpret, break clients that do exhaustive matching when you add a value, and are meaningless in a log line. Always use strings.

**Evolvability first-job habit.** On your first day working on an API, check whether new fields added in the last six months are marked as stable or experimental. If they are not, that is technical debt you can address immediately: add an `x-stability` OpenAPI extension to the spec and propose that the team adopts it for new fields going forward. This is the kind of small, high-signal contribution that gets noticed in code review.

### Senior @ FAANG: Consistency and Evolvability as Platform-Level Contracts

At staff level, the design principles in this section are not guidelines for individual engineers. They are contracts that must be enforced systematically. Each principle has a governance implementation.

**Consistency enforcement via shared Spectral rulesets.** A shared Spectral ruleset in the organization's internal registry encodes naming conventions, response envelope shapes, error format requirements, timestamp formats, and pagination shape constraints. Every API repo runs Spectral in CI against this shared ruleset. Teams can add local rules but cannot override shared ones without a governance review. The staff engineer owns the shared ruleset, not individual API designs.

The ruleset is versioned using semantic versioning. A new required rule is a major version bump (teams must opt in with a migration window). A new recommended rule is a minor bump (teams get a warning, not a failure). This models the same evolvability principle the API itself follows: additive changes are non-breaking, required changes need coordination.

**Composable primitives as an architectural forcing function.** The heuristic "if a new use case requires a new bespoke endpoint, your primitives are too coarse" is easy to state but hard to enforce. The governance mechanism: in API design review, for every proposed new endpoint, the reviewer asks "which combination of existing primitives would satisfy this use case, and why is that combination insufficient?" If no satisfactory answer exists, the endpoint is approved. If a satisfactory combination exists, the endpoint is rejected in favor of documentation showing the composition pattern.

This forces API surface area to grow at the pace of genuinely novel requirements, not at the pace of "we need a new use case and creating an endpoint is easier than reading the docs."

**Evolvability and the stability contract as an ADR.** The evolvability bullet points in this section describe practices. A staff engineer turns them into an ADR that answers: what is the organization's versioning policy, what counts as a breaking change, what is the sunset timeline for deprecated fields, and how do consumers know which fields are stable versus experimental? Without a written ADR, these decisions are made inconsistently per team and per engineer.

The stability taxonomy for an ADR: `stable` (field will not be removed or renamed without a major version bump and a minimum 12-month sunset period), `beta` (field may change with 90-day notice), `experimental` (field may change or be removed with no notice, use only in non-production). The OpenAPI extension `x-stability: stable|beta|experimental` makes this machine-readable for SDK generators and documentation tools.

**Bar-raiser signal on consistency.** In a design review or interview, the L6+ signal on consistency is not "I would use snake_case." It is "I would encode the convention in the Spectral ruleset, generate types from the OpenAPI spec so the compiler enforces the shape, and add a contract test that fails if the response shape diverges from the spec." The consistency principle enforced by automation is worth more than the same principle enforced by discipline.

---
