## 38.3 URL Design

### Resource Naming Conventions

URL design rules: use plural nouns (`/users`, `/posts`), lowercase with hyphens for multi-word segments (`/user-profiles` is kebab-case, never `/userProfiles` or `/user_profiles`), nest resources for ownership relationships (`/users/{id}/posts`), keep nesting shallow (max 2-3 levels), and put filters/sorting in query params (`?status=active&sort=created_at`). Never use verbs in paths: that's what HTTP methods are for. The narrow exception is **action sub-resources** (`POST /posts/{id}/publish`) when the operation does not map cleanly to CRUD.

The example below uses the Go 1.22+ standard-library `http.ServeMux`, which gained method matching and path wildcards in February 2024, enough to build production APIs without chi, gorilla/mux, or httprouter for most services. Patterns are written as `"METHOD /path/{var}"`, and variables are extracted with `r.PathValue("var")`.

```go
// ... imports omitted for brevity (net/http)

func SetupRoutes() *http.ServeMux {
    mux := http.NewServeMux()

    // Users resource (method + path variable patterns, Go 1.22+)
    mux.HandleFunc("GET    /users",                listUsers)    // list
    mux.HandleFunc("POST   /users",                createUser)   // create
    mux.HandleFunc("GET    /users/{id}",           getUser)      // read
    mux.HandleFunc("PUT    /users/{id}",           replaceUser)  // replace
    mux.HandleFunc("PATCH  /users/{id}",           updateUser)   // partial update
    mux.HandleFunc("DELETE /users/{id}",           deleteUser)   // delete

    // Nested resources
    mux.HandleFunc("GET    /users/{id}/posts",     getUserPosts)
    mux.HandleFunc("GET    /users/{id}/followers", getFollowers)

    // Posts resource
    mux.HandleFunc("GET    /posts",                listPosts)
    mux.HandleFunc("POST   /posts",                createPost)
    mux.HandleFunc("GET    /posts/{id}",           getPost)
    mux.HandleFunc("PUT    /posts/{id}",           replacePost)
    mux.HandleFunc("PATCH  /posts/{id}",           updatePost)
    mux.HandleFunc("DELETE /posts/{id}",           deletePost)

    // Action sub-resources (when CRUD does not fit)
    mux.HandleFunc("POST   /posts/{id}/publish",   publishPost)
    mux.HandleFunc("POST   /posts/{id}/archive",   archivePost)

    // Cross-resource search
    mux.HandleFunc("GET    /search",               globalSearch)

    return mux
}

// Handlers read path vars via r.PathValue:
func getUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // "123" for GET /users/123
    _ = id
}
```

Unmatched methods on an otherwise-matching path produce `405 Method Not Allowed` automatically, and the mux populates the `Allow` header with the registered verbs, behavior that previously required a third-party router.

### Query Parameters

Query string parameters carry optional filters, pagination cursors, and sort directives. Parsing them from `r.URL.Query()` returns a `url.Values` map, and helpers like `strconv.Atoi` or dedicated query-binding libraries convert strings to typed values safely.

```go
// ... imports omitted for brevity (net/http, strconv, strings)

// QueryParams holds parsed query parameters
type QueryParams struct {
    // Pagination
    Page     int
    PageSize int
    Cursor   string

    // Sorting
    SortBy    string
    SortOrder string // asc, desc

    // Filtering
    Filters map[string]string

    // Field selection
    Fields []string

    // Search
    Query string
}

func ParseQueryParams(r *http.Request) QueryParams {
    q := r.URL.Query()

    params := QueryParams{
        Page:     parseInt(q.Get("page"), 1),
        PageSize: parseInt(q.Get("page_size"), 20),
        Cursor:   q.Get("cursor"),
        SortBy:   q.Get("sort_by"),
        SortOrder: q.Get("sort_order"),
        Query:    q.Get("q"),
        Filters:  make(map[string]string),
    }

    // Parse fields (sparse fieldsets)
    if fields := q.Get("fields"); fields != "" {
        params.Fields = strings.Split(fields, ",")
    }

    // Parse filters
    // Example: ?filter[status]=active&filter[role]=admin
    for key, values := range q {
        if strings.HasPrefix(key, "filter[") && strings.HasSuffix(key, "]") {
            filterKey := key[7 : len(key)-1]
            params.Filters[filterKey] = values[0]
        }
    }

    return params
}

func parseInt(s string, defaultVal int) int {
    if s == "" {
        return defaultVal
    }
    val, err := strconv.Atoi(s)
    if err != nil {
        return defaultVal
    }
    return val
}

// Example URLs:
// GET /users?page=2&page_size=50
// GET /users?sort_by=created_at&sort_order=desc
// GET /users?filter[status]=active&filter[role]=admin
// GET /users?fields=id,name,email
// GET /posts?q=golang
```

### Junior → FAANG: URL design rules you can apply without thinking

URL design is the most visible artifact of your API. Every client sees the path before they see the response body. Internalize eight rules and you will avoid the junior review mistakes that block merges.

1. Collections are plural nouns. `/users`, not `/user`. `/invoices`, not `/invoice`. The single exception some teams make is a singleton that is scoped by auth (`/me`, `/account`), where the plural does not make semantic sense.

2. Items are addressed by id inside the collection. `/users/42`, not `/user/42`. The id is opaque to the URL grammar (prefer ULIDs or UUIDs over sequential integers for public APIs, because sequential ids leak business metrics and enable enumeration attacks).

3. Path segments are kebab-case (`/payment-methods`), not camelCase or snake_case. This is the Stripe, GitHub, and Google default. Be consistent platform-wide.

4. Nesting represents ownership only, and stays at two levels max. `/users/{id}/posts` is fine. `/users/{id}/posts/{postId}/comments/{commentId}/reactions` is not. Flatten to `/comments/{id}/reactions` and link back.

5. Verbs never appear in paths. `/updateUser`, `/getUsers`, `/doThing` are RPC. If CRUD does not fit, use a noun action sub-resource (`POST /posts/{id}/publications` creating a publication). Reserve bare verbs (`POST /posts/{id}/publish`) for cases where the action is genuinely not a resource.

6. Filters, sorts, pagination, and field selection live in query strings, never in path segments.

7. Versioning in the URL for public APIs (`/v1/users`). Do not ship a public API without a version segment. Adding one later is a breaking change.

8. IDs are stable. Once an id is issued it never changes. If you must re-key, issue a redirect.

Worked example to burn into memory. "Design URLs for a ticketing system with organizations, projects, tickets, and comments." The junior answer nests everything. The correct answer flattens. `/v1/organizations/{org}/projects` (nested because projects belong to one org and are addressed as such). `/v1/projects/{project_id}/tickets` (projects own tickets, two-level nesting). `/v1/tickets/{id}` (direct access because clients will often have a ticket id without a project id). `/v1/tickets/{id}/comments` for the comment collection. `/v1/comments/{id}` for individual comments. Notice the same resource is reachable via two paths. That is fine as long as both paths return the same representation.

The query-param parser in the code above has two junior bugs. First, `PageSize` has no upper bound, which lets a client request `?page_size=1000000` and OOM the server. Always cap `PageSize` to a documented maximum (usually 100). Second, filter keys are not validated against an allowlist, so `filter[password_hash]=x` will reach the repository layer and may work. Always validate filter keys against a per-endpoint allowlist before they touch the store.

Concrete interview probe. "A user wants to list their own invoices. What URL and status code." The answer is `GET /v1/me/invoices` returning 200. The alternative `GET /v1/users/{my_id}/invoices` also works but requires the client to know their own id, which the SDK usually has but is one more round-trip for partners. The wrong answer is `POST /v1/getInvoices`.

Another probe. "How do you let a client fetch only the fields they need." The answer is sparse fieldsets: `GET /users/42?fields=id,email`. Document which fields are projectable. The server returns only those fields plus any required metadata (`id` is usually non-optional). This halves payload size for mobile clients and is a trivial feature to ship with struct-tag reflection.

### Senior @ FAANG: URL governance, the naming battles worth fighting, and pagination done right

At staff level URL design is policy, not preference. Every choice becomes load-bearing the moment external clients depend on it. The senior framing is "what happens when we need to change this in 2030," and most juniors do not think that far ahead.

Primary sources you must read. The Google AIP corpus at aip.dev (especially AIP-121 Resource-oriented design, AIP-122 Resource names, AIP-132 Standard methods, AIP-151 Long-running operations, AIP-158 Pagination, AIP-160 Filtering). The Microsoft REST API Guidelines on GitHub. The Stripe API reference (not a spec but the de facto industry standard). JSON:API 1.1. OpenAPI 3.1. RFC 3986 URI syntax, RFC 7807 and 9457 Problem Details, RFC 8288 Web Linking, RFC 8594 Sunset header, RFC 9110 HTTP Semantics. If you can cite the relevant AIP or RFC in an API review, you win the argument.

Plural versus singular is the naming battle that keeps coming up. The defensible position is plural always for collections, with rare exceptions for singleton sub-resources (`/users/{id}/avatar` not `/users/{id}/avatars` because there is exactly one). Write this in the style guide and stop re-litigating.

Kebab-case versus snake_case versus camelCase for path segments and for JSON fields are two separate decisions and the industry defaults differ. Paths are kebab-case (`/payment-methods`) because URLs are case-sensitive but many systems normalize them, and kebab-case is unambiguously lowercase. JSON field casing is contested. Google uses camelCase, Stripe uses snake_case, Microsoft uses camelCase. Pick one per platform and enforce with a spectral rule. Mixed casing in one API is a support-ticket generator.

Resource id design is load-bearing. Sequential integers leak growth rates to competitors (`/invoices/40301` tells you how many invoices exist). UUIDv4 is unpredictable but not sortable. ULID and UUIDv7 are sortable by creation time and are the 2026 default for public ids. Stripe-style prefixed ids (`cus_AbC123`, `inv_XyZ789`) are the gold standard because they are self-describing in logs, support tools, and error messages. Adopt prefixes early because retrofitting them is a breaking change.

Versioning strategy is the decision with the longest tail. Three defensible options. URL path versioning (`/v1/...`) is simple and cache-friendly, used by GitHub, Stripe REST v1, Twilio. Header versioning (`Stripe-Version: 2026-04-01`) enables per-request version selection and is what Stripe uses for breaking changes, at the cost of more complex SDK and gateway tooling. Content-type versioning (`Accept: application/vnd.example.v2+json`) is technically the most correct per Fielding but almost nobody does it and tooling support is thin. The 2026 staff default is path versioning for the major version and date-based header versioning for breaking changes within a major. Document the deprecation policy (minimum 180 days for public APIs, enforced via the `Sunset` header per RFC 8594 and the `Deprecation` header per RFC 9745).

Tenant scoping is the decision that splits the API surface. Two defensible patterns. Path-scoped tenancy (`/orgs/{org}/repos/{repo}`) used by GitHub is best when tenants are first-class addressable entities that partners link to. Header-scoped tenancy (`X-Org-Id: ...` or a tenant claim in the JWT) is best when tenancy is implicit from auth. The anti-pattern is mixing the two in one product surface, which creates inconsistent SDK ergonomics and makes caching keys ambiguous. Pick one per product and enforce it in the gateway routing rules.

Pagination is where most REST APIs fail at scale. The four options.

Offset pagination (`?page=5&per_page=50`) is simple and broken. Under writes rows shift, so page 5 sometimes skips and sometimes duplicates. Cost scales with `OFFSET`, so page 1000 is 1000 times slower than page 1. Acceptable for small, rarely-changing lists only. Avoid for anything that grows.

Cursor pagination (opaque token) is the 2026 default. The cursor is a base64-encoded JSON or MessagePack of the sort key(s) of the last row (`{"created_at":"2026-04-22T10:00:00Z","id":"inv_abc"}`). Clients treat it as opaque. The server signs or HMACs it to prevent tampering. Response carries `next_cursor` and optionally `prev_cursor`. Stable under inserts, O(1) per page, hard for clients to skip pages (a feature, not a bug).

Keyset pagination (`?after_id=...&after_created_at=...`) is the transparent cousin. Clients can construct cursors themselves, which is great for resumability and debugging and terrible if you ever want to change the sort key because the cursor is coupled to the schema. Use for internal APIs, prefer opaque cursors for public.

Link header pagination per RFC 8288 is the presentation layer on top of any of the above. `Link: <https://api.example.com/v1/invoices?cursor=eyJ...>; rel="next", <https://api.example.com/v1/invoices?cursor=eyJ...>; rel="prev"`. GitHub's implementation is canonical. Always emit `Link` in addition to body cursors so clients can traverse without parsing the body. Do not return a total count on large collections because it forces an extra scan that dominates query cost. If you must, compute it once and cache it.

Filter syntax is the next governance decision. Four dialects.

RSQL (`filter=status==active;created_at=gt=2026-01-01`) is compact, has FIQL roots, and has parsers in most languages. Good balance of expressiveness and simplicity.

OData (`$filter=status eq 'active' and created_at gt 2026-01-01T00:00:00Z`) is Microsoft's default. Most expressive, most complex, requires a real parser. Suitable for enterprise scenarios with complex predicates.

JSON:API filter family (`filter[status]=active&filter[created_at][gt]=2026-01-01`) is the simplest, maps cleanly to query strings, and is the default in this chapter's examples. Limited expressiveness (no OR, no grouping) but covers 80 percent of needs with 5 percent of the complexity.

Google AIP-160 expression language is a fourth option gaining traction, using a small CEL-like syntax. Worth watching.

Pick one. Document which fields are filterable per resource in the OpenAPI spec via vendor extensions. Validate against an allowlist before constructing the query to prevent injection and denial-of-service via unindexed filters. The critical implementation detail is that filter parameters must map to indexed columns, or a malicious client can construct a filter that triggers a full table scan. Document the index coverage in the ADR.

Sparse fieldsets (`?fields=id,name,email` or JSON:API's `fields[users]=id,name`) are the cheapest performance win in a REST API. Mobile clients download half the bytes. The implementation is a projection layer that reads struct tags and emits only allowed fields, with a per-endpoint allowlist of projectable fields. The gotcha is that `id` is usually non-optional (clients need it for cache keys) and relationship fields (`author_id`) must be present if relationships are embedded. Document the invariants.

Sort parameter design. The industry-converged form is `?sort=-created_at,name` where `-` prefix denotes descending. Allow multiple sort keys. Validate against an allowlist. Reject sorts on unindexed columns with 422 `code=sort_field_not_allowed`. Stable sort requires a tiebreaker on the primary key, so always append `id ASC` to any sort internally even if the client did not ask.

Search versus list. A `GET /search` cross-resource endpoint is a separate contract from list endpoints. It takes a free-text query, runs against a search index (Elasticsearch, OpenSearch, Meilisearch, Typesense), and returns a union type of result kinds. Do not pretend search is just a filter on a list endpoint, because the performance, ranking, and pagination semantics are different (relevance-based cursors, not time-based).

Action resources deserve a last word. When the action is a state transition (`publish`, `archive`, `cancel`), you have three encodings. `PATCH /posts/{id}` with `{"status":"published"}` is the cleanest if the status field is client-settable. `POST /posts/{id}/publications` is correct if the action creates an auditable record (publication id, publication timestamp, publisher id). `POST /posts/{id}/publish` is acceptable when neither of the above fits but the action is truly a verb. The senior position is prefer the first two. Reserve the third for narrow cases and document the idempotency contract (almost always via `Idempotency-Key`).

OpenAPI-first workflow closes the loop. The style guide above is enforced via spectral rules in CI. The OpenAPI spec is the source of truth. Server stubs generated via oapi-codegen v2. SDKs generated via openapi-generator or Fern. Breaking-change detection via openapi-diff. Documentation via Redocly or Scalar. The payoff is that URL governance stops being a code-review flame war and becomes an automated check. This is the productivity multiplier that separates platform teams that scale from those that drown in style debates.

---
