## API Versioning Pitfalls: When Evolution Breaks Everything

### The Sunset Without Warning Disaster

**The failure mode**: A team deprecates v1 with six months of notice, announced in a blog post. That sounds generous and is nearly useless. A blog post reaches people who already follow you, which is the population least likely to be running an integration written three years ago by someone who has since left. Enterprise customers on long release cycles never see it, because nobody on the team that owns the integration reads your blog. On sunset day v1 starts returning 410 and their production systems fail at once. The contractual dimension makes it worse: enterprise agreements frequently guarantee a notice period measured in years, so a six-month sunset can breach the contract regardless of how loudly it was announced.

The lesson is not "give more notice." It is that notice must be *delivered on a channel the integration's owner actually receives*, and you cannot know whether it was received without per-customer telemetry showing they stopped calling. Passive announcement is not notice. It is hope.

```go
// WRONG: Hard cutoff with no runtime warnings
func APIMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := extractVersion(r)

        if version == "v1" {
            http.Error(w, "API v1 has been sunset", http.StatusGone)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// CORRECT: Progressive deprecation with multiple warning channels
type DeprecationManager struct {
    db *sql.DB
}

func (d *DeprecationManager) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := extractVersion(r)

        policy := d.getDeprecationPolicy(version)

        switch policy.Status {
        case StatusActive:
            // No deprecation warnings
            next.ServeHTTP(w, r)

        case StatusDeprecated:
            // Deprecation (RFC 9745) is "@" + Unix seconds.
            // Sunset (RFC 8594) is an HTTP-date. Different RFCs, different
            // formats. Formatting Deprecation as an HTTP-date produces a
            // header no compliant client will parse.
            setDeprecationHeaders(w, policy)

            // Log usage for tracking
            d.logDeprecatedUsage(r, version)

            // Still serve the request
            next.ServeHTTP(w, r)

        case StatusSunsetting:
            setDeprecationHeaders(w, policy)

            // No Warning header here. RFC 9111 removed Warning from HTTP, and
            // "299" is a warn-code from that obsolete header, not an HTTP
            // status code. Anything built on either is built on nothing.
            // The escalation that works is behavioral: scheduled brownouts,
            // plus direct contact with the owner.

            // Notify the API key owner. Extract what the notification needs
            // BEFORE starting the goroutine: r is invalid once the handler
            // returns, its context is canceled and its body is closed, so
            // touching it from a background goroutine is a data race at best.
            note := sunsetNotice{
                APIKey:         extractAPIKey(r),
                APIVersion:     version,
                DaysRemaining:  int(time.Until(policy.SunsetAt).Hours() / 24),
                MigrationGuide: policy.MigrationGuideURL,
            }
            go d.notifyOwnerOfImminentSunset(note)

            next.ServeHTTP(w, r)

        case StatusSunset:
            // Return error with helpful migration info
            w.Header().Set("Content-Type", "application/json")
            w.WriteHeader(http.StatusGone)
            json.NewEncoder(w).Encode(map[string]any{
                "error":              "api_version_sunset",
                "message":            fmt.Sprintf("API %s has been sunset", version),
                "sunset_date":        policy.SunsetAt.Format(time.RFC3339),
                "migration_guide":    policy.MigrationGuideURL,
                "successor_version":  policy.SuccessorVersion,
                "support_contact":    "api-support@example.com",
            })
        }
    })
}

// setDeprecationHeaders writes the standards-compliant signal set.
func setDeprecationHeaders(w http.ResponseWriter, policy DeprecationPolicy) {
    // RFC 9745: structured-fields Date, "@" + Unix seconds.
    w.Header().Set("Deprecation", fmt.Sprintf("@%d", policy.DeprecatedAt.Unix()))
    // RFC 8594: HTTP-date, in GMT.
    w.Header().Set("Sunset", policy.SunsetAt.UTC().Format(http.TimeFormat))
    // RFC 8288 Web Linking.
    if policy.SuccessorURL != "" {
        w.Header().Add("Link", fmt.Sprintf("<%s>; rel=\"successor-version\"", policy.SuccessorURL))
    }
    if policy.MigrationGuideURL != "" {
        w.Header().Add("Link", fmt.Sprintf("<%s>; rel=\"deprecation\"", policy.MigrationGuideURL))
    }
}

// sunsetNotice carries everything the notifier needs, copied out of the
// request while it is still valid.
type sunsetNotice struct {
    APIKey         string
    APIVersion     string
    DaysRemaining  int
    MigrationGuide string
}

func (d *DeprecationManager) notifyOwnerOfImminentSunset(note sunsetNotice) {
    owner := d.getAPIKeyOwner(note.APIKey)

    // Check if we've notified recently
    if d.hasNotifiedRecently(owner.ID, 7*24*time.Hour) {
        return
    }

    // Send email, Slack, or SMS, whatever the customer configured
    d.sendNotification(owner, NotificationSunsetWarning{
        APIVersion:     note.APIVersion,
        DaysRemaining:  note.DaysRemaining,
        MigrationGuide: note.MigrationGuide,
    })

    d.recordNotification(owner.ID)
}
```

### The Breaking Change Hidden in a "Patch"

**The failure mode**: A team releases a "bug fix" that changes a field from `string` to `int`, reasoning that "the string was always numeric anyway." That reasoning is about *values*. Clients bind on *types*. A Swift `Codable` or Kotlin Moshi model declaring `id: String` throws at decode the instant the server sends `12345` instead of `"12345"`, and it throws for the whole response, not just that field, so the entire screen fails.

What makes this class so dangerous is that mobile amplifies it. A broken web client is fixed by a deploy. A broken mobile client is fixed by a release, an app store review, and a user choosing to update, which means the blast radius persists for weeks after the server-side change is reverted. The server team sees a clean rollback. The users do not.

```go
// Version 1.0: Returns string ID
type UserResponseV1 struct {
    ID   string `json:"id"` // "12345"
    Name string `json:"name"`
}

// Version 1.0.1: "Bug fix" changes to int - BREAKING!
type UserResponseV1Fixed struct {
    ID   int64  `json:"id"` // 12345 - BREAKS CLIENTS!
    Name string `json:"name"`
}

// CORRECT: String to int is a MAJOR version change
// Keep v1 as-is, create v2

type UserResponseV2 struct {
    ID   int64  `json:"id"` // 12345
    Name string `json:"name"`
}

// Better: Support both formats for a transition period
type UserResponseFlexible struct {
    ID   FlexibleID `json:"id"`
    Name string     `json:"name"`
}

type FlexibleID int64

func (f FlexibleID) MarshalJSON() ([]byte, error) {
    // Always output as integer for consistency
    return json.Marshal(int64(f))
}

func (f *FlexibleID) UnmarshalJSON(data []byte) error {
    // Accept both string and int on input
    var i int64
    if err := json.Unmarshal(data, &i); err == nil {
        *f = FlexibleID(i)
        return nil
    }

    var s string
    if err := json.Unmarshal(data, &s); err == nil {
        i, err := strconv.ParseInt(s, 10, 64)
        if err != nil {
            return err
        }
        *f = FlexibleID(i)
        return nil
    }

    return fmt.Errorf("id must be string or integer")
}

// Define what IS and ISN'T a breaking change
/*
BREAKING CHANGES (require major version bump):
- Changing field type (string → int, even if values are same)
- Removing a field
- Renaming a field
- Changing field from optional to required
- Changing response structure (object → array)
- Changing HTTP status codes
- Changing error codes/format
- Changing authentication method
- Reducing rate limits

NOT BREAKING (can be patch/minor):
- Adding optional fields
- Adding new endpoints
- Adding new optional query parameters
- Increasing rate limits
- Adding new error codes (if clients handle unknown codes)
*/
```

### The Documentation Drift Disaster

**The failure mode**: Documentation says the `limit` parameter accepts 1-100. The implementation actually accepts 1-1000. Nothing appears wrong for months. Then a developer tries `limit=500`, observes that it works, and ships code depending on it. Later someone "fixes" the implementation to match the documentation and breaks that customer's production system.

Note who is at fault, because it is counterintuitive and it matters for how you respond. The customer built on undocumented behavior, which is their risk. But *you* created the trap: the gap between the documented contract and the enforced contract is a promise the server was silently making. Every unenforced constraint in your docs is an invitation for someone to discover the real limit empirically and depend on it. This is why the fix is not "document it better," it is to make one declaration drive both the document and the runtime check, so the gap cannot exist.

```go
// WRONG: Documentation separate from code
// swagger.yaml says limit max: 100
// Code does something different:
func listUsers(w http.ResponseWriter, r *http.Request) {
    limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
    if limit <= 0 || limit > 1000 { // Different from docs!
        limit = 50
    }
    // ...
}

// CORRECT: Documentation generated from code
// @Summary List users
// @Param limit query int false "Number of results (1-100)" minimum(1) maximum(100) default(50)
func listUsers(w http.ResponseWriter, r *http.Request) {
    limit := parseIntParam(r, "limit", 50)

    // Validation matches documentation
    if limit < 1 {
        limit = 1
    }
    if limit > 100 {
        limit = 100
    }

    // ...
}

// Or use constants that drive both code and docs
const (
    MinLimit     = 1
    MaxLimit     = 100
    DefaultLimit = 50
)

// @Summary List users
// @Param limit query int false "Number of results" minimum(1) maximum(100) default(50)
func listUsers(w http.ResponseWriter, r *http.Request) {
    limit := parseIntParamBounded(r, "limit", DefaultLimit, MinLimit, MaxLimit)
    // ...
}

// Test that documentation matches implementation
func TestLimitMatchesDocs(t *testing.T) {
    spec, err := openapi3.NewLoader().LoadFromFile("openapi.yaml")
    require.NoError(t, err) // a swallowed error here makes the test vacuous

    // Paths is a struct, so Find() rather than indexing.
    pathItem := spec.Paths.Find("/users")
    require.NotNil(t, pathItem)

    param := pathItem.Get.Parameters.GetByInAndName("query", "limit")
    require.NotNil(t, param)
    require.NotNil(t, param.Schema.Value.Min)
    require.NotNil(t, param.Schema.Value.Max)

    // Min and Max are *float64. Comparing them directly against a float64
    // compares a pointer to a value and can never be equal, so the assertion
    // would fail on a perfectly correct spec. Dereference first.
    assert.Equal(t, float64(MinLimit), *param.Schema.Value.Min)
    assert.Equal(t, float64(MaxLimit), *param.Schema.Value.Max)

    // Default is an `any` holding whatever the YAML decoded to, so compare
    // through a numeric conversion rather than asserting a concrete type.
    assert.EqualValues(t, DefaultLimit, param.Schema.Value.Default)
}
```

### Quick Reference: API Versioning Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Silent sunset | Production outages | Deprecation headers, direct notifications |
| "Bug fix" breaking changes | Client crashes | Strict breaking change definition |
| Documentation drift | Behavior mismatch | Generate docs from code |
| Missing version detection | Can't track usage | Log version with all requests |
| No migration path | Stuck on old version | Provide codemods, migration guides |
| Version in response body | Can't route at edge | Version in URL or header |
| Mixing strategies | Confusion | Pick one strategy, stick with it |
| No version for internal APIs | Breaking changes between services | Version all APIs, even internal |

### Junior to FAANG: Recognizing Pitfall Patterns

Prerequisite gap. The three incidents above look different on the surface but share one root cause: someone decided unilaterally what counts as breaking without checking against a shared policy. Juniors often carry the assumption that "if the behavior looks the same to me, it is additive." That assumption breaks strongly typed clients every time.

Worked example of the type swap. A teammate submits a PR changing `id` from string to int. The change looks clean. The test suite passes because Go tests marshal and unmarshal on the same side. Mobile clients using Codable in Swift or Moshi in Kotlin will crash at decode time. Your job as a reviewer is to catch this and comment "type changes are always breaking, please add a new field `numeric_id` instead and deprecate `id`."

First-job context. You will be asked to ship a "small fix." Before you do, run the three-question check: does this change any field type, does this change any field's required status, does this remove or rename any field. If any answer is yes, it is a version bump, not a patch.

"Why did this fail?" reflex. When the pager fires after a deploy and a customer reports decode errors, the first suspect is schema drift. Diff the OpenAPI spec between the last green deploy and head. If anything in the diff matches a breaking signature, you found the bug in sixty seconds.

Interview entry point. "Tell me about a time an API change broke customers." Even if you have not lived it, the answer structure is: describe the change, describe the client-side failure mode, describe the detection mechanism, describe the rollback, describe the policy change that prevents recurrence. The last step is the signal.

### Senior at FAANG: Platform-Grade Pitfall Prevention

Staff engineers do not prevent these incidents with review comments. They prevent them with structural controls.

Silent sunset prevention. Per-customer telemetry is the non-negotiable control. A sunset cannot proceed until the dashboard shows zero traffic from every customer for a configured window. Contracts with enterprise customers often guarantee 18 to 24 months of notice. Encode the guarantee in the telemetry system. The Sunset header is the machine-readable signal. The direct email to the API key owner is the human signal. The in-product banner on the developer portal is the third channel. Three independent channels, because any single channel will miss the long-tail.

Hidden breaking change prevention. The breaking-change detector from exercise 1 runs in CI as a required check. The policy document enumerates every breaking signature. The API review board has override authority with an ADR. No ADR, no override. The FlexibleID pattern shown above is a staff-grade technique for migrations that must accept both old and new types during a transition, but it is a transition mechanism, not a permanent contract. Add a telemetry counter on which input shape clients send and a plan to remove the flexibility after the transition.

Documentation drift prevention. Single source of truth is the only durable fix. Derive the OpenAPI schema, the handler validation, and the SDK codegen from one declaration. Contract tests in CI exercise every path and method against the live handler and fail the build on mismatch. The constant pattern shown above (MinLimit, MaxLimit, DefaultLimit) is a starting point. The mature form is a struct tag or a code-generated validator that drives both runtime enforcement and the OpenAPI document from the same source.

Staff-grade incident postmortem checklist. When one of these pitfalls triggers an incident, the postmortem must include: the exact diff that introduced the break, which CI check should have caught it, why the check did not catch it, what control is being added to prevent recurrence, the telemetry signal that would have shortened detection, and the customer communication timeline. Anything less is theater.

ADR template for a versioning policy document:

1. Scope. Which APIs, which teams, which regions.
2. Axis. URL, header, media type, or hybrid. Justified.
3. Compatibility rules. Explicit list of breaking and additive signatures.
4. Deprecation. Headers, telemetry, timeline, exit criteria.
5. Governance. Review board, override authority, audit log.
6. Tooling. Detector, dashboard, migration assistant.
7. Review cadence. Quarterly or annual.

Maturity model L1 to L5 for pitfall prevention:

- L1. Incidents happen. Nobody writes them down.
- L2. Incidents happen. Postmortems exist but do not drive policy.
- L3. Postmortems drive policy. Policy is written. Some checks are automated.
- L4. Checks gate CI. Telemetry is per customer. Deprecation has exit criteria.
- L5. Policy is code. Controls are structural. Incidents are rare and the rare cases drive platform-wide improvements within the same quarter.

---
