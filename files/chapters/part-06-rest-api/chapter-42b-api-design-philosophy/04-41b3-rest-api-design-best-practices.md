## 42B.3 REST API Design Best Practices

### Resource Naming: Nouns, Not Verbs

REST is resource-oriented. Resources are things (nouns), not actions (verbs). The HTTP method conveys the action.

```
# Wrong: verb-based (RPC-style)
POST /createUser
POST /deleteUser
GET  /getUserById
POST /sendUserEmailVerification

# Right: resource-based
POST   /users
DELETE /users/{id}
GET    /users/{id}
POST   /users/{id}/email-verifications
```

Use **plural nouns** for collection resources:
```
/users       (not /user)
/orders      (not /order)
/products    (not /product)
```

Use **kebab-case** for multi-word resource names:
```
/email-addresses   (not /emailAddresses or /email_addresses)
/payment-methods   (not /paymentMethods)
/api-keys          (not /apiKeys)
```

Use **sub-resources** for relationships:
```
/users/{user_id}/addresses
/orders/{order_id}/line-items
/products/{product_id}/variants
```

### HTTP Methods and Their Semantics

The safe/idempotent/cacheable properties of each method determine how caches, load balancers, and retry logic treat the request. GET can be retried automatically, DELETE is idempotent and can be retried safely, while POST is neither and requires client-managed idempotency keys. Violating these semantics (for example, using GET for state-changing operations) breaks HTTP infrastructure that relies on these guarantees.

```go
// GET: Safe (no side effects), Idempotent
// Use for: reading resources, searching, listing
// Body: none (use query params)
// Response: 200 OK with body, or 404 Not Found

// POST: Not safe, Not idempotent
// Use for: creating resources, triggering actions
// Body: resource representation or action payload
// Response: 201 Created + Location header, or 200 OK for actions

// PUT: Not safe, Idempotent
// Use for: full resource replacement (send complete representation)
// Body: complete resource representation
// Response: 200 OK with updated resource, or 204 No Content

// PATCH: Not safe, Not necessarily idempotent
// Use for: partial resource update (send only changed fields)
// Body: partial resource or JSON Patch (RFC 6902)
// Response: 200 OK with updated resource

// DELETE: Not safe, Idempotent
// Use for: removing resources
// Body: none (or reason in body, not recommended)
// Response: 204 No Content, or 200 OK if returning deleted resource
```

In Go, a clean handler organization:

```go
package api

import (
    "net/http"
    "github.com/go-chi/chi/v5"
)

func RegisterUserRoutes(r chi.Router, h *UserHandler) {
    r.Route("/users", func(r chi.Router) {
        r.Get("/", h.ListUsers)       // GET    /users
        r.Post("/", h.CreateUser)     // POST   /users

        r.Route("/{userID}", func(r chi.Router) {
            r.Get("/", h.GetUser)      // GET    /users/{userID}
            r.Put("/", h.ReplaceUser)  // PUT    /users/{userID}
            r.Patch("/", h.UpdateUser) // PATCH  /users/{userID}
            r.Delete("/", h.DeleteUser)// DELETE /users/{userID}

            r.Route("/addresses", func(r chi.Router) {
                r.Get("/", h.ListAddresses)      // GET    /users/{userID}/addresses
                r.Post("/", h.CreateAddress)     // POST   /users/{userID}/addresses
                r.Delete("/{addrID}", h.DeleteAddress) // DELETE /users/{userID}/addresses/{addrID}
            })
        })
    })
}
```

### HTTP Status Codes: Be Precise

The most commonly misused status codes:

```
2xx Success:
  200 OK              - Success with body (GET, PUT, PATCH responses)
  201 Created         - Resource created (POST response, include Location header)
  202 Accepted        - Request accepted for async processing
  204 No Content      - Success with no body (DELETE, some PATCHes)

3xx Redirection:
  301 Moved Permanently  - Resource has a new permanent URL
  304 Not Modified       - Conditional GET, client's cache is fresh
  307 Temporary Redirect - Preserve HTTP method on redirect
  308 Permanent Redirect - Preserve HTTP method on permanent redirect

4xx Client Errors:
  400 Bad Request         - Malformed request syntax
  401 Unauthorized        - Not authenticated (misleading name: means "not logged in")
  403 Forbidden           - Authenticated but not authorized ("not allowed")
  404 Not Found           - Resource doesn't exist (or you're hiding it)
  405 Method Not Allowed  - HTTP method not supported on this resource
  409 Conflict            - Resource state conflict (duplicate create, etc.)
  410 Gone                - Resource existed but was permanently deleted
  422 Unprocessable Entity- Syntactically valid but semantically invalid
  429 Too Many Requests   - Rate limit exceeded

5xx Server Errors:
  500 Internal Server Error - Unexpected server error
  502 Bad Gateway           - Upstream service error
  503 Service Unavailable   - Server temporarily unavailable (use Retry-After)
  504 Gateway Timeout       - Upstream service timeout
```

Common mistakes:

```
# Wrong: returning 200 for validation errors
HTTP/1.1 200 OK
{"success": false, "error": "email is required"}

# Right: 422 for semantic validation failures
HTTP/1.1 422 Unprocessable Entity
{"type": "validation_error", "code": "missing_required_field", "param": "email"}

# Wrong: returning 404 when user isn't authorized to see a resource
# (information leak: reveals the resource exists)
HTTP/1.1 404 Not Found  ← attacker now knows ID 42 exists

# Better: 403 if authenticated, 401 if not authenticated
HTTP/1.1 403 Forbidden

# Wrong: returning 500 for a rate limit
HTTP/1.1 500 Internal Server Error  ← this is not a server error

# Right:
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

Go handler showing precise status code usage:

```go
func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    var req CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        // Malformed JSON → 400
        writeError(w, http.StatusBadRequest, "invalid_json", "Request body contains invalid JSON")
        return
    }

    if err := req.Validate(); err != nil {
        var ve *ValidationError
        if errors.As(err, &ve) {
            // Semantically invalid → 422
            writeValidationError(w, ve)
            return
        }
    }

    // Check if order with this idempotency key already exists → 409
    existing, err := h.orders.FindByIdempotencyKey(r.Context(), req.IdempotencyKey)
    if err == nil {
        // Return existing resource with 200 (idempotent)
        writeJSON(w, http.StatusOK, existing)
        return
    }

    order, err := h.orders.Create(r.Context(), req)
    if err != nil {
        var notFound *NotFoundError
        if errors.As(err, &notFound) {
            writeError(w, http.StatusUnprocessableEntity, "referenced_resource_not_found",
                fmt.Sprintf("Referenced %s with ID %s not found", notFound.Resource, notFound.ID))
            return
        }
        // Unexpected error → 500
        h.logger.Error("failed to create order", "error", err)
        writeError(w, http.StatusInternalServerError, "internal_error", "An unexpected error occurred")
        return
    }

    // 201 Created with Location header
    w.Header().Set("Location", fmt.Sprintf("/orders/%s", order.ID))
    writeJSON(w, http.StatusCreated, order)
}
```

### URL Hierarchy: Nesting vs Flat Resources

Nested URLs express ownership/containment:
```
/users/{user_id}/orders          # Orders belonging to a user
/organizations/{org_id}/members  # Members of an organization
/posts/{post_id}/comments        # Comments on a post
```

Flat URLs with query params express filtering on a global resource:
```
/orders?user_id={user_id}        # All orders, filtered by user
/members?org_id={org_id}         # All members, filtered by org
```

**When to nest vs flat**:

Nest when:
- The child resource cannot exist without the parent (comment without a post)
- The parent ID is required (never optional) for the operation
- The depth is at most 2 levels (`/users/{id}/orders`, not `/users/{id}/orders/{id}/items/{id}/variants`)

Use flat with query params when:
- The resource can belong to multiple parents
- You need to list across multiple parents (`/orders` with no user filter = all orders)
- Nesting would exceed 2 levels deep

```go
// Router showing both patterns
r.Get("/users/{userID}/orders", h.GetUserOrders)       // Nested: user's orders
r.Get("/orders", h.ListOrders)                         // Flat: all orders, filterable
r.Get("/orders/{orderID}", h.GetOrder)                 // Direct access by ID (no nesting needed)
```

### Pagination: Cursor vs Offset

**Offset pagination** (page 1, page 2, etc.):
```
GET /orders?page=3&per_page=20
```

```go
type OffsetPaginationParams struct {
    Page    int `query:"page" default:"1"`
    PerPage int `query:"per_page" default:"20" max:"100"`
}

type OffsetPaginatedResponse[T any] struct {
    Data       []T  `json:"data"`
    Total      int  `json:"total"`
    Page       int  `json:"page"`
    PerPage    int  `json:"per_page"`
    TotalPages int  `json:"total_pages"`
    HasNext    bool `json:"has_next"`
    HasPrev    bool `json:"has_prev"`
}
```

Pros: Supports random access ("go to page 5"), easy to implement, familiar to users.
Cons: Inconsistent under concurrent inserts/deletes (page drift). Expensive for large offsets (`OFFSET 10000` scans 10,000 rows). Cannot be used for real-time feeds.

**Cursor pagination** (token-based):
```
GET /orders                         # First page
GET /orders?cursor=eyJpZCI6MTAwfQ== # Next page using cursor from previous response
```

```go
type CursorPaginationParams struct {
    Cursor string `query:"cursor"`
    Limit  int    `query:"limit" default:"20" max:"100"`
}

type CursorPaginatedResponse[T any] struct {
    Data       []T    `json:"data"`
    NextCursor string `json:"next_cursor,omitempty"` // empty means no more pages
    HasMore    bool   `json:"has_more"`
}

// Cursor is an opaque base64-encoded JSON of the last item's sort key
type Cursor struct {
    ID        string    `json:"id"`
    CreatedAt time.Time `json:"created_at"`
}

func encodeCursor(c Cursor) string {
    b, _ := json.Marshal(c)
    return base64.StdEncoding.EncodeToString(b)
}

func decodeCursor(s string) (Cursor, error) {
    b, err := base64.StdEncoding.DecodeString(s)
    if err != nil {
        return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
    }
    var c Cursor
    if err := json.Unmarshal(b, &c); err != nil {
        return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
    }
    return c, nil
}

// SQL query using cursor
func (r *OrderRepo) ListWithCursor(ctx context.Context, cursor *Cursor, limit int) ([]Order, error) {
    query := `
        SELECT id, user_id, status, total_cents, created_at
        FROM orders
        WHERE ($1::uuid IS NULL OR (created_at, id) < ($2::timestamptz, $1::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3
    `
    var cursorID *string
    var cursorTime *time.Time
    if cursor != nil {
        cursorID = &cursor.ID
        cursorTime = &cursor.CreatedAt
    }
    rows, err := r.db.Query(ctx, query, cursorID, cursorTime, limit+1)
    // ... handle rows, detect hasMore by checking if limit+1 rows returned
}
```

Pros: Stable (no page drift), efficient (no large OFFSET), works for infinite scroll.
Cons: No random access, cursor becomes invalid when referenced row is deleted.

**Rule of thumb**: Use cursor pagination for product-facing APIs. Use offset for internal/admin APIs where random access is needed.

### Filtering and Sorting

Design a consistent filter syntax:

```
# Simple equality
GET /orders?status=pending

# Multiple values (OR)
GET /orders?status=pending,processing

# Comparison operators
GET /orders?created_after=2024-01-01&created_before=2024-12-31
GET /orders?total_cents_gte=10000&total_cents_lte=50000

# Full-text search
GET /products?q=wireless+headphones

# Sorting: prefix with - for descending
GET /orders?sort=-created_at          # newest first
GET /orders?sort=status,-created_at   # by status asc, then newest first
```

```go
type OrderFilters struct {
    Status        []string    `query:"status"`
    CreatedAfter  *time.Time  `query:"created_after"`
    CreatedBefore *time.Time  `query:"created_before"`
    TotalCentsGte *int64      `query:"total_cents_gte"`
    TotalCentsLte *int64      `query:"total_cents_lte"`
    UserID        *uuid.UUID  `query:"user_id"`
    Sort          []SortField `query:"sort"`
    Q             string      `query:"q"`
}

type SortField struct {
    Field     string
    Direction string // "asc" or "desc"
}

// Parse "sort=-created_at,status" into []SortField
func parseSortParam(s string) ([]SortField, error) {
    allowed := map[string]bool{
        "created_at":  true,
        "total_cents": true,
        "status":      true,
    }
    var fields []SortField
    for _, part := range strings.Split(s, ",") {
        direction := "asc"
        field := part
        if strings.HasPrefix(part, "-") {
            direction = "desc"
            field = part[1:]
        }
        if !allowed[field] {
            return nil, fmt.Errorf("invalid sort field: %s", field)
        }
        fields = append(fields, SortField{Field: field, Direction: direction})
    }
    return fields, nil
}
```

### Sparse Fieldsets

Let clients request only the fields they need:

```
GET /users?fields=id,email,name
GET /orders?fields=id,status,total_cents,created_at
```

This reduces payload size, reduces over-fetching, and can enable database query optimization:

```go
type FieldSelector struct {
    allowed  map[string]bool
    selected map[string]bool
}

func NewFieldSelector(allowed []string, requested string) (*FieldSelector, error) {
    allowedMap := make(map[string]bool)
    for _, f := range allowed {
        allowedMap[f] = true
    }

    selectedMap := make(map[string]bool)
    if requested == "" {
        // Return all allowed fields by default
        for k := range allowedMap {
            selectedMap[k] = true
        }
    } else {
        for _, f := range strings.Split(requested, ",") {
            f = strings.TrimSpace(f)
            if !allowedMap[f] {
                return nil, fmt.Errorf("unknown field: %s", f)
            }
            selectedMap[f] = true
        }
    }

    return &FieldSelector{allowed: allowedMap, selected: selectedMap}, nil
}

func (fs *FieldSelector) Include(field string) bool {
    return fs.selected[field]
}

// Usage: filter response struct to only selected fields
func (fs *FieldSelector) FilterUser(u *User) map[string]any {
    result := make(map[string]any)
    if fs.Include("id") { result["id"] = u.ID }
    if fs.Include("email") { result["email"] = u.Email }
    if fs.Include("name") { result["name"] = u.Name }
    if fs.Include("created_at") { result["created_at"] = u.CreatedAt }
    return result
}
```

### Error Response Format: RFC 9457 Problem Details

**RFC 9457** "Problem Details for HTTP APIs" (July 2023) defines the standard error format. It obsoletes RFC 7807, which is the number you will still see in most blog posts, library READMEs, and older code. The wire format is compatible, so this is not a migration so much as a citation fix, but cite the live document. RFC 9457's substantive additions are worth knowing: it registers the `errors` extension for multiple problems in one response (used below), and it clarifies that `type` is an identifier rather than a URL anyone is obliged to dereference.

One field deserves emphasis because it is the most commonly misused: `type` is a **stable identifier that clients match on**, and it is the only part of the document that is a contract. `title` and `detail` are for humans and may be reworded freely. If a client is parsing `detail` with a regex to decide what went wrong, you have failed to give it a usable `type`, and you can no longer improve your error prose without breaking someone.

```json
{
  "type": "https://api.example.com/errors/validation-error",
  "title": "Validation Error",
  "status": 422,
  "detail": "The request body contains invalid data.",
  "instance": "/orders/create-attempt-abc123",
  "errors": [
    {
      "field": "email",
      "code": "invalid_format",
      "message": "Must be a valid email address"
    },
    {
      "field": "amount",
      "code": "out_of_range",
      "message": "Must be between 1 and 999999 cents"
    }
  ]
}
```

Go implementation:

```go
package apierror

import (
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"
)

// ProblemDetail implements RFC 9457 (which obsoletes RFC 7807).
type ProblemDetail struct {
    Type     string       `json:"type"`
    Title    string       `json:"title"`
    Status   int          `json:"status"`
    Detail   string       `json:"detail,omitempty"`
    Instance string       `json:"instance,omitempty"`
    Errors   []FieldError `json:"errors,omitempty"`

    // headers carries response headers that are semantically part of this
    // problem, such as Retry-After on a 429. It is unexported, so
    // encoding/json ignores it without needing a `json:"-"` tag: a value
    // that belongs in a header goes in the header, not in the body.
    // Describing a retry delay only in human-readable `detail` prose forces
    // clients to regex your error messages, which then makes your error
    // prose a compatibility contract you can never reword.
    headers map[string]string
}

type FieldError struct {
    Field   string `json:"field"`
    Code    string `json:"code"`
    Message string `json:"message"`
}

func (p *ProblemDetail) Error() string {
    return p.Detail
}

func Write(w http.ResponseWriter, r *http.Request, p *ProblemDetail) {
    if p.Instance == "" {
        p.Instance = r.URL.Path // do not clobber an explicitly set instance
    }
    for k, v := range p.headers {
        w.Header().Set(k, v)
    }
    w.Header().Set("Content-Type", "application/problem+json")

    // WriteHeader before the body: the first write to w implicitly commits
    // 200 OK, so encoding first would send every error as a success.
    w.WriteHeader(p.Status)
    json.NewEncoder(w).Encode(p)
}

// Convenience constructors
func ValidationError(detail string, errors []FieldError) *ProblemDetail {
    return &ProblemDetail{
        Type:   "https://api.example.com/errors/validation-error",
        Title:  "Validation Error",
        Status: http.StatusUnprocessableEntity,
        Detail: detail,
        Errors: errors,
    }
}

func NotFound(resourceType, id string) *ProblemDetail {
    return &ProblemDetail{
        Type:   "https://api.example.com/errors/not-found",
        Title:  "Not Found",
        Status: http.StatusNotFound,
        Detail: fmt.Sprintf("%s with ID %s was not found", resourceType, id),
    }
}

func RateLimited(retryAfter int) *ProblemDetail {
    if retryAfter < 1 {
        retryAfter = 1 // never invite an immediate retry
    }
    return &ProblemDetail{
        Type:   "https://api.example.com/errors/rate-limited",
        Title:  "Too Many Requests",
        Status: http.StatusTooManyRequests,
        Detail: fmt.Sprintf("Rate limit exceeded. Retry after %d seconds.", retryAfter),
        // The prose above is for humans. This is the part machines read.
        headers: map[string]string{
            "Retry-After": strconv.Itoa(retryAfter),
        },
    }
}

func Unauthorized() *ProblemDetail {
    return &ProblemDetail{
        Type:   "https://api.example.com/errors/unauthorized",
        Title:  "Unauthorized",
        Status: http.StatusUnauthorized,
        Detail: "Authentication is required. Provide a valid API key or Bearer token.",
    }
}
```

### Junior → FAANG: Building Fluency With REST Mechanics Before the Interview

The best practices in this section are the foundation of every API design interview question at FAANG. The gap between candidates who pass and candidates who do not is usually not that they have never heard these rules. It is that they have never built fluency applying them under pressure to ambiguous scenarios.

**Status codes under pressure.** The most common interview trap: "A user tries to create a resource but they do not have permission. What status code do you return?" Many candidates say 404 to "hide" the existence of the resource. The correct answer depends on context: if the user is not authenticated, return 401. If the user is authenticated but not authorized, return 403. If you need to hide the existence of the resource for security reasons (for example, a private repo in a multi-tenant system), return 404 with a documented policy decision explaining the tradeoff. Being able to articulate that tradeoff is the L4+ signal.

**Cursor vs offset pagination.** Know the database mechanics behind each. Offset pagination with `LIMIT 20 OFFSET 10000` performs a full table scan of 10,020 rows and discards 10,000. Cursor pagination with a keyset (`WHERE (created_at, id) < (cursor_time, cursor_id)`) uses a composite index and reads only the rows it returns. At FAANG scale, this is the difference between a query that runs in milliseconds and one that causes a read replica to fall behind during a bulk export. Practice writing the SQL for both patterns and be able to explain the index usage.

**Resource naming applied to edge cases.** The easy case is `GET /users/{id}`. The interview case is "how do you model a password reset?" The wrong answer is `POST /resetPassword`. The right answer is `POST /users/{id}/password-resets` (creating a password reset resource) or `DELETE /users/{id}/sessions` (invalidating sessions on password change). Practice converting verb-based operations into resource-based models for: email verification, account deactivation, two-factor enrollment, bulk import, and async job submission.

**RFC 9457 in Go.** The `ProblemDetail` implementation in this section is production-ready. Copy it, extend it, and make it the error response type for every project you build. When you can write the Problem Details response for a validation error, a rate limit, and an authorization failure from memory, you are interview-ready on error design. Cite it as RFC 9457: saying "7807" is not wrong so much as dated, and an interviewer who knows the area will notice which document you learned from.

### Senior @ FAANG: Elevating REST Best Practices to Platform-Level Decisions

At staff level, the best practices in this section represent decisions that must be made once, encoded in shared tooling, and enforced consistently across dozens of services. Three areas require special depth at this level.

**Pagination strategy as a platform contract.** Individual teams choosing between cursor and offset pagination independently produces an inconsistent API surface that forces SDK developers to handle two pagination models. The platform-level decision: define the organization's pagination contract in the shared OpenAPI component library. Both models are permitted, but cursor pagination is the default for all new collection endpoints and offset is permitted only with a documented rationale (for example, admin consoles requiring random access). The shared component library provides reusable OpenAPI schemas for `CursorPaginatedResponse` and `OffsetPaginatedResponse` that teams include by reference.

The Go shared library provides `pagination.EncodeCursor`, `pagination.DecodeCursor`, and `pagination.BuildKeysetWhere` as composable primitives. Teams do not implement cursor logic per service. They import the library and pass the cursor struct. This eliminates the class of bugs where different services encode cursors differently, making cross-service pagination comparisons impossible.

**HTTP method semantics and infrastructure trust.** The RFC 9110 safe/idempotent properties are not just semantic conventions. They are contracts that HTTP infrastructure (CDN caches, service mesh retry policies, load balancer health checks) relies on. At FAANG scale, the service mesh retry configuration is a platform decision: GET and HEAD are retried automatically on transient failures, DELETE is retried (idempotent), PUT is retried (idempotent), POST and PATCH are never retried without an application-layer idempotency key. This configuration is set in the platform's Envoy filter, not per service. If a service uses GET for a state-changing operation, the platform will retry it on failure and cause double execution. This is a platform safety concern, not just a REST pedantry concern.

The governance implication: the Spectral ruleset flags GET handlers that have side effects (heuristic: GET handlers that call non-read service methods). The code review checklist requires that any POST or PATCH endpoint either accepts an `Idempotency-Key` header or documents explicitly why it does not need one.

**RFC 9457 as the organization's error contract.** Standardizing on RFC 9457 (Problem Details) across the organization means SDK generators can produce typed error classes from the `type` URI. A Python SDK can raise `stripe.CardDeclinedError` instead of a generic `APIError` because the error type URI is machine-readable and stable. In Go, the `ProblemDetail.Type` field is a URI that maps to a Go error type via a registry. This is not polish. It is the mechanism that makes client error handling robust across language SDKs.

The ADR for adopting RFC 9457 organization-wide should address: the base URI pattern for error types (`https://api.example.com/errors/{slug}`), the extension fields the organization uses beyond the RFC (machine-readable `code`, offending `param`, `doc_url` for correction guidance), the `Content-Type` requirement (`application/problem+json`), and how existing non-conforming error formats will be migrated (wrapper at the gateway layer as a transitional step, not a forced service rewrite).

**Sparse fieldsets and GraphQL pressure.** Sparse fieldsets (`?fields=id,email,name`) are the REST answer to the GraphQL argument "your payloads are too fat and I can't control what I get back." At FAANG scale, the decision between REST with sparse fieldsets and GraphQL is an architectural ADR. REST with sparse fieldsets satisfies 80% of the over-fetching problem while maintaining HTTP cache semantics (GraphQL POST requests are not cacheable by default). If the remaining 20% (arbitrary graph traversal, real-time subscriptions with fine-grained field selection) is critical to the use case, GraphQL is justified. If it is not, REST with sparse fieldsets is the lower operational complexity choice. This is a staff-level architectural decision with measurable tradeoffs, not a preference.

---
