## 42B.8 API Performance Design

### The Transport Layer: HTTP/2, HTTP/3, Compression

Before touching application-level optimizations, get the transport right. In 2026, any public API should serve HTTP/2 (or HTTP/3 for edge endpoints) with Brotli compression:

- **HTTP/2 multiplexing** eliminates head-of-line blocking on a single TCP connection. A dashboard firing 20 parallel `GET`s pays the TLS handshake once, not 20 times.
- **HTTP/3 over QUIC** matters for mobile and high-latency links because it eliminates TCP's slow-start after packet loss and survives network changes (wifi to cellular) without reconnecting.
- **Brotli** (`Accept-Encoding: br`) compresses JSON 15 to 25 percent better than gzip for equivalent CPU cost. Fall back to gzip for clients that do not negotiate it.
- **Content negotiation**: honor `Accept-Encoding` strictly. Never return Brotli-encoded bodies to a client that did not ask for it.

Put the compression decision in a single middleware, not per-handler. This is table stakes, not an optimization.

### Response Payload Design

**Principle: Return what the client needs, no more, no less.**

Common mistakes:
- Returning 50 fields when the list view needs 5 (over-fetching)
- Not including related resources, forcing N+1 requests (under-fetching)

GraphQL addresses this inherently. For REST, use:
- **Sparse fieldsets** (`?fields=id,name,status`)
- **Expandable resources** (`?expand[]=customer`)
- **Purpose-built list endpoints** that return summary representations

```go
// Summary representation for list views
type OrderSummary struct {
    ID        string          `json:"id"`
    Status    string          `json:"status"`
    TotalCents int64          `json:"total_cents"`
    Currency  string          `json:"currency"`
    CreatedAt time.Time       `json:"created_at"`
}

// Full representation for detail views (includes line items, customer, etc.)
type OrderDetail struct {
    OrderSummary
    LineItems []LineItem    `json:"line_items"`
    Customer  *CustomerRef  `json:"customer"`
    Shipping  *Address      `json:"shipping_address"`
    Billing   *Address      `json:"billing_address"`
    Events    []OrderEvent  `json:"events,omitempty"`
}
```

### Pagination: Cursor Over Offset

For any list that can grow beyond a few hundred items, cursor pagination beats offset on every axis:

- **Consistency**: offset pagination shifts items across pages as the dataset mutates. Cursor pagination yields a stable view anchored on the sort key.
- **Performance**: `LIMIT 50 OFFSET 10000` reads and discards 10,000 rows. `WHERE (created_at, id) < (cursor_created_at, cursor_id) ORDER BY created_at DESC, id DESC LIMIT 50` uses the composite index and stops at 50.
- **Opaque tokens**: serialize the cursor as base64-encoded JSON. Clients treat it as a string. You retain the freedom to extend the encoding without a breaking change.

> **Senior track**: Offset pagination is acceptable in exactly one case, internal admin UIs with small, bounded datasets where "jump to page 47" is a real user need. For public APIs, always cursor.

### Bulk Endpoints for N+1 Prevention

Instead of:
```
GET /users/1
GET /users/2
GET /users/3
... (N requests)
```

Provide:
```
POST /users/batch
{"ids": ["1", "2", "3"]}

# Or via query params for GET:
GET /users?ids=1,2,3
```

```go
type BatchGetRequest struct {
    IDs []string `json:"ids" validate:"required,min=1,max=100"`
}

func (h *UserHandler) BatchGet(w http.ResponseWriter, r *http.Request) {
    var req BatchGetRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
        return
    }

    if err := validate(req); err != nil {
        writeValidationError(w, err)
        return
    }

    // Single database query for all IDs
    users, err := h.users.BatchGet(r.Context(), req.IDs)
    if err != nil {
        writeInternalError(w)
        return
    }

    // Return a map for O(1) client lookup
    result := make(map[string]*UserResponse, len(users))
    for _, u := range users {
        result[u.ID] = mapUserToResponse(u)
    }

    writeJSON(w, http.StatusOK, map[string]any{
        "users": result,
    })
}
```

### Async Patterns for Long Operations

For operations that take more than a few seconds (report generation, file processing, bulk imports):

```
# Client submits job
POST /reports/generate
→ 202 Accepted
{
  "job_id": "job_abc123",
  "status": "pending",
  "poll_url": "/jobs/job_abc123",
  "estimated_duration_seconds": 30
}

# Client polls for completion
GET /jobs/job_abc123
→ 200 OK
{
  "job_id": "job_abc123",
  "status": "processing",  # pending → processing → completed | failed
  "progress": 0.45,
  "started_at": "2024-01-15T10:30:00Z"
}

# When done:
→ 200 OK
{
  "job_id": "job_abc123",
  "status": "completed",
  "result_url": "/reports/rpt_xyz789",
  "completed_at": "2024-01-15T10:30:35Z"
}
```

```go
type Job struct {
    ID          string      `json:"job_id" db:"id"`
    Type        string      `json:"type" db:"type"`
    Status      JobStatus   `json:"status" db:"status"`
    Progress    float64     `json:"progress" db:"progress"`
    ResultURL   *string     `json:"result_url,omitempty" db:"result_url"`
    Error       *string     `json:"error,omitempty" db:"error"`
    StartedAt   *time.Time  `json:"started_at,omitempty" db:"started_at"`
    CompletedAt *time.Time  `json:"completed_at,omitempty" db:"completed_at"`
    CreatedAt   time.Time   `json:"created_at" db:"created_at"`
}

func (h *ReportHandler) GenerateReport(w http.ResponseWriter, r *http.Request) {
    var req GenerateReportRequest
    if err := parseAndValidate(r, &req); err != nil {
        writeValidationError(w, err)
        return
    }

    job, err := h.jobs.Create(r.Context(), JobParams{
        Type:    "report.generate",
        Payload: req,
        UserID:  GetAuthContext(r.Context()).UserID,
    })
    if err != nil {
        writeInternalError(w)
        return
    }

    // Enqueue for background processing
    h.queue.Enqueue(r.Context(), job.ID)

    w.Header().Set("Location", fmt.Sprintf("/jobs/%s", job.ID))
    writeJSON(w, http.StatusAccepted, map[string]any{
        "job_id":                       job.ID,
        "status":                       "pending",
        "poll_url":                     fmt.Sprintf("/jobs/%s", job.ID),
        "estimated_duration_seconds":   30,
    })
}
```

### Conditional Requests: ETag and If-None-Match

Reduce bandwidth by letting clients skip re-downloading unchanged resources:

```go
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    userID := chi.URLParam(r, "userID")

    user, err := h.users.Get(r.Context(), userID)
    if err != nil {
        writeNotFound(w, r, "user", userID)
        return
    }

    // Compute ETag from content hash or last-modified
    etag := computeETag(user)

    // Check If-None-Match header
    if match := r.Header.Get("If-None-Match"); match != "" {
        if match == etag {
            w.WriteHeader(http.StatusNotModified)
            return
        }
    }

    w.Header().Set("ETag", etag)
    w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
    writeJSON(w, http.StatusOK, mapUserToResponse(user))
}

func computeETag(v any) string {
    b, _ := json.Marshal(v)
    hash := sha256.Sum256(b)
    return `"` + hex.EncodeToString(hash[:8]) + `"`
}
```

### Compression

JSON API responses compress well because every record repeats the same field names, and that repetition is exactly what a dictionary coder collapses. The size of the win depends almost entirely on how many records are in the response. Gzipping a typical list payload at level 5:

| Records | Raw | Gzipped | Saved |
|---|---|---|---|
| 1 | 195 B | 161 B | 17% |
| 10 | 1.7 KB | 223 B | 87% |
| 100 | 17 KB | 724 B | 96% |
| 1,000 | 171 KB | 6.3 KB | 96% |

Note the shape of that curve, because it contradicts the usual advice to "just turn on compression." A single-record response barely compresses: there is no repetition to exploit yet, and gzip's own header and trailer are roughly 20 bytes of pure overhead. Below a few hundred bytes you are spending CPU on both ends, defeating `Content-Length`-based progress, and saving almost nothing. Above ten records the repeated keys dominate and the savings jump past 85% and then flatten.

The practical rule: compress list endpoints, set a minimum size threshold (1 KB is a reasonable default) below which you skip it, and do not bother compressing single-resource `GET`s. Most middleware, including chi's, does not apply a size threshold for you.

```go
import "github.com/go-chi/chi/v5/middleware"

// Add to middleware stack
r.Use(middleware.Compress(5, "application/json", "text/plain"))

// Or custom:
func CompressionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        accept := r.Header.Get("Accept-Encoding")

        if strings.Contains(accept, "br") {
            // Brotli preferred (better compression than gzip)
            w.Header().Set("Content-Encoding", "br")
            bw := brotli.NewWriter(w)
            defer bw.Close()
            next.ServeHTTP(&brotliResponseWriter{ResponseWriter: w, writer: bw}, r)
            return
        }

        if strings.Contains(accept, "gzip") {
            w.Header().Set("Content-Encoding", "gzip")
            gz := gzip.NewWriter(w)
            defer gz.Close()
            next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, writer: gz}, r)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

---

### Junior → FAANG: Understanding API Performance as a Design Discipline

Most junior engineers treat performance as something you bolt on after shipping. At FAANG, performance constraints are embedded in the design before a single line of handler code is written. Closing that gap is what gets you past the L4 bar.

**Prerequisite gaps to close first**

If you have not yet internalized the difference between latency and throughput, do that now. Latency is how long one request takes. Throughput is how many requests per second the system handles. An optimization that cuts latency per request by 20ms may actually reduce throughput if it increases memory pressure. Always measure both.

Understand what a P99 latency means versus a mean. The mean hides the worst-case user experience. SLOs at FAANG are written in P99 and P999, not averages.

**Worked example: diagnosing over-fetching on a list endpoint**

Imagine a `GET /orders` endpoint that returns 50 fields per order, including nested line items, customer details, and audit events, when the mobile dashboard only renders order ID, status, and total. The payload is 80 KB per page instead of 4 KB. On a 3G connection that 20x difference in payload is the dominant latency factor, not your database query time.

Fix it by defining a `OrderSummary` struct with only the fields the view needs, then return that type from the list endpoint. The detail endpoint returns `OrderDetail`. This is the expand pattern: lean by default, verbose on demand.

**First-job habits**

Always add compression middleware to the router stack on day one of a new service. It is a one-line change with no downside for JSON APIs. Never leave it out.

When you write a new list endpoint, ask: "What is the maximum size this list could reach in three years?" If the answer is "unbounded," implement cursor pagination from the start. Retrofitting pagination into a live API is a breaking change.

**Interview entry-point framing**

When asked "how would you scale this API?", do not jump straight to horizontal scaling and Kubernetes. Start with payload shape: are we returning only what clients need? Then cursor pagination: are we avoiding table scans? Then caching and async patterns. Performance lives in design choices, not only in infrastructure.

---

### Senior @ FAANG: Platform-Level Performance Governance and Maturity Models

At the senior and staff level, API performance is not a per-endpoint concern. It is a platform-wide contract enforced through tooling, SLOs, and architectural governance. The question shifts from "is this endpoint fast?" to "how do we guarantee the platform stays fast as 200 engineers contribute to it?"

**SLO architecture as a design input**

Before any new resource is designed, define its SLO. What is the P99 latency target? What is the error budget? These are not aspirational numbers you set after measuring. They are constraints that determine which implementation approaches are even on the table. A `POST /payments` endpoint with a sub-200ms P99 on a shared database cannot afford a serializable transaction with four round trips. The SLO eliminates that design. This is what "designing for performance" actually means at this level.

Document SLOs in the API spec using an extension field like `x-slo-p99-ms: 200`. Make them machine-readable so CI can flag when a handler's benchmark violates the declared SLO during a pull request.

**Payload shape governance**

At scale, over-fetching is a systemic problem, not an individual bug. When any team can add a field to any response, response sizes drift upward over time. Govern this through a schema review process: any PR that adds fields to a high-traffic endpoint requires a payload impact assessment. Measure the 95th percentile response size before and after, and require sign-off if it increases by more than 10%.

Sparse fieldsets (`?fields=`) are a mitigation, but they shift the burden to clients. A better long-term approach is to instrument which fields clients actually request, then identify and deprecate fields with near-zero usage. At Stripe scale, this analysis has removed hundreds of fields that were costing serialization CPU budget with zero client benefit.

**Cursor pagination: the composite index contract**

When you mandate cursor pagination platform-wide, you must also mandate the corresponding index contract. Every paginated endpoint must have a composite index on its sort columns that includes a unique tiebreaker. Write this into the database review checklist. An endpoint that paginates on `created_at` without an `id` tiebreaker will produce duplicate or skipped items when rows share a timestamp. At high write throughput, timestamp collisions are not hypothetical.

The cursor token format must be versioned. Encode a `v` field inside the base64 JSON (`{"v":1,"created_at":"...","id":"..."}`). When you need to change the cursor structure, bump the version and write a decoder that handles both. Clients holding old cursors across a deployment do not break.

**Async job API: the state machine contract**

The `202 Accepted` with a polling URL pattern looks simple. At platform scale it accumulates surprising failure modes. Design the job state machine explicitly and document it as an ADR.

States: `pending`, `processing`, `completed`, `failed`, `canceled`. Transitions: `pending -> processing` (worker picks it up), `processing -> completed` (success), `processing -> failed` (terminal error), `pending -> canceled` (client cancels before a worker picks it up). `processing -> canceled` is intentionally not in the state machine: do not cancel in-flight work without dedicated compensation logic.

The `result_url` in the completed state should use a short-lived signed URL if the result contains sensitive data. Do not return raw storage URLs.

**ETag governance**

ETag computation based on `json.Marshal` is correct in principle but has a subtle problem: Go map iteration order is non-deterministic. If any response includes a `map[string]string` field (like `metadata`), serializing it twice may produce different JSON byte sequences, resulting in different ETags for the same logical resource. Sort map keys before hashing, or use a deterministic serializer.

At the platform level, ETags also interact with CDN caching. Define a policy: which endpoints are eligible for CDN caching, what the `Cache-Control` directives must be, and who can approve deviations. A misconfigured `Cache-Control: public` on a user-specific endpoint is a data leak.

**Bar-raiser signals**

In a senior design interview, reviewers are looking for evidence that you think beyond the single request. Can you model the cumulative effect of design decisions across millions of requests? Do you understand that cursor pagination is not just faster, it changes what the database index must look like? Do you treat the `Retry-After` header as a contract, not a suggestion? Can you explain why async pattern polling frequency should be bounded (exponential backoff with a cap) and what happens to your job polling table if it is not?

Staff-level answers also include the governance layer: how do you prevent the next engineer from shipping an endpoint that silently violates the platform performance contract? That answer involves CI benchmarks, SLO annotations in the spec, payload size monitoring, and a human review gate, not just good intentions.
