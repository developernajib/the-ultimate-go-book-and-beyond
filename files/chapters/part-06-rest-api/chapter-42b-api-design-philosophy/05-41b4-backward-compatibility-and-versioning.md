## 42B.4 Backward Compatibility and Versioning

### Why Breaking Changes Are Expensive

The cost of a breaking change is not just the code change itself. It is:

1. **Client coordination**: Every client must update before or after your change deploys. Multi-team coordination is expensive.
2. **Parallel maintenance**: While clients migrate, you maintain old and new behavior simultaneously.
3. **Rollback risk**: If a client hasn't migrated and you deploy, they are broken. You either roll back your service or break them.
4. **Trust erosion**: Developers who have been burned by breaking changes become defensive. They hedge against your API. They avoid adopting new features. They evaluate alternatives.

The formula: `Cost of breaking change = Number of clients × Migration complexity × Trust damage`

### What Constitutes a Breaking Change

**Definitely breaking**:
- Removing a field from a response
- Renaming a field (`user_id` → `userId`)
- Changing a field's type (`string` → `integer`)
- Changing a field's meaning (semantic change: `status: "active"` now means something different)
- Removing an endpoint
- Changing HTTP method of an endpoint
- Making an optional request field required
- Changing error codes or error response structure
- Removing a query parameter
- Changing authentication mechanism

**Probably breaking** (depends on client implementation):
- Adding a new required header
- Changing default values for optional fields
- Changing sort order of list results
- Changing the format of an ID field (e.g., numeric to UUID)
- Adding new enum values to an existing enum field (clients with exhaustive switch statements will break)

**Non-breaking**:
- Adding a new optional field to a response
- Adding a new optional field to a request
- Adding a new endpoint
- Adding a new optional query parameter
- Relaxing validation (accepting more values, not fewer)
- Adding new enum values (with appropriate documentation)
- Adding new error codes to an existing error type

### Versioning Strategies

**URL path versioning** (`/v1/`, `/v2/`):
```
https://api.example.com/v1/users
https://api.example.com/v2/users
```
Pros: Explicit, visible in logs, easy to route in infrastructure, easy to understand, simple to test with curl.
Cons: "Version" means different things (breaking vs feature). Encourages big-bang version bumps.

**Header versioning**:
```
GET /users
API-Version: 2024-01-15
```
Pros: Clean URLs, allows fine-grained versioning.
Cons: Not visible in URL (harder to share, bookmark, log). Must read headers to know what you're getting. Harder to test in browser.

**Query parameter versioning**:
```
GET /users?version=2
```
Pros: Visible in URL, easy to test.
Cons: Pollutes query params, caching complications (CDN may not vary on query params).

**Stripe's date-based versioning**: The cleanest approach for mature APIs. Each version is a date. You set your version once (on API key creation or in a config), and all your requests use that version's behavior forever - until you explicitly opt in to a newer version.

```
Stripe-Version: 2023-10-16
```

This decouples "new features" from "breaking changes." New features appear in all versions. Breaking changes only affect clients that opt in.

### Implementing Multi-Version API in Go

`APIVersion` models each version as a date-stamped struct with a `Breaking` field listing the specific contract changes it introduces, providing self-documenting history alongside the code. The middleware reads the client-supplied version header, validates it against the registry, and stores the resolved version in context so handlers can apply version-specific response transformations without routing duplication.

```go
package versioning

import (
    "context"
    "net/http"
    "time"
)

type APIVersion struct {
    Date     time.Time
    Name     string
    Breaking []string // descriptions of breaking changes in this version

    // Lifecycle dates. Both zero means the version is current.
    //
    // These are explicit fields rather than something derived from Date at
    // request time ("deprecated if older than a year") because deprecation
    // is a decision, not a computation. Deriving it means the header starts
    // firing on an anniversary nobody chose, clients get a sunset date that
    // slides forward on every request, and no human ever approved either.
    DeprecatedAt time.Time // RFC 9745: when it became deprecated
    SunsetAt     time.Time // RFC 8594: when it stops responding. Must be >= DeprecatedAt
}

var versions = []APIVersion{
    {Date: mustParseDate("2023-01-01"), Name: "2023-01-01"},
    {Date: mustParseDate("2023-06-01"), Name: "2023-06-01", Breaking: []string{
        "order.items is now an array of objects instead of array of IDs",
    }},
    {Date: mustParseDate("2024-01-15"), Name: "2024-01-15", Breaking: []string{
        "user.name is split into first_name and last_name",
    }},
}

type contextKey string
const versionKey contextKey = "api_version"

// VersionMiddleware extracts and validates the API version from the request
func VersionMiddleware(defaultVersion string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            versionStr := r.Header.Get("API-Version")
            if versionStr == "" {
                versionStr = defaultVersion
            }

            version, err := parseVersion(versionStr)
            if err != nil {
                http.Error(w, "Invalid API-Version header", http.StatusBadRequest)
                return
            }

            ctx := context.WithValue(r.Context(), versionKey, version)

            // Echo the version back so clients know which version was used
            w.Header().Set("API-Version", version.Name)

            // Warn if version is deprecated.
            //
            // Deprecation is defined by RFC 9745 as a structured-field Date:
            // an "@" followed by a Unix timestamp. It is NOT a boolean.
            // `Deprecation: true` is the form you will find all over the web
            // and it does not conform: a spec-compliant parser rejects it.
            // The value answers "since when", which is information "true"
            // cannot carry, and which clients need in order to tell a
            // freshly deprecated version from one that is nearly gone.
            if deprecatedAt := version.DeprecatedAt; !deprecatedAt.IsZero() {
                w.Header().Set("Deprecation",
                    "@"+strconv.FormatInt(deprecatedAt.Unix(), 10))

                // Sunset (RFC 8594) is an HTTP-date, a different format from
                // Deprecation. Yes, two adjacent headers about the same
                // lifecycle use two different time encodings. RFC 9745
                // requires Sunset to be no earlier than Deprecation.
                if !version.SunsetAt.IsZero() {
                    w.Header().Set("Sunset", version.SunsetAt.UTC().Format(http.TimeFormat))
                }
                w.Header().Set("Link", `</docs/migration>; rel="deprecation"`)
            }

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func GetVersion(ctx context.Context) APIVersion {
    v, _ := ctx.Value(versionKey).(APIVersion)
    return v
}

// VersionedUserResponse returns different shapes based on API version
func VersionedUserResponse(ctx context.Context, u *User) any {
    version := GetVersion(ctx)

    if version.Date.Before(mustParseDate("2024-01-15")) {
        // Old version: combined name field
        return UserResponseV1{
            ID:        u.ID,
            Name:      u.FirstName + " " + u.LastName,
            Email:     u.Email,
            CreatedAt: u.CreatedAt,
        }
    }

    // New version: split name fields
    return UserResponseV2{
        ID:        u.ID,
        FirstName: u.FirstName,
        LastName:  u.LastName,
        Email:     u.Email,
        CreatedAt: u.CreatedAt,
    }
}

type UserResponseV1 struct {
    ID        string    `json:"id"`
    Name      string    `json:"name"`
    Email     string    `json:"email"`
    CreatedAt time.Time `json:"created_at"`
}

type UserResponseV2 struct {
    ID        string    `json:"id"`
    FirstName string    `json:"first_name"`
    LastName  string    `json:"last_name"`
    Email     string    `json:"email"`
    CreatedAt time.Time `json:"created_at"`
}
```

### Deprecation and Sunset Headers

Two different RFCs cover two different questions, and they are routinely conflated:

- **`Deprecation`** (**RFC 9745**) answers *since when is this deprecated?* Its value is a structured-field Date: an `@` followed by a Unix timestamp, for example `Deprecation: @1688169599`. It may be a past date (already deprecated) or a future one (deprecation is scheduled).
- **`Sunset`** (**RFC 8594**) answers *when does this stop working?* Its value is an HTTP-date, for example `Sunset: Sat, 01 Jan 2025 00:00:00 GMT`. RFC 9745 requires it to be no earlier than the `Deprecation` date.
- **`Link`** (**RFC 8288**) points at what to do about it: the migration guide, the successor version.

The single most common error here is `Deprecation: true`. It appears in a great deal of published sample code, and it is not valid: RFC 9745 defines the field as a Date, so a boolean is a type error that a conforming parser rejects. It also throws away the only information that makes the header actionable. "Deprecated" tells a client nothing it can schedule against. "Deprecated since June 2023, sunset January 2025" tells it exactly how much runway it has.

```go
// deprecate marks a route deprecated as of deprecatedAt, ceasing to respond
// at sunset. Pass a zero sunset if no removal date is committed yet.
func deprecate(deprecatedAt, sunset time.Time, successor string) func(http.Handler) http.Handler {
    // Fail at startup, not at request time: an inverted pair here would
    // advertise a resource that dies before it is deprecated, which RFC 9745
    // forbids and which no client can act on sensibly.
    if !sunset.IsZero() && sunset.Before(deprecatedAt) {
        panic("sunset must not precede deprecation")
    }

    // Format once at construction. These values do not change per request,
    // and formatting them per request is pure waste on a hot path.
    depHeader := "@" + strconv.FormatInt(deprecatedAt.Unix(), 10)
    sunsetHeader := ""
    if !sunset.IsZero() {
        sunsetHeader = sunset.UTC().Format(http.TimeFormat)
    }
    linkHeader := fmt.Sprintf(`<%s>; rel="successor-version"`, successor)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // RFC 9745 Date: "@" + Unix seconds. Never "true".
            w.Header().Set("Deprecation", depHeader)
            if sunsetHeader != "" {
                // RFC 8594 HTTP-date. Note this is a different encoding from
                // the line above, for two headers describing one lifecycle.
                w.Header().Set("Sunset", sunsetHeader)
            }
            // RFC 8288 web linking.
            w.Header().Set("Link", linkHeader)
            next.ServeHTTP(w, r)
        })
    }
}

// Apply to v1 routes that are being deprecated.
r.Route("/v1", func(r chi.Router) {
    var (
        deprecatedAt = time.Date(2024, 7, 1, 0, 0, 0, 0, time.UTC)
        sunset       = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
    )
    r.Use(deprecate(deprecatedAt, sunset, "https://api.example.com/docs/migration-v2"))
    // ... v1 routes
})
```

Which produces:

```http
Deprecation: @1719792000
Sunset: Wed, 01 Jan 2025 00:00:00 GMT
Link: <https://api.example.com/docs/migration-v2>; rel="successor-version"
```

A client can now do something useful with this: log a warning today, fail its own CI when the sunset date is within 30 days, and open a migration ticket automatically. None of that is possible with `Deprecation: true`, which is why the header so often gets emitted, ignored, and then followed by an outage that surprises everyone.

### Junior → FAANG: Understanding Why Breaking Changes Are a Career Risk

Many junior engineers treat versioning as a naming problem: "just add `/v2`." The real problem is the promise attached to every field you ship. Once a client reads `user.name`, that field is part of your contract regardless of what your spec says. Here is how to build the right mental model early.

**The prerequisite gap most juniors carry:** They have shipped code that only they call. When you are the only consumer, breaking changes cost you nothing. In a multi-team or multi-customer API, you are never the only consumer. The discipline of treating every field as a permanent commitment must become habitual before you touch a production API.

**Worked example: The "harmless" rename.** You want to rename `user_id` to `id` for consistency. You update the response, run your own tests, and ship. Two weeks later, an iOS client that has not shipped an update in three months starts throwing null-pointer exceptions in production. The client was reading `user_id` by key name, found nil after your rename, and passed nil to a function that did not expect it. The fix requires a hotfix on the mobile app side, app store review time, and a rollback on your side. The rename cost ten minutes. The incident cost days.

**Interview entry-point framing.** FAANG interviewers will ask some form of: "How would you design an API that evolves without breaking clients?" A passing answer names a versioning strategy. A strong answer explains the breaking-change taxonomy (removing vs renaming vs changing type vs changing semantics), picks a strategy with a stated rationale (not "because Stripe does it"), and describes how you would detect regressions before they reach production. Know the difference between the `Deprecation` (RFC 9745), `Sunset` (RFC 8594), and `Link` (RFC 8288) headers, what each one's value format is, and when each fires. If you say `Deprecation: true`, an interviewer who knows the RFC has learned that you learned this from a blog post: the field is a structured-field Date (`@1719792000`), and it answers "since when," which is the whole reason it is useful.

**First-job habits to build immediately:**
- Before shipping any field, ask: "What happens to a client that ignores this field?" and "What happens to a client that depends on this field and I later remove it?"
- Add `oasdiff` or `openapi-diff` to your local pre-commit hook from day one, not as a CI afterthought.
- Read RFC 8594 (`Sunset`) and RFC 9745 (`Deprecation`). Both are short. Know that they define different value formats, an HTTP-date and a structured-field Date respectively, and that RFC 9745 requires the sunset instant to be no earlier than the deprecation instant.
- Never ship an enum without documenting that new values may appear. Clients should handle unknown enum values gracefully. If they cannot, that is your bug to communicate, not theirs to guess.

**The date-based versioning mental model.** Stripe's approach separates two concerns that URL-path versioning conflates: "What version of the contract governs this request?" and "Which code path handles it?" A client frozen at `Stripe-Version: 2023-10-16` keeps working even after you ship ten new breaking changes, because each change only applies to clients that opt in. URL-path versioning forces you to duplicate entire route trees. Date-based versioning pushes the branching into handler logic, which is cheaper to maintain and easier to test.

---

### Senior @ FAANG: Versioning as Platform Governance

At L6 and above, versioning stops being an implementation decision and becomes a platform contract. You are not choosing a strategy for one API. You are setting the policy that governs how dozens of teams evolve their APIs over years. That changes everything about how you think about it.

**Architecture Decision Record framing.** The versioning strategy belongs in an ADR, not a README comment. The ADR must answer: What is the minimum notice period before a breaking change ships? Who approves exceptions? What is the automated enforcement mechanism? What happens to teams that miss the deprecation deadline? An ADR without enforcement is a wish list. Enforcement without automation is a tax on human attention that compounds as the API surface grows.

**The maturity model for versioning.**

Level 0: No versioning. Teams change whatever they want. Incidents are frequent. Trust is low.

Level 1: URL-path versioning. Breaking changes require a new prefix. No automation. Teams accumulate "v2" endpoints that shadow "v1" indefinitely because no one owns the cleanup.

Level 2: Automated breaking-change detection. `oasdiff` runs in CI. PRs that introduce breaking changes fail. But there is no policy for what "approved breaking change" looks like, so engineers add `# breaking: approved` comments and disable the check.

Level 3: Policy-as-code. Breaking changes require a named ADR, a migration guide, a `Sunset` header with a date, and telemetry proving client adoption before removal. The CI check reads a policy file that maps endpoint paths to their approved sunset dates and owner contacts. Unapproved breaking changes cannot merge.

Level 4: Governance engine at the gateway. The API gateway enforces contracts at runtime. A deploy whose OpenAPI spec introduces a breaking change against the registered contract is rejected before traffic shifts. This is where Apigee Apihub and Kong's DevPortal are pushing in 2025 and 2026.

**The telemetry gate is the hardest part to get right.** Many teams declare deprecation, set a sunset date, and then cannot actually remove the endpoint because they have no idea who is still calling it. The missing piece is per-version, per-client call volume metered at the gateway layer. Before you can enforce a sunset, you need a dashboard that shows: "For `/v1/users`, here are the top 20 callers by request volume in the last 30 days, broken down by the API version header they send." Without that, every deprecation becomes a negotiation rather than a policy execution.

**Staff-level concern: versioning and multi-region consistency.** If your API is deployed across regions with independent release trains, a breaking change in region A before region B has caught up creates a window where the same client gets different responses depending on which region their request lands on. This is not a theoretical concern. The mitigation is version-aware traffic routing at the load balancer level: pin clients that are on old versions to regions that still serve the old contract, and drain them only after all regions are consistent. This requires the versioning system to be a first-class citizen of your deployment pipeline, not a header appended to the request.

**Bar-raiser interview signals at L6+.** The interviewer wants to see that you think about versioning as a system, not a header. Strong signals include: you propose a telemetry gate before any sunset, you describe an ADR process and name who approves exceptions, you explain the tradeoff between header versioning and URL-path versioning in terms of caching behavior at the CDN layer (URL-path versioning is CDN-cacheable by default, while header versioning requires `Vary: API-Version` which many CDNs handle poorly), and you acknowledge that date-based versioning requires more sophisticated handler branching but provides a much cleaner client upgrade path. Weak signals: naming a versioning strategy without a deprecation policy, or conflating versioning with feature flags.

**Go-specific implementation concern.** The `VersionedUserResponse` pattern shown in this chapter scales to two or three versions. Beyond that, a `switch` on version date inside every handler becomes unmaintainable. The scalable pattern is a transformation pipeline: each version boundary is a registered transform function that maps `ResponseV_n` to `ResponseV_n-1`. Handlers always return the latest shape. The middleware stack applies transforms in reverse chronological order until it reaches the client's pinned version. This makes adding a new version additive (register one new transform) rather than multiplicative (add one branch to every handler).

---
