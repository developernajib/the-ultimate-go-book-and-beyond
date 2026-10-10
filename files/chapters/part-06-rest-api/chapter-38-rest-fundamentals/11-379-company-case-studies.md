## 38.9 Company Case Studies

### How Stripe Designs APIs

Stripe's REST API is one of the most studied and imitated in the industry. It handles billions of dollars in transactions and serves millions of developers, and its conventions around idempotency, expansion, and pagination have become de facto standards.

**Key Design Principles from Stripe:**

```go
// 1. Consistent Resource Naming
// Stripe uses plural nouns with logical grouping
// /v1/customers, /v1/charges, /v1/payment_intents

// 2. Expansion Pattern - Avoid N+1 queries
// GET /v1/charges/ch_123?expand[]=customer&expand[]=invoice
type Charge struct {
    ID       string      `json:"id"`
    Customer any `json:"customer"` // string ID or expanded Customer object
    Invoice  any `json:"invoice"`  // string ID or expanded Invoice object
}

// 3. Idempotency Keys for Safe Retries
type StripeHandler struct{}

func (h *StripeHandler) CreateCharge(w http.ResponseWriter, r *http.Request) {
    idempotencyKey := r.Header.Get("Idempotency-Key")

    if idempotencyKey != "" {
        // Check if we've seen this key before
        if existing, found := h.idempotencyStore.Get(idempotencyKey); found {
            // Return cached response
            w.WriteHeader(existing.Status)
            w.Write(existing.Body)
            return
        }
    }

    // Process the charge...
    result := h.processCharge(r)

    // Cache the result
    if idempotencyKey != "" {
        h.idempotencyStore.Set(idempotencyKey, result, 24*time.Hour)
    }
}

// 4. List Pagination with Cursors
// GET /v1/customers?limit=10&starting_after=cus_123
type ListResponse struct {
    Object  string     `json:"object"` // "list"
    Data    []Customer `json:"data"`
    HasMore bool       `json:"has_more"`
    URL     string     `json:"url"`
}

// 5. Metadata for Custom Fields
type Customer struct {
    ID       string            `json:"id"`
    Email    string            `json:"email"`
    Metadata map[string]string `json:"metadata"` // User-defined key-value pairs
}
```

### How Twilio Designs APIs

Twilio handles massive scale real-time communications with a focus on developer experience.

```go
// 1. Account-Based URLs
// /2010-04-01/Accounts/{AccountSid}/Messages
// Version in URL allows breaking changes

// 2. Subresources for Related Data
// GET /Accounts/{AccountSid}/Calls/{CallSid}/Recordings
type TwilioRouter struct{}

func (t *TwilioRouter) SetupRoutes(r chi.Router) {
    r.Route("/Accounts/{accountSid}", func(r chi.Router) {
        r.Use(t.authenticateAccount)

        r.Route("/Messages", func(r chi.Router) {
            r.Get("/", t.listMessages)
            r.Post("/", t.sendMessage)
            r.Get("/{messageSid}", t.getMessage)

            r.Route("/{messageSid}/Media", func(r chi.Router) {
                r.Get("/", t.listMedia)
                r.Get("/{mediaSid}", t.getMedia)
            })
        })
    })
}

// 3. Callback URLs for Async Operations
type SendMessageRequest struct {
    To            string `json:"To"`
    From          string `json:"From"`
    Body          string `json:"Body"`
    StatusCallback string `json:"StatusCallback"` // Webhook URL for status updates
}

// 4. Rich Filtering on List Endpoints
// GET /Messages?DateSent>=2024-01-01&DateSent<=2024-01-31&To=+1234567890
func (t *TwilioRouter) listMessages(w http.ResponseWriter, r *http.Request) {
    query := r.URL.Query()

    filter := MessageFilter{
        DateSentGte: query.Get("DateSent>"),
        DateSentLte: query.Get("DateSent<"),
        To:          query.Get("To"),
        From:        query.Get("From"),
        Status:      query.Get("Status"),
    }

    messages, err := t.messageService.List(r.Context(), filter)
    // ...
}
```

### How GitHub Designs APIs

GitHub's API serves millions of developers and handles complex nested resources.

```go
// 1. Hypermedia (HATEOAS) Extensively
type Repository struct {
    ID          int64  `json:"id"`
    Name        string `json:"name"`
    FullName    string `json:"full_name"`
    Description string `json:"description"`

    // Links to related resources
    URL             string `json:"url"`
    HTMLURL         string `json:"html_url"`
    IssuesURL       string `json:"issues_url"`       // Template: {/number}
    PullsURL        string `json:"pulls_url"`        // Template: {/number}
    CommitsURL      string `json:"commits_url"`      // Template: {/sha}
    ContributorsURL string `json:"contributors_url"`
}

// 2. Conditional Requests for Caching
func (h *GitHubHandler) GetRepository(w http.ResponseWriter, r *http.Request) {
    etag := h.calculateETag(repo)
    lastModified := repo.UpdatedAt

    // Check If-None-Match
    if r.Header.Get("If-None-Match") == etag {
        w.WriteHeader(http.StatusNotModified)
        return
    }

    // Check If-Modified-Since
    if ims := r.Header.Get("If-Modified-Since"); ims != "" {
        if t, err := time.Parse(http.TimeFormat, ims); err == nil {
            if !lastModified.After(t) {
                w.WriteHeader(http.StatusNotModified)
                return
            }
        }
    }

    w.Header().Set("ETag", etag)
    w.Header().Set("Last-Modified", lastModified.Format(http.TimeFormat))
    w.Header().Set("Cache-Control", "private, max-age=60")

    json.NewEncoder(w).Encode(repo)
}

// 3. Link Header for Pagination
// Link: <https://api.github.com/repos?page=2> - rel="next",
//       <https://api.github.com/repos?page=5> - rel="last"
func (h *GitHubHandler) ListRepositories(w http.ResponseWriter, r *http.Request) {
    page := parsePageParam(r)
    perPage := parsePerPageParam(r, 30, 100)

    repos, total := h.repoService.List(r.Context(), page, perPage)
    totalPages := (total + perPage - 1) / perPage

    // Build Link header
    var links []string
    if page < totalPages {
        links = append(links, fmt.Sprintf("<%s?page=%d>; rel=\"next\"", r.URL.Path, page+1))
    }
    if page > 1 {
        links = append(links, fmt.Sprintf("<%s?page=%d>; rel=\"prev\"", r.URL.Path, page-1))
    }
    links = append(links, fmt.Sprintf("<%s?page=%d>; rel=\"last\"", r.URL.Path, totalPages))
    links = append(links, fmt.Sprintf("<%s?page=1>; rel=\"first\"", r.URL.Path))

    w.Header().Set("Link", strings.Join(links, ", "))
    json.NewEncoder(w).Encode(repos)
}

// 4. Preview Headers for Beta Features
// Accept: application/vnd.github.v3+json
// Accept: application/vnd.github.squirrel-girl-preview+json (reactions)
```

### How Netflix Designs APIs

Netflix handles massive scale with edge computing and API optimization.

```go
// 1. Experience APIs (Backend for Frontend)
// Different endpoints optimized for different clients
type NetflixRouter struct{}

func (n *NetflixRouter) SetupRoutes(r chi.Router) {
    // Mobile-optimized (smaller payloads)
    r.Route("/mobile/v1", func(r chi.Router) {
        r.Get("/home", n.mobileHome)
        r.Get("/browse/{genre}", n.mobileBrowse)
    })

    // TV-optimized (pre-aggregated data)
    r.Route("/tv/v1", func(r chi.Router) {
        r.Get("/home", n.tvHome)
        r.Get("/browse/{genre}", n.tvBrowse)
    })

    // Web-optimized
    r.Route("/web/v1", func(r chi.Router) {
        r.Get("/home", n.webHome)
    })
}

// 2. Falcor-style JSON Graph
// Request specific fields to reduce payload
// GET /api/titles?paths=["titles",["123","456"],["name","year","rating"]]
type FalcorRequest struct {
    Paths [][]any `json:"paths"`
}

type JSONGraphEnvelope struct {
    JSONGraph map[string]any `json:"jsonGraph"`
}

// 3. Graceful Degradation
func (n *NetflixRouter) mobileHome(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Parallel fetch with fallbacks
    var wg sync.WaitGroup
    var featured, trending, myList any
    var featuredErr, trendingErr, myListErr error

    wg.Add(3)
    go func() {
        defer wg.Done()
        featured, featuredErr = n.featuredService.Get(ctx)
    }()
    go func() {
        defer wg.Done()
        trending, trendingErr = n.trendingService.Get(ctx)
    }()
    go func() {
        defer wg.Done()
        myList, myListErr = n.myListService.Get(ctx)
    }()
    wg.Wait()

    // Build response with available data
    response := HomeResponse{}
    if featuredErr == nil {
        response.Featured = featured
    }
    if trendingErr == nil {
        response.Trending = trending
    }
    if myListErr == nil {
        response.MyList = myList
    }

    json.NewEncoder(w).Encode(response)
}
```

### Junior → FAANG: Reading These Case Studies the Right Way

If you are joining your first team in 2026, the mistake is treating Stripe, Twilio, and GitHub docs as aesthetic references. They are not. They are artifacts of decade-long migrations where each header, each cursor, each expand parameter survived a postmortem. Read them as compiled scar tissue.

Prerequisite gaps you must close before the case studies click. First, HTTP semantics at the RFC level (RFC 9110 for semantics and conditional requests, RFC 9111 for caching, which together consolidated the older 7231/7232/7234). You cannot evaluate GitHub's ETag strategy if you do not know that `If-None-Match` on a `GET` returns 304 with an empty body and no `Content-Length`. Second, URI templating (RFC 6570) because GitHub literally ships `issues_url` as `{/number}` and clients are expected to expand it. Third, cursor pagination math. Offset pagination at scale is a full table scan that grows linearly with page number. Stripe's `starting_after=cus_123` is a seek, not an offset.

Worked example, entry-point interview style. Prompt: "build a `POST /charges` endpoint that is safe to retry." Junior answer walks the keyboard: accept a body, insert a row, return 201. FAANG-floor answer has a reflex. Pull `Idempotency-Key` header, hash the request body, look up `(key, body_hash)` in a store with 24h TTL, if present return the cached response with the original status code and headers, if present with a different body hash return 422 (key reuse with different payload is a client bug). Only then touch the database. That reflex, built from reading Stripe's idempotency doc three times, is what separates L3 from L4.

The "why did this fail" reflex. When you see a production incident where a payment was double-charged, your first question is not "was there a bug in the handler." It is "did the client retry, and if so, did the retry carry the same idempotency key." In practice, most payment incidents at junior-staffed teams trace back to missing idempotency keys on retries, not logic bugs. Learn to ask the question before you open the code.

First-job context. You will not design a new public API in your first year. You will add endpoints to an existing one. The case studies matter because your team's conventions were copied, poorly, from one of them. Identify which. If URLs are `/v1/resource` with snake_case fields and cursor pagination, your team copied Stripe. If URLs carry an account SID and responses come back in XML-flavored JSON, your team copied Twilio pre-2018. If every response has a `Link` header and `application/vnd.company.v3+json`, your team copied GitHub. Knowing the ancestor tells you what rules are load-bearing versus cargo-culted.

Interview entry-point drill. Pick one case study per week. Reimplement three endpoints in Go using `net/http` and `chi`. Do not copy paste. Write the handler, write a table-driven test, write the OpenAPI stub. By week four you will have internalized expansion, HATEOAS templates, and Link-header pagination deeply enough to answer "how would you version this" without stalling.

### Senior @ FAANG: Case Studies as ADR Source Material

At staff and principal level, case studies are not role models. They are decision corpora. Your job is to extract the implicit ADR each company wrote with their blood and decide whether the constraint that forced that decision applies to you.

Stripe's design philosophy decomposes into four load-bearing ADRs. ADR-1: versioning is date-based and per-account, not per-URL, because the customer base was financial institutions with multi-year integration cycles and URL-bump versioning would force synchronized upgrades across unrelated features. ADR-2: expansion is opt-in because the default object must be cacheable at the CDN, and expanded objects are not. ADR-3: idempotency keys are mandatory on all mutating endpoints because the blast radius of a double-charge is regulatory, not just UX. ADR-4: metadata is a first-class `map[string]string` on every resource because Stripe refuses to model customer-specific business logic, which preserves the schema's stability over a decade. Copy these ADRs only if the constraint matches. A B2C photo-sharing app does not need date-based versioning.

GitHub v3 versus v4 GraphQL split is the single most instructive API bifurcation case in the industry. The v3 REST API hit a ceiling around 2016 when clients routinely made fifteen sequential calls to render a single PR view (repo, PR, commits, checks, reviews, review comments, files, author, author's org membership, labels, milestones, assignees, projects, timeline, reactions). The fix was not a better REST. It was GraphQL v4. But v3 was not deprecated, because enterprise customers had a decade of scripts and bot integrations. The ADR: new clients get GraphQL, old clients keep REST, forever. Read that as a maturity model input. When your REST surface crosses roughly 200 endpoints with heavy nested reads, you are in GitHub's 2015 position, and the honest answer may be a parallel query API, not more REST.

Twilio's account-scoped URL pattern (`/2010-04-01/Accounts/{AccountSid}/...`) is a multi-tenancy ADR in disguise. Every single path embeds the tenant. Authorization is trivially auditable from access logs because the tenant is in the URL, not in a header or JWT claim. The tradeoff is URL ugliness and SDK complexity. At 100+ tenant scale with per-tenant rate limits, compliance audit, and per-tenant data residency, the Twilio pattern becomes cheaper than JWT-scoped tenancy. Below that scale it is overkill.

PayPal REST, Slack Web API, Google Maps, AWS service APIs, Netflix private APIs, Shopify Storefront, and Heroku Platform API each encode one dominant ADR worth extracting. PayPal: HATEOAS for real, because payment state machines are regulated and the server owns the state transition graph. Slack: action-oriented endpoints (`chat.postMessage`) because RPC semantics matched the bot-framework audience better than noun-CRUD. Google Maps: aggressive per-key quota and billing metadata inline on every response, because the API is a billing primitive. AWS: service-per-subdomain with Sigv4 request signing, because cross-service blast-radius isolation is existential. Netflix: Experience APIs (BFF) per device class, because client heterogeneity dwarfs backend heterogeneity. Shopify Storefront: separate read-only public surface from admin surface, with different auth, rate limits, and schema, because the threat models are disjoint. Heroku Platform API: `Accept: application/vnd.heroku+json; version=3` with explicit range negotiation, because Heroku's customers are developers who tolerate header complexity for versioning precision.

API maturity model L1 through L5 mapped against these companies. L1 ad-hoc (one team, one service, no spec). L2 documented (OpenAPI generated from code, hand-written in a wiki). L3 governed (API review board, style guide, Spectral linter in CI). L4 platform (shared gateway, centralized auth, metered quotas, a contract testing pipeline, breaking-change detector via `buf breaking` or `openapi-diff` gating merges). L5 product (public-facing SLA, deprecation policy measured in years, versioned SDK generation, per-endpoint business KPIs wired to dashboards). Stripe and Twilio are L5. GitHub is L5 with L4 legacy baggage. Heroku is L5. Your startup is almost certainly L2 claiming to be L4.

Governance artifacts you should have by L4. An API review board that meets weekly, with a rotating chair, a standing rubric (naming, pagination, error format, idempotency, auth, versioning, backward compatibility, observability hooks), and a written decision log. Spectral ruleset checked in CI. Pact contract tests between consumer and producer, gated on PR. A breaking-change detector running on every PR against the main-branch OpenAPI. A deprecation policy written down, with SLA (minimum 12 months for public, 6 months for partner, 3 months for internal). A bar-raiser reviewer for every new top-level resource.

ADR template to staple onto every new resource. Context: why this resource, what user journey. Decision: noun, URL shape, auth scope, idempotency story, pagination story, error contract, versioning stance. Consequences: what future changes are now cheap, what are now expensive, what is now impossible. Alternatives considered: GraphQL field, gRPC RPC, async event, inline on existing resource. Review cadence: who owns this, when do we revisit.

The staff-level instinct the case studies teach. No API design decision is local. Every header you add becomes a contract. Every field you expose becomes a lawsuit-adjacent invariant. Every status code becomes a runbook branch. Read Stripe and GitHub not to copy their answers but to calibrate how much thought belongs in each decision before you ship.

---
