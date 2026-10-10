## 38.1 REST Principles

### Core Constraints

REST's six architectural constraints (Client-Server, Stateless, Cacheable, Uniform Interface with HATEOAS, Layered System, and Code-on-Demand) together enable the scalability and loose coupling that make RESTful APIs easy to evolve. The HTTP method semantics table in the architecture diagram above captures the safe/idempotent/cacheable properties you need to internalize.

### Richardson Maturity Model

Leonard Richardson's maturity model is the practical lens for measuring how "RESTful" an API actually is:

- **Level 0: The Swamp of POX.** One URL, one verb (usually POST), RPC-over-HTTP. SOAP endpoints live here.
- **Level 1: Resources.** Distinct URLs per resource (`/users/123`, `/orders/456`), but still one verb.
- **Level 2: HTTP Verbs.** Correct use of GET/POST/PUT/PATCH/DELETE plus meaningful status codes. **This is where the vast majority of production APIs live**: Stripe, GitHub (v3), Twilio, and most AWS services stop here.
- **Level 3: Hypermedia Controls (HATEOAS).** Responses include links to related actions, so clients discover capabilities at runtime instead of hardcoding URLs. Aspirational for most teams. GitHub's v3 API and PayPal ship partial HATEOAS, but the constraint is rarely justified outside long-lived public APIs with many clients you do not control.

Aim for Level 2 cleanly before chasing Level 3. A disciplined Level 2 API with good error envelopes and documentation beats a half-baked HATEOAS implementation every time.

### HTTP Methods

The handler struct holds a `UserStore` interface rather than a concrete type, keeping the HTTP layer decoupled from storage. Each method delegates to the store with the request's context so cancellations and deadlines propagate automatically, and failures return opaque error messages rather than raw store errors to avoid leaking implementation details.

```go
// ... imports omitted for brevity (net/http, encoding/json, errors)

type UserHandler struct {
    store UserStore
}

// GET /users - List users
func (h *UserHandler) List(w http.ResponseWriter, r *http.Request) {
    users, err := h.store.List(r.Context())
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(users)
}

// GET /users/{id} - Get single user
func (h *UserHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id") // Go 1.22+

    user, err := h.store.Get(r.Context(), id)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            http.Error(w, "User not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}

// POST /users - Create user
func (h *UserHandler) Create(w http.ResponseWriter, r *http.Request) {
    var input CreateUserInput
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    user, err := h.store.Create(r.Context(), input)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Location", "/users/"+user.ID)
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

// PUT /users/{id} - Replace user
func (h *UserHandler) Replace(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    var input User
    if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    input.ID = id // Ensure ID matches URL
    user, err := h.store.Replace(r.Context(), input)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            http.Error(w, "User not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}

// PATCH /users/{id} - Partial update
func (h *UserHandler) Update(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    var patch map[string]any
    if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    user, err := h.store.Update(r.Context(), id, patch)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            http.Error(w, "User not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}

// DELETE /users/{id} - Delete user
func (h *UserHandler) Delete(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    if err := h.store.Delete(r.Context(), id); err != nil {
        if errors.Is(err, ErrNotFound) {
            http.Error(w, "User not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

### Junior → FAANG: the six constraints translated into handler code

The six REST constraints read like a philosophy lecture. They are actually a checklist you can apply to the handler code above.

Client-Server means the server knows nothing about the client's UI state. The handler above takes an id and returns JSON. It does not know if the caller is a browser, a mobile app, or curl. That is the constraint in action. The violation to watch for is handlers that branch on `User-Agent` or return different payload shapes based on who is calling. Do not do that. Provide content negotiation (`Accept` header) or explicit query parameters (`?view=summary`) instead.

Stateless means each request carries everything needed to process it. The JWT travels on every request, not just login. Session state belongs in Redis or the database, not in server memory. The violation is a handler that reads a per-process map keyed by user id. In a two-replica deployment that map is empty half the time. Junior engineers learn this the hard way during their first load test.

Cacheable means responses declare their cacheability. None of the handlers above set `Cache-Control`. For `Get`, the bare minimum is `Cache-Control: private, max-age=30` with an `ETag`, so the CDN and the client can 304 on repeat. Add that in code review.

Uniform Interface means the method and URL semantics are consistent across the API. PUT always replaces, PATCH always patches, DELETE always removes. The handler file follows this. The violation is a `POST /users/{id}/updateEmail` endpoint. It is RPC, and it should be a PATCH.

Layered System means intermediaries (CDN, LB, gateway) can exist without the client knowing. The handler does not assume a direct connection. It reads `X-Forwarded-For` through a trusted-proxy middleware for client IP, not from `r.RemoteAddr`.

Code-on-Demand is optional and rarely used in REST. Ignore it for now.

Three concrete upgrades a junior should make to the handler code above before it is production-ready.

First, replace `http.Error` with a structured error writer that emits RFC 9457 Problem Details. `http.Error` returns `text/plain` which breaks clients that only parse JSON. A minimal version writes `{"type":"about:blank","title":"User not found","status":404,"instance":"/users/42","trace_id":"..."}` with `Content-Type: application/problem+json`.

Second, the `Create` handler must validate input before calling `store.Create`. Use `go-playground/validator/v10` with struct tags (`validate:"required,email"`) and return 422 on validation failure. Returning 500 when a required field is missing is the most common junior bug in this file.

Third, `json.NewDecoder(r.Body).Decode(&input)` should enable `DisallowUnknownFields` and cap body size with `http.MaxBytesReader(w, r.Body, 1<<20)`. Without these, clients can send a 10 GB body and OOM the process, or they can send unknown fields that silently become data drift.

Interview worked example. "Implement PATCH for users safely." The candidate-level answer uses `map[string]any` like the code above. The senior-track answer uses JSON Merge Patch (RFC 7396) or JSON Patch (RFC 6902), explicitly allowlists which fields are patchable, and returns 422 if the patch touches a forbidden field (`id`, `created_at`). Bonus points for optimistic concurrency via `If-Match: <etag>` returning 412 Precondition Failed on stale writes.

### Senior @ FAANG: constraints as operational levers, HATEOAS reality, and Fielding revisited

At staff level the six constraints are not a philosophical framework. They are operational levers that determine what you can and cannot do at scale. Let us walk each as a lever.

Statelessness is the lever that enables horizontal scaling. When every request is self-contained, adding replicas is a load balancer config change. The moment you put session state in process memory you have coupled your deployment to sticky sessions, which couples you to a specific LB, which couples you to a cloud provider. The staff-level default is zero process-local state that survives a request. Caches are opt-in, keyed, and bounded.

Cacheability is the lever that absorbs traffic at the edge. An API that correctly emits `Cache-Control`, `ETag`, `Last-Modified`, and `Vary` gets linear cost reduction at the CDN. The hidden prerequisite is deterministic cache-key design. If your URL scheme depends on query parameter order (`?a=1&b=2` versus `?b=2&a=1`) you have two cache entries for one logical resource. The fix is a middleware that canonicalizes query strings before they hit the origin, or a gateway rule that does the same. `Vary` is the other landmine. Forgetting `Vary: Accept-Language` on a localized endpoint serves English content to French clients. Audit every response's `Vary` header as part of API review.

The uniform interface constraint is the lever that makes SDK generation and gateway policies possible. If every endpoint follows the same method and status conventions, the gateway can enforce schema-aware WAF rules, the SDK generator can produce idiomatic clients, and the observability layer can bucket by `route_template`. Inconsistency breaks all three. Enforce with spectral linting on the OpenAPI spec in CI.

The layered system constraint is the lever that lets you insert and remove intermediaries. The operational requirement is that the service must not depend on being the first hop. Client IP comes from `X-Forwarded-For` with a trusted-proxy allowlist. TLS information comes from `X-Forwarded-Proto` and `X-Forwarded-Ssl`. Original host comes from `X-Forwarded-Host`. As of Go 1.27 the standard library still does not parse these safely by default. Use a middleware that knows your LB's trusted ranges and strips the headers on ingress if the source is untrusted. Otherwise a malicious client can spoof their IP by sending the header directly.

Now HATEOAS, the constraint that provokes the most ideology and the least production impact. Fielding's argument in the 2000 dissertation is that hypermedia enables client evolution. Clients follow links at runtime, so the server can rename URLs without breaking them. This is beautiful in theory. In practice, three forces push real APIs to stay at Level 2. Clients hard-code URLs because documentation and SDKs encourage it. Hypermedia payloads are meaningfully larger, which matters on mobile. Discovery at runtime requires a vocabulary (IANA link relations, or a custom one) that clients must understand, which is itself coupling. The defensible staff position is Level 2 with targeted hypermedia in three specific places. Pagination links in the `Link` header per RFC 8288 (everyone agrees on this). One-time action URLs where the URL encodes a signed token (upload URLs, password-reset confirmations). Webhook delivery where the payload includes a retry endpoint. Beyond that, HATEOAS is a tax that does not pay back. If a reviewer quotes Fielding to block a Level 2 design, your counter is that Stripe, GitHub, Twilio, and AWS all ship Level 2 and have the most successful APIs in the industry.

Fielding revisited is worth doing once in your career. The dissertation's actual argument is not "use HTTP verbs." It is that network-based architectures have a set of desirable properties (scalability, simplicity, modifiability, visibility, portability, reliability) and constraints are chosen to maximize them. REST is one such style. Fielding himself has said that most APIs calling themselves REST are not REST, and he is correct by his definition. The senior answer is that the industry has converged on "HTTP APIs that use methods and status codes correctly" as the useful definition, and that is what this chapter teaches. Do not apologize for it.

The PATCH handler in the code above is a teaching example. At senior level the policy is stricter. Choose one patch format per service (JSON Merge Patch RFC 7396 is usually the right default, JSON Patch RFC 6902 is more expressive but harder for clients to generate) and document it. `Content-Type: application/merge-patch+json` is the wire signal. Reject unknown fields with 422. Apply the patch to a validated struct, not to a `map[string]any`, so type errors are caught at decode time. Combine with `If-Match: <etag>` for optimistic concurrency. Without this, two concurrent patches race and the last write wins silently, which is the class of bug that produces "my edit disappeared" tickets at scale.

The replace handler (PUT) is where idempotency earns its keep. PUT is idempotent by definition, which means a retried PUT must produce the same end state. Two implications. First, the request body must be the complete desired state, not a delta. If the client omits a field, PUT means "set this field to its zero value," not "leave it alone." Document this loudly because clients will get it wrong. Second, PUT on a non-existent id should create the resource with that id (upsert) per RFC 9110, unless your policy is that ids are server-assigned, in which case PUT on an unknown id returns 404. Pick one and write it in the style guide.

The DELETE handler's second-call behavior is a governance question. RFC 9110 says the second DELETE may return 404 or 204. The client-friendly choice is 204 always for the first call, 404 thereafter, because it tells the client their retry did nothing new. The SDK-friendly choice is 204 always, treating DELETE as pure idempotent. Pick one per platform. The anti-pattern is a service that returns 204 sometimes and 404 sometimes depending on race conditions.

One more senior lever not visible in the code. Observability-friendly routes. The handlers above use `r.PathValue("id")` with Go 1.22+ routing. That is fine for correctness but the metrics layer must log the `route_template` (`/users/{id}`), not the raw URL (`/users/42`). Otherwise your Prometheus cardinality explodes and you cannot afford to run the metrics system. The middleware that does this lookup must be aware of the router's pattern. Since Go 1.23 the stdlib mux exposes the matched pattern directly as `r.Pattern` on the request. Use it.

---
