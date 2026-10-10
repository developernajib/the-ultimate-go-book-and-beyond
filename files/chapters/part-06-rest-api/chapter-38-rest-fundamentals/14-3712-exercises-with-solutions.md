## 38.12 Exercises with Solutions

### Exercise 1: Build a Complete CRUD API with HATEOAS

**Problem:** Create a bookstore API that follows REST best practices with HATEOAS links.

**Solution:**

```go
// ... imports omitted for brevity (encoding/json, fmt, log/slog, net/http, os, sync, time, uuid)

// Domain models
type Book struct {
    ID          string    `json:"id"`
    Title       string    `json:"title"`
    Author      string    `json:"author"`
    ISBN        string    `json:"isbn"`
        PriceCents  int64    `json:"price_cents"`
    PublishedAt time.Time `json:"published_at"`
    CreatedAt   time.Time `json:"created_at"`
    UpdatedAt   time.Time `json:"updated_at"`
}

// Response types with HATEOAS
type BookResponse struct {
    Data  *Book      `json:"data"`
    Links BookLinks  `json:"_links"`
}

type BookListResponse struct {
    Data  []BookWithLinks `json:"data"`
    Meta  PaginationMeta  `json:"meta"`
    Links ListLinks       `json:"_links"`
}

type BookWithLinks struct {
    Book
    Links BookLinks `json:"_links"`
}

type BookLinks struct {
    Self   Link `json:"self"`
    Author Link `json:"author,omitempty"`
    Delete Link `json:"delete,omitempty"`
    Update Link `json:"update,omitempty"`
}

type ListLinks struct {
    Self  Link `json:"self"`
    Next  Link `json:"next,omitempty"`
    Prev  Link `json:"prev,omitempty"`
    First Link `json:"first"`
    Last  Link `json:"last,omitempty"`
}

type Link struct {
    Href   string `json:"href"`
    Method string `json:"method,omitempty"`
}

type PaginationMeta struct {
    Page       int   `json:"page"`
    PageSize   int   `json:"page_size"`
    TotalCount int64 `json:"total_count"`
    TotalPages int   `json:"total_pages"`
}

// In-memory store (replace with database in production)
// Standard sync.RWMutex-backed map store - implements Create/Get/List/Update/Delete
// with UUID generation, timestamps, and offset pagination on the List method.
type BookStore struct {
    mu    sync.RWMutex
    books map[string]*Book
}

func NewBookStore() *BookStore { return &BookStore{books: make(map[string]*Book)} }

func (s *BookStore) Create(book *Book) error {
    s.mu.Lock(); defer s.mu.Unlock()
    book.ID = uuid.New().String(); book.CreatedAt = time.Now(); book.UpdatedAt = time.Now()
    s.books[book.ID] = book; return nil
}

func (s *BookStore) Get(id string) (*Book, bool) {
    s.mu.RLock(); defer s.mu.RUnlock(); return s.books[id], s.books[id] != nil
}

func (s *BookStore) List(page, pageSize int) ([]Book, int64) {
    s.mu.RLock(); defer s.mu.RUnlock()
    all := make([]Book, 0, len(s.books))
    for _, b := range s.books { all = append(all, *b) }
    total := int64(len(all))
    start := (page - 1) * pageSize
    if start >= len(all) { return []Book{}, total }
    end := start + pageSize; if end > len(all) { end = len(all) }
    return all[start:end], total
}

func (s *BookStore) Update(id string, book *Book) bool {
    s.mu.Lock(); defer s.mu.Unlock()
    if _, ok := s.books[id]; !ok { return false }
    book.ID = id; book.UpdatedAt = time.Now(); s.books[id] = book; return true
}

func (s *BookStore) Delete(id string) bool {
    s.mu.Lock(); defer s.mu.Unlock()
    if _, ok := s.books[id]; !ok { return false }
    delete(s.books, id); return true
}

// Handlers
type BookHandler struct {
    store  *BookStore
    logger *slog.Logger
}

func NewBookHandler(store *BookStore, logger *slog.Logger) *BookHandler {
    return &BookHandler{store: store, logger: logger}
}

func (h *BookHandler) List(w http.ResponseWriter, r *http.Request) {
    page := parseQueryInt(r, "page", 1)
    pageSize := parseQueryInt(r, "page_size", 10)
    if pageSize > 100 {
        pageSize = 100
    }

    books, total := h.store.List(page, pageSize)
    totalPages := int((total + int64(pageSize) - 1) / int64(pageSize))

    // Build response with HATEOAS links
    booksWithLinks := make([]BookWithLinks, len(books))
    for i, book := range books {
        booksWithLinks[i] = BookWithLinks{
            Book: book,
            Links: BookLinks{
                Self:   Link{Href: fmt.Sprintf("/api/v1/books/%s", book.ID), Method: "GET"},
                Update: Link{Href: fmt.Sprintf("/api/v1/books/%s", book.ID), Method: "PUT"},
                Delete: Link{Href: fmt.Sprintf("/api/v1/books/%s", book.ID), Method: "DELETE"},
            },
        }
    }

    baseURL := "/api/v1/books"
    links := ListLinks{
        Self:  Link{Href: fmt.Sprintf("%s?page=%d&page_size=%d", baseURL, page, pageSize)},
        First: Link{Href: fmt.Sprintf("%s?page=1&page_size=%d", baseURL, pageSize)},
    }

    if page < totalPages {
        links.Next = Link{Href: fmt.Sprintf("%s?page=%d&page_size=%d", baseURL, page+1, pageSize)}
        links.Last = Link{Href: fmt.Sprintf("%s?page=%d&page_size=%d", baseURL, totalPages, pageSize)}
    }
    if page > 1 {
        links.Prev = Link{Href: fmt.Sprintf("%s?page=%d&page_size=%d", baseURL, page-1, pageSize)}
    }

    writeJSON(w, http.StatusOK, BookListResponse{
        Data: booksWithLinks,
        Meta: PaginationMeta{
            Page:       page,
            PageSize:   pageSize,
            TotalCount: total,
            TotalPages: totalPages,
        },
        Links: links,
    })
}

func (h *BookHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    book, found := h.store.Get(id)
    if !found {
        writeError(w, http.StatusNotFound, "NOT_FOUND", "Book not found")
        return
    }

    writeJSON(w, http.StatusOK, BookResponse{
        Data: book,
        Links: BookLinks{
            Self:   Link{Href: fmt.Sprintf("/api/v1/books/%s", id), Method: "GET"},
            Update: Link{Href: fmt.Sprintf("/api/v1/books/%s", id), Method: "PUT"},
            Delete: Link{Href: fmt.Sprintf("/api/v1/books/%s", id), Method: "DELETE"},
        },
    })
}

func (h *BookHandler) Create(w http.ResponseWriter, r *http.Request) {
    var input struct {
        Title       string    `json:"title"`
        Author      string    `json:"author"`
        ISBN        string    `json:"isbn"`
    PriceCents  int64    `json:"price_cents"`
        PublishedAt time.Time `json:"published_at"`
    }

    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
        return
    }

    // Validation
    if input.Title == "" {
        writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Title is required")
        return
    }

    book := &Book{
        Title:       input.Title,
        Author:      input.Author,
        ISBN:        input.ISBN,
        PriceCents:  input.PriceCents,
        PublishedAt: input.PublishedAt,
    }

    if err := h.store.Create(book); err != nil {
        h.logger.Error("failed to create book", "error", err)
        writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to create book")
        return
    }

    w.Header().Set("Location", fmt.Sprintf("/api/v1/books/%s", book.ID))
    writeJSON(w, http.StatusCreated, BookResponse{
        Data: book,
        Links: BookLinks{
            Self: Link{Href: fmt.Sprintf("/api/v1/books/%s", book.ID), Method: "GET"},
        },
    })
}

func (h *BookHandler) Update(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    existing, found := h.store.Get(id)
    if !found {
        writeError(w, http.StatusNotFound, "NOT_FOUND", "Book not found")
        return
    }

    var input Book
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
        return
    }

    input.CreatedAt = existing.CreatedAt
    h.store.Update(id, &input)

    writeJSON(w, http.StatusOK, BookResponse{
        Data: &input,
        Links: BookLinks{
            Self: Link{Href: fmt.Sprintf("/api/v1/books/%s", id), Method: "GET"},
        },
    })
}

func (h *BookHandler) Delete(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    if !h.store.Delete(id) {
        writeError(w, http.StatusNotFound, "NOT_FOUND", "Book not found")
        return
    }

    w.WriteHeader(http.StatusNoContent)
}

// Utility functions (writeJSON, writeError, parseQueryInt) - same pattern
// as response package in section 38.8; see WriteJSON/WriteError there.

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    store := NewBookStore()
    handler := NewBookHandler(store, logger)

    mux := http.NewServeMux()

    // Book routes
    mux.HandleFunc("GET /api/v1/books", handler.List)
    mux.HandleFunc("POST /api/v1/books", handler.Create)
    mux.HandleFunc("GET /api/v1/books/{id}", handler.Get)
    mux.HandleFunc("PUT /api/v1/books/{id}", handler.Update)
    mux.HandleFunc("DELETE /api/v1/books/{id}", handler.Delete)

    logger.Info("starting server", "port", 8080)
    http.ListenAndServe(":8080", mux)
}
```

### Exercise 2: Implement Idempotent POST with Redis

**Problem:** Implement an idempotent payment creation endpoint that safely handles retries.

**Solution:**

```go
// ... imports omitted for brevity (context, crypto/sha256, encoding/hex, encoding/json, errors, net/http, time, github.com/redis/go-redis/v9)

type PaymentRequest struct {
    Amount      int64  `json:"amount"`
    Currency    string `json:"currency"`
    Description string `json:"description"`
    CustomerID  string `json:"customer_id"`
}

type PaymentResponse struct {
    ID          string    `json:"id"`
    Amount      int64     `json:"amount"`
    Currency    string    `json:"currency"`
    Status      string    `json:"status"`
    CustomerID  string    `json:"customer_id"`
    CreatedAt   time.Time `json:"created_at"`
}

type CachedResponse struct {
    StatusCode int             `json:"status_code"`
    Body       json.RawMessage `json:"body"`
    Timestamp  time.Time       `json:"timestamp"`
}

type IdempotencyStore struct {
    redis *redis.Client
    ttl   time.Duration
}

func NewIdempotencyStore(redis *redis.Client, ttl time.Duration) *IdempotencyStore {
    return &IdempotencyStore{
        redis: redis,
        ttl:   ttl,
    }
}

// Get retrieves a cached response for an idempotency key
func (s *IdempotencyStore) Get(ctx context.Context, key string) (*CachedResponse, error) {
    data, err := s.redis.Get(ctx, "idempotency:"+key).Bytes()
    if err == redis.Nil {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }

    var cached CachedResponse
    if err := json.Unmarshal(data, &cached); err != nil {
        return nil, err
    }

    return &cached, nil
}

// Lock attempts to acquire a lock for the idempotency key
// Returns true if lock acquired, false if another request is processing
func (s *IdempotencyStore) Lock(ctx context.Context, key string) (bool, error) {
    lockKey := "idempotency:lock:" + key

    // Try to set lock with NX (only if not exists)
    ok, err := s.redis.SetNX(ctx, lockKey, time.Now().Unix(), 30*time.Second).Result()
    if err != nil {
        return false, err
    }

    return ok, nil
}

// Unlock releases the lock
func (s *IdempotencyStore) Unlock(ctx context.Context, key string) error {
    return s.redis.Del(ctx, "idempotency:lock:"+key).Err()
}

// Save stores the response for the idempotency key
func (s *IdempotencyStore) Save(ctx context.Context, key string, resp *CachedResponse) error {
    data, err := json.Marshal(resp)
    if err != nil {
        return err
    }

    return s.redis.Set(ctx, "idempotency:"+key, data, s.ttl).Err()
}

type PaymentHandler struct {
    idempotency   *IdempotencyStore
    paymentService PaymentService
}

type PaymentService interface {
    CreatePayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error)
}

func (h *PaymentHandler) CreatePayment(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // 1. Get idempotency key from header
    idempotencyKey := r.Header.Get("Idempotency-Key")
    if idempotencyKey == "" {
        writeError(w, http.StatusBadRequest, "MISSING_IDEMPOTENCY_KEY",
            "Idempotency-Key header is required")
        return
    }

    // 2. Parse request body (we'll need it to verify matching requests)
    var req PaymentRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        writeError(w, http.StatusBadRequest, "INVALID_JSON", "Invalid request body")
        return
    }

    // 3. Create composite key including request hash for request matching.
    // Note: keying on (key + hash) treats a reused key with a different body
    // as a brand-new request. Production systems should store the hash under
    // the bare key and reject mismatches with 422 (see the extensions below).
    requestHash := hashRequest(req)
    compositeKey := idempotencyKey + ":" + requestHash

    // 4. Check for cached response
    cached, err := h.idempotency.Get(ctx, compositeKey)
    if err != nil {
        writeError(w, http.StatusInternalServerError, "CACHE_ERROR", "Failed to check idempotency cache")
        return
    }

    if cached != nil {
        // Return cached response
        w.Header().Set("X-Idempotent-Replayed", "true")
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(cached.StatusCode)
        w.Write(cached.Body)
        return
    }

    // 5. Try to acquire lock
    locked, err := h.idempotency.Lock(ctx, compositeKey)
    if err != nil {
        writeError(w, http.StatusInternalServerError, "LOCK_ERROR", "Failed to acquire lock")
        return
    }

    if !locked {
        // Another request is processing this key
        writeError(w, http.StatusConflict, "CONCURRENT_REQUEST",
            "Another request with this idempotency key is being processed")
        return
    }
    defer h.idempotency.Unlock(ctx, compositeKey)

    // 6. Double-check cache after acquiring lock
    cached, err = h.idempotency.Get(ctx, compositeKey)
    if err == nil && cached != nil {
        w.Header().Set("X-Idempotent-Replayed", "true")
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(cached.StatusCode)
        w.Write(cached.Body)
        return
    }

    // 7. Process the payment
    payment, err := h.paymentService.CreatePayment(ctx, req)

    var statusCode int
    var body json.RawMessage

    if err != nil {
        // Determine error type and status code
        var apiErr *APIError
        if errors.As(err, &apiErr) {
            statusCode = apiErr.Status
            body, _ = json.Marshal(apiErr)
        } else {
            statusCode = http.StatusInternalServerError
            body, _ = json.Marshal(map[string]string{
                "error": "Internal server error",
            })
        }
    } else {
        statusCode = http.StatusCreated
        body, _ = json.Marshal(payment)
    }

    // 8. Cache the response (for both success and client errors)
    // Don't cache 5xx errors - those should be retried
    if statusCode < 500 {
        h.idempotency.Save(ctx, compositeKey, &CachedResponse{
            StatusCode: statusCode,
            Body:       body,
            Timestamp:  time.Now(),
        })
    }

    // 9. Return response
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    w.Write(body)
}

func hashRequest(req PaymentRequest) string {
    data, _ := json.Marshal(req)
    hash := sha256.Sum256(data)
    return hex.EncodeToString(hash[:])[:16]
}

// APIError - see definition in section 38.2 - also implements error interface:
// func (e *APIError) Error() string { return e.Message }
```

### Junior → FAANG: Extending These Exercises for Real Learning

These two exercises are the minimum viable REST API. If you stop where the solution stops, you will pass a bootcamp final but fail an onsite. Here is how to extend each for genuine signal.

Exercise 1 extensions, in order. First, replace the sync.RWMutex-backed map with a real Postgres store, using `pgx` and parameterized queries. Add a `migrations/` directory with `0001_create_books.up.sql` and `.down.sql`. This is non-negotiable. Every interview asks "where does the data live," and "in-memory" is the wrong answer in 2026. Second, replace offset pagination with cursor pagination using `(created_at, id)` as a composite sort key. Third, add `ETag` generation from a hash of the book's `updated_at` and return 304 on `If-None-Match`. Fourth, write table-driven tests that cover 201, 200, 404, 422, 409 paths. Fifth, generate an OpenAPI spec by hand (not with a generator) and lint it with Spectral. Sixth, add a `/health` endpoint and a `/metrics` endpoint using Prometheus. By the time you finish these six extensions, you have shipped a production-shaped API, which is the interview signal.

Exercise 2 extensions. First, replace the Redis `SETNX` lock with a proper `INSERT ... ON CONFLICT DO NOTHING RETURNING` against Postgres, because Redis locks have well-documented failure modes under split-brain (see Martin Kleppmann on Redlock). Second, handle the case where the handler crashes after saving the payment but before caching the response. The next retry will create a duplicate. Fix is to persist the idempotency record in the same transaction as the payment, not after. Third, add the body-hash-collision test. Send two requests with the same key and different bodies. The second must return 422 with a clear error message referencing RFC-style guidance. Fourth, measure throughput under load with `hey` or `k6` at 1000 requests per second, graph tail latency, identify the bottleneck (almost certainly Redis round-trips).

"Why did this fail" drill against Exercise 2. A customer reports a duplicate charge. You have logs showing two requests with the same `Idempotency-Key` arriving 200ms apart. Walk the decision tree aloud. Did both requests see an empty cache? If yes, the lock did not serialize them, which means Redis was partitioned or the lock key differed. Did one request see the cache? If yes, was the cached response returned correctly? If the cached response was returned but the customer was still charged twice, the bug is upstream (the lock acquired false positives) or downstream (the payment processor itself is not idempotent). This drill trains the reflex interviewers grade on.

First-job context. You will inherit a handler that looks like Exercise 2 but without the locking, without the body hash, without the 5xx-skip logic. Your job is to add them without breaking existing clients. That is an incremental refactor, gated behind a feature flag, with dashboards to confirm the new behavior in production.

Interview entry-point. A common L4 screen asks you to code Exercise 1 live. You will be graded on three things. First, correct HTTP semantics (201 with Location, 204 for delete, 422 for validation). Second, test coverage (did you write tests, not just handlers). Third, articulated tradeoffs (why you picked offset over cursor, even if you picked wrong, as long as you named the tradeoff). Practice coding Exercise 1 from scratch in under 45 minutes, speaking the tradeoffs aloud.

### Senior @ FAANG: Staff-Level Exercise Extensions

At staff and principal level, these exercises are starting points for platform artifacts, not end products. Each extends into a multi-sprint project that produces something the whole org uses.

Staff extension 1, build a REST API spec review tool. Wrap Spectral in a CLI with your org's ruleset baked in. Rules at minimum: naming conventions (snake_case fields, plural noun resources), required response codes on every path (200, 400, 401, 403, 404, 500), required examples on every schema, required `operationId` for SDK generation, required pagination schema on list endpoints, required idempotency header declaration on POST endpoints, banned patterns (verbs in URLs, enveloped responses on new endpoints, 200 with error body). Ship as a GitHub App that posts PR comments with rule violations, a required check that blocks merges on P0 rules, and a dashboard that tracks per-team compliance over time. Budget one engineer-quarter for v1, two for v2 with the dashboard and the exception workflow. Governance: the ruleset itself is code-reviewed by the API review board, not by individual engineers.

Staff extension 2, design an API gateway with rate-limit, auth, canary, and observability. Architecture: Envoy or a Go gateway like Kong, with rate limiting backed by Redis sliding window, auth via JWT verification against a JWKS endpoint cached locally with five-minute TTL, canary routing keyed on a header set by the client or a percentage rule, observability via OpenTelemetry with propagated trace context and structured access logs shipped to a logging pipeline. Load-bearing decisions. Fail-open versus fail-closed on Redis outage (fail-open with a conservative local-cache fallback is the standard). JWT verification at the edge versus at the service (edge plus service, defense in depth). Canary routing as header-based for testing or percentage-based for production rollouts. SLO: gateway adds less than 5ms p99 latency. Budget two engineer-quarters for the gateway itself plus one engineer-quarter per integration (Redis, JWKS, OTel, canary controller).

Staff extension 3, implement an RFC-compliant pagination library. Support three modes. Cursor (base64-encoded JSON, HMAC-signed, composite sort key). Offset (opt-in, capped at page 100). Link-header (GitHub-style, RFC 8288). One Go package, one API surface, three implementations under a `pagination.Strategy` interface. Test matrix: stability under concurrent inserts, stability under deletes, stability under reordering, cursor tamper resistance (modified cursor returns 400), cursor expiration (cursors older than 24h return 410). Ship with a generator that emits the SQL for a given table and sort key. Adoption plan: all new list endpoints must use this library, existing endpoints migrate over two quarters, migration tracked on a platform dashboard. Budget one engineer-quarter for the library, one for the migration tooling.

Staff extension 4, build a contract testing pipeline. Pact Broker hosted internally, per-consumer pacts published on every PR, per-provider verification on every PR, `can-i-deploy` gate before production release. Add an `openapi-diff` bot that runs on every PR against the main-branch OpenAPI and blocks merges on breaking changes unless the PR carries the `api-breaking-approved` label, which requires API review board sign-off. Budget two engineer-quarters for the pipeline, ongoing operational cost roughly one engineer-week per quarter.

Staff extension 5, design a deprecation workflow at scale. Deprecation is an SDLC event, not a code comment. Every deprecation produces a ticket, an owner, a sunset date, a migration guide, a dashboard of remaining callers, a comms plan (email to API keys, changelog, developer portal banner), and a rollback plan. Enforcement: responses on deprecated endpoints must carry `Deprecation: @<timestamp>`, `Sunset: <date>`, and `Link: <migration-url>; rel="deprecation"`. At sunset minus 7 days, responses add a 299 warning. At sunset, responses become 410 Gone with migration URL. The endpoint route is not removed until sunset plus 365 days. Tooling: a deprecation manager service that reads deprecation metadata from a YAML file, updates the OpenAPI spec, injects middleware that adds the headers, and queries access logs to produce the remaining-callers dashboard. Budget three engineer-quarters.

Staff extension 6, API platform maturity uplift. Map your org against L1 through L5. Identify the next-level gap. Fund a quarterly deliverable that closes one gap. Measure success by a specific metric. Breaking-change rate, time-to-deprecate, per-team spec-compliance percentage, new-endpoint review turnaround, developer NPS. Publish the metric dashboard. Defend it in staff reviews. Repeat.

ADR template for each extension. Context: what problem this solves, what scale triggers it. Decision: the architecture, the ruleset, the governance hook. Consequences: what future work is now cheap, what is now expensive, what exceptions are allowed and who approves them. Alternatives considered: buy versus build, centralized versus federated, opt-in versus required. Review cadence: the platform team reviews the artifact quarterly.

Principal-level signal on exercises. The principal does not implement the extensions. The principal picks which extensions the org needs in what order, justifies the sequencing against business risk, funds them against roadmap priorities, and staffs them with the right mix of platform and embedded engineers. The exercises themselves are demonstrations that the principal understands the work well enough to decompose, estimate, and review. That understanding is the signal.

---
