## Common Mistakes

### 1. Returning Go Errors Instead of GraphQL User Errors

Returning a Go `error` from a mutation resolver puts the message in the generic `errors` array, where clients cannot distinguish a field validation failure from a server crash. The corrected approach returns a typed `Payload` with an embedded `errors` list so clients can inspect the `field` and `code` and render field-level feedback in the UI without parsing error strings.

```go
// Wrong: opaque error in errors[] array, client can't distinguish field errors
func (r *mutationResolver) CreateUser(ctx context.Context, input model.CreateUserInput) (*model.User, error) {
    if !isValidEmail(input.Email) {
        return nil, errors.New("invalid email") // Client gets: {"errors": [{"message": "invalid email"}]}
    }
}

// Correct: structured errors in payload, client knows which field failed
func (r *mutationResolver) CreateUser(ctx context.Context, input model.CreateUserInput) (*model.CreateUserPayload, error) {
    if !isValidEmail(input.Email) {
        return &model.CreateUserPayload{
            Errors: []*model.UserError{{
                Field: ptr("email"), Message: "Invalid email address", Code: "INVALID_EMAIL",
            }},
        }, nil
    }
}
```

### 2. Not Using DataLoaders (N+1 Queries)

A field resolver that calls `GetByID` directly issues one SELECT per post in the response list, turning a request for 100 posts into 101 database queries. The DataLoader batches all concurrent `Load` calls from a single GraphQL execution into a single `WHERE id IN (...)` query, reducing N+1 to a constant two queries regardless of result set size.

```go
// Wrong: database query inside resolver, called N times for N posts
func (r *postResolver) Author(ctx context.Context, post *model.Post) (*model.User, error) {
    return r.userRepo.GetByID(ctx, post.AuthorID) // N separate SELECT queries
}

// Correct: DataLoader batches all concurrent resolutions into one query
func (r *postResolver) Author(ctx context.Context, post *model.Post) (*model.User, error) {
    return dataloader.For(ctx).UserByID.Load(ctx, post.AuthorID)()
}
```

### 3. Not Verifying Webhook Timestamps (Replay Attack Vulnerability)

Validating only the HMAC signature without checking the timestamp lets an attacker replay any previously captured webhook indefinitely, because a valid signature stays valid forever.

The fix is more subtle than "also check the timestamp," and the near-miss version below is worth studying because it looks right, passes review, and defends nothing.

```go
// Wrong: validates signature but not timestamp, so attackers can replay valid requests
func VerifyWebhook(secret []byte, signature string, body []byte) bool {
    mac := hmac.New(sha256.New, secret)
    mac.Write(body)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(signature))
}

// STILL WRONG: checks a timestamp that the signature does not cover.
//
// The HMAC is computed over `body` alone, so the timestamp is just an
// unauthenticated header the attacker also controls. Replaying a capture
// from three days ago requires exactly one extra step: send the same body
// and the same signature, and put today's value in the timestamp header.
// The signature still verifies, because nothing about it depends on the
// timestamp. This "fix" bounds nothing.
//
// Second flaw: `time.Since(t) > 5*time.Minute` is false for any FUTURE
// timestamp, because Since returns a negative duration. A timestamp of
// year 3000 sails through the check.
func VerifyWebhook(secret []byte, sig, timestamp string, body []byte) error {
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil || time.Since(time.Unix(ts, 0)) > 5*time.Minute {
        return errors.New("timestamp missing or expired (5-minute window)")
    }
    mac := hmac.New(sha256.New, secret)
    mac.Write(body) // <-- the timestamp is not in here, so it is not protected
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
    if !hmac.Equal([]byte(expected), []byte(sig)) {
        return errors.New("invalid signature")
    }
    return nil
}

// Correct: bind the timestamp INTO the signed content, and bound the skew
// in both directions.
func VerifyWebhook(secret []byte, sig, timestamp string, body []byte) error {
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return errors.New("invalid timestamp")
    }

    // Reject in BOTH directions. A future timestamp is not a clock-skew
    // curiosity, it is an attacker buying themselves a replay window that
    // opens later. Check the timestamp before the HMAC: it is O(1) while
    // the HMAC is O(len(body)), so this also stops a flood of replays from
    // costing you CPU.
    const tolerance = 5 * time.Minute
    if age := time.Since(time.Unix(ts, 0)); age > tolerance || age < -tolerance {
        return errors.New("timestamp outside tolerance window")
    }

    // The signed content is timestamp.body, so the timestamp is no longer
    // something the attacker can edit. Changing either half invalidates the
    // MAC, which is what makes the freshness check meaningful.
    mac := hmac.New(sha256.New, secret)
    mac.Write([]byte(timestamp))
    mac.Write([]byte("."))
    mac.Write(body)
    expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))

    // hmac.Equal, never ==: constant time, no early exit to time against.
    if !hmac.Equal([]byte(expected), []byte(sig)) {
        return errors.New("invalid signature")
    }
    return nil
}
```

The general principle is worth extracting, because it recurs well beyond webhooks: **a check on unauthenticated data is not a security control.** The timestamp only bounds the replay window once it is inside the MAC. Anything you validate but do not authenticate is a value the attacker fills in for you.

Note also that the tolerance window does not eliminate replay, it bounds it: within those five minutes an identical delivery is still cryptographically valid. Closing that last gap is the receiver's idempotency check on the event ID, which is why signing and deduplication are two halves of one design rather than independent features.

### 4. Sending Webhooks Synchronously in Request Path

Delivering a webhook inside the HTTP handler that serves the client request couples your API latency to the webhook receiver's response time. If the receiver is slow or unreachable, your client waits or gets an error for something that has nothing to do with their request. The fix is the outbox pattern: write the event to the database in the same transaction as the business operation, then let a background worker handle delivery.

```go
// Wrong: webhook delivery in customer-facing HTTP handler - adds latency and can fail the request
func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    order := h.createOrder(r)
    // This HTTP call to customer's server happens inline - if their server is slow, your API is slow
    h.webhookSender.Send(ctx, endpoint, buildPayload(order))
    json.NewEncoder(w).Encode(order)
}

// Correct: use outbox pattern, return immediately, deliver asynchronously
func (h *OrderHandler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    order := h.createOrder(r) // This also writes to outbox table in same transaction
    json.NewEncoder(w).Encode(order) // Return in milliseconds
    // Delivery worker handles HTTP delivery in background
}
```

### 5. Not Handling Webhook Receiver Idempotency

Webhook senders retry on network failures and timeouts, so a receiver that processes every delivery without deduplication will fulfill orders or charge customers multiple times. Checking the event ID against a persistent idempotency store before processing and returning `200` immediately on a duplicate stops the sender's retry loop without executing the business logic twice.

```go
// Wrong: process every incoming webhook - causes double processing on retry
func HandlePayment(w http.ResponseWriter, r *http.Request) {
    var event stripe.Event
    json.NewDecoder(r.Body).Decode(&event)
    fulfillOrder(event.Data) // If Stripe retries (network hiccup), order is fulfilled twice!
    w.WriteHeader(200)
}

// Correct: check idempotency key before processing
func HandlePayment(w http.ResponseWriter, r *http.Request) {
    var event stripe.Event
    json.NewDecoder(r.Body).Decode(&event)

    if idempotency.IsProcessed(r.Context(), event.ID) {
        w.WriteHeader(200) // Already processed - return 200 to stop retries
        return
    }

    fulfillOrder(event.Data)
    idempotency.MarkProcessed(r.Context(), event.ID)
    w.WriteHeader(200)
}
```

### 6. Using Subscription for Polling Use Cases

GraphQL subscriptions maintain a persistent WebSocket connection with per-connection server state, which adds operational complexity. For data that changes infrequently (dashboard metrics that update every minute, for example), a simple REST endpoint with `Cache-Control` headers and client-side polling is far cheaper to run and easier to scale horizontally.

```graphql
// Overengineering: GraphQL subscription for data that changes every 60 seconds
subscription {
  dashboardMetrics {  # Refreshing metrics every second via WebSocket
    activeUsers
    revenue
  }
}

// Better: REST endpoint with appropriate cache headers + client-side polling
// GET /api/metrics → Cache-Control: max-age=60
// Client polls every 60 seconds - far less server-side complexity
```

### 7. Not Implementing AsyncAPI for Kafka Topics

Teams that don't document their Kafka topics with AsyncAPI end up with:
- No schema validation - consumers break when producers change message format
- No discoverability - teams don't know what events exist
- Copy-paste consumer code - no generated type-safe stubs

The fix: create `asyncapi.yaml` alongside every service that produces events, store in central schema registry, generate Go types from spec.

### 8. Exposing Internal GraphQL Errors to Clients

A resolver that forwards the raw database error to the client exposes table names, column names, and query structure. That is the same information leak present in REST APIs but harder to notice because GraphQL errors surface in a consistent `errors` array. The fix logs the full error with `slog` for internal tracing and returns only a generic message through the resolver's error return value.

```go
// Wrong: database errors leak to clients
func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
    user, err := r.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id).Scan(&user)
    return nil, err // "pq: column users.secret_field does not exist" leaks DB schema!
}

// Correct: log internal errors, return generic message to client
func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
    user, err := r.userRepo.GetByID(ctx, id)
    if err != nil {
        slog.Error("fetching user", "id", id, "error", err) // Log full error internally
        return nil, errors.New("failed to fetch user")       // Generic message to client
    }
    return user, nil
}
```

---

### Junior → FAANG: Recognizing Mistake Patterns Before You Make Them

The eight mistakes in this chapter share a common structure: a shortcut that works in development fails in production because of a constraint that development environments hide. Learning to recognize that structure lets you anticipate mistakes in code review, not just in postmortems.

The shortcut-to-constraint map for each mistake:

- Returning raw Go errors from GraphQL mutations: shortcut is using the standard error return, constraint hidden is that clients receive a structureless string that breaks UI-level field validation.
- Skipping DataLoaders: shortcut is a direct repo call inside a resolver, constraint hidden is that GraphQL executes sub-resolvers concurrently across N items, so one DB call becomes N calls.
- Skipping timestamp validation: shortcut is verifying only the HMAC, constraint hidden is that a valid signature never expires on its own.
- Synchronous webhook delivery: shortcut is sending in the request handler, constraint hidden is that receiver latency directly adds to your API's p99.
- No idempotency on the receiver: shortcut is trusting that webhooks arrive exactly once, constraint hidden is that any retry mechanism guarantees at-least-once, never exactly-once.
- Subscriptions for polling use cases: shortcut is picking the most "real-time" looking tool, constraint hidden is the per-connection server state that kills horizontal scaling.
- Missing AsyncAPI for Kafka topics: shortcut is skipping the spec, constraint hidden is that schema discovery becomes a manual process at the worst possible time (production incident).
- Leaking internal errors: shortcut is returning the raw error, constraint hidden is that database error messages expose schema structure.

First-job interview habit: for each design decision you propose in a system design interview, name the constraint that would cause the shortcut version to fail. This is the difference between describing a working system and demonstrating engineering judgment.

When you do code review, scan specifically for these patterns: resolver functions that return `error` directly from a mutation, resolver functions that call a repository method directly when the result type is a list field, webhook handler functions that send HTTP requests before writing the response, and webhook receivers that lack an idempotency check at the top.

### Senior @ FAANG: Mistake Taxonomy as a Code Review and Governance Framework

At staff level, individual mistakes matter less than the systems that allow them to propagate. Each mistake class in this chapter corresponds to a prevention mechanism that a mature team operationalizes.

**Mistake class 1: wrong abstraction at the boundary (GraphQL errors, internal error leakage)**

These mistakes happen when engineers apply a pattern that is correct for one layer at a layer where a different contract applies. Returning a Go error from a mutation resolver is correct for internal service calls, where the caller can inspect the error type. It is wrong at the GraphQL boundary, where the client is a browser or mobile app that deserves structured field-level feedback.

Prevention mechanism: define a code-review checklist item for mutation resolvers specifically. Every mutation return type must include a `errors: [UserError!]!` field. Enforce this with a linting rule in `gqlgen` configuration or a custom AST check in CI. Architectural decision: require a typed payload wrapper for all mutations, establish it as a schema convention in the team's GraphQL style guide, and have the schema registry reject mutations that violate it.

**Mistake class 2: missing coordination layer (N+1, synchronous delivery)**

N+1 and synchronous webhook delivery are both coordination failures. The resolver could have batched. The handler could have queued. Both chose the direct path instead of the mediated path.

Prevention mechanism for N+1: integration tests that count SQL queries. Run these in CI. A DataLoader regression that ships to production costs significantly more than a failing test in a PR. The test infrastructure investment is a one-time cost.

Prevention mechanism for synchronous delivery: architectural fitness function. Define a rule: "no outbound HTTP calls are permitted inside HTTP handlers that serve client-facing endpoints." Enforce it with a custom linter that inspects import graphs or call trees. This is the same class of architectural constraint as "no database calls in the presentation layer," and it deserves the same enforcement rigor.

**Mistake class 3: missing security controls (timestamp validation, idempotency, SSRF)**

Security mistakes in this chapter are particularly dangerous because they are invisible in happy-path testing. A webhook system with no timestamp validation looks correct in all positive tests. The vulnerability only surfaces under adversarial conditions.

Governance approach: treat every webhook handler as a security boundary and require a security review checklist completion before shipping. The checklist must include: HMAC verification present, timestamp window enforced, idempotency check present, payload size limit present. Automate what you can: a middleware wrapper that enforces HMAC and timestamp validation structurally prevents mistake 3 across all webhook handlers, not just the ones the author remembered.

For the sender side, SSRF prevention (URL validation at subscription registration time) belongs in the subscription creation service, not the delivery worker. The delivery worker should never make a request to a URL that has not already been validated. Validate once at registration, store the validated result, deliver without re-validating. This prevents a class of mutation attacks where an attacker updates an endpoint URL after registration.

**Mistake class 4: wrong tool selection (subscriptions for polling, missing AsyncAPI)**

These are design-time mistakes that are expensive to correct after services are in production. A service running WebSocket subscriptions for data that refreshes every 60 seconds has already allocated connection-state infrastructure for a problem that did not require it. Migrating clients from WebSocket to polling requires coordinating client deployments.

Prevention mechanism: technology radar for async patterns within your organization. Document when to use polling, when to use SSE, when to use WebSocket, and when to use Kafka. Apply it in architecture reviews before implementation begins. The radar should be a living document with ADR references for each decision that moved a technology between rings.

For missing AsyncAPI: adopt a policy that no Kafka producer ships without an AsyncAPI spec checked into the central schema registry. Add schema registry validation to the CI pipeline of every service. This is not optional documentation. It is the contract that lets consumers build without reading your source code.

**Bar-raiser signal across all classes**

At a staff-level system design interview, the bar-raiser is listening for whether you proactively identify prevention mechanisms, not just whether you know the correct patterns. The expected answer to "what could go wrong with this webhook system" includes not just the mistake list but the architectural controls that prevent each mistake class from reaching production. Describing the control and the enforcement mechanism (linter, CI gate, code-review checklist, middleware wrapper, architectural fitness function) is what separates L6 from L5 in system design evaluation.
