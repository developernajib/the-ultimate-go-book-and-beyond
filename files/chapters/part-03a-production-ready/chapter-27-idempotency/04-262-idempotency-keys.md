## 27.2 Idempotency Keys

> **Senior track**: Stripe's public contract is the industry reference (docs.stripe.com/api/idempotent_requests). Keys are client-generated UUIDs sent as the `Idempotency-Key` header, responses are cached for at least 24 hours, and reusing the same key with a different request body returns a 400-level conflict rather than silently serving the cached response. Concurrent requests with the same key receive a 409, the second caller must retry. Keys scope to (account, endpoint), not globally. Replicate these semantics verbatim, clients already know the protocol.

### Basic Implementation

An idempotency handler wraps the operation in a check-lock-check-execute-store sequence. The first `Check` is an optimistic fast path for the common case of a cached result. The distributed lock prevents two concurrent retries from both executing the operation. The second `Check` after acquiring the lock handles the race where one caller completed between the first check and the lock acquisition, a double-checked locking pattern necessary for correctness under concurrent retries.

The critical piece is the **request fingerprint**. The store is keyed on the idempotency key *alone*, and the fingerprint of the original request body is stored beside the response. On every lookup the handler compares the incoming fingerprint against the stored one. Same key, same body means replay the cached response. Same key, *different* body means the client has made a mistake serious enough that the only safe answer is to refuse. Read the note after the middleware for why this must not be done by mixing the body hash into the key.

```go
package idempotency

import (
    "context"
    "errors"
    "fmt"
    "time"
)

var (
    ErrDuplicateRequest = errors.New("duplicate request detected")
    ErrRequestInFlight  = errors.New("request already in progress")
    // ErrKeyReuse means the key was already used with a DIFFERENT request
    // body. This is a client bug and must surface as 400, never as a replay.
    ErrKeyReuse = errors.New("idempotency key reused with different request parameters")
    // ErrRecordLost means the operation succeeded but its idempotency record
    // could not be persisted, so a retry would re-execute it. Alert on this.
    ErrRecordLost = errors.New("operation executed but idempotency record was not stored")
)

type IdempotencyStore interface {
    // Check returns stored response if exists, nil if not found
    Check(ctx context.Context, key string) (*StoredResponse, error)
    // Lock attempts to acquire a lock for the key
    Lock(ctx context.Context, key string, ttl time.Duration) (bool, error)
    // Store saves the response for future lookups
    Store(ctx context.Context, key string, response *StoredResponse, ttl time.Duration) error
    // Unlock releases the lock
    Unlock(ctx context.Context, key string) error
}

type StoredResponse struct {
    StatusCode int
    Body       []byte
    Headers    map[string]string
    CreatedAt  time.Time

    // Fingerprint of the request that produced this response. Compared on
    // every replay to detect key reuse with different parameters.
    Fingerprint string
}

type IdempotencyHandler struct {
    store       IdempotencyStore
    lockTTL     time.Duration
    responseTTL time.Duration
}

func NewIdempotencyHandler(store IdempotencyStore) *IdempotencyHandler {
    return &IdempotencyHandler{
        store:       store,
        lockTTL:     5 * time.Minute,
        responseTTL: 24 * time.Hour,
    }
}

// Handle runs fn at most once per key. fingerprint identifies the request
// parameters - a key replayed with a different fingerprint returns ErrKeyReuse.
func (h *IdempotencyHandler) Handle(
    ctx context.Context,
    key, fingerprint string,
    fn func() (*StoredResponse, error),
) (*StoredResponse, error) {
    // Fast path: an existing response for this key.
    existing, err := h.store.Check(ctx, key)
    if err != nil {
        return nil, err
    }
    if existing != nil {
        return replay(existing, fingerprint)
    }

    // Acquire lock
    acquired, err := h.store.Lock(ctx, key, h.lockTTL)
    if err != nil {
        return nil, err
    }
    if !acquired {
        return nil, ErrRequestInFlight
    }
    defer h.store.Unlock(ctx, key)

    // Double-check after acquiring lock
    existing, err = h.store.Check(ctx, key)
    if err != nil {
        return nil, err
    }
    if existing != nil {
        return replay(existing, fingerprint)
    }

    // Execute the actual operation
    response, err := fn()
    if err != nil {
        return nil, err
    }
    response.Fingerprint = fingerprint

    // Only cache outcomes the client should be held to. A 5xx is a transient
    // failure: caching it would pin the client to that error for responseTTL,
    // and every retry would replay the outage instead of recovering from it.
    if !shouldCache(response.StatusCode) {
        return response, nil
    }

    if err := h.store.Store(ctx, key, response, h.responseTTL); err != nil {
        // The operation ALREADY HAPPENED but we failed to record it. A retry
        // will re-execute it. This is the dangerous window: see the note below.
        // Do not swallow this. It is an alertable event.
        return response, fmt.Errorf("%w: %v", ErrRecordLost, err)
    }

    return response, nil
}

// replay returns the cached response, or ErrKeyReuse if the caller sent the
// same key with different parameters.
func replay(existing *StoredResponse, fingerprint string) (*StoredResponse, error) {
    if existing.Fingerprint != fingerprint {
        return nil, ErrKeyReuse
    }
    return existing, nil
}

// shouldCache reports whether a status code represents a settled outcome.
// 2xx and 4xx are decisions the server stands behind. 5xx is not.
func shouldCache(status int) bool {
    return status < 500
}
```

### Redis-Based Store

Redis is the natural backing store for idempotency data: `SetNX` provides an atomic distributed lock acquisition that either sets the key (acquired) or returns false (already locked) in a single round-trip. Responses are JSON-serialized and stored with a TTL so they expire automatically, preventing unbounded storage growth while keeping replayed responses available for the client's retry window.

```go
package idempotency

import (
    "context"
    "encoding/json"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisStore struct {
    client *redis.Client
    prefix string
}

func NewRedisStore(client *redis.Client, prefix string) *RedisStore {
    return &RedisStore{
        client: client,
        prefix: prefix,
    }
}

func (s *RedisStore) key(k string) string {
    return s.prefix + ":response:" + k
}

func (s *RedisStore) lockKey(k string) string {
    return s.prefix + ":lock:" + k
}

func (s *RedisStore) Check(ctx context.Context, key string) (*StoredResponse, error) {
    data, err := s.client.Get(ctx, s.key(key)).Bytes()
    if err == redis.Nil {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }

    var response StoredResponse
    if err := json.Unmarshal(data, &response); err != nil {
        return nil, err
    }

    return &response, nil
}

func (s *RedisStore) Lock(ctx context.Context, key string, ttl time.Duration) (bool, error) {
    ok, err := s.client.SetNX(ctx, s.lockKey(key), "locked", ttl).Result()
    return ok, err
}

func (s *RedisStore) Store(ctx context.Context, key string, response *StoredResponse, ttl time.Duration) error {
    data, err := json.Marshal(response)
    if err != nil {
        return err
    }

    return s.client.Set(ctx, s.key(key), data, ttl).Err()
}

func (s *RedisStore) Unlock(ctx context.Context, key string) error {
    return s.client.Del(ctx, s.lockKey(key)).Err()
}
```

### HTTP Middleware

HTTP middleware transparently applies idempotency to any mutating endpoint without modifying handler code. The body hash travels alongside the key as a *fingerprint*, not as part of the key. The middleware looks the key up on its own, compares fingerprints, and rejects a mismatch with `400`.

```go
package idempotency

import (
    "bytes"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "io"
    "net/http"
    "time"
)

const IdempotencyKeyHeader = "Idempotency-Key"

// accountID returns the authenticated principal for the request. In a real
// service this reads whatever your auth middleware put on the context. It must
// come from the verified credential, NEVER from a client-supplied header.
func accountID(r *http.Request) string {
    if v, ok := r.Context().Value(accountIDKey).(string); ok {
        return v
    }
    return "anonymous"
}

type ctxKey struct{ name string }

var accountIDKey = ctxKey{"accountID"}

func Middleware(handler *IdempotencyHandler) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Only apply to mutating methods
            if r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS" {
                next.ServeHTTP(w, r)
                return
            }

            key := r.Header.Get(IdempotencyKeyHeader)
            if key == "" {
                // No idempotency key - process normally
                next.ServeHTTP(w, r)
                return
            }

            // Include request body hash in key for safety
            bodyBytes, err := io.ReadAll(r.Body)
            if err != nil {
                http.Error(w, "Failed to read body", http.StatusBadRequest)
                return
            }
            r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

            // Scope the key so one tenant cannot collide with (or probe for)
            // another's keys, and so the same key on a different endpoint is a
            // different operation. Stripe scopes to (account, endpoint).
            storeKey := scopeKey(r, key)

            // The body hash is a FINGERPRINT, passed separately. It must not
            // be concatenated into the key: see the note below.
            fingerprint := hashBody(bodyBytes)

            response, err := handler.Handle(r.Context(), storeKey, fingerprint, func() (*StoredResponse, error) {
                // Capture the response
                recorder := newResponseRecorder()

                next.ServeHTTP(recorder, r)

                return &StoredResponse{
                    StatusCode: recorder.statusCode,
                    Body:       recorder.body.Bytes(),
                    Headers:    extractHeaders(recorder.Header()),
                    CreatedAt:  time.Now(),
                }, nil
            })

            switch {
            case errors.Is(err, ErrKeyReuse):
                // 400, not 409. The client sent a key it already used with
                // different parameters. Retrying will not help: the request
                // itself is malformed. This matches Stripe's contract.
                http.Error(w, "Idempotency-Key was already used with different request parameters",
                    http.StatusBadRequest)
                return
            case errors.Is(err, ErrRequestInFlight):
                // 409. An identical request is executing right now. This one
                // is retryable, so the client should back off and retry.
                w.Header().Set("Retry-After", "1")
                http.Error(w, "Request already in progress", http.StatusConflict)
                return
            case err != nil:
                http.Error(w, "Internal error", http.StatusInternalServerError)
                return
            }

            // Write cached response
            for k, v := range response.Headers {
                w.Header().Set(k, v)
            }
            w.WriteHeader(response.StatusCode)
            w.Write(response.Body)
        })
    }
}

type responseRecorder struct {
    header     http.Header
    statusCode int
    body       *bytes.Buffer
}

func newResponseRecorder() *responseRecorder {
    return &responseRecorder{
        header:     make(http.Header),
        statusCode: http.StatusOK,
        body:       &bytes.Buffer{},
    }
}

func (r *responseRecorder) Header() http.Header {
    return r.header
}

func (r *responseRecorder) WriteHeader(code int) {
    r.statusCode = code
}

func (r *responseRecorder) Write(b []byte) (int, error) {
    return r.body.Write(b)
}

// hashBody returns the full SHA-256 of the request body. Do not truncate:
// a fingerprint collision means serving one request's cached response to a
// DIFFERENT request that reused the key, which is the exact outcome the
// fingerprint exists to prevent. The bytes are free.
func hashBody(body []byte) string {
    h := sha256.Sum256(body)
    return hex.EncodeToString(h[:])
}

// scopeKey namespaces an idempotency key. Keys are client-chosen strings, so
// a global namespace lets one tenant's "key-1" collide with another's, and
// lets a caller probe for a key someone else used. Scope by authenticated
// principal and by endpoint.
func scopeKey(r *http.Request, key string) string {
    return accountID(r) + ":" + r.Method + ":" + r.URL.Path + ":" + key
}

func extractHeaders(h http.Header) map[string]string {
    headers := make(map[string]string)
    for k := range h {
        headers[k] = h.Get(k)
    }
    return headers
}
```

> **Never concatenate the body hash into the idempotency key.** This is the most important paragraph in the chapter, and the tempting one-liner is:
>
> ```go
> fullKey := key + ":" + hashBody(bodyBytes) // catastrophically wrong
> ```
>
> It looks like it enforces the fingerprint rule. It does the exact opposite. Reusing a key with a different body now produces a *different* `fullKey`, which misses the cache, which means the operation **executes as a brand new request**. The mechanism you installed to prevent double-charging is the thing that causes it.
>
> Walk the failure. A client POSTs `{"amount_cents": 10000}` with `Idempotency-Key: abc`. The charge succeeds, but the response is lost to a timeout. The client retries with key `abc` and a body that differs in some way the developer considers irrelevant: a re-serialized JSON with reordered fields, an added `client_retry: 2` field, a corrected `{"amount_cents": 100000}` after someone noticed a typo. Every one of those yields a different body hash, a different `fullKey`, a cache miss, and **a second charge**. The customer is billed twice while holding a receipt that proves they sent the same idempotency key both times. This is precisely the failure the header exists to prevent, and the "safety" measure caused it.
>
> The correct structure separates identity from content. The **key** is the identity of the operation and is the only thing you look up by. The **fingerprint** is a property of the request stored beside the response, compared after the lookup succeeds. Same key and same fingerprint means replay. Same key and different fingerprint means the client has a bug, and the only safe response is to refuse and say so.
>
> **Refuse with 400, not 409.** This trips people up because 409 Conflict sounds right. Reach for the standard test: is the request retryable as-is? A 409 says "conflict right now, try again", and a well-behaved client will retry, forever, because the request will never succeed. The problem is not timing, it is that the request is self-contradictory: it asserts "this is the same operation as before" while carrying different parameters. That is a malformed request, which is 400. Reserve 409 for `ErrRequestInFlight`, where an identical request genuinely is executing concurrently and retrying *will* work. This matches Stripe's published contract, and since clients already implement against Stripe's semantics, matching them exactly means retry logic your callers already wrote behaves correctly against your API.
>
> **Do not cache 5xx responses.** The original stored whatever the handler produced. Cache a 500 from a transient database blip and you have pinned that client to that error for the full 24-hour TTL: every retry replays the cached failure, the outage is long over, and the client cannot make progress until the key expires. Cache settled outcomes only, meaning 2xx and 4xx, which are decisions the server stands behind. A 5xx means "unknown, try again", so leave no record and let the retry genuinely re-execute.
>
> **Scope keys to the authenticated principal.** Keys are arbitrary client-chosen strings. In a global namespace, one tenant picking `order-1` collides with every other tenant that picked `order-1`, and a caller who guesses a key can fetch a cached response belonging to someone else. Scope to (account, method, path) and derive the account from the verified credential, never from a header the caller controls.

### Prove it, do not assume it

Idempotency is a claim about concurrency, and claims about concurrency are worthless until measured. These are the tests worth writing, run against a real Redis with `-race` and a handler that counts actual side effects:

| Scenario | Result | Real charges |
|----------|--------|-------------:|
| First `POST {"amount_cents":10000}`, key `abc` | `200 {"charge_id":1}` | 1 |
| Exact retry, same key and body | `200 {"charge_id":1}` (replayed) | 0 |
| Same key `abc`, body `{"amount":99999}` | **`400`** key reuse | 0 |
| 50 concurrent identical requests | 43 replayed `200`, 7 got `409` | **1** |
| Backend 500, then retry once healthy | `500`, then `200` | recovers |
| Backend 422, then retry | `422` replayed, backend called once | n/a |

The row that matters most is the 50-way concurrent one: fifty simultaneous retries of the same key produce **exactly one** charge. The losers of the lock race receive a `409` and are expected to retry, at which point they hit the cached response. That is the contract working.

For contrast, run the body-hash-in-key version through the same test. Two requests with the same idempotency key and different bodies produce **two charges**. One test, and the design question answers itself.

### The uncomfortable gap: the record and the effect

One hazard survives all of the above, and honesty about it matters more than a tidy example. In `Handle`, the operation runs in `fn()` and the record is written afterwards by `store.Store`. Those are two separate systems, so a crash in between, or a Redis failure on the write, leaves the effect applied with no record of it. The retry finds no key, executes again, and charges twice. The original code's comment said "Log but don't fail, operation succeeded, next retry will re-execute but should be safe". That is a dual-write hazard being waved away, and the phrase "should be safe" is doing an enormous amount of unearned work.

You cannot close this window with a cache in front of a database, because the guarantee has to be atomic with the effect. There are exactly two honest options:

1. **Put the idempotency record in the same transaction as the business write.** The record and the effect commit together or not at all, which is the only way to make "executed" and "recorded" the same event. This requires the record to live in the same database as the data, which is the strongest argument for a Postgres-backed idempotency table over a Redis one, and is the design the rest of this chapter builds toward.
2. **Make the underlying operation idempotent by identity**, so a second execution is harmless regardless of what the record says: a unique constraint on `(account_id, idempotency_key)` in the `charges` table, or a conditional write. Then the cache is a latency optimization rather than a correctness mechanism, and losing it costs you a duplicate *attempt* that the database rejects, not a duplicate *charge*.

Redis-backed middleware is fine for the first cut and genuinely eliminates most duplicates. Just be precise about what it is: a fast dedup cache, not a guarantee. Returning `ErrRecordLost` rather than swallowing the error is what keeps that distinction visible, because the alert is the only signal that the window opened.

### Staff Lens: Idempotency Middleware Is Shared Code

Ship idempotency middleware as a shared library. Every mutation endpoint uses it. Adding a new endpoint is one line. Consistency across services.

---
