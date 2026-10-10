## 60.2 High-Level Design

The high-level architecture separates the hot read path (short URL resolution) from the write path (URL creation) so each can be scaled independently, reflecting the roughly 100:1 read-to-write ratio typical of URL shorteners. Redis sits in front of PostgreSQL on the read path to absorb the majority of redirect requests without hitting the database, while Kafka receives click events asynchronously so analytics processing never adds latency to the critical redirect flow. The load balancer distributes traffic across stateless API server instances, enabling horizontal scaling as traffic grows.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────►│ Load Balancer│────►│  API Server │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
            ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
            │     Cache     │           │   Database    │           │   Analytics   │
            │    (Redis)    │           │  (PostgreSQL) │           │    (Kafka)    │
            └───────────────┘           └───────────────┘           └───────────────┘
```

### API Design

The API exposes three primary operations: shorten a long URL, resolve a short ID back to its destination, and retrieve click statistics. Using HTTP 302 (Found) rather than 301 (Moved Permanently) for redirects is a deliberate correctness choice, browsers cache 301 responses indefinitely, which would prevent the system from updating or expiring URLs after a client has already visited once. The `TrackClick` call is dispatched as a goroutine so the redirect response returns before analytics I/O completes.

```go
// api/handlers.go
package api

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

// ShortenRequest represents a URL shortening request
type ShortenRequest struct {
    LongURL   string     `json:"long_url" validate:"required,url"`
    CustomID  string     `json:"custom_id,omitempty" validate:"omitempty,alphanum,min=4,max=20"`
    ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// ShortenResponse contains the shortened URL
type ShortenResponse struct {
    ShortURL  string     `json:"short_url"`
    ShortID   string     `json:"short_id"`
    LongURL   string     `json:"long_url"`
    ExpiresAt *time.Time `json:"expires_at,omitempty"`
    CreatedAt time.Time  `json:"created_at"`
}

// URLStats contains URL statistics
type URLStats struct {
    ShortID     string    `json:"short_id"`
    TotalClicks int64     `json:"total_clicks"`
    UniqueIPs   int64     `json:"unique_ips"`
    LastAccess  time.Time `json:"last_access"`
    TopCountries []CountryStats `json:"top_countries"`
    ClicksByDay  []DayStats     `json:"clicks_by_day"`
}

type CountryStats struct {
    Country string `json:"country"`
    Clicks  int64  `json:"clicks"`
}

type DayStats struct {
    Date   string `json:"date"`
    Clicks int64  `json:"clicks"`
}

// ClickMeta carries the request fields analytics needs, copied out of
// the request so the handler can return without retaining it.
type ClickMeta struct {
    Referrer  string
    UserAgent string
    RemoteIP  string
}

// Handler handles URL shortening operations
type Handler struct {
    service *URLService
}

// NewHandler creates a new handler
func NewHandler(service *URLService) *Handler {
    return &Handler{service: service}
}

// ShortenURL handles POST /api/shorten
func (h *Handler) ShortenURL(w http.ResponseWriter, r *http.Request) {
    var req ShortenRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }

    // Validate request
    if err := validate(req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    // Create shortened URL
    result, err := h.service.CreateShortURL(r.Context(), req)
    if err != nil {
        handleError(w, err)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(result)
}

// RedirectURL handles GET /{shortID}
func (h *Handler) RedirectURL(w http.ResponseWriter, r *http.Request) {
    shortID := r.PathValue("shortID")
    if shortID == "" {
        http.Error(w, "Short ID required", http.StatusBadRequest)
        return
    }

    // Get original URL
    longURL, err := h.service.GetLongURL(r.Context(), shortID)
    if err != nil {
        handleError(w, err)
        return
    }

    // Track click asynchronously. Two traps avoided here: the request
    // context is canceled the moment this handler returns, so the
    // goroutine detaches from it with WithoutCancel, and *http.Request
    // must not be retained past the handler, so the needed fields are
    // copied first.
    meta := ClickMeta{
        Referrer:  r.Referer(),
        UserAgent: r.UserAgent(),
        RemoteIP:  r.RemoteAddr,
    }
    go h.service.TrackClick(context.WithoutCancel(r.Context()), shortID, meta)

    // Redirect (use 302 since URLs can expire or be deleted -     // 301 would be cached permanently by browsers, preventing re-routing)
    http.Redirect(w, r, longURL, http.StatusFound)
}

// GetStats handles GET /api/stats/{shortID}
func (h *Handler) GetStats(w http.ResponseWriter, r *http.Request) {
    shortID := r.PathValue("shortID")

    stats, err := h.service.GetStats(r.Context(), shortID)
    if err != nil {
        handleError(w, err)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}

// DeleteURL handles DELETE /api/urls/{shortID}
func (h *Handler) DeleteURL(w http.ResponseWriter, r *http.Request) {
    shortID := r.PathValue("shortID")

    if err := h.service.DeleteURL(r.Context(), shortID); err != nil {
        handleError(w, err)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

---

### Junior → FAANG: Reading High-Level Designs and Asking the Right Questions

A high-level design diagram is a communication tool, not a blueprint. Before you can defend or extend a design, you need to be able to read one and ask the questions that expose its hidden assumptions.

**Understand why the read and write paths are separated.** The diagram shows clients going through a load balancer to an API server, which then fans out to Redis, PostgreSQL, and Kafka. The key insight is that reads (redirects) and writes (URL creation) have fundamentally different characteristics. Reads are 100x more frequent, they must be fast, and they can tolerate eventual consistency (a newly created URL might not be in cache for a few milliseconds). Writes are infrequent, they must be durable, and they must be consistent (two clients should not get the same short code). This asymmetry drives the entire architecture.

**Know why Kafka appears here.** Kafka is not used for URL storage. It is used for analytics fan-out. Click events are published to Kafka so that downstream consumers (analytics dashboards, billing systems, abuse detection) can process them independently and at their own pace, without adding latency to the redirect response. If Kafka were removed and click tracking were done synchronously inside the redirect handler, every redirect would be as slow as the slowest analytics write. This is the core pattern of asynchronous decoupling.

**302 vs 301 is not a minor detail.** This is a question interviewers ask directly. The answer must include: 301 is cached permanently by browsers, so a URL that is deleted or expired will continue redirecting to the wrong destination for any client that already cached the 301. 302 tells the browser to always check the redirect server, which preserves the service's ability to revoke, update, or expire URLs. The performance cost of 302 is real (one extra round trip per cold cache), but it is the correct trade-off for a mutable system.

**Work through the API surface before drawing infrastructure.** Define the API contract first: what HTTP method and path for shortening, what for redirect, what for stats, what for deletion. Then decide what each endpoint returns and what status codes it uses. This order matters because the API contract is what downstream consumers depend on. Getting the infrastructure right but the API wrong produces a correctly scaled system that no client can use properly.

---

### Senior @ FAANG: Architectural Boundary Decisions and API Contract Governance

High-level design at staff level is about drawing the right boundaries, not the most boxes. Every component boundary is a deployment unit, a failure domain, and a team boundary. Each one has a cost.

**The stateless API server is a constraint, not a given.** The design shows stateless API servers behind a load balancer. "Stateless" means no in-process rate limit counters, no in-process caches that could diverge between replicas, and no sticky sessions. This constraint enables horizontal scaling with zero coordination cost, but it requires that all shared state (rate limit counters, URL cache, analytics buffer flushing) live outside the process in Redis or Kafka. At L6+, you articulate this constraint explicitly in a design review: "This service is stateless. Here is what that means for deployments, rolling restarts, and autoscaling." You also document the exceptions: if the service uses an in-process LRU cache for the hot URL set, that state is acceptable because it is a performance hint, not authoritative state.

**API versioning belongs in the high-level design, not retrofitted later.** The API design shows `/api/shorten`, `/{shortID}`, and `/api/stats/{shortID}`. At platform scale, you need a versioning strategy before the first consumer integrates. Options: URL versioning (`/v1/shorten`), header versioning (`Accept: application/vnd.shortener.v1+json`), or query parameter versioning (`?api-version=2024-01-01`). Each has trade-offs. URL versioning is the most explicit and easiest to route at the load balancer, but it proliferates versions in client code. The choice should be documented in the API governance policy and applied consistently. Retrofitting versioning after consumers are integrated is one of the most expensive platform operations.

**The analytics fan-out pattern has a latency SLO implication.** By decoupling analytics into an async Kafka pipeline, you accept that analytics data is eventually consistent with reality. The redirect count shown in a dashboard may lag the actual click volume by seconds or minutes depending on consumer throughput. This is an explicit architectural trade-off that must be communicated to product stakeholders. Document the analytics consistency SLO: "Dashboard data is accurate within 30 seconds of the redirect event under normal load." If the product requires real-time click counts (for example, a billboard campaign manager watching live traffic), the architecture needs a separate fast-path counter (an atomic `INCR` in Redis updated synchronously) alongside the eventually consistent analytics pipeline.

**Service mesh concerns belong at this level.** A high-level design that shows "API Server talks to Redis" without addressing mutual TLS, service identity, and traffic policy is incomplete at L6. In a production FAANG environment, every service-to-service call is authenticated via mTLS, rate limited at the mesh layer, and observable through distributed tracing. The high-level design should note which components communicate over the mesh, what the retry policy is (Redis calls should not retry aggressively on errors, because retrying a LATENCY spike will make it worse), and what the timeout contract is at each hop. These are not implementation details. They are architectural decisions that affect failure modes.
