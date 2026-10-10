## 41.8 Common Mistakes and How to Avoid Them

### Mistake 1: Breaking Changes Without Version Bump

Renaming `name` to `first_name` and `last_name` in the same version silently breaks every client that deserializes the `name` field, a change they cannot detect without reading response bodies on every deploy. The safe approach adds the new fields with `omitempty` alongside the original field in v1, then reserves the field removal for a new major version.

```go
// ❌ Wrong: Breaking changes in existing version
// v1 originally returned:
type UserV1Old struct {
    Name string `json:"name"`
}

// Changed without version bump (BREAKS clients):
type UserV1New struct {
    FirstName string `json:"first_name"`
    LastName  string `json:"last_name"`
}

// ✅ Correct: Add fields additively, version for breaking changes
// v1 stays backwards compatible:
type UserV1 struct {
    Name      string `json:"name"`                   // Original field
    FirstName string `json:"first_name,omitempty"`   // New field (additive)
    LastName  string `json:"last_name,omitempty"`    // New field (additive)
}

// v2 makes breaking change:
type UserV2 struct {
    FirstName string `json:"first_name"` // Required in v2
    LastName  string `json:"last_name"`  // Required in v2
    // name field removed: breaking change, hence new version
}
```

### Mistake 2: Versioning Individual Endpoints

Per-endpoint versioning forces clients to track a compatibility matrix: which version of users works with which version of posts, and whether comments v2 is compatible with the other endpoints they are using. Versioning the entire API surface together maintains a cohesive contract: clients on v2 know every endpoint is v2.

```go
// ❌ Wrong: Per-endpoint versioning creates chaos
// /api/users/v1
// /api/users/v2
// /api/posts/v1
// /api/posts/v3 (skipped v2?)
// /api/comments/v2

// Clients don't know which versions are compatible

// ✅ Correct: Version the entire API together
// /api/v1/users
// /api/v1/posts
// /api/v1/comments

// /api/v2/users
// /api/v2/posts
// /api/v2/comments

// All v2 endpoints work together as a cohesive unit
```

### Mistake 3: No Deprecation Warning Period

`DeprecationSchedule` encodes the four-phase timeline as struct fields, and the middleware below enforces the two phases that are purely mechanical: emit warning headers once `DeprecationStart` has passed, and return `410 Gone` after `SunsetDate`. The other two phases are deliberately not in this middleware. `NotificationStart` drives an out-of-band email job, not a response header, and `RateLimitStart` belongs in your rate limiter's configuration, where the per-version budget lives. Encoding all four dates in one struct is still worth it, because the schedule becomes a single reviewable object that the middleware, the notification job, and the rate limiter all read from rather than three systems with three copies of the date.

Computing `daysRemaining` dynamically means the header stays accurate without a redeploy, and it cannot go negative here because the sunset branch returns first.

```go
// ❌ Wrong: Sudden removal
// Monday: /api/v1 works
// Tuesday: /api/v1 returns 410 Gone
// Result: All v1 clients broken!

// ✅ Correct: Gradual deprecation with warnings
type DeprecationSchedule struct {
    // Phase 1: Add deprecation headers (6+ months before sunset).
    // Continue serving normally, add warning headers. Enforced by the
    // middleware below.
    DeprecationStart time.Time

    // Phase 2: Email notifications (3+ months before sunset).
    // Read by the out-of-band notification job, not by the middleware:
    // a response header cannot send an email.
    NotificationStart time.Time

    // Phase 3: Rate limit deprecated version (1 month before).
    // Read by the rate limiter's per-version budget config, not here.
    RateLimitStart time.Time

    // Phase 4: Sunset.
    // Return 410 Gone with migration information. Enforced below.
    SunsetDate time.Time
}

func (d *DeprecationSchedule) GetMiddleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            now := time.Now()

            if now.After(d.SunsetDate) {
                ErrorResponse(w, 410, "GONE",
                    "This API version has been sunset. Please migrate to v2.")
                return
            }

            if now.After(d.DeprecationStart) {
                // RFC 9745: an @-prefixed Unix timestamp of when deprecation
                // began, not the literal "true" that older examples show.
                w.Header().Set("Deprecation",
                    fmt.Sprintf("@%d", d.DeprecationStart.Unix()))
                // RFC 8594: an HTTP-date. UTC so the weekday is correct.
                w.Header().Set("Sunset", d.SunsetDate.UTC().Format(http.TimeFormat))
                w.Header().Set("Link", "</api/v2>; rel=\"successor-version\"")

                daysRemaining := int(d.SunsetDate.Sub(now).Hours() / 24)
                w.Header().Set("X-Deprecation-Notice",
                    fmt.Sprintf("This version will be removed in %d days", daysRemaining))
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Mistake 4: Documentation Drift

Documentation drift occurs when a spec says a field is required but the handler accepts requests without it, leaving API clients with false confidence that their integration is correct. The test-based approach in `TestOpenAPIAccuracy` exercises every path and method defined in the spec against the live handler, making drift a failing CI test rather than a silent contract violation.

```go
// ❌ Wrong: Documentation doesn't match implementation
// OpenAPI spec says:
//   email: required
// But handler allows:
func CreateUser(w http.ResponseWriter, r *http.Request) {
    var input struct {
        Email string `json:"email"` // Not validated as required!
    }
    // ...
}

// ✅ Correct: Generate spec from code or validate consistency
// Option 1: Use swag annotations that match validation tags
type CreateUserInput struct {
    Email string `json:"email" validate:"required,email"`
}

// Option 2: Validate OpenAPI spec against tests
func TestOpenAPIAccuracy(t *testing.T) {
    spec := loadOpenAPISpec("openapi.yaml")

    // For each endpoint in spec, send request matching spec
    // and verify response matches spec.
    // Paths is a struct, not a map: use Map() to range over it.
    for path, item := range spec.Paths.Map() {
        for method, op := range item.Operations() {
            t.Run(fmt.Sprintf("%s %s", method, path), func(t *testing.T) {
                req := buildRequestFromSpec(op)
                resp := executeRequest(req)
                validateResponseMatchesSpec(t, resp, op.Responses)
            })
        }
    }
}
```

### Mistake 5: Not Documenting Error Responses

Documenting only the success path leaves client developers guessing what a `409` or `422` response body looks like, forcing them to test against a live server to discover the schema. The full `@Failure` annotation set, combined with a concrete `ValidationError` example in the OpenAPI components, lets generated SDKs surface typed error types for each status code.

```go
// ❌ Wrong: Only documenting success cases
// @Success 200 {object} User
// (no error documentation)

// ✅ Correct: Document all possible error responses
// @Success      200  {object}  Response{data=User}
// @Failure      400  {object}  APIError  "Invalid request body"
// @Failure      401  {object}  APIError  "Authentication required"
// @Failure      403  {object}  APIError  "Insufficient permissions"
// @Failure      404  {object}  APIError  "User not found"
// @Failure      409  {object}  APIError  "Email already exists"
// @Failure      422  {object}  APIError{details=[]ErrorDetail}  "Validation failed"
// @Failure      429  {object}  APIError  "Rate limit exceeded"
// @Failure      500  {object}  APIError  "Internal server error"

// Include error examples in OpenAPI spec.
// openapi3.Ptr is the generic helper - the old StringPtr no longer exists.
func defineErrorResponses(g *APIDocGenerator) {
    g.doc.Components.Responses["ValidationError"] = &openapi3.ResponseRef{
      Value: &openapi3.Response{
        Description: openapi3.Ptr("Validation failed"),
        Content: openapi3.Content{
            "application/json": &openapi3.MediaType{
                Schema: &openapi3.SchemaRef{Ref: "#/components/schemas/APIError"},
                Example: map[string]any{
                    "status":  422,
                    "code":    "VALIDATION_ERROR",
                    "message": "Validation failed",
                    "details": []map[string]string{
                        {"field": "email", "code": "INVALID_FORMAT", "message": "Invalid email format"},
                    },
                },
            },
        },
      },
    }
}
```

### Junior to FAANG: Catching Breaks Before They Ship

Prerequisite gap. Juniors often do not distinguish between an additive change (safe) and a breaking change (not safe). The minimum mental model: adding an optional response field is additive, adding a required request field is breaking, renaming anything is breaking, tightening a validator is breaking, loosening a validator is additive, and changing the type of a field is always breaking.

Worked example of a silent break. A team changes an `id` field from integer to string because the backing store moved to UUIDs. The OpenAPI spec is updated. Tests pass. Clients in strongly typed languages crash at deserialization the next morning. The lesson is that type changes require a new field name and a deprecation window, not a type swap.

First-job context. Your value in your first year is the review comment "this is a breaking change, please add a new field instead." You do not need to architect the versioning policy. You need to read every PR through the lens of "what would a client on last month's SDK see after this deploys."

"Why did this fail?" reflex. When a customer reports a sudden regression, the first three checks are: did any response field change type, did any required request field appear, did any enum value disappear. If yes to any, you found the bug without needing logs.

Interview entry point. "Your teammate wants to rename `email` to `email_address`. Walk me through the migration." Answer: add `email_address` alongside `email` as an alias, set both on write, read from either on input, deprecate `email` with a six-month Sunset header, measure usage per customer, remove only when usage is zero.

### Senior at FAANG: Detecting Drift at Platform Scale

Staff engineers do not catch breaks in review. They catch them in CI or, better, they make breaks structurally impossible.

Anti-pattern: versioning everything. Teams who version every endpoint independently pay a combinatorial cost. Clients must reason about a matrix of versions. SDK codegen explodes. Docs fragment. The staff intervention is a platform-wide rule that version axis is chosen once and the entire surface moves together.

Anti-pattern: no version strategy. When there is no documented policy, every team picks their own. The PayPal lesson applies. Establish an API review board with veto rights, a written policy in the handbook, and a lint rule in CI that blocks new surfaces without a version axis declaration.

Anti-pattern: breaking change without deprecation period. The `Sunset` header (RFC 8594) and the `Deprecation` header (RFC 9745) are not optional on a mature platform. A staff-grade middleware emits both, records per-customer usage in a telemetry store, and refuses to sunset until telemetry shows zero calls for a configured window. If you cannot measure usage per customer, you cannot safely sunset.

Anti-pattern: missing Sunset header. Even when deprecation is announced in a blog post, without the Sunset header, machine-readable deprecation signals do not propagate to SDKs and dashboards. Customers learn by failure.

Anti-pattern: stale docs. The staff fix is code-first with contract tests. Generate OpenAPI from handler metadata, run a CI job that exercises every path and method in the spec against a live handler, and fail the build on mismatch. Do not rely on humans to update YAML.

Anti-pattern: manual changelog. Manual changelogs omit changes. Automated changelogs read the OpenAPI diff between two commits and emit a structured entry per change with a category (additive, deprecation, breaking). A breaking-change detector in CI gates PRs on breaking changes and requires a version bump plus ADR before merge.

Anti-pattern: spec drift with code-first. Code-first tools drift when handlers add fields without updating the registered schema. The fix is a single source of truth, such as a Go struct with validation tags, and codegen that derives both the handler binding and the OpenAPI schema from the same declaration. No hand-written YAML in the PR diff.

ADR template for deprecation:

1. Scope. Which endpoints, which fields, which versions.
2. Signal. Deprecation header, Sunset header, Link to successor.
3. Timeline. Warning period, notification period, rate limit period, sunset date. Absolute dates, not relative durations.
4. Measurement. Per-customer telemetry, exit criteria, dashboard URL.
5. Rollback. What happens if telemetry at sunset shows nonzero calls, who has authority to extend.

Maturity model L1 to L5 for deprecation discipline:

- L1 Ad hoc. Breaking changes ship without notice.
- L2 Announced. Blog posts warn of upcoming changes. No machine signals.
- L3 Signaled. Deprecation and Sunset headers emitted. Changelog curated.
- L4 Measured. Per-customer usage telemetry. Migration tooling available. Exit criteria documented.
- L5 Governed. CI blocks breaking changes without ADR. Automated changelog from OpenAPI diff. API review board approves sunsets. Zero-usage invariant enforced before hard removal.

---
