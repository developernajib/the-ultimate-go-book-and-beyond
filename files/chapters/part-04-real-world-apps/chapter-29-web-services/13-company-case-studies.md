## Company Case Studies

### Stripe: API Design Excellence

Stripe's API is widely regarded as one of the best-designed REST APIs in production. Three patterns stand out: idempotency keys for safe retries, date-based header versioning for backward compatibility, and expandable resources to reduce round trips.

**Idempotency Keys**

Idempotency keys let clients safely retry failed requests. The server stores the result of the first request keyed by the client-supplied idempotency key. Subsequent requests with the same key return the cached result without re-executing the operation.
```go
// Stripe's approach to idempotency
func (h *PaymentHandler) CreateCharge(w http.ResponseWriter, r *http.Request) {
    idempotencyKey := r.Header.Get("Idempotency-Key")
    if idempotencyKey == "" {
        // Stripe allows requests without idempotency keys but recommends them
        idempotencyKey = uuid.New().String()
    }

    // Check for existing result
    if result, found := h.idempotencyStore.Get(idempotencyKey); found {
        // Return cached result
        RespondJSON(w, result.StatusCode, result.Body)
        return
    }

    // Process the charge
    charge, err := h.service.CreateCharge(r.Context(), input)
    if err != nil {
        // Store error result for idempotency
        h.idempotencyStore.Set(idempotencyKey, ErrorResult(err))
        HandleError(w, err)
        return
    }

    // Store success result
    h.idempotencyStore.Set(idempotencyKey, SuccessResult(charge))
    RespondSuccess(w, http.StatusCreated, charge)
}
```

**Versioning Strategy**

Instead of URL-based versioning, Stripe uses a date string in request headers. The server reads the version and transforms the response format accordingly, allowing old clients to keep working while new clients opt into the latest schema.

```go
// Stripe uses date-based API versioning in headers
func VersionedAPI(defaultVersion string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            version := r.Header.Get("Stripe-Version")
            if version == "" {
                version = defaultVersion
            }

            // Set version in context for handlers
            ctx := context.WithValue(r.Context(), "api_version", version)

            // Transform response based on version
            w = &versionedResponseWriter{
                ResponseWriter: w,
                version:        version,
            }

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

**Expandable Resources**

Expandable resources let clients request related objects inline. A `GET /v1/charges/ch_xxx?expand[]=customer` returns the full customer object embedded in the charge response, eliminating the need for a second API call.

```go
// Stripe allows expanding nested resources in a single request
// GET /v1/charges/ch_xxx?expand[]=customer&expand[]=balance_transaction
func (h *ChargeHandler) Get(w http.ResponseWriter, r *http.Request) {
    expands := r.URL.Query()["expand[]"]

    charge, err := h.service.GetCharge(r.Context(), chargeID)
    if err != nil {
        HandleError(w, err)
        return
    }

    // Expand requested resources
    for _, expand := range expands {
        switch expand {
        case "customer":
            charge.Customer, _ = h.customerService.Get(r.Context(), charge.CustomerID)
        case "balance_transaction":
            charge.BalanceTransaction, _ = h.txService.Get(r.Context(), charge.TxID)
        }
    }

    RespondSuccess(w, http.StatusOK, charge)
}
```

### Netflix: Resilient API Gateway (Zuul's Lessons, Translated to Go)

Netflix's Zuul gateway (a Java system, like most of Netflix's application tier) handles enormous request volumes using resilience patterns that prevent cascading failures. The patterns translate to Go directly:

**Circuit Breaker Pattern**

A circuit breaker tracks failures to a downstream service. When failures exceed a threshold, the breaker "opens" and short-circuits requests immediately instead of waiting for timeouts. After a cooldown period, it enters a "half-open" state and lets a few requests through to test recovery.

```go
// Netflix uses Hystrix-style circuit breakers
type CircuitBreaker struct {
    name          string
    maxFailures   int
    timeout       time.Duration
    halfOpenMax   int

    mu            sync.RWMutex
    failures      int
    lastFailure   time.Time
    state         CircuitState
}

type CircuitState int

const (
    StateClosed CircuitState = iota
    StateOpen
    StateHalfOpen
)

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if !cb.allowRequest() {
        return ErrCircuitOpen
    }

    err := fn()
    cb.recordResult(err)
    return err
}

func (cb *CircuitBreaker) allowRequest() bool {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    switch cb.state {
    case StateClosed:
        return true
    case StateOpen:
        if time.Since(cb.lastFailure) > cb.timeout {
            cb.mu.RUnlock()
            cb.mu.Lock()
            cb.state = StateHalfOpen
            cb.mu.Unlock()
            cb.mu.RLock()
            return true
        }
        return false
    case StateHalfOpen:
        return true
    }
    return false
}

// Middleware that wraps downstream calls with circuit breaker
func WithCircuitBreaker(cb *CircuitBreaker, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        err := cb.Execute(func() error {
            rec := httptest.NewRecorder()
            next.ServeHTTP(rec, r)

            if rec.Code >= 500 {
                return fmt.Errorf("upstream error: %d", rec.Code)
            }

            // Copy response
            for k, v := range rec.Header() {
                w.Header()[k] = v
            }
            w.WriteHeader(rec.Code)
            w.Write(rec.Body.Bytes())
            return nil
        })

        if err == ErrCircuitOpen {
            RespondError(w, http.StatusServiceUnavailable, "Service temporarily unavailable")
        }
    })
}
```

**Request Hedging**

Request hedging sends the same request to multiple backends simultaneously and uses whichever response arrives first. This reduces tail latency at the cost of extra load, so it is typically reserved for read-only, latency-sensitive endpoints.

```go
// Netflix hedges requests to reduce tail latency
func (h *APIGateway) HedgedRequest(
    ctx context.Context,
    urls []string,
    timeout time.Duration,
) (*http.Response, error) {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    results := make(chan *http.Response, len(urls))
    errors := make(chan error, len(urls))

    for _, url := range urls {
        go func(url string) {
            req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
            resp, err := h.client.Do(req)
            if err != nil {
                errors <- err
                return
            }
            if resp.StatusCode >= 500 {
                errors <- fmt.Errorf("server error: %d", resp.StatusCode)
                return
            }
            results <- resp
        }(url)
    }

    // Return first successful response
    for i := 0; i < len(urls); i++ {
        select {
        case resp := <-results:
            return resp, nil
        case <-errors:
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    return nil, fmt.Errorf("all requests failed")
}
```

### Uber: High-Throughput API Design

Uber processes millions of API calls per second. Two patterns reduce overhead: request batching to minimize round trips, and adaptive rate limiting that adjusts thresholds based on system load.

**Request Batching**

A batch endpoint accepts an array of operations in a single HTTP request, executes them concurrently on the server, and returns all results at once. This cuts network round trips and amortizes TLS and header overhead across many operations.

```go
// Uber batches multiple operations into single requests
type BatchRequest struct {
    Operations []Operation `json:"operations"`
}

type Operation struct {
    Method   string          `json:"method"`
    Path     string          `json:"path"`
    Body     json.RawMessage `json:"body,omitempty"`
    Headers  map[string]string `json:"headers,omitempty"`
}

type BatchResponse struct {
    Results []OperationResult `json:"results"`
}

type OperationResult struct {
    StatusCode int             `json:"status_code"`
    Body       json.RawMessage `json:"body"`
    Headers    map[string]string `json:"headers,omitempty"`
}

func (h *BatchHandler) Execute(w http.ResponseWriter, r *http.Request) {
    var batch BatchRequest
    if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
        RespondError(w, http.StatusBadRequest, "Invalid batch request")
        return
    }

    if len(batch.Operations) > 100 {
        RespondError(w, http.StatusBadRequest, "Maximum 100 operations per batch")
        return
    }

    results := make([]OperationResult, len(batch.Operations))
    var wg sync.WaitGroup

    for i, op := range batch.Operations {
        wg.Add(1)
        go func(idx int, op Operation) {
            defer wg.Done()
            results[idx] = h.executeOperation(r.Context(), op)
        }(i, op)
    }

    wg.Wait()

    RespondJSON(w, http.StatusOK, BatchResponse{Results: results})
}
```

**Adaptive Rate Limiting**

Instead of fixed rate limits, adaptive rate limiting monitors CPU and memory usage and adjusts the allowed request rate dynamically. Under heavy load it reduces throughput to protect the service. When resources are healthy it scales back up.

```go
// Uber uses adaptive rate limiting based on system load
type AdaptiveRateLimiter struct {
    baseRate    float64
    currentRate float64
    minRate     float64
    maxRate     float64

    cpuThreshold    float64
    memoryThreshold float64

    mu sync.RWMutex
}

func (rl *AdaptiveRateLimiter) Adjust() {
    ticker := time.NewTicker(time.Second)
    for range ticker.C {
        cpuUsage := getCurrentCPUUsage()
        memUsage := getCurrentMemoryUsage()

        rl.mu.Lock()
        if cpuUsage > rl.cpuThreshold || memUsage > rl.memoryThreshold {
            // Reduce rate under load
            rl.currentRate = math.Max(rl.minRate, rl.currentRate*0.9)
        } else if cpuUsage < rl.cpuThreshold*0.7 && memUsage < rl.memoryThreshold*0.7 {
            // Increase rate when system is healthy
            rl.currentRate = math.Min(rl.maxRate, rl.currentRate*1.1)
        }
        rl.mu.Unlock()
    }
}

func (rl *AdaptiveRateLimiter) Allow(key string) bool {
    rl.mu.RLock()
    rate := rl.currentRate
    rl.mu.RUnlock()

    // Use token bucket with current rate
    return rl.buckets[key].AllowN(time.Now(), int(rate))
}
```

### Junior to FAANG: Learning From the Case Studies Before You Need Them

When you read these case studies, do not try to implement every pattern on day one. Learn when each applies. Idempotency keys matter the moment you have any retriable mutation. Versioning matters when you have a public client. Circuit breakers matter when you call any external service that can fail. Request hedging only matters when tail latency is a product-level concern. Batching matters when network round trips dominate. Adaptive rate limiting matters when fixed limits break under variable load.

In interviews, do not parrot "I'd use Hystrix-style circuit breakers." Explain why. "I would wrap the payments-API client in a circuit breaker because a 30-second payments outage should not cascade into a 30-second page-load for our homepage. Breaker opens after 5 percent error rate over 60 seconds, opens for 30 seconds, half-open with 3 probes. Requests during open return a cached last-known price or a graceful error." That answer is worth ten Hystrix name-drops.

Worked example at junior scale. Add idempotency to a single POST endpoint in your own side project. Use Redis `SETNX` with 24-hour TTL. Measure the overhead (sub-millisecond). Notice the resulting retry safety, illustrating why Stripe made this a first-class API primitive.

### Senior at FAANG: Deconstructing Each Pattern as Platform Primitive

Stripe's idempotency key is a full platform primitive, not a handler concern. The canonical implementation. Middleware reads `Idempotency-Key` header. Store `(key, request_fingerprint)` in Redis with 24-hour TTL. On collision with same fingerprint, replay the cached response including status and headers. On collision with different fingerprint, return 422 with a clear code `idempotency_key_conflict`. Stream-safe (do not cache unbounded response bodies, cap at 1 MB). Fingerprint is sha256 of method, path, and normalized body. Publish as `platform/idempotency` and wire into every mutating endpoint by default.

Stripe's versioning strategy is an ADR. Date-based header versioning trades URL-path simplicity for fine-grained per-schema control. Works because Stripe owns the SDK and rolls versions atomically. For orgs without that discipline, URL-path versioning is safer. Document the trade-off. Do not mix strategies within one API surface.

Netflix-style circuit breakers should be platform-default around every outbound HTTP and RPC call. Use `sony/gobreaker` or `failsafe-go`. Configure per-upstream via a central policy file. Metrics per breaker state (closed, open, half-open) with alerts on prolonged open. Pair with bulkheading (cap concurrent calls per upstream with a semaphore) and retry budgets (cap total retries at 10 percent of base RPS to avoid retry storms). These three patterns together (breaker, bulkhead, budget) define the FAANG "resilience triplet."

Netflix-style hedging trade-off. Hedging doubles upstream load for a latency win. Enable only when upstream has idle capacity AND the operation is side-effect free AND latency SLO demands it. Typical usage, image CDN, recommendation fetch, A/B flag lookup. Never enable for writes. Budget the extra load in capacity planning. Measure the tail-latency win with histogram comparison.

Uber's batching pattern caveats. Batch endpoints are DoS amplifiers, one request generates 100 downstream operations. Cap batch size (100 typical), enforce timeout on the whole batch, not each operation (clients expect one response). Per-operation concurrency semaphore to avoid downstream fan-out storms. Batch endpoints are often abused as "one endpoint that does everything" which defeats all caching and monitoring. Governance, batch endpoints only for grouping same-shape operations, never as a meta-API.

Adaptive rate limiting caveats. Simple CPU-threshold-based adaptation creates feedback loops (load drops, rate goes up, load returns, rate drops, oscillation). Use a PID controller or smoothed decay. Measure the actual load source (CPU, goroutine count, DB saturation) and adapt on the binding resource. Publish the adaptive-rate-limit library as platform, forbid custom per-service implementations.

Cross-case ADR. The "resilience stack" FAANG-wide. Every outbound call is wrapped in (timeout, circuit-breaker, bulkhead, retry-with-budget-and-jitter). Every inbound call is wrapped in (rate-limit, idempotency-check-if-mutating, auth, validation). Publish the exact order. Enforce via builder. Teach in onboarding. Do not let teams reinvent.

Tail-latency roadmap. Measure p99, p99.9, p99.99 per endpoint. If p99 is your SLO, do not optimize beyond it (waste). If tail matters (search, real-time), use hedging, load-aware routing, and small-over-large splits (split large responses into chunks to get first-byte faster). Own a "tail-latency reduction program" as a staff-level project per year.

Stripe vs Netflix vs Uber as org mindsets. Stripe, API-first developer experience, slow thoughtful schema evolution, extreme backward compatibility. Netflix, resilience-first consumer service, graceful degradation over failure. Uber, throughput-first operations backend, batching and adaptation. Pick the mindset that matches your product, borrow primitives from the others as needed. The staff skill is knowing which pattern fits which context.

Staff archetype in case-study work. The Patterns Catalog Owner maintains the org handbook of "when to use which pattern" with concrete examples from the org's own services, not blog posts. Reviewed quarterly. One of the most durable pieces of documentation a staff engineer writes.

Multi-year roadmap. Year 1, adopt idempotency, circuit breakers, retry budgets as platform defaults. Year 2, measure tail latency, apply hedging selectively. Year 3, adaptive rate limiting org-wide with smoothed controllers. Year 4, batching for high-volume read APIs, with governance rules to prevent abuse.

---
