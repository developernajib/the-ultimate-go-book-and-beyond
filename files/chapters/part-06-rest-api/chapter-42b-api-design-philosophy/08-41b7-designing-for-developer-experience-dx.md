## 42B.7 Designing for Developer Experience (DX)

### SDK Design

An SDK is not a thin wrapper around HTTP calls. A good SDK:

1. **Feels native** to the language: Go SDK uses idiomatic Go (interfaces, errors, context), Python SDK uses Pythonic patterns
2. **Handles authentication** so developers never manually set headers
3. **Handles retries** with exponential backoff and jitter
4. **Handles pagination** with iterators, not raw pages
5. **Has rich errors** that include the original response for debugging

```go
// Client initialization
client := payments.NewClient(payments.Config{
    APIKey:    os.Getenv("PAYMENTS_API_KEY"),
    BaseURL:   "https://api.example.com",
    Timeout:   30 * time.Second,
    MaxRetries: 3,
})

// Creating a payment - SDK handles auth, retries, error mapping
payment, err := client.Payments.Create(ctx, &payments.CreatePaymentParams{
    Amount:   2000,
    Currency: "USD",
    Source:   "pm_abc123",
})
if err != nil {
    var apiErr *payments.APIError
    if errors.As(err, &apiErr) {
        log.Printf("API error: %s (code: %s)", apiErr.Message, apiErr.Code)
    }
    return err
}

// Listing with automatic pagination - iterator hides cursor complexity
iter := client.Payments.List(ctx, &payments.ListPaymentsParams{
    Status: "pending",
})
for iter.Next() {
    p := iter.Payment()
    fmt.Printf("Payment: %s %d\n", p.ID, p.Amount)
}
if err := iter.Err(); err != nil {
    return err
}
```

SDK iterator implementation:

```go
type PaymentIterator struct {
    client  *Client
    params  *ListPaymentsParams
    current []Payment
    index   int
    cursor  string
    hasMore bool
    err     error
    done    bool
}

func (it *PaymentIterator) Next() bool {
    if it.err != nil || it.done {
        return false
    }

    it.index++

    // Need to fetch next page
    if it.index >= len(it.current) {
        if it.index > 0 && !it.hasMore {
            it.done = true
            return false
        }

        page, err := it.client.payments.list(it.params, it.cursor)
        if err != nil {
            it.err = err
            return false
        }

        it.current = page.Data
        it.cursor = page.NextCursor
        it.hasMore = page.HasMore
        it.index = 0

        if len(it.current) == 0 {
            it.done = true
            return false
        }
    }

    return true
}

func (it *PaymentIterator) Payment() *Payment {
    if it.index < len(it.current) {
        return &it.current[it.index]
    }
    return nil
}

func (it *PaymentIterator) Err() error {
    return it.err
}
```

### Sandbox and First-Call Experience

A world-class API ships three non-negotiables for first-time developers:

- **A sandbox that lives at the same hostname as production**, keyed off the API key prefix (`sk_test_...` vs `sk_live_...`). Separate `sandbox.example.com` subdomains force clients to configure two base URLs and one of them will get it wrong in production.
- **Working copy-paste curl examples** in every endpoint's doc page, with a "run this" button that auto-fills the sandbox key. The goal is getting to `HTTP/1.1 200 OK` in under five minutes.
- **Scenario-triggering test values**. Stripe's `4000 0000 0000 0002` always declines, `4000 0000 0000 9995` always fails insufficient-funds. Clients can test error paths without mocks. This alone cuts integration time in half.

### Retry and Backoff Guidance

Clients need explicit guidance on how to retry, or they will invent something wrong. Document the policy and enforce it in your SDKs:

- Retry only on `429`, `500`, `502`, `503`, `504`, and connection errors. Never retry `4xx` other than `429`.
- Exponential backoff with full jitter: `sleep = random(0, min(cap, base * 2^attempt))`. Base 100ms, cap 30s, max 5 attempts is a good default.
- Respect the `Retry-After` header on `429` and `503`. If present, it replaces the computed backoff.
- Every retried POST request must carry the same `Idempotency-Key` as the original. Generating a new key per attempt defeats the point.

### Idempotency Keys

Idempotency keys allow clients to safely retry requests without creating duplicate resources:

```
POST /payments
Idempotency-Key: client-generated-uuid-v4
Content-Type: application/json

{"amount": 2000, "currency": "USD", "source": "pm_abc123"}
```

If the client sends the same `Idempotency-Key` again (due to timeout or network error):
- The server returns the **original response** (same body, same status code)
- No duplicate charge occurs
- The `Idempotency-Key` is good for 24 hours

The header is on the standards track as `draft-ietf-httpapi-idempotency-key-header`, still a draft, so today's behaviour is a de-facto convention set by the payment APIs that popularised it rather than a ratified requirement. Document your exact semantics, because clients cannot infer them.

One rule deserves to be stated before any code, because it is the one most implementations miss. **A key must be bound to the request it was first used with.** If a client sends the same key with a *different* body, that is not a retry. It is a bug in the client (a recycled UUID, a mutated payload between attempts, or a key collision), and replaying the stored response would silently confirm a payment the client never asked for. The right answer is to reject it: store a fingerprint of the original request alongside the response, compare on every hit, and return **400** on mismatch, which is what Stripe does. A common misreading assigns 409 to this case. Keep the two apart:

| Situation | Status | Why |
|---|---|---|
| Same key, same request, original finished | 200/201 replay | This is a retry. It is the whole point. |
| Same key, **different** request | **400** | Client bug. Never replay, never re-execute. |
| Same key, same request, original still in flight | **409** | Genuine concurrency. Tell the client to wait and retry. |

```go
type IdempotencyStore interface {
    Get(ctx context.Context, key string) (*IdempotencyRecord, error)
    Set(ctx context.Context, key string, record *IdempotencyRecord) error
    Lock(ctx context.Context, key string) (unlock func(), err error)
}

type IdempotencyRecord struct {
    Key        string
    Fingerprint string // hash of the original request: method + path + body
    StatusCode int
    Headers    map[string]string
    Body       []byte
    CreatedAt  time.Time
    ExpiresAt  time.Time
}

// fingerprint binds a key to the request it was first used with.
// Hash rather than store the body: request bodies contain card details and
// PII, and this record lives in a cache for 24 hours.
func fingerprint(method, path string, body []byte) string {
    h := sha256.New()
    h.Write([]byte(method))
    h.Write([]byte{0}) // separator: prevents ("POST","/ab") colliding with ("POST/a","b")
    h.Write([]byte(path))
    h.Write([]byte{0})
    h.Write(body)
    return hex.EncodeToString(h.Sum(nil))
}

// IdempotencyMiddleware intercepts duplicate requests
func IdempotencyMiddleware(store IdempotencyStore) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            key := r.Header.Get("Idempotency-Key")
            if key == "" || r.Method == http.MethodGet {
                next.ServeHTTP(w, r)
                return
            }

            // Validate key format
            if len(key) > 255 {
                http.Error(w, "Idempotency-Key must be <= 255 characters", http.StatusBadRequest)
                return
            }

            // Namespace by auth context to prevent cross-client replay.
            // Without this, one tenant guessing another's key could read
            // back that tenant's stored response body.
            authCtx := GetAuthContext(r.Context())
            namespacedKey := fmt.Sprintf("%s:%s", authCtx.KeyID, key)

            // Buffer the body so we can fingerprint it AND still hand it to
            // the handler. r.Body is a single-use stream: read it without
            // replacing it and the handler downstream receives EOF.
            body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxIdempotentBody))
            if err != nil {
                http.Error(w, "Request body too large", http.StatusRequestEntityTooLarge)
                return
            }
            r.Body = io.NopCloser(bytes.NewReader(body))
            fp := fingerprint(r.Method, r.URL.Path, body)

            // Check for existing result
            existing, err := store.Get(r.Context(), namespacedKey)
            if err == nil {
                // Same key, DIFFERENT request. This is not a retry, it is a
                // client bug. Replaying here would return a success the
                // client never asked for - re-executing would double-charge.
                // Refuse, and use 400 (not 409): 409 means "try again in a
                // moment", which is exactly the wrong advice, since retrying
                // this request will never succeed.
                if !hmac.Equal([]byte(existing.Fingerprint), []byte(fp)) {
                    apierror.Write(w, r, &apierror.ProblemDetail{
                        Type:   "https://api.example.com/errors/idempotency-key-reuse",
                        Title:  "Idempotency-Key Reuse",
                        Status: http.StatusBadRequest,
                        Detail: "This Idempotency-Key was already used with a different request body. Use a new key for a new request.",
                    })
                    return
                }

                // Same key, same request: a genuine retry. Replay verbatim.
                for k, v := range existing.Headers {
                    w.Header().Set(k, v)
                }
                w.Header().Set("Idempotent-Replayed", "true")
                w.WriteHeader(existing.StatusCode)
                w.Write(existing.Body)
                return
            }

            // Lock to prevent concurrent duplicate requests. 409 is correct
            // HERE: the original is genuinely still in flight, so "retry
            // shortly" is actionable advice.
            unlock, err := store.Lock(r.Context(), namespacedKey)
            if err != nil {
                http.Error(w, "A request with this Idempotency-Key is already in progress", http.StatusConflict)
                return
            }
            defer unlock()

            // Record the response
            rec := &responseRecorder{ResponseWriter: w}
            next.ServeHTTP(rec, r)

            // Only persist outcomes that are safe to replay.
            //
            // Storing a 5xx would pin the failure: every retry replays the
            // same 500 for 24 hours and the client can never get through,
            // even after you fix the outage. 5xx and 429 mean "unknown or
            // try again", so leave no record and let the retry re-execute.
            // That is safe precisely because the key is still unused.
            if rec.statusCode < 500 && rec.statusCode != http.StatusTooManyRequests {
                // Detached context: r.Context() is cancelled the moment the
                // response is written, so using it here loses the race and
                // the record is silently never saved. The bug surfaces as
                // "idempotency sometimes doesn't work" under load.
                ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
                defer cancel()

                if err := store.Set(ctx, namespacedKey, &IdempotencyRecord{
                    Key:         namespacedKey,
                    Fingerprint: fp,
                    StatusCode:  rec.statusCode,
                    Headers:     rec.headers,
                    Body:        rec.body,
                    CreatedAt:   time.Now(),
                    ExpiresAt:   time.Now().Add(24 * time.Hour),
                }); err != nil {
                    // The side effect already happened and the client already
                    // has its response. All we lost is replay protection, so
                    // alert rather than fail: a retry would re-execute.
                    logger.Error("idempotency record not persisted",
                        "err", err, "key_hash", fp[:16])
                }
            }
        })
    }
}
```

### Webhooks: Event Delivery

Webhooks push events to clients instead of requiring polling.

```go
type WebhookEvent struct {
    ID        string          `json:"id"`
    Type      string          `json:"type"`      // "payment.succeeded", "payment.failed"
    Created   time.Time       `json:"created"`
    APIVersion string         `json:"api_version"`
    Data      json.RawMessage `json:"data"`
    Livemode  bool            `json:"livemode"`
}

// Webhook delivery with retry
type WebhookDelivery struct {
    webhookID string
    event     *WebhookEvent
    endpoint  *WebhookEndpoint
    client    *http.Client
    store     WebhookDeliveryStore
}

func (d *WebhookDelivery) Deliver(ctx context.Context) error {
    payload, err := json.Marshal(d.event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    // Sign the payload with HMAC-SHA256
    signature := d.sign(payload, d.endpoint.Secret)

    req, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.endpoint.URL, bytes.NewReader(payload))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-Webhook-Event", d.event.Type)
    req.Header.Set("X-Webhook-Signature", "sha256="+signature)
    req.Header.Set("X-Webhook-ID", d.webhookID)
    req.Header.Set("X-Webhook-Timestamp", strconv.FormatInt(time.Now().Unix(), 10))

    resp, err := d.client.Do(req)
    if err != nil {
        return fmt.Errorf("delivering webhook: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return fmt.Errorf("webhook endpoint returned %d", resp.StatusCode)
    }

    return nil
}

func (d *WebhookDelivery) sign(payload []byte, secret string) string {
    mac := hmac.New(sha256.New, []byte(secret))
    // Include timestamp to prevent replay attacks
    timestamp := strconv.FormatInt(time.Now().Unix(), 10)
    mac.Write([]byte(timestamp + "."))
    mac.Write(payload)
    return hex.EncodeToString(mac.Sum(nil))
}

// Client-side webhook signature verification
func VerifyWebhookSignature(payload []byte, signatureHeader, secret string, tolerance time.Duration) error {
    // Parse: sha256=timestamp.signature
    parts := strings.SplitN(signatureHeader, ".", 2)
    if len(parts) != 2 {
        return ErrInvalidSignature
    }

    timestamp, err := strconv.ParseInt(parts[0], 10, 64)
    if err != nil {
        return ErrInvalidSignature
    }

    // Check timestamp freshness (replay attack prevention)
    eventTime := time.Unix(timestamp, 0)
    if time.Since(eventTime) > tolerance {
        return ErrStaleWebhook
    }

    // Recompute signature
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(parts[0] + "."))
    mac.Write(payload)
    expected := hex.EncodeToString(mac.Sum(nil))

    // Constant-time comparison to prevent timing attacks
    if !hmac.Equal([]byte(expected), []byte(parts[1])) {
        return ErrInvalidSignature
    }

    return nil
}
```

### Junior → FAANG: DX Is Not a UX Problem, It Is an Engineering Problem

Developer experience is often framed as documentation quality or onboarding flow. Those matter, but the deeper lever is the API design itself. An API with a bad DX cannot be rescued by better docs. The errors are confusing because the model is confusing.

**The prerequisite gap.** Junior engineers tend to design APIs from the server's perspective: what is easiest to implement, what maps cleanly to the database schema, what requires the fewest handler methods. Good DX requires designing from the client's perspective: what task is the developer trying to accomplish, what does a successful integration look like in their code, and what happens when something goes wrong at 2am and they are staring at an error response.

**Worked example: The idempotency key that was optional until it wasn't.** An API ships without idempotency key support on its payment creation endpoint. Integrators write clients that retry on network timeout. Duplicate charges appear. The API team adds idempotency key support six months later, but makes it optional for backward compatibility. Half the integrators never read the changelog and keep sending requests without keys. Duplicate charges continue. The lesson: idempotency support for state-changing operations must be a day-one decision, not a retrofit. The middleware in this chapter shows exactly how to implement it. Understand it before you ship your first `POST` endpoint.

**Worked example: The iterator that paid for itself.** The raw pagination API returns a `next_cursor` field and requires clients to loop, pass the cursor back, and accumulate results. Every client reimplements this loop. Some get it wrong (off-by-one on the `has_more` check). The Go SDK wraps this in a `PaymentIterator` that follows the `iter.Next()` / `iter.Payment()` / `iter.Err()` pattern, which Go engineers recognize immediately because it matches `sql.Rows` and `bufio.Scanner`. The integrator writes three lines instead of twenty and cannot make the pagination mistake because the iterator handles it internally.

**Interview entry-point framing.** When asked "How would you design an SDK for your API?", a passing answer describes wrapping the HTTP calls. A strong answer describes: idiomatic patterns for the target language, transparent retry with jitter, pagination as an iterator, rich error types that carry the original response, and a sandbox key prefix scheme that does not require a separate base URL. Name the specific Go patterns: `context.Context` threading, `errors.As` for typed errors, `io.Reader` for streaming responses if relevant.

**First-job habits:**
- Before shipping any endpoint, write the client code you would want to call. If it is awkward, the API design is probably wrong.
- Test your curl examples before publishing them. Copy the example from the doc, paste it into a terminal, and verify the response is what the doc says it is.
- Every `POST` that creates a resource should support an idempotency key. Add the middleware from day one.
- Write the error message for every error code as if you are the developer reading it at midnight. "Invalid request" is not a message. "The `amount` field must be a positive integer in the smallest currency unit (e.g., 100 for $1.00)" is a message.

---

### Senior @ FAANG: DX as a Platform Multiplier

At staff level, DX is not measured by how good one API feels. It is measured by how consistently good all APIs feel, how fast new integrators reach their first successful call, and how rarely support tickets are filed for issues that documentation or SDK design could have prevented.

**Time-to-first-successful-call (TTFSC) as the primary DX metric.** TTFSC is the elapsed time from a developer signing up to receiving a non-error response from the API. Every hour above five minutes represents friction that drives integrators to competitors. The components of TTFSC are: account creation and key issuance, finding the right endpoint in the docs, constructing a correct request, and interpreting the response. Instrumentation: log the first successful API call per API key with a timestamp, compute the delta from key creation. Aggregate weekly. Alert if the median rises above your target. This metric surfaces DX regressions faster than any survey.

**The sandbox as a first-class product.** The sandbox is not a lower-effort version of production. It is a product that must be designed. Key decisions: How are test keys distinguished from live keys? (Prefix scheme: `sk_test_` vs `sk_live_`. Never separate hostnames.) How are scenario-triggering test values documented and maintained? (A dedicated test data reference page, versioned alongside the API.) How does the sandbox handle webhooks? (A webhook inspector UI that shows delivery attempts and payloads for test-mode events is table stakes.) How does sandbox state reset? (Per-key isolation so one integrator's test data does not pollute another's.) The scenario-triggering test values mentioned in this chapter reduce integration time measurably. Maintain them as a first-class artifact of each new feature, not as an afterthought.

**SDK as a contract surface.** An SDK is a versioned contract with its own backward-compatibility obligations. Every public method signature, every exported type field, every error type is part of the SDK contract. If you rename a method in the Go SDK, you break every Go integrator who called it directly. This means SDK design decisions deserve the same ADR treatment as API design decisions. Before shipping a new method, ask: Is the naming idiomatic? Is the parameter order consistent with existing methods? Is the error type extensible without breaking the type assertion? A poor SDK method costs more to fix after release than a poor API endpoint, because SDK upgrades require integrators to update their import version, not just their request shape.

**Retry and backoff as a shared library, not per-service code.** Every service that exposes an HTTP API will eventually need an SDK. Every SDK needs retry logic. If retry logic is implemented per-SDK, it will diverge: different base intervals, different jitter strategies, different handling of `Retry-After`. The platform investment is a shared retry library with a single implementation, configurable per SDK but consistent in behavior. This also makes it possible to change retry behavior (for example, to implement adaptive backoff based on observed error rates) in one place rather than across a fleet of SDKs.

**Webhook reliability at platform scale.** The delivery loop in this chapter handles a single webhook endpoint. At platform scale, webhook delivery is a distributed system problem. The failure modes include: the delivery worker crashes after writing to the database but before sending the HTTP request (message lost), the integrator's endpoint returns 200 but the processing fails internally (false success), and the delivery worker sends the webhook but the database write fails (duplicate delivery without idempotency). The correct architecture is at-least-once delivery with an idempotent event ID: write the event to a durable queue before any delivery attempt, deliver from the queue, mark delivered only after a confirmed 2xx response. The integrator is responsible for idempotency on their side, which is why the `id` field on the `WebhookEvent` struct is required and must be globally unique.

**Idempotency key implementation at scale.** The middleware in this chapter uses a distributed store with a locking protocol. The subtle correctness requirement is that the lock must be held for the duration of the upstream handler, not just for the cache lookup. A distributed lock that expires before the handler completes allows a second request with the same key to pass the lock check and proceed concurrently, producing a duplicate. The lock TTL must be longer than the p99 latency of your slowest handler. Measure it, set the TTL to 2x the p99, and alert if the p99 approaches the TTL threshold. The `Idempotent-Replayed: true` response header is a DX feature: integrators can distinguish a fresh response from a replayed one in their test suites.

**Bar-raiser signals at L6+.** Strong signals include: you propose TTFSC as a metric before discussing implementation, you design the sandbox as a product rather than a test environment, you describe SDK versioning obligations and explain why method renaming is a breaking change in the same way field renaming is for APIs, you connect the idempotency implementation to the at-least-once delivery model and explain why the lock TTL must exceed p99 latency, and you describe webhook delivery as a distributed system with defined failure modes and mitigations. Weak signals: describing DX as "better documentation," treating the sandbox as a feature flag on production code, or not accounting for concurrent duplicate requests in the idempotency design.

---
