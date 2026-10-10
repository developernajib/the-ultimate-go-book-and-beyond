## 41.7 Company Case Studies

### How Stripe Versions Their API

Stripe uses date-based versioning with backwards-compatible changes by default. Each Stripe account is pinned to the version that was current when it was created, so existing integrations never see behavior changes unless the developer explicitly upgrades via the dashboard or overrides per-call with the `Stripe-Version` header. The URL stays at `/v1` forever. The real versioning lives in a date header such as `Stripe-Version: 2026-01-15`. A server-side "version gates" layer transforms responses to match the caller's pinned version, so a single handler serves every historical version. The cost of maintaining that transform layer is real, and it is the reason Stripe has avoided a breaking bump for over a decade.

```go
// Stripe's Date-Based Versioning
// Header: Stripe-Version: 2024-01-15
// Dashboard default version applies when header omitted

// Typed context keys, reusing the pattern from 41.1. A bare string key such
// as context.WithValue(ctx, "api_version", v) compiles and passes go vet, but
// the key namespace is global: any other package that happens to use the same
// string silently overwrites your value. An unexported named type cannot
// collide with a key from any other package. staticcheck flags the string
// form as SA1029.
type ctxKey string

const (
    versionKey  ctxKey = "api_version"
    previewsKey ctxKey = "previews"
)

type StripeVersioningMiddleware struct {
    defaultVersion string // Account's default version from dashboard
    versions       map[string]*VersionConfig
}

type VersionConfig struct {
    Released    time.Time
    Deprecated  *time.Time
    Changes     []VersionChange
}

type VersionChange struct {
    Description string
    Field       string
    OldBehavior string
    NewBehavior string
}

func (m *StripeVersioningMiddleware) Handle(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := r.Header.Get("Stripe-Version")
        if version == "" {
            version = m.defaultVersion // From API key's account settings
        }

        // Validate version exists
        config, exists := m.versions[version]
        if !exists {
            ErrorResponse(w, 400, "INVALID_VERSION",
                fmt.Sprintf("Unknown API version: %s", version))
            return
        }

        // Check if deprecated
        if config.Deprecated != nil && time.Now().After(*config.Deprecated) {
            w.Header().Set("Stripe-Deprecated-Version", version)
            w.Header().Set("Stripe-Latest-Version", m.getLatestVersion())
        }

        // Add version to response
        w.Header().Set("Stripe-Version", version)

        ctx := context.WithValue(r.Context(), versionKey, version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Key insight: Changes are ADDITIVE by default
// - New fields can be added without version change
// - New enum values are documented but don't require version change
// - Behavior changes require new version
// - Field removals require new version
// - Type changes require new version
```

### How GitHub Versions Their API

GitHub versions its REST API with a **header**, not a URL segment. Requests carry `X-GitHub-Api-Version: 2022-11-28`, and a request that omits the header defaults to `2022-11-28`, the first dated version, which captured the API exactly as it behaved before versioning was introduced. This is worth stating plainly because `/api/v3` is widely miscited as GitHub's REST version. That path belongs to GitHub Enterprise Server installations, and the old `Accept: application/vnd.github.v3+json` media type is a separate, earlier mechanism. Neither is how `api.github.com` versions today.

The policy around the header is the interesting part. Additive changes land in every supported version, so only breaking changes create a new dated version, and advance notice precedes them. When a new version ships, the previous one is supported for at least 24 further months. Call a version outside that window and you get `410 Gone`, not a silent fallback to the newest behavior, which is the correct choice: failing loudly beats quietly changing the meaning of a request.

GitHub separately uses custom `Accept` media types (for example `application/vnd.github.squirrel-girl-preview+json`) to gate *experimental* features, tracking adoption to decide when to graduate them. Keep the two mechanisms distinct in your head: the header selects the API version, media-type previews opt into unstable features. The middleware below models the preview mechanism.

```go
// GitHub's versioning: X-GitHub-Api-Version header (dated versions).
// Separately, previews opt in to experimental features via Accept:
//   Accept: application/vnd.github.squirrel-girl-preview+json

type GitHubVersioningMiddleware struct {
    previews map[string]PreviewFeature
}

type PreviewFeature struct {
    Name        string
    MediaType   string
    Description string
    Stable      bool   // Graduated to stable
    Deprecated  bool   // Being removed
}

func (m *GitHubVersioningMiddleware) Handle(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        accept := r.Header.Get("Accept")

        // Parse preview features from Accept header
        enabledPreviews := m.parsePreviewHeaders(accept)

        // Track preview usage for graduation decisions
        for _, preview := range enabledPreviews {
            metrics.IncrementCounter("preview_usage", map[string]string{
                "preview": preview,
                "path":    r.URL.Path,
            })

            // Warn about deprecated previews
            if feature, ok := m.previews[preview]; ok && feature.Deprecated {
                w.Header().Add("X-GitHub-Warning",
                    fmt.Sprintf("Preview '%s' is deprecated and will be removed", preview))
            }
        }

        ctx := context.WithValue(r.Context(), previewsKey, enabledPreviews)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Compiled once at package level, not per request. This regex sits on the
// hot path of every request that carries an Accept header.
var previewRe = regexp.MustCompile(`vnd\.github\.([a-z-]+)-preview`)

func (m *GitHubVersioningMiddleware) parsePreviewHeaders(accept string) []string {
    // Parse: application/vnd.github.squirrel-girl-preview+json
    var previews []string
    for _, part := range strings.Split(accept, ",") {
        part = strings.TrimSpace(part)
        if matches := previewRe.FindStringSubmatch(part); len(matches) > 1 {
            previews = append(previews, matches[1])
        }
    }
    return previews
}
```

### How Twilio Documents Their API

Twilio uses date-versioned URL paths (e.g., `/2010-04-01/Accounts/...`) and ships code samples in seven or more languages for every endpoint. Their documentation includes an interactive console that lets developers make live API calls from the browser, reducing the time from reading docs to a working integration.

```go
// Twilio's Documentation Patterns
// - Date-versioned paths: /2010-04-01/Accounts/...
// - Code samples in 7+ languages for every endpoint
// - Interactive console in documentation
// - Webhook signature verification examples

type TwilioDocGenerator struct {
    baseURL string
}

// Generate multi-language code samples
func (g *TwilioDocGenerator) GenerateCodeSamples(endpoint Endpoint) map[string]string {
    samples := make(map[string]string)

    // Go sample
    samples["go"] = g.generateGoSample(endpoint)

    // cURL sample
    samples["curl"] = g.generateCurlSample(endpoint)

    // Python sample
    samples["python"] = g.generatePythonSample(endpoint)

    // JavaScript sample
    samples["javascript"] = g.generateJSSample(endpoint)

    // Java sample
    samples["java"] = g.generateJavaSample(endpoint)

    // PHP sample
    samples["php"] = g.generatePHPSample(endpoint)

    // Ruby sample
    samples["ruby"] = g.generateRubySample(endpoint)

    return samples
}

func (g *TwilioDocGenerator) generateGoSample(e Endpoint) string {
    template := `package main

import (
    "fmt"
    twilio "github.com/twilio/twilio-go"
    api "github.com/twilio/twilio-go/rest/api/v2010"
)

func main() {
    client := twilio.NewRestClient()

    params := &api.{{.OperationName}}Params{}
{{range .Parameters}}
    params.Set{{.Name | title}}("{{.Example}}")
{{end}}

    resp, err := client.{{.Resource}}.{{.OperationName}}(params)
    if err != nil {
        fmt.Println(err.Error())
    } else {
        fmt.Println(*resp.Sid)
    }
}`

    return executeTemplate(template, e)
}

// Interactive API console
type APIConsole struct {
    accountSid string
    authToken  string
}

func (c *APIConsole) Execute(endpoint, method string, params map[string]string) (*http.Response, error) {
    req, _ := http.NewRequest(method, endpoint, nil)
    req.SetBasicAuth(c.accountSid, c.authToken)

    // Add params as query or body based on method
    if method == "GET" {
        q := req.URL.Query()
        for k, v := range params {
            q.Add(k, v)
        }
        req.URL.RawQuery = q.Encode()
    } else {
        form := url.Values{}
        for k, v := range params {
            form.Add(k, v)
        }
        req.Body = io.NopCloser(strings.NewReader(form.Encode()))
        req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
    }

    return http.DefaultClient.Do(req)
}
```

### Junior to FAANG: Reading Real Versioning Strategies

Prerequisite gap most juniors hit: they copy `/v1` into a URL without understanding that Stripe, Twilio, and GitHub all picked different axes (date header, date path, URL segment plus media type) for concrete reasons tied to their customer base. If your first job ships a public API, the reflex to learn is "which axis matches our release cadence and our customers' tolerance for churn." A Stripe-style dated version header makes sense when you have thousands of integrators who cannot coordinate upgrades. A GitHub-style media-type preview makes sense when you want opt-in experimentation without polluting the stable surface.

Worked example. Suppose you inherit a small internal API with three consumers, all of whom you can reach by email. URL versioning at `/v1` is fine. Now imagine the same API exposed to 5,000 partner integrators where each partner has a different release cycle. URL versioning forces a flag day when you cut `/v2`. Dated versioning lets each integrator stay pinned until they opt in. The mechanism is not the decision. The decision is who bears the upgrade cost.

First-job context. In your first year you will almost never design a versioning scheme from scratch. You will inherit one and extend it. The skill that gets noticed is catching an accidental breaking change during code review, such as changing a field from string to object, renaming an enum value, or tightening a validator. The "why did this fail?" reflex: when a customer reports a sudden 400, check the diff of the response schema in the last two weeks before you blame the customer.

Interview entry point. Expect "design a versioning strategy for a public REST API." The answer ladder is: pick an axis (URL, header, media type), explain backwards compatibility rules (additive is safe, removal and type changes are not), describe deprecation signals (the `Sunset` header per RFC 8594 and the `Deprecation` header per RFC 9745, which are different RFCs with different value formats), and name the operational cost (request transform layer, SDK regeneration, doc site per version).

### Senior at FAANG: API Versioning Governance and Platform Maturity

Staff and principal engineers are measured on how an API ecosystem evolves across years, not on any single endpoint. The case studies above embed hard platform lessons.

Stripe's dated versioning. The staff-level ADR is not "pick dates" but "invest in a version transform pipeline." Every request and response passes through an ordered chain of migrations, each of which adapts a later version to an earlier pinned version. The cost is a permanent tax on every handler author, who must write a migration when they change behavior. The payoff is that Stripe has not forced a v2 migration on customers since launch. When you propose this pattern, budget a dedicated platform team of three to five engineers for the transform infrastructure, property-based tests that verify round-trip equivalence, and an internal doc requiring every PR that changes a response shape to include a migration or an explicit "additive" label.

Shopify's quarterly schedule. Shopify ships a stable API version at the start of each quarter, named by date (`2026-04`). Each stable version is supported for a minimum of 12 months, and consecutive versions overlap by at least 9 months. Keep those two numbers straight: 12 months is how long your version keeps working, 9 months is the guaranteed window in which both the old and new versions are live so you can migrate incrementally rather than cutting over on a single day. The governance lesson is predictability. Partners plan migrations against a known calendar instead of reacting to ad hoc deprecations. The maturity signal is a public versioning policy document, a programmatic version manifest, and dashboards that show each partner which versions their keys call.

GitHub's dual-surface maintenance. GitHub has run its REST API alongside a GraphQL API for years, and every security patch and schema addition has to land in both surfaces. That is the real cost of offering two paradigms. The staff call is when to declare a surface frozen, what "frozen" means operationally (no new endpoints, security fixes only), and how to measure adoption to justify eventual sunset. Note the versioning commitment underneath: when GitHub ships a new dated REST version, the prior version stays supported for at least 24 further months, and calls to an unsupported version return `410 Gone`. A hard, published support window plus a loud failure mode is what makes a long tail governable rather than infinite.

AWS deprecation pain. AWS SDKs historically pinned to specific service API dates, and upgrading an SDK sometimes silently changed response shapes. The lesson is that SDK codegen is part of the versioning contract. If you ship SDKs in eight languages, your versioning pipeline must produce deterministic artifacts per version with semver alignment and a documented changelog.

Twilio. Twilio's date-path strategy has a hidden cost. Every new date creates a parallel route tree. The staff discipline is aggressive use of shared handlers with thin version adapters, not duplicated controllers.

Google Ads. Google Ads enforces hard sunsets with a public deprecation schedule and a mandatory migration tool. The staff lesson is that deprecation without tooling fails. Customers will not migrate on goodwill. Ship a migration assistant, a diff tool, and a dashboard showing per-customer call volume on deprecated versions.

Slack. Slack's API evolution is cautious because bot authors cannot always be reached. The staff pattern is "never break, always add." When a capability must change, ship a new method under a new name and let the old one drift into irrelevance.

PayPal version sprawl. PayPal accumulated multiple REST APIs with overlapping scope because product teams shipped independent versions. The staff lesson is that versioning without a single API review board produces fragmentation. Establish a platform API council with veto rights on new surfaces.

ADR template for a versioning decision:

1. Context. Customer count, upgrade tolerance, release cadence, SDK languages.
2. Options. URL, header, media type, hybrid. Explicit cost per option.
3. Decision. Chosen axis and the invariants it guarantees.
4. Consequences. Who writes migrations, who owns the transform layer, how deprecation is signaled, how sunset is measured.

Maturity model L1 to L5 for API lifecycle governance:

- L1 Ad hoc. No versioning policy. Breaking changes ship on master. Customers learn by failure.
- L2 Reactive. URL versioning exists. Breaking changes happen but are announced in a changelog after the fact.
- L3 Defined. Written versioning policy. Deprecation headers present. Public changelog. Sunset dates announced.
- L4 Managed. Version manifest is programmatic. Per-customer telemetry tracks version adoption. Migration tooling ships with every major change. SDK codegen is version-locked.
- L5 Optimized. Request transform layer serves all historical versions from one handler. Property-based tests enforce round-trip equivalence. API review board governs new surfaces. Maturity is measured quarterly and reported to leadership.

---
