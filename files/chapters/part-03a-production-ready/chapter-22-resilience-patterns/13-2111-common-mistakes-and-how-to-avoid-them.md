## 22.11 Common Mistakes and How to Avoid Them

### Mistake 1: Retrying Non-Idempotent Operations

Retrying a `POST` that creates a resource without idempotency protection can create duplicate records. The first request may have succeeded and timed out before the response came back, so the retry creates a second one. An idempotency key lets the server recognise the duplicate and return the original result instead of doing the work twice.

The key must come **from the client**, generated once per logical operation and reused across that operation's retries. Deriving it from the request content is a different thing entirely, and a bug: two genuinely separate orders for the same item at the same price hash identically, so the second one is silently swallowed. Content hashing deduplicates *identical requests*, which is not what "the same operation, retried" means.

```go
// WRONG: Retrying without idempotency
func createOrder(ctx context.Context, order Order) error {
    return retry.Do(ctx, func() error {
        return orderService.Create(ctx, order) // May create duplicates!
    })
}

// CORRECT: one client-generated key per logical operation, reused by retries.
func createOrderIdempotent(ctx context.Context, order Order) error {
    // Generated ONCE, outside the retry loop. Inside it, every attempt
    // would get a fresh key and every attempt would create a new order.
    idempotencyKey := uuid.NewString()

    return retry.Do(ctx, func() error {
        return orderService.CreateWithKey(ctx, order, idempotencyKey)
    })
}

// Server-side idempotency handling.
//
// The reservation must be ATOMIC. See "the check-then-act trap" below:
// a Get followed by a Set is not idempotency, it is a race with a
// comfortable-looking comment.
func (s *OrderService) CreateWithKey(ctx context.Context, order Order, key string) error {
    // Claim the key atomically. SetNX (INSERT ... ON CONFLICT DO NOTHING in
    // SQL) succeeds for exactly one caller, no matter how many race.
    claimed, err := s.idempotencyStore.SetNX(ctx, key, statusInProgress, 24*time.Hour)
    if err != nil {
        return err
    }

    if !claimed {
        // Someone else owns this key. Return their result, or tell the
        // caller to retry if the original is still running.
        return s.awaitResult(ctx, key)
    }

    if err := s.db.CreateOrder(ctx, order); err != nil {
        // Release the claim so a genuine retry can succeed. Leaving it
        // pinned would make a transient DB error permanently unretryable.
        s.idempotencyStore.Delete(ctx, key)
        return err
    }

    return s.idempotencyStore.Set(ctx, key, order.ID, 24*time.Hour)
}
```

**The check-then-act trap.** The tempting server-side shape is "look it up, and if it is not there, do the work":

```go
// WRONG, despite looking exactly like idempotency.
existing, err := s.idempotencyStore.Get(ctx, key)
if err == nil && existing != nil {
    return nil // already processed
}
if err := s.db.CreateOrder(ctx, order); err != nil {
    return err
}
s.idempotencyStore.Set(ctx, key, order.ID, 24*time.Hour)
```

There is a window between the `Get` and the `Set` in which the key does not exist yet. Every concurrent request carrying that key sees "not processed" and proceeds to create the order. Run 20 concurrent retries of a single idempotency key against this handler and count the rows:

```
book's check-then-act version:  orders created for ONE idempotency key: 13
atomic SetNX version:           orders created for ONE idempotency key: 1
```

Thirteen orders. The idempotency key made no difference at all, because the code never atomically *claimed* it. And concurrent retries of the same key are not a contrived scenario: they are the normal case. A client that times out and retries frequently has the original request still in flight, which is precisely why the response never arrived.

The rule: idempotency requires an **atomic claim**, not a lookup. `SetNX`, a unique constraint on the key column, `INSERT ... ON CONFLICT DO NOTHING`, or a compare-and-swap. If two callers can both observe "not yet done" and both proceed, you have written a race with reassuring variable names.

### Mistake 2: Not Propagating Context Cancellation

When a context is canceled, because the client disconnected, a deadline expired, or a parent handler timed out, any in-flight work that ignores the cancellation continues consuming goroutines, connections, and CPU for an operation whose result will never be used. The wrong version below passes no context to `http.Get`, so canceling the outer context has no effect on the HTTP call or the `time.Sleep` between attempts. The correct version attaches the context to every outbound request and checks `ctx.Done()` before sleeping, ensuring the retry loop exits immediately when the caller no longer needs the result.

```go
// WRONG: Ignoring context in retry loop
func fetchWithRetry(ctx context.Context, url string) ([]byte, error) {
    for attempt := 0; attempt < 3; attempt++ {
        resp, err := http.Get(url) // Context not used!
        if err == nil {
            return io.ReadAll(resp.Body)
        }
        time.Sleep(time.Second * time.Duration(attempt+1))
    }
    return nil, errors.New("all retries failed")
}

// CORRECT: Respect context throughout
func fetchWithRetry(ctx context.Context, url string) ([]byte, error) {
    for attempt := 0; attempt < 3; attempt++ {
        req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
        if err != nil {
            return nil, err
        }

        resp, err := http.DefaultClient.Do(req)
        if err == nil {
            defer resp.Body.Close()
            return io.ReadAll(resp.Body)
        }

        // Check context before sleeping
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(time.Second * time.Duration(attempt+1)):
        }
    }
    return nil, errors.New("all retries failed")
}
```

### Mistake 3: Circuit Breaker with Wrong Granularity

A single circuit breaker for all endpoints means a failure on one slow endpoint trips the breaker and blocks every request to the API, including unrelated healthy endpoints. Breakers scoped to a *route* isolate failures to the affected resource, leaving the rest of the API surface available while the troubled route is open.

The granularity has to be chosen deliberately, and both extremes are wrong. One breaker per service is too coarse: any single bad endpoint takes down the rest. One breaker per **URL** is too fine, and is the more dangerous mistake because it looks more careful. Keying on `/users/12345` gives you a breaker per user, which means each one sees a handful of requests (far too few for a failure rate to mean anything), the breaker never trips because no individual key accumulates evidence, and the map grows without bound on an attacker-controlled key. Key on the **route template** (`/users/{id}`), which is the unit that actually shares a backend code path.

```go
// WRONG: One circuit breaker for all endpoints
var globalCircuitBreaker = circuit.NewCircuitBreaker(settings)

func callAPI(endpoint string) error {
    // Also a compile error: http.Get returns (*http.Response, error),
    // which does not fit a func() error.
    return globalCircuitBreaker.Execute(func() error {
        return http.Get("https://api.example.com" + endpoint)
    })
}

// CORRECT: one circuit breaker per ROUTE TEMPLATE, not per URL.
type APIClient struct {
    breakers map[string]*circuit.CircuitBreaker
    mu       sync.RWMutex
}

// getBreaker uses double-checked locking: an RLock fast path for the common
// case (the breaker already exists) and a full Lock only to create one.
func (c *APIClient) getBreaker(route string) *circuit.CircuitBreaker {
    c.mu.RLock()
    cb, ok := c.breakers[route]
    c.mu.RUnlock()
    if ok {
        return cb
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    // Re-check under the write lock: another goroutine may have created it
    // between our RUnlock and Lock. Without this, two breakers are built for
    // the same route, and the loser's metrics registration panics.
    if cb, ok := c.breakers[route]; ok {
        return cb
    }

    cb = circuit.NewCircuitBreaker(circuit.DefaultSettings(route))
    c.breakers[route] = cb
    return cb
}

// Call takes the route template ("/users/{id}") separately from the concrete
// path ("/users/12345"), so the breaker is keyed on the shared code path
// rather than on one user's id.
func (c *APIClient) Call(ctx context.Context, route, path string) (*http.Response, error) {
    cb := c.getBreaker(route)

    result, err := cb.ExecuteWithContext(ctx, func(ctx context.Context) (any, error) {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet,
            "https://api.example.com"+path, nil)
        if err != nil {
            return nil, err
        }
        return http.DefaultClient.Do(req)
    })
    if err != nil {
        return nil, err
    }
    return result.(*http.Response), nil
}
```

Note that the breaker map is keyed on `route`, a value from your own routing table, not from the request. That bound is what keeps the map finite. The moment the key comes from user input, a per-key breaker map becomes an unbounded allocation, exactly like the rate limiter in section 22.5.

### Mistake 4: Retry Storms

When many clients retry simultaneously after a service recovers from a brief outage, the synchronized surge overwhelms it again. That is the thundering herd. Full jitter spreads retry attempts across the whole backoff window so clients de-correlate, while a retry budget caps the fleet's aggregate retry rate as a second, independent control.

```go
// WRONG: All clients retry at the same time
func fetchData(ctx context.Context) error {
    return retry.Do(ctx, retry.Config{
        InitialInterval: 1 * time.Second,
        Multiplier:      2,
    }, func() error {
        return callService()
    })
}

// A percentage nudge ("sleep +/- 50%") is the same trap in a wider band:
// it still clusters every client around the same instant. Section 22.2
// measures exactly this. Note the chapter's retry.Config deliberately has
// no proportional mode: Full, Equal, or None, so this mistake is a
// compile error rather than a runtime surprise.

// CORRECT: full jitter. sleep = random(0, interval).
func fetchData(ctx context.Context) error {
    return retry.Do(ctx, retry.Config{
        InitialInterval: 1 * time.Second,
        Multiplier:      2,
        Jitter:          retry.JitterFull,
    }, func() error {
        return callService()
    })
}

// Even better: Implement adaptive retry budget
type AdaptiveRetrier struct {
    budget     *RetryBudget
    baseConfig retry.Config
}

func (ar *AdaptiveRetrier) Do(ctx context.Context, fn func() error) error {
    var lastErr error
    for attempt := 0; attempt <= ar.baseConfig.MaxRetries; attempt++ {
        err := fn()
        if err == nil {
            return nil
        }
        lastErr = err

        if attempt < ar.baseConfig.MaxRetries {
            if !ar.budget.CanRetry() {
                return fmt.Errorf("retry budget exhausted: %w", lastErr)
            }

            // Calculate backoff with jitter
            wait := ar.calculateBackoff(attempt)
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(wait):
            }
        }
    }
    return lastErr
}
```

### Mistake 5: Bulkhead Without Timeout

A bulkhead that blocks indefinitely while waiting for a semaphore slot defeats its own purpose: callers pile up waiting for permits, consuming goroutines and memory until the backlog grows large enough to cause its own failures. Adding a context deadline or an explicit timeout to the semaphore acquisition makes the bulkhead fail-fast when it is full, returning an error immediately rather than queuing unbounded callers.

```go
// WRONG: Bulkhead that can block forever
type Bulkhead struct {
    sem chan struct{}
}

func (b *Bulkhead) Execute(fn func() error) error {
    b.sem <- struct{}{} // Can block forever!
    defer func() { <-b.sem }()
    return fn()
}

// CORRECT: Bulkhead with timeout
func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn()
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(b.timeout):
        return ErrBulkheadTimeout
    }
}
```

### Staff Lens: Resilience Mistakes Compound

A retry without jitter is bad. A retry without jitter around an open circuit breaker is worse. A retry without jitter plus no timeout means a hung caller retrying forever against a failed dependency. Each mistake alone is a bug. Combinations create amplified outages.

Review every resilience change holistically. Ask: what is the worst case if this dependency is completely down? If the answer is anything other than "fail fast with fallback", the resilience chain has a gap.

---
