## 41.9 Interview Questions

### Question 1: What are the pros and cons of different API versioning strategies?

**Answer:**

| Strategy | Pros | Cons | Best For |
|----------|------|------|----------|
| **URL Path** (`/v1/users`) | Explicit, cacheable, easy to route | URL pollution, harder to sunset | Public APIs, external developers |
| **Header** (`X-API-Version: 1`) | Clean URLs, flexible | Hidden, harder to test in browser | Internal APIs, sophisticated clients |
| **Query Param** (`?version=1`) | Simple, optional | Easy to forget, caching issues | Rare, not recommended |
| **Content-Type** (`Accept: vnd.api.v1+json`) | RESTful, per-resource versioning | Complex, verbose | APIs needing granular versioning |

Stripe's hybrid approach is often cited as ideal: use date-based versions with additive changes by default, requiring explicit version only for breaking changes.

**What FAANG expects:** A senior candidate does not recite the table. They reason about the consumer. Public APIs with thousands of anonymous integrators demand URL path versioning for discoverability and operational clarity. Internal services with controlled SDK distribution can afford header-based versioning. They also name the real cost of date-based versioning (a server-side "version gates" transform layer that every change must pass through) and explain why Stripe can amortize it but a five-engineer startup cannot.

**Follow-ups you should be ready for:**
- *"How do caches and CDNs interact with each strategy?"* URL path is trivially cacheable. header-based requires `Vary` headers and careful cache-key engineering. Query parameters pollute cache keys and are often stripped by intermediaries.
- *"How would you version a GraphQL API?"* GraphQL discourages versioning entirely. You deprecate fields individually with the `@deprecated` directive and introspection exposes the schema. This is also GraphQL's best argument over REST for rapidly evolving surfaces.
- *"When would you mix strategies?"* GitHub is the canonical example, and it is worth getting the details right because it is widely miscited. Its REST API versions through the `X-GitHub-Api-Version` header with dated values (`2022-11-28`), *not* through a `/v3` URL segment, which belongs to GitHub Enterprise Server. On top of that it uses `Accept` media types to opt into preview features. So the mix is: a dated header for the API version, a media type for experimental features. That split is justified exactly when feature-level experiments ship on a different cadence than versions do.

### Question 2: How would you handle a breaking change in a production API?

**Answer:**

```go
// 1. Create new version BEFORE making the change
// Keep v1 working, add v2 with changes

// 2. Add deprecation headers to v1 immediately
r.Route("/api/v1", func(r chi.Router) {
    r.Use(deprecation(DeprecationInfo{
        Version:    1,
        SunsetDate: time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC),
        Successor:  "/api/v2",
    }))
    // v1 handlers
})

// 3. Document the migration
type MigrationGuide struct {
    FromVersion int
    ToVersion   int
    Changes     []MigrationStep
}

type MigrationStep struct {
    Type        string // "field_renamed", "field_removed", "behavior_changed"
    Endpoint    string
    Description string
    Before      string // Example of old format
    After       string // Example of new format
}

// 4. Provide migration tooling if possible
// - SDK methods that work with both versions
// - Conversion utilities
// - Validation that highlights incompatibilities

// 5. Track version usage to plan sunset
func trackVersionUsage(version int) {
    metrics.Increment("api_version_calls", map[string]string{
        "version": strconv.Itoa(version),
    })
}
```

**What FAANG expects:** The interviewer wants to see that you treat a breaking change as a product launch, not a refactor. That means: (1) per-API-key usage tracking so you know *which* customers you will break and can email them directly, (2) a written migration guide with before/after examples, not just a changelog bullet, (3) `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers from day one of v2's release, and (4) an internal dashboard that alerts you when v1 traffic fails to decay as expected, because a flat curve means the deprecation messaging is not landing.

**Follow-ups you should be ready for:**
- *"What if a customer cannot migrate by the sunset date?"* Stripe's answer: long-tail versions are supported indefinitely for paying customers. Only free-tier or unpinned accounts get force-upgraded. Name the economic trade-off.
- *"How do you prevent your team from classifying something as 'additive' that actually breaks clients?"* Automated spec-diff in CI (see Exercise 1) plus a written "what counts as breaking" policy. Adding an enum value is *not* breaking only if the spec documented clients must handle unknown values.
- *"What is the `Sunset` header's actual format?"* An IMF-fixdate HTTP-date in GMT per RFC 8594, the same format as `Date` and `Expires`, so `Sunset: Sun, 01 Jun 2025 00:00:00 GMT`. This is a good discriminator question because the natural next step trips most candidates: `Deprecation` is a *different RFC with a different format*. It is RFC 9745, and its value is a structured-fields Date, meaning `@` plus Unix seconds (`Deprecation: @1733011200`), marking when deprecation began. It is not a boolean. If you say "`Deprecation: true`" you are quoting a draft that was never ratified. Complete the answer with `Link: </v2>; rel="successor-version"` (RFC 8288) pointing at the replacement.

### Question 3: How do you keep documentation in sync with code?

**Answer:**

Three main approaches:

```go
// 1. Code-first with swag annotations (recommended for Go)
// Annotations live with code, run swag init to generate spec

// @Summary Create user
// @Param user body CreateUserInput true "User data"
// @Success 201 {object} User
func CreateUser(w http.ResponseWriter, r *http.Request) {
    // Implementation matches annotation
}

// 2. Spec-first with code generation
// Write OpenAPI spec, generate handlers/models
// Use oapi-codegen: oapi-codegen -generate types,server spec.yaml

// 3. Contract testing
// Write tests that verify implementation matches spec
func TestAPIContract(t *testing.T) {
    spec := loadSpec("openapi.yaml")

    // Paths is a struct in current kin-openapi - Map() exposes it as a map.
    for path, pathItem := range spec.Paths.Map() {
        for method, op := range pathItem.Operations() {
            t.Run(fmt.Sprintf("%s %s", method, path), func(t *testing.T) {
                // Generate valid request from spec
                req := generateRequest(op)

                // Execute
                resp := execute(req)

                // Validate response matches spec
                err := validateResponse(resp, op.Responses)
                require.NoError(t, err)
            })
        }
    }
}
```

**What FAANG expects:** The strong answer explicitly compares code-first vs. spec-first and names the failure mode of each: code-first (swag) drifts when annotations lag behind handler changes. spec-first (ogen, oapi-codegen) drifts when the generated server is copy-edited instead of regenerated. The candidate then names the *only* real defense: contract testing in CI that exercises the spec against the running server. Nothing else keeps them honest long-term.

**Follow-ups you should be ready for:**
- *"Have you used `ogen` or `oapi-codegen`? What are the differences?"* Both are spec-first Go codegenerators with no runtime dependencies. `ogen` produces stronger types (`OptNullable[T]` for proper PATCH semantics, checked enums), at the cost of a more opinionated generated surface. `oapi-codegen` produces simpler, more idiomatic Go and is often easier to drop into an existing project.
- *"What is OpenAPI 3.1 and why does it matter?"* It is the OpenAPI version that finally adopted JSON Schema 2020-12, ending the fragmentation where OpenAPI's Schema Object was a near-but-not-quite JSON Schema dialect. Pick 3.1 for new projects. 3.0 is only justified if a critical downstream generator has not caught up.
- *"How would you generate client SDKs for your API?"* For hobby/internal use, OpenAPI Generator templates work. For a polished public SDK (Go, Python, TypeScript), services like Stainless and Fern produce idiomatic clients that Anthropic, OpenAI, and Cloudflare use for their own public SDKs.

### Question 4: How would you implement feature flags for API changes?

**Answer:**

```go
// Use headers for beta features (GitHub-style)
type FeatureFlagMiddleware struct {
    features map[string]FeatureConfig
}

type FeatureConfig struct {
    Name        string
    Enabled     bool
    RolloutPct  int    // Percentage of requests
    AllowList   []string // API keys that can use this feature
    Header      string   // Header to enable feature
}

// Typed context key: a bare string key shares a global namespace with every
// other package and can be silently overwritten.
type ctxKey string

const featuresKey ctxKey = "features"

func (m *FeatureFlagMiddleware) Handle(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        enabledFeatures := make(map[string]bool)

        for name, config := range m.features {
            if m.isFeatureEnabled(r, name, config) {
                enabledFeatures[name] = true
                w.Header().Add("X-Enabled-Features", name)
            }
        }

        // The response body now depends on these request headers, so they
        // must be in Vary or a cache will serve one variant to everyone.
        w.Header().Add("Vary", "X-API-Key")

        ctx := context.WithValue(r.Context(), featuresKey, enabledFeatures)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func (m *FeatureFlagMiddleware) isFeatureEnabled(r *http.Request, name string, config FeatureConfig) bool {
    if !config.Enabled {
        return false
    }

    // Check explicit header opt-in
    if config.Header != "" && r.Header.Get(config.Header) == "true" {
        return true
    }

    // Check allowlist
    apiKey := r.Header.Get("X-API-Key")
    for _, allowed := range config.AllowList {
        if allowed == apiKey {
            return true
        }
    }

    // Check percentage rollout.
    //
    // Hash (apiKey, flagName) together, never apiKey alone. Hashing the key
    // by itself gives every flag the same bucket ordering, so the unlucky
    // customer in bucket 0 is the guinea pig for EVERY experiment while the
    // customer in bucket 99 never sees any of them. Mixing the flag name in
    // decorrelates the buckets across flags.
    if config.RolloutPct > 0 {
        if apiKey == "" {
            return false // no stable identity, do not roll out
        }
        hash := fnv.New32a()
        hash.Write([]byte(apiKey))
        hash.Write([]byte{0}) // separator: avoids ("ab","c") colliding with ("a","bc")
        hash.Write([]byte(name))
        return int(hash.Sum32()%100) < config.RolloutPct
    }

    return false
}

// Usage in handler
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    // Comma-ok, not a bare assertion. A bare .(map[string]bool) panics if
    // this route is ever mounted without the middleware, turning a config
    // mistake into a 500 on every request instead of a safe default.
    features, _ := r.Context().Value(featuresKey).(map[string]bool)

    user, _ := h.service.GetUser(r.Context(), id)

    if features["new_user_format"] {
        json.NewEncoder(w).Encode(toUserV2(user))
    } else {
        json.NewEncoder(w).Encode(toUserV1(user))
    }
}
```

**What FAANG expects:** The candidate distinguishes *feature flags* (experimental opt-in for specific clients, GitHub-preview-style) from *traffic-percentage rollouts* (gradual exposure to all users) and uses different mechanisms for each. They also name the operational risks: feature flags become tech debt when they outlive their experiment, so every flag ships with a removal ticket.

**Follow-ups you should be ready for:**
- *"How do you prevent feature flags from accumulating forever?"* Every flag has an owner and an expiration date. CI fails when a flag has been 100% rolled out for more than N weeks without being deleted. LaunchDarkly and Unleash ship this out of the box.
- *"How do you hash for consistent rollout without stickiness bugs?"* FNV or xxHash of `(api_key, flag_name)` mod 100, with a separator between the two so `("ab","c")` and `("a","bc")` cannot collide. This is exactly what `isFeatureEnabled` above does, and the reason is worth stating: hashing the key alone gives every flag identical bucket boundaries, so the same unlucky customers are the test subjects for every experiment you ever run while others are never sampled at all.
- *"What's different between an API feature flag and an internal-service feature flag?"* Public API flags are a contract with external clients, so you cannot toggle them off without warning. Internal flags can be killed instantly. Treat the two classes with completely different removal discipline.

### Question 5: What information should be included in an API changelog?

**Answer:**

```go
type ChangelogEntry struct {
    Version     string    `json:"version"`
    Date        time.Time `json:"date"`
    Title       string    `json:"title"`

    // Categorized changes
    Breaking    []Change  `json:"breaking,omitempty"`    // Must handle
    Added       []Change  `json:"added,omitempty"`       // New features
    Changed     []Change  `json:"changed,omitempty"`     // Behavior changes
    Deprecated  []Change  `json:"deprecated,omitempty"`  // Will be removed
    Removed     []Change  `json:"removed,omitempty"`     // Already removed
    Fixed       []Change  `json:"fixed,omitempty"`       // Bug fixes
    Security    []Change  `json:"security,omitempty"`    // Security fixes

    // Migration info
    MigrationGuide string `json:"migration_guide,omitempty"`
}

type Change struct {
    Description string   `json:"description"`
    Endpoints   []string `json:"endpoints,omitempty"`
    Before      string   `json:"before,omitempty"`  // Example before change
    After       string   `json:"after,omitempty"`   // Example after change
    PRLink      string   `json:"pr_link,omitempty"` // Link to PR
    DocsLink    string   `json:"docs_link,omitempty"`
}

// Example entry:
var exampleChangelog = ChangelogEntry{
    Version: "2.0.0",
    Date:    time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC),
    Title:   "User API v2 Release",
    Breaking: []Change{
        {
            Description: "User `name` field split into `first_name` and `last_name`",
            Endpoints:   []string{"GET /users", "GET /users/{id}", "POST /users"},
            Before:      `{"name": "John Doe"}`,
            After:       `{"first_name": "John", "last_name": "Doe"}`,
            DocsLink:    "https://docs.api.com/migration/v2-user-names",
        },
    },
    Added: []Change{
        {
            Description: "Added user roles array to response",
            Endpoints:   []string{"GET /users/{id}"},
            After:       `{"roles": ["admin", "editor"]}`,
        },
    },
    MigrationGuide: "https://docs.api.com/migration/v1-to-v2",
}
```

**What FAANG expects:** The interviewer is checking whether you understand a changelog's audience. A changelog is not release notes for internal engineers. It is a *migration manual* for integrators who may have learned about your API six months ago and are reading the changelog cold. That means: (1) breaking changes visually separated at the top of each release entry, (2) `before`/`after` concrete JSON examples (not prose descriptions), (3) stable anchor links per entry so they can be cited in PRs and support tickets, and (4) an RSS/Atom feed so clients can subscribe programmatically.

**Follow-ups you should be ready for:**
- *"How do you automate changelog generation?"* Conventional-commits-style commit messages plus a generator (`git-cliff`, `release-please`), or annotate PRs with a `changelog:` block that CI extracts. Fully hand-written changelogs always drift.
- *"How do you prevent a team member from classifying something as non-breaking when it is?"* A written policy (field rename = breaking. Adding an enum value = breaking unless the spec documents forward-compatibility. changing HTTP status code = breaking) plus a CI check that diffs the OpenAPI spec and blocks the merge if any breaking-change signature appears without a major version bump.
- *"Who actually reads an API changelog?"* Honest answer: almost nobody reads it voluntarily. Which is why runtime `Deprecation` and `Sunset` headers, plus direct emails to affected API key owners, matter more than any changelog page. Treat the changelog as the record of record, not the primary communication channel.

### Junior to FAANG: Entry-Level Interview Ladder

Prerequisite gap. Juniors often conflate versioning with "add /v2 to the URL." That answers the L3 signal but not the L4 or L5 signal. Before the interview, learn these four distinctions cold: axis choice (URL, header, media type, hybrid), compatibility rules (what is additive, what is breaking), deprecation signals (the `Deprecation` header per RFC 9745 and the `Sunset` header per RFC 8594, which are separate RFCs with separate value formats), and documentation sync (code-first vs spec-first, contract testing).

Worked example for an L3 question. "Your team needs to add an optional `timezone` field to the user response. Do you need a new version?" Answer: no, optional additive fields are safe on any versioning strategy. Ship it, update the OpenAPI schema, and move on. The trap is overthinking the question and proposing `/v2`. Overengineering in interviews signals fear, not skill.

First-job context for interviews. At L3 and L4, interviewers are not asking you to design the platform. They want to see that you know what breaks clients, how to write a handler that serves two shapes at once, and how to add Deprecation headers without affecting unrelated responses. Practice writing a middleware that emits Deprecation and Sunset headers in twenty lines of Go. That is the muscle.

"Why did this fail?" reflex in interviews. When the interviewer describes a bug ("clients started failing after deploy"), your first question is "what changed in the response schema." Not "what was in the logs." Schema first.

Interview entry point ladder L3 to L7:

- L3. Implement a handler that reads a version from a header and returns two shapes.
- L4. Design URL versus header versioning for a new public API and justify the trade-off.
- L5. Design versioning for a public API at 1M developer keys, including deprecation telemetry, Sunset enforcement, and SDK codegen.
- L6. Migrate 200 endpoints from v1 to v2 over eighteen months with zero customer breakage and a public dashboard for leadership.
- L7. Define the versioning contract for an entire developer platform across fifty microservices, including governance, review boards, and a cross-org maturity model.

### Senior at FAANG: Bar-Raiser Scenarios and Signals

Staff and principal interviews test platform judgment. The bar-raiser questions below are representative of the L5 to L7 loop.

Bar-raiser 1. Migrate 200 endpoints from v1 to v2 over eighteen months. The signal they are measuring is whether you propose a flag day (fail) or a gradual migration with per-endpoint telemetry (pass). Structure: inventory all endpoints, classify each as additive-only or breaking, ship v2 as a superset, emit Deprecation headers on v1 with per-endpoint Sunset dates, build a dashboard keyed by customer and endpoint, define exit criteria as zero traffic for thirty days, and stagger sunsets so no customer sees more than five endpoints disappear per month.

Bar-raiser 2. Sunset an endpoint with 10K daily callers. Signal: do you measure per-customer or only aggregate. Staff answer: per-customer telemetry, direct email campaign to top callers, Deprecation and Sunset headers, migration guide with before and after examples, office hours for top ten callers, a sandbox that returns a warning banner in the response, and a hard sunset only after thirty consecutive days of zero traffic across all customers, not just aggregate.

Bar-raiser 3. Unify inconsistent APIs across fifty microservices. Signal: do you reach for a rewrite (fail) or propose an API gateway with translation rules and a deprecation timeline (pass). Staff answer: introduce an API gateway, define a target schema in OpenAPI, write gateway translation rules per service, shadow traffic to validate translations, cut over gradually behind a feature flag, keep backend services unchanged until the gateway contract is stable, then migrate backend services one at a time behind the stable gateway contract.

Bar-raiser 4. Design an SDK codegen pipeline across eight languages. Signal: do you understand that SDKs are part of the versioning contract. Staff answer: single source OpenAPI spec, pinned version per release, deterministic codegen with a locked template set, semantic version alignment across all SDKs, golden file tests per language, a publish pipeline that emits simultaneously to all registries, and a policy that SDK-only bug fixes bump the patch version without touching the server.

Interview signal ladders L3 to L7 in detail:

- L3. Knows the difference between additive and breaking. Can implement a versioned handler. Writes correct Deprecation headers.
- L4. Chooses a versioning axis with justification. Can implement a deprecation middleware with telemetry. Understands contract testing.
- L5. Designs versioning for 1M developer keys. Names the transform layer cost. Proposes a per-customer usage dashboard. Has a written policy.
- L6. Owns cross-team migration. Coordinates SDK codegen, docs, changelog, and telemetry as one pipeline. Reports to leadership quarterly.
- L7. Sets platform-wide versioning policy. Establishes API review board. Defines the maturity model. Governs the relationship between product teams and the platform.

ADR template for a cross-team migration:

1. Scope. Endpoints in migration, expected customer impact, SDK languages affected.
2. Approach. Superset v2, gateway translation, or clean-room rewrite. Justify.
3. Timeline. Per-phase dates, exit criteria per phase, rollback plan.
4. Telemetry. Per-customer dashboard URL, alerting thresholds.
5. Governance. Review board approval, leadership report cadence, escalation path.

Maturity model L1 to L5 for interview signal:

- L1. Knows URL versioning exists.
- L2. Can defend a versioning choice.
- L3. Can implement deprecation signals and migration tooling.
- L4. Can design platform-wide versioning for millions of keys.
- L5. Can govern versioning across an entire org with a written policy, review board, and maturity model.

---
