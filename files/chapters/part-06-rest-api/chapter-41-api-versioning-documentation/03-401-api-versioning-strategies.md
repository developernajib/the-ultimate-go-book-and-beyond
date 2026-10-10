## 41.1 API Versioning Strategies

### Versioning Approaches

| Strategy | Example | Pros | Cons |
|---|---|---|---|
| URL path | `/api/v1/users` | Explicit, cacheable, trivial to debug from a browser or cURL, easy to route at the CDN/LB edge | URL churn on major bumps, can encourage "big-bang" rewrites |
| Query param | `/api/users?version=1` | Optional, simple to layer onto an existing API | Easy to forget, cache-key pollution, intermediaries may strip it |
| Request header | `X-API-Version: 2` (custom) | Clean URLs, flexible | Invisible in browsers and logs, harder for partners to test, must be echoed on errors |
| Content-type / Accept | `Accept: application/vnd.api+json; version=2` | Closest to the REST / HATEOAS ideal, per-resource granularity | Verbose, painful to test, few SDKs set it correctly by default |
| Date-based (Stripe) | `Stripe-Version: 2026-01-15` | Additive-by-default, account pinning means old integrations never break silently | Requires a rigorous change classifier and server-side transform layer |

**Recommendation:** URL path for public, partner-facing APIs (discoverable, cacheable, easy to document). Header-based (including date pinning a la Stripe) for sophisticated internal consumers with SDKs that can set headers consistently. Avoid query parameters for versioning entirely. They get stripped by intermediaries, pollute cache keys, and silently disappear behind URL rewrites.

**A quick practical heuristic:** if a curious developer cannot paste your API URL into a browser and understand which version they are hitting, you have made life harder for every integrator. URL path versioning trades aesthetic purity for operational clarity, which is almost always the right trade for public APIs.

### URL Path Versioning

Chi's `Route` nesting groups all v1 handlers under the `/api/v1` prefix while keeping v2 routes fully isolated, so both versions can coexist without shared handler code. This structure makes it straightforward to delete a version by removing its `Route` block without touching other handlers.

```go
// ... imports omitted for brevity (net/http, github.com/go-chi/chi/v5,
// github.com/go-chi/chi/v5/middleware, and the local v1 and v2 handler packages)

func setupVersionedRoutes() http.Handler {
    r := chi.NewRouter()

    // Global middleware
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // API v1
    r.Route("/api/v1", func(r chi.Router) {
        r.Route("/users", func(r chi.Router) {
            r.Get("/", v1.ListUsers)
            r.Post("/", v1.CreateUser)
            r.Get("/{id}", v1.GetUser)
            r.Put("/{id}", v1.UpdateUser)
            r.Delete("/{id}", v1.DeleteUser)
        })

        r.Route("/posts", func(r chi.Router) {
            r.Get("/", v1.ListPosts)
            r.Post("/", v1.CreatePost)
        })
    })

    // API v2 - with breaking changes
    r.Route("/api/v2", func(r chi.Router) {
        r.Route("/users", func(r chi.Router) {
            r.Get("/", v2.ListUsers)   // Changed response format
            r.Post("/", v2.CreateUser) // Changed input format
            r.Get("/{id}", v2.GetUser)
            r.Patch("/{id}", v2.UpdateUser) // Changed from PUT to PATCH
            r.Delete("/{id}", v2.DeleteUser)
        })

        r.Route("/articles", func(r chi.Router) { // Renamed from posts
            r.Get("/", v2.ListArticles)
            r.Post("/", v2.CreateArticle)
        })
    })

    return r
}
```

### Header-Based Versioning

The `APIVersion` middleware reads the `X-API-Version` header, validates it against the supported set, and stores the resolved integer in the request context so downstream handlers can branch on version without re-parsing the header. Falling back to `defaultVersion` when the header is absent lets existing clients continue working after the middleware is added.

```go
// ... imports omitted for brevity (context, net/http, strconv, strings)

type contextKey string

const APIVersionKey contextKey = "api_version"

// APIVersion extracts and validates API version from header
func APIVersion(defaultVersion int, supportedVersions []int) func(http.Handler) http.Handler {
    supported := make(map[int]bool)
    for _, v := range supportedVersions {
        supported[v] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            version := defaultVersion

            // Check X-API-Version header
            if v := r.Header.Get("X-API-Version"); v != "" {
                parsed, err := strconv.Atoi(v)
                if err != nil {
                    http.Error(w, "Invalid API version", http.StatusBadRequest)
                    return
                }
                version = parsed
            }

            // Check Accept header (application/vnd.api.v2+json)
            if accept := r.Header.Get("Accept"); accept != "" {
                if v := parseAcceptVersion(accept); v > 0 {
                    version = v
                }
            }

            // Validate version
            if !supported[version] {
                w.Header().Set("X-Supported-Versions", formatVersions(supportedVersions))
                http.Error(w, "Unsupported API version", http.StatusBadRequest)
                return
            }

            // Add version to response header
            w.Header().Set("X-API-Version", strconv.Itoa(version))

            // Vary is mandatory, not optional, whenever the response body
            // depends on a request header. Without it any cache (browser,
            // CDN, reverse proxy) keys solely on the URL and will happily
            // hand a v1 caller a cached v2 body. This is the entire reason
            // the URL-path strategy gets a free "cacheable" checkmark: it
            // has no header to vary on.
            w.Header().Add("Vary", "X-API-Version")
            w.Header().Add("Vary", "Accept")

            ctx := context.WithValue(r.Context(), APIVersionKey, version)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func parseAcceptVersion(accept string) int {
    // Parse: application/vnd.api.v2+json
    parts := strings.Split(accept, ".")
    for _, part := range parts {
        if strings.HasPrefix(part, "v") {
            if v, err := strconv.Atoi(strings.TrimPrefix(strings.Split(part, "+")[0], "v")); err == nil {
                return v
            }
        }
    }
    return 0
}

func formatVersions(versions []int) string {
    strs := make([]string, len(versions))
    for i, v := range versions {
        strs[i] = strconv.Itoa(v)
    }
    return strings.Join(strs, ", ")
}

// GetAPIVersion extracts version from context
func GetAPIVersion(ctx context.Context) int {
    if v, ok := ctx.Value(APIVersionKey).(int); ok {
        return v
    }
    return 1
}
```

### Version-Aware Handlers

The handler function processes the incoming request, delegates to the service layer for business logic, and writes a structured response. Keeping handlers thin (parsing input, calling services, formatting output) separates HTTP concerns from domain logic.

```go
// ... imports omitted for brevity (encoding/json, net/http, time,
// github.com/go-chi/chi/v5)

type UserHandler struct {
    service UserService
}

// UserV1 response format for API v1
type UserV1 struct {
    ID        string `json:"id"`
    Name      string `json:"name"`
    Email     string `json:"email"`
    CreatedAt string `json:"created_at"`
}

// UserV2 response format for API v2 (breaking change)
type UserV2 struct {
    ID        string   `json:"id"`
    FirstName string   `json:"first_name"`
    LastName  string   `json:"last_name"`
    Email     string   `json:"email"`
    Roles     []string `json:"roles"`
    Metadata  Metadata `json:"metadata"`
}

type Metadata struct {
    CreatedAt string `json:"created_at"`
    UpdatedAt string `json:"updated_at"`
    Version   int    `json:"version"`
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    userID := chi.URLParam(r, "id")

    user, err := h.service.GetByID(r.Context(), userID)
    if err != nil {
        handleError(w, r, err)
        return
    }

    version := GetAPIVersion(r.Context())

    w.Header().Set("Content-Type", "application/json")

    switch version {
    case 1:
        json.NewEncoder(w).Encode(toUserV1(user))
    case 2:
        json.NewEncoder(w).Encode(toUserV2(user))
    default:
        json.NewEncoder(w).Encode(toUserV2(user))
    }
}

func toUserV1(u *User) UserV1 {
    return UserV1{
        ID:        u.ID,
        Name:      u.FirstName + " " + u.LastName,
        Email:     u.Email,
        CreatedAt: u.CreatedAt.Format(time.RFC3339),
    }
}

func toUserV2(u *User) UserV2 {
    return UserV2{
        ID:        u.ID,
        FirstName: u.FirstName,
        LastName:  u.LastName,
        Email:     u.Email,
        Roles:     u.Roles,
        Metadata: Metadata{
            CreatedAt: u.CreatedAt.Format(time.RFC3339),
            UpdatedAt: u.UpdatedAt.Format(time.RFC3339),
            Version:   u.Version,
        },
    }
}
```

### Junior → FAANG: Choosing A Strategy With Confidence

The table at the top of this section is memorize-worthy, but the thing your first job actually needs you to understand is the `switch version { case 1: ... case 2: ... }` pattern in `GetUser`. That switch is the load-bearing anti-pattern in most first attempts at versioning. It works at two versions, becomes awkward at three, and becomes a bug factory at four. The reason is that every new endpoint you add gets the same switch copy-pasted, and every time you add a version, you have to go find every switch and add a new case. The correct structure is a response formatter registry: `formatters := map[int]func(*User) any{1: toUserV1, 2: toUserV2}` with the handler selecting by version and calling the formatter. Now adding v3 is one map entry, not a grep across the codebase. This single refactor moves a codebase from "has versioning" to "can sustain versioning."

The prerequisite you need for header-based versioning to work safely is `Vary`, which is why the middleware above sets it alongside the version header. Without `Vary`, a caching layer keys on the URL alone and serves one cached body to clients asking for different versions. That is the classic "I deployed v2 and some users are still getting v1" bug, and it costs a full day the first time you hit it because the bug is not in your code, it is in a cache you forgot existed. The rule to internalize: the moment a response body depends on a request header, that header belongs in `Vary`. Note the code uses `Header().Add` twice rather than `Set` with a comma-joined string. Both produce a valid `Vary`, but `Add` composes safely when another middleware in the chain also needs to vary on something, whereas `Set` silently overwrites whatever it already set.

A worked example for your first job. You have `GetUser` returning v1 and v2 via the switch above. Product asks for a new field `phone_number` in the response. The junior instinct is to add it to `UserV2`. Stop and ask: is this additive or breaking? Adding a new field to a JSON response is additive, so adding `phone_number` to `UserV2` is safe and does not require a v3. But if you added it to `UserV1`, would that break anyone? Almost certainly not, because JSON clients ignore unknown fields by convention. The subtle case is if a v1 client uses a strict schema validator that rejects unknown fields, in which case adding a field to v1 is technically breaking. The resolution: put new fields in the latest version only, never backport to old versions, and your v1 schema stays frozen. That discipline is what makes v1 safe to support forever.

The interview entry-point for this section is "show me how you would implement header-based versioning in Go." The answer is: middleware that parses the header into context, handlers that read version from context, response formatters in a map keyed by version, Vary header on all responses. That is a 15 minute code-on-a-whiteboard answer and it hits every point an interviewer is checking for.

### Senior @ FAANG: Transform Pipelines, Compatibility Graphs, And The Stripe Model

The `toUserV1` and `toUserV2` functions shown here are the starter version of what becomes, at scale, a request-response transform pipeline. The senior architecture upgrade is to stop thinking of versions as separate code paths and start thinking of them as transformations applied to a canonical internal type. The canonical type is always the latest shape (internally, in the service's memory model). Incoming requests from older versions are transformed up to the canonical shape by a chain of per-version request transformers. Outgoing responses are transformed down to the client's pinned version by the inverse chain. The handler only ever sees the canonical type, which means business logic is never forked per version.

The Stripe model takes this one step further by making the version a per-request date, with the transformation chain indexed by date rather than by integer. A request carrying `Stripe-Version: 2022-08-01` flows through every transformer dated after 2022-08-01 up to the current internal shape. The response flows back through the inverse chain in reverse order. Each transformer is a small, auditable diff: "in this dated version, the `customer.shipping.address` field was renamed from `shipping_address`, so the up-transformer renames the field on incoming requests and the down-transformer renames it back on outgoing responses for clients pinned to dates before this transformer." The beauty of the model is that adding a new breaking change is one transformer, and old integrations never need to migrate because the chain grows at the head, not the tail. The cost is that every transformer lives forever, and after a decade Stripe has hundreds of them. They accept this cost because the alternative (forcing merchants to migrate) is strictly worse for their business.

The compatibility debate at senior level is additive-only vs semantic versioning for APIs. The additive-only camp, of which Stripe is the clearest public example, says breaking changes are never acceptable on the same version, and every breaking change is a new version. The semver-for-APIs camp (some internal Google APIs, some AWS services) says minor versions can include additive changes and major versions can include breaking changes, with a strict deprecation window for majors. The tradeoff is consumer effort: additive-only means consumers never need to do anything, but the server accumulates complexity. Semver-for-APIs means servers stay cleaner, but consumers must track major versions and migrate on a schedule. For public APIs with a long tail of integrations you cannot reach, additive-only wins. For internal APIs where you can coordinate migrations, semver-for-APIs is fine. The senior call is to pick the regime and document it, because consumer expectations are set by which regime you announce.

Breaking change detection in CI is the mechanism that makes either regime enforceable. `oasdiff breaking old.yaml new.yaml` classifies every change in an OpenAPI spec PR as breaking or non-breaking, with configurable severity per rule (removing an endpoint is always breaking, tightening an enum is breaking, adding an optional request parameter is non-breaking). The CI job fails if a breaking change appears in a PR that is not flagged with a "breaking-change-approved" label. That label is only applied by the API review board after reviewing the migration plan. For protobuf, `buf breaking` does the same against a configured baseline (typically the main branch or the last released version). Optic does it by observing traffic and inferring the schema, useful for services without a hand-maintained spec. Pick one and wire it into every PR on the repo. The time from "we have no breaking change detection" to "breaking changes are flagged in CI" is a one-week project and it pays off the first time it catches a bad PR.

The contract-as-code angle at senior level is that the OpenAPI spec becomes the canonical artifact that drives more than one downstream. Request and response validation at the gateway, auth policy attachment, rate limit budgets, SDK generation across five languages, mock server for local development (Prism reads the spec and serves example responses), contract tests in CI (Schemathesis reads the spec and fuzzes the server). Every one of these downstreams is a mouth to feed, and every one of them breaks if the spec drifts. The senior project is to make spec accuracy non-optional, typically by generating the spec from typed handler code (with `huma` or `goa` in Go, where the spec is derived from the Go types, so spec and runtime cannot drift) or by running the runtime against the spec in CI with Schemathesis (where the server is verified to match the spec on every build). Either approach works. What does not work is hand-writing the spec and trusting engineers to keep it in sync.

The GitHub GraphQL model is worth one more mention at senior level because it inverts the problem. Instead of versioning the API, GraphQL versions each field via the `@deprecated` directive, and clients select exactly the fields they want in their queries. The server tracks per-field usage via query introspection logs, and deprecation notices go to consumers still selecting deprecated fields. This sidesteps the big-bang version bump entirely. The cost is that GraphQL has its own complexity tax (N+1 queries, query cost analysis, persisted queries for mobile), and not every API should be GraphQL. But if you are greenfield, have sophisticated consumers, and want to avoid the versioning overhead entirely, the senior call is to evaluate GraphQL on its merits rather than defaulting to REST and paying the version tax.

---
