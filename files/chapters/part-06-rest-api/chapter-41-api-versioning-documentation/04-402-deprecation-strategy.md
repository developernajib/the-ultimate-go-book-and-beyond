## 41.2 Deprecation Strategy

### Deprecation Headers

The `Deprecation` middleware injects the standard headers on every response from a deprecated route: the `Deprecation` header (RFC 9745) carrying *when* the deprecation took effect, the `Sunset` header (RFC 8594) carrying the date the endpoint goes offline, and `Link` headers (RFC 8288) pointing to the successor version and the migration guide. Attaching this as middleware rather than duplicating header writes in each handler ensures no deprecated endpoint silently omits the warning.

Two format details are worth pinning down, because almost every example on the web gets them wrong. `Deprecation` is **not** a boolean. `Deprecation: true` was an early draft spelling that never made it into the RFC. RFC 9745 defines the value as a structured-fields Date: an `@` followed by Unix seconds, for example `Deprecation: @1733011200`, and it describes a moment in the past (when the endpoint became deprecated) or, occasionally, a scheduled future deprecation. `Sunset` is a different format entirely, an HTTP-date such as `Sun, 01 Jun 2025 00:00:00 GMT`. Two adjacent headers, two unrelated encodings. Always produce them with `time` formatting rather than by hand.

```go
// ... imports omitted for brevity (fmt, net/http, time,
// github.com/go-chi/chi/v5)

// DeprecationInfo holds deprecation metadata
type DeprecationInfo struct {
    Version int
    // DeprecatedAt is when the endpoint became deprecated, normally in the
    // past. It is what the RFC 9745 Deprecation header carries.
    DeprecatedAt time.Time
    // SunsetDate is when the endpoint stops responding, in the future.
    SunsetDate  time.Time
    Successor   string
    DocumentURL string
}

// Deprecation middleware adds deprecation headers
func Deprecation(info DeprecationInfo) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Deprecation header (RFC 9745). The value is a structured-fields
            // Date: "@" followed by Unix seconds. NOT the string "true", which
            // is a pre-RFC draft spelling that no compliant client parses.
            w.Header().Set("Deprecation",
                fmt.Sprintf("@%d", info.DeprecatedAt.Unix()))

            // Sunset header (RFC 8594): an HTTP-date, a completely different
            // encoding from Deprecation above. http.TimeFormat gets the
            // day-of-week right, which hand-written dates routinely do not.
            w.Header().Set("Sunset", info.SunsetDate.UTC().Format(http.TimeFormat))

            // Link relations (RFC 8288)
            if info.Successor != "" {
                w.Header().Add("Link", fmt.Sprintf("<%s>; rel=\"successor-version\"", info.Successor))
            }
            if info.DocumentURL != "" {
                w.Header().Add("Link", fmt.Sprintf("<%s>; rel=\"deprecation\"", info.DocumentURL))
            }

            // Human-readable notice. Clamp at zero: without this, every
            // response after the sunset date advertises "removed in -12 days",
            // which is how you learn the sunset silently never happened.
            daysRemaining := int(time.Until(info.SunsetDate).Hours() / 24)
            switch {
            case daysRemaining > 0:
                w.Header().Set("X-Deprecation-Notice",
                    fmt.Sprintf("API v%d is deprecated and will be removed in %d days. Please migrate to %s",
                        info.Version, daysRemaining, info.Successor))
            default:
                w.Header().Set("X-Deprecation-Notice",
                    fmt.Sprintf("API v%d is past its sunset date and may be removed at any time. Migrate to %s now",
                        info.Version, info.Successor))
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage
func setupRoutes() {
    r := chi.NewRouter()

    // Deprecated v1 API
    r.Route("/api/v1", func(r chi.Router) {
        r.Use(Deprecation(DeprecationInfo{
            Version:      1,
            DeprecatedAt: time.Date(2024, 12, 1, 0, 0, 0, 0, time.UTC),
            SunsetDate:   time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC),
            Successor:    "/api/v2",
            DocumentURL:  "https://api.example.com/docs/migration-guide-v2",
        }))

        // v1 routes...
    })

    // Current v2 API
    r.Route("/api/v2", func(r chi.Router) {
        // v2 routes...
    })
}
```

### Deprecation Logging

Structured logging emits key-value pairs rather than free-form strings, making log entries machine-parseable for log aggregation systems. The `log/slog` package provides a standard structured logger with handlers for JSON and text output.

```go
// ... imports omitted for brevity (crypto/sha256, encoding/hex, log/slog,
// net, net/http, sync, time)

// DeprecationLogger tracks deprecated API usage.
//
// Note on usages: an unbounded sync.Map keyed by client is a slow memory
// leak, since every distinct IP that ever probes a deprecated route stays
// resident forever. For a short-lived deprecation it is fine. For anything
// long-running, back it with an LRU or a TTL cache instead.
type DeprecationLogger struct {
    logger *slog.Logger
    usages sync.Map // client -> last warning time
}

func NewDeprecationLogger(logger *slog.Logger) *DeprecationLogger {
    return &DeprecationLogger{logger: logger}
}

// Log deprecated API usage
func (dl *DeprecationLogger) Middleware(version int) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            clientID := getClientID(r)

            // Rate limit warnings per client
            if dl.shouldLog(clientID) {
                dl.logger.Warn("deprecated API usage",
                    "version", version,
                    "path", r.URL.Path,
                    "method", r.Method,
                    "client_id", clientID,
                    "user_agent", r.UserAgent(),
                    "ip", r.RemoteAddr,
                )
            }

            next.ServeHTTP(w, r)
        })
    }
}

func (dl *DeprecationLogger) shouldLog(clientID string) bool {
    now := time.Now()

    if last, ok := dl.usages.Load(clientID); ok {
        lastTime := last.(time.Time)
        // Only log once per hour per client
        if now.Sub(lastTime) < time.Hour {
            return false
        }
    }

    dl.usages.Store(clientID, now)
    return true
}

func getClientID(r *http.Request) string {
    // Try API key. Two traps here, both of which have shipped to production
    // in real codebases:
    //
    //  1. key[:8] panics on any key shorter than 8 bytes, and the key is
    //     attacker-controlled, so that is a free remote crash.
    //  2. A key prefix is still key material. It lands in logs, which fan
    //     out far wider than your secret store, and it narrows a brute
    //     force. Hash it instead: stable for grouping, useless if leaked.
    if key := r.Header.Get("X-API-Key"); key != "" {
        sum := sha256.Sum256([]byte(key))
        return "key:" + hex.EncodeToString(sum[:8])
    }

    // Fall back to IP. RemoteAddr is "host:port", and the port makes every
    // request from one client look like a different client, which would
    // defeat the once-per-hour rate limit below.
    host, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        host = r.RemoteAddr
    }
    return "ip:" + host
}
```

### Junior → FAANG: Treating Deprecation As A Project, Not A Header

The middleware shown here emits the right headers, and if you stop reading there you will think deprecation is solved by three lines of Go. It is not. The header is the smallest piece. The real deprecation is a calendar with four milestones (announce, warn, escalate, sunset), a data stream (structured logs that let you answer "who is still calling this?"), and an outreach process (email to API contacts, in-app banner, changelog entry). The middleware is what attaches the signal to the response. Everything else is what makes the signal into an operation.

The prerequisite you need is knowing which RFC defines what, because these headers arrived years apart and the internet is full of stale examples. `Sunset` comes from RFC 8594 (2019) and carries an HTTP-date: the endpoint goes offline at that moment and well-behaved clients should have migrated before then. `Deprecation` comes from RFC 9745 (2025) and carries a structured-fields Date, `@` plus Unix seconds, marking when the endpoint *became* deprecated. It is still alive, just discouraged. If you write `Deprecation: true` you are copying a draft that the RFC did not adopt, and a compliant parser will reject it. `Link` with `rel="successor-version"` tells clients where the replacement lives, and `rel="deprecation"` (RFC 8631) points at the migration guide. Together they form a machine-readable signal an SDK can parse to surface a warning and link to the guide automatically. That is why the exact format matters: it is a contract with SDK maintainers, not prose for humans.

A common bug to avoid on your first deprecation: the `Sunset` date in this example is hardcoded as `time.Date(2025, 6, 1, ...)`. If you ship this and forget about it, the sunset silently arrives, your middleware keeps emitting the same date, and future client versions never see the update. The fix is to load the sunset date from config (environment variable or config file) with a deploy-time check that refuses to start if the sunset is within 30 days (forcing someone to either extend it or flip to the 410 Gone response). Defensive configuration beats a hardcoded timestamp every time.

A worked example for your first job. You are asked to deprecate `/api/v1/orders`. The full project: day 0, add the middleware and ship (clients start seeing Sunset headers). Day 1, write a changelog entry linking to the migration guide, email it to every account with v1 usage in the last 30 days. Day 30, review the usage dashboard and identify top 10 callers still on v1, open tickets with their account managers. Day 90, send a final warning email to remaining callers. Day 120, flip the handler to return `410 Gone` with a Link to v2. That is a 120 day project, and the header is day 0. Everything else is the work.

The interview entry-point for this section is "walk me through how you would sunset an old API version." The answer is the timeline above, named artifacts, named stakeholders (developer relations, account management, API platform team), and one specific metric (percent of traffic on old version, target under 1% before sunset). Candidates who answer "set the Sunset header" fail this question. Candidates who answer with a timeline and a metric pass it.

### Senior @ FAANG: Deprecation Policy, SLOs, And Enforcement At Scale

At senior level, deprecation is a platform capability, not a per-endpoint task. The deliverable is a deprecation SLO that every public endpoint in the org must meet, a policy document that says how deprecations are announced and enforced, and tooling that makes the happy path automatic. The middleware shown in this section is the starting point of that tooling, not the end.

The SLO at FAANG scale varies by customer tier. AWS's external facing services commit to minimum multi-year deprecation windows for general-availability APIs, because their customers run critical infrastructure and migration requires change control boards on the consumer side. Google Cloud runs quarters to a year depending on the service, with stability levels documented on every API page (`stable`, `beta`, `alpha`, each with its own SLO). Meta's internal Graph API runs months with a strict SLO because all consumers are Meta employees on a shared release train. The policy choice is a function of who your consumers are and how fast they can respond. Write it down before the first deprecation, because once you have announced one deprecation timeline, every future deprecation is expected to match it or to explain why it is shorter.

The enforcement mechanism that senior engineers build is the deprecation compliance check in CI. Every public endpoint in the OpenAPI spec carries an `x-lifecycle` extension (`preview`, `ga`, `deprecated`, `sunset`) and, for deprecated endpoints, an `x-sunset-date`. The CI check fails the PR if a deprecated endpoint lacks a sunset date, if the sunset date is within the minimum SLO window (too aggressive), or if the sunset date has passed without the endpoint being moved to sunset status (overdue). This check runs on every PR to the spec repo, and it cannot be bypassed without API review board signoff. The outcome is that the spec itself is the source of truth for deprecation state, and no endpoint can drift into an unsupported state without a human decision.

The Stripe-style sunset handling is worth studying as the gold standard. Stripe does not delete API versions, they layer transformers, so from a consumer perspective the sunset never happens. When a version is truly retired (rare, but it has happened for versions so old that supporting them blocks a security change), the response is not 410 Gone, it is a 400 with a structured error explaining the exact path forward and a link to a dedicated migration assistant that can analyze the caller's recent requests and suggest code changes. That level of care is expensive to build, but for a company whose value proposition is API stability, it is table stakes. If your API is in a similar trust position (payments, identity, health data), budget for it.

The per-customer usage dashboard is the most load-bearing piece of senior deprecation infrastructure. The structured log stream from the middleware shown here feeds a data warehouse, and the dashboard answers three questions: how much traffic is still on the deprecated version, broken down by day and trending toward zero on the sunset date? Who are the top 20 customers by traffic on the deprecated version, ranked by contract tier so high-value customers get personal outreach? What SDK versions are still making those calls, so the SDK team can push a patched release that transparently migrates? Without this dashboard, sunset is a leap of faith. With it, sunset is a data-driven decision with a clear gate: traffic on v1 is under 0.1%, top 10 callers have confirmed migration, proceed with 410 Gone.

Customer notification at scale is multi-channel fan-out because no single channel reaches every consumer. Email to the account on file gets the account owner, but developers who integrated the API may not be on that alias. Status page posts reach consumers subscribed to incident notifications. In-app banners on the developer console reach engineers who log in to manage API keys. RSS or Atom feeds on the changelog page reach SDK maintainers and third-party tool authors who monitor upstream changes. Discord or Slack developer community announcements reach the engaged segment. The Sunset header reaches the smallest audience (consumers whose clients actually parse RFC 8594) but is the most machine-actionable. The senior deliverable is the notification playbook that says which channels fire on announcement, on 30-day warning, and on sunset, with templates for each, and a single command that triggers the fan-out across all channels simultaneously.

The lifecycle state machine to formalize is: `preview` (opt-in via header or feature flag, may break without notice, no SLO), `ga` (stable, breaking changes prohibited on this version, infinite SLO within the version's support window), `deprecated` (Sunset header active, still functional, new integrations discouraged, migration guide published), `sunset` (returns 410 Gone with Link to successor, or for high-trust APIs, returns 400 with structured error). Each transition is an auditable event with an approver, a ticket, and a changelog entry. The tooling either generates the transitions from spec changes (moving `x-lifecycle` from `ga` to `deprecated` in the spec fires the deprecation notification fan-out) or fails CI if a transition happens without approval. At scale, the automation is what keeps the policy enforceable across hundreds of services and thousands of endpoints.

One final senior concern: the interaction between deprecation and clients that ignore Sunset headers. Some fraction of your consumers will be on old SDKs that do not parse the header, or on custom integrations written by someone who has left the company. Those consumers will keep calling v1 right up until sunset day. The mitigation is progressive degradation in the final week, sometimes called a brownout. Before reaching for it, know that two things people reach for here do not exist as described. There is no `299` HTTP status code: 299 is a *warn-code* used inside the `Warning` header, not a status line, and the `Warning` header itself was removed by RFC 9111, so building on either is building on nothing. What actually works is behavioral, not a novel status. Run short, scheduled brownouts: for a few minutes at a publicized time, have the deprecated endpoint return `503` with a `Retry-After` and a Problem Details body naming the sunset, then return to normal. Lengthen and repeat the windows as the date approaches. The point is to surface the dependency on the consumer's own dashboards and pagers while it is still cheap for them to discover it, which is precisely what the passive headers failed to do. This is harsh, and you only do it for consumers who ignored every passive warning for months. The senior judgment call is when to apply it, and the answer is after the data warehouse shows that passive warnings are not producing migration, and after the account team has personally contacted the top remaining callers. At that point, the accelerated pressure is kinder than silent breakage on sunset day.

---
