## 38.10 Common Mistakes and How to Avoid Them

### Mistake 1: Using Verbs in URLs

Verb-based URLs duplicate the role of the HTTP method, creating redundancy that breaks client tooling, caching proxies, and semantic contract expectations. The fix maps each action to the correct HTTP method on a noun-based resource path so the method itself conveys intent.

```go
// ❌ Wrong: Verb-based URLs
mux.HandleFunc("GET /getUsers", getUsers)
mux.HandleFunc("POST /createUser", createUser)
mux.HandleFunc("POST /deleteUser/{id}", deleteUser)

// ✅ Correct: Resource-based URLs with HTTP methods
mux.HandleFunc("GET /users", listUsers)
mux.HandleFunc("POST /users", createUser)
mux.HandleFunc("DELETE /users/{id}", deleteUser)
```

**Why it matters:** Verb-based URLs don't scale well, create inconsistency, and ignore HTTP method semantics. REST uses HTTP methods to express actions, not URL paths.

### Mistake 2: Ignoring Idempotency

A `PUT` handler that calls `Create` unconditionally will produce duplicates when a client retries after a network timeout. The correct approach uses an upsert (insert on first call, replace on subsequent calls) so any number of retries yields a single authoritative resource state.

```go
// ❌ Wrong: Non-idempotent PUT creates duplicates
func (h *Handler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    var user User
    json.NewDecoder(r.Body).Decode(&user)

    // Creates new record every time!
    h.db.Create(&user)
}

// ✅ Correct: PUT is idempotent - replace entire resource
func (h *Handler) ReplaceUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    var user User
    json.NewDecoder(r.Body).Decode(&user)
    user.ID = id

    // Upsert: create if not exists, replace if exists
    result := h.db.Save(&user)
    if result.RowsAffected == 0 {
        h.db.Create(&user)
    }
}
```

**Why it matters:** Network failures happen. Clients retry. PUT requests must produce the same result regardless of how many times they're called.

### Mistake 3: Exposing Internal Errors

Passing `err.Error()` directly to `http.Error` leaks SQL queries, file paths, and framework internals that attackers can exploit for reconnaissance. The corrected handler logs the full error with a request ID for internal tracing while returning only a generic message to the caller.

```go
// ❌ Wrong: Leaking internal details
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.db.Get(id)
    if err != nil {
        // Exposes database details, SQL queries, stack traces
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
}

// ✅ Correct: Generic errors + internal logging
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.repo.Get(r.Context(), id)
    if err != nil {
        // Log internal details
        h.logger.Error("failed to get user",
            "id", id,
            "error", err,
            "request_id", middleware.GetRequestID(r.Context()),
        )

        // Return safe error to client
        response.Error(w, http.StatusInternalServerError,
            "INTERNAL_ERROR", "An unexpected error occurred")
        return
    }
}
```

**Why it matters:** Error messages can reveal database schemas, file paths, framework versions, and other information useful for attackers.

### Mistake 4: Using Wrong Status Codes

Returning `200 OK` for error paths breaks HTTP clients, CDN caches, and monitoring dashboards that rely on status codes to detect failures. The corrected handler switches on sentinel error types to emit precise codes (`422` for validation failures, `409` for duplicates), giving API consumers the signal they need to retry or surface a user-facing message.

```go
// ❌ Wrong: Returning 200 for everything
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        json.NewEncoder(w).Encode(map[string]string{
            "error": err.Error(),
        })
        return // Still returns 200!
    }
    json.NewEncoder(w).Encode(user)
}

// ✅ Correct: Appropriate status codes
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        switch {
        case errors.Is(err, domain.ErrValidation):
            response.Error(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", err.Error())
        case errors.Is(err, domain.ErrDuplicate):
            response.Error(w, http.StatusConflict, "DUPLICATE", "Resource already exists")
        default:
            response.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to create")
        }
        return
    }

    w.Header().Set("Location", "/users/"+user.ID)
    response.JSON(w, http.StatusCreated, user) // 201 for creation
}
```

**Why it matters:** Clients rely on status codes for error handling, caching, and retry logic. HTTP proxies and CDNs use them for caching decisions.

### Mistake 5: Offset Pagination at Scale

Cursor-based pagination scales to large datasets by returning a stable opaque cursor instead of an offset, preventing the skipped-row problem that afflicts `OFFSET`-based pagination on frequently updated tables.

```go
// ❌ Wrong: Offset pagination breaks at scale
// GET /users?page=10000&page_size=20
// This requires scanning 200,000 rows to skip!
func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
    page := parseIntParam(r, "page", 1)
    pageSize := parseIntParam(r, "page_size", 20)
    offset := (page - 1) * pageSize

    // SLOW: SELECT * FROM users LIMIT 20 OFFSET 199980
    users, _ := h.db.Query("SELECT * FROM users LIMIT $1 OFFSET $2", pageSize, offset)
}

// ✅ Correct: Cursor-based pagination
// GET /users?cursor=IjEyMyI=&limit=20 (base64 of the JSON-encoded last id)
func (h *Handler) ListUsers(w http.ResponseWriter, r *http.Request) {
    cursor := r.URL.Query().Get("cursor")
    limit := parseIntParam(r, "limit", 20)

    var lastID string
    if cursor != "" {
        decoded, _ := base64.StdEncoding.DecodeString(cursor)
        json.Unmarshal(decoded, &lastID)
    }

    // FAST: Uses index on id
    query := "SELECT * FROM users WHERE id > $1 ORDER BY id LIMIT $2"
    users, _ := h.db.Query(query, lastID, limit+1)

    hasMore := len(users) > limit
    if hasMore {
        users = users[:limit]
    }

    var nextCursor string
    if hasMore && len(users) > 0 {
        cursorData, _ := json.Marshal(users[len(users)-1].ID)
        nextCursor = base64.StdEncoding.EncodeToString(cursorData)
    }

    response.JSON(w, http.StatusOK, PaginatedResponse{
        Data:       users,
        NextCursor: nextCursor,
        HasMore:    hasMore,
    })
}
```

**Why it matters:** Offset pagination performance degrades linearly with page number. At scale (millions of rows), late pages can take seconds or timeout entirely.

### Mistake 6: Unconsumed Response Body Causing Connection Leaks

Calling `resp.Body.Close()` without reading the response body to completion is a widespread source of socket exhaustion and latency spikes, as analyzed by [Franck Kambiwa (September 2026), "The One-Line Bug That’s Silently Killing Your Go HTTP Client’s Performance"](https://medium.com/@franckkambiwa/the-one-line-bug-thats-silently-killing-your-go-http-client-s-performance-16df2206bc18).

#### The Failure Mechanics

In Go's `net/http/transport.go`, each persistent HTTP/1.1 connection is managed by a `persistConn` running a background `readLoop`. The response body returned to the caller is wrapped in an internal `bodyEOFSignal`.

When `resp.Body.Close()` is called:
- If the body was read until `io.EOF`, `bodyEOFSignal` flags the connection as cleanly drained (`bodyEOF = true`). The transport returns the underlying TCP connection to the idle pool via `tryPutIdleConn`.
- If `resp.Body.Close()` is called before `io.EOF` is reached (for instance, when inspecting only the HTTP status code or returning early on error), `bodyEOF` remains `false`. The transport permanently closes the underlying `net.Conn`.

```go
// ❌ WRONG: Closing early without reading the body destroys connection reuse
resp, err := client.Do(req)
if err != nil {
    return err
}
defer resp.Body.Close()

if resp.StatusCode != http.StatusOK {
    return fmt.Errorf("upstream error: %d", resp.StatusCode) // Connection closed, never reused!
}
```

Under heavy outbound traffic (e.g., 2,000 req/s), closing unread connections forces the Go runtime to perform fresh TCP 3-way handshakes and TLS negotiations on every request. This exhausts local ephemeral ports into `TIME_WAIT` status (`dial tcp: bind: address already in use`), while multiplying outbound latency by 5x to 20x.

#### The Safe Bounded Drain Pattern

Always drain remaining response bytes before closing, but cap the read size to prevent unbounded memory consumption from rogue payloads:

```go
// ✅ CORRECT: Drain up to 512KB to allow connection reuse, then close
resp, err := client.Do(req)
if err != nil {
    return err
}
defer func() {
    // Discard up to 512KB of unread body so the transport can safely reuse the TCP socket
    _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 512*1024))
    _ = resp.Body.Close()
}()
```

### Junior → FAANG: The Seven Mistakes You Will Actually Make in Year One

The five mistakes above are real, but they are the ones seniors notice in review. The ones that will bite you in your first production incident are subtler. Learn to recognize them as reflexes.

Mistake A, the 200-for-everything anti-pattern. Most junior code you inherit returns 200 with a JSON body like `{"success": false, "error": "not found"}`. It feels defensive because the response always parses. It is catastrophic. CDN caches 200 responses. Load balancer health checks see green. Monitoring dashboards report no errors. Retry middleware does not retry. The fix is mechanical. Errors get 4xx or 5xx, success gets 2xx, and the body shape differs between the two. If your client library cannot handle that, fix the client, not the server.

Mistake B, enveloped responses everywhere. `{"data": {...}, "meta": {...}, "status": "ok"}` on every endpoint was fashionable circa 2015. It is mostly cargo cult. RFC 9457 (`application/problem+json`) covers errors. For success you return the resource directly. Envelopes only earn their keep when you have list pagination metadata or when you genuinely need sibling-level fields (warnings, deprecations). Otherwise they force every client to `.data` unwrap and they break HTTP content negotiation.

Mistake C, no rate limit on anything. Junior dev ships an endpoint, writes no limiter, gets paged at 3am because one client's retry loop with no jitter took down the database. The reflex is, every new endpoint has a rate limit before it ships, even if the limit is permissive. Token bucket per API key, 429 with `Retry-After` header, documented in the OpenAPI spec.

Mistake D, no auth on internal endpoints. "It's behind the firewall" is wrong for three reasons. First, flat networks are rare. Second, service compromises propagate laterally. Third, mTLS is almost free with a service mesh. Every endpoint has an auth check, even internal. `Authorization: Bearer <service-token>` or mTLS at the mesh level. No exceptions.

Mistake E, over-fetching because you shipped no field selection. Your mobile team complains that `/users/{id}` returns 14KB when they need five fields. Add `?fields=id,name,email` parsing. It is thirty lines of code. If you ignore it you will be asked for a GraphQL migration in eighteen months, and that is a year of work.

Mistake F, breaking changes without versioning. You rename `user_name` to `username`. Clients break. You apologize in the changelog. This is a fireable pattern if it happens twice. Every field rename is additive. Add the new field, leave the old, deprecate in the response headers (`Deprecation: @<timestamp>`, `Sunset: <date>`), remove after the sunset window. Never before.

Mistake G, no idempotency on mutations. Covered in Mistake 2 above for `PUT`, but `POST` needs it too. Stripe's `Idempotency-Key` header is the template. Hash the request body into the stored key so a replay with a different body is a client error, not a silent overwrite.

Worked "why did this fail" drill. Incident: duplicate charge. You check the logs. Two `POST /charges` requests arrived twelve seconds apart from the same client, both returned 201. The junior diagnosis is "bug in the client retry." The FAANG diagnosis is "we accepted two mutating requests without idempotency, that is our bug, fix is to require `Idempotency-Key` on all `POST` and reject requests without it after a grace period." Blame lands on the server design, not the client, because the server's job is to be safe by construction.

Interview entry-point. "Tell me about a mistake you caught in a code review recently." The answer that gets you hired is concrete, references one of the seven mistakes above, names the specific fix, and articulates why the fix is the default, not a workaround. The answer that does not is "I found a typo."

### Senior @ FAANG: Mistake Taxonomy, Governance, and Deprecation at Scale

At staff level the question is not "what are the mistakes" but "why do they keep happening" and "what systemic control kills them at the source." The answer is always governance plus tooling plus incentives, not a style guide PDF.

Taxonomy of mistakes by failure mode. Design-time mistakes (verbs in URLs, enveloped responses, no versioning strategy) are caught by API review board and Spectral linter in CI. Implementation-time mistakes (200-for-everything, exposing internal errors, missing idempotency) are caught by a handler-level middleware stack that enforces invariants and by contract tests. Operation-time mistakes (no rate limit, no auth on internal, no pagination) are caught by gateway-level policy that defaults to deny. Evolution-time mistakes (breaking changes, silent removals) are caught by `openapi-diff` or `buf breaking` in CI and by a deprecation policy with teeth.

Anti-pattern catalog worth writing down. The 200-for-everything pattern appears when a team optimizes for "the JSON always parses." Fix is banning it at the linter level. The enveloped-response pattern appears when a team copied a 2015 JSON:API tutorial. Fix is deprecating the envelope on new endpoints and leaving legacy alone. The leaking-stack-traces pattern appears when error middleware is opt-in instead of default. Fix is a top-level recovery middleware that logs with request ID and returns RFC 9457 `problem+json`. The no-pagination pattern appears when a list endpoint ships with `SELECT * FROM table LIMIT 100` and grows into `LIMIT 10000` by customer request. Fix is a cursor-pagination library that every list endpoint must import, with a lint rule banning raw `LIMIT` in handlers. The no-idempotency-on-mutations pattern appears when the first POST endpoint was shipped before the platform team existed. Fix is a required header on all mutating endpoints, enforced at the gateway.

Bar-raiser question, "kill a deprecated endpoint at 10K callers." The L5 answer is sequenced. Step 1, enumerate callers from access logs keyed by API key. Step 2, partition into owned-by-us (internal teams), owned-by-partner (contracted), owned-by-public (unknown). Step 3, for each partition define a sunset date with SLA. Internal 90 days, partner 180, public 365. Step 4, add `Deprecation: @<timestamp>`, `Sunset: <date>`, and `Link: <migration-guide>; rel="deprecation"` to every response on the old endpoint. Step 5, land a dashboard that tracks caller count per partition per week. Step 6, open support tickets per partner at T-minus-180, T-minus-90, T-minus-30. Step 7, at T-minus-7, start returning 299 warnings. Step 8, at T-zero, return 410 Gone with migration URL, not 404. Step 9, leave the 410 in place for another year before removing the route entirely. This is a multi-quarter project, not a ticket.

Bar-raiser question, "audit an API surface of 500 endpoints." Mechanize the audit. Feed the OpenAPI spec to Spectral with a rigorous ruleset (naming, response codes, auth, examples, error shape, pagination). Diff against last quarter's baseline via `openapi-diff`. Spot-check ten random endpoints manually for drift between spec and implementation using contract tests. Categorize findings as P0 (security, breaking change), P1 (consistency, missing auth on internal), P2 (stylistic, missing examples). Ship the report with an owner per finding and a due date. Re-audit quarterly. The audit is a capability the platform team owns, not a one-time project.

Bar-raiser question, "migrate REST to gRPC." The honest answer starts with "probably do not, and here is how I would decide." Inventory the traffic patterns. If 80% of calls are server-to-server with a typed SDK, gRPC is a win. If 80% are browser clients, gRPC-Web adds cost without protocol benefit. If 80% are mobile, the battery and size of protobuf versus JSON matters. Migration strategy if you do go: stand up gRPC alongside REST, proxy REST to gRPC at the gateway, migrate heavy internal callers first, leave public REST in place indefinitely. Never do a big-bang cutover.

Bar-raiser question, "design an API for a multi-tenant SaaS." The ADR has four axes. Tenancy in URL versus JWT claim (URL is auditable, JWT is pretty). Rate limits per-tenant and per-endpoint (sliding window, Redis-backed, fail-open with circuit breaker). Authorization at gateway plus service layer (defense in depth). Data residency as a routing concern (tenant-region map at the gateway, not per-service). Pick URL-embedded tenancy for regulated industries, JWT for startups, prepare to migrate if you picked wrong.

Governance artifacts. API review board with a written charter. Spectral ruleset as code, versioned, tested. Pact contract tests between every consumer and producer, gating merges. `buf breaking` or `openapi-diff` blocking breaking changes unless the PR is labeled `api-breaking-approved`. Deprecation policy with SLAs published. Quarterly API audit with a published dashboard. Bar-raiser reviewer required for new top-level resources.

Maturity model per mistake. L1 teams make these mistakes and do not know. L2 teams know and document them in a style guide nobody reads. L3 teams lint for them in CI. L4 teams fail builds on them and have middleware that makes them impossible. L5 teams have forgotten these are mistakes because the platform makes the right thing the default. Your goal as staff is to move your org up one level per year.

---
