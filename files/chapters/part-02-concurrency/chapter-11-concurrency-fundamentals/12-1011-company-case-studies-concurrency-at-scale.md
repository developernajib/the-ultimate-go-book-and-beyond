## 11.11 Company Case Studies: Concurrency at Scale

### Google: Concurrency in Infrastructure Services

Google's Go services process billions of requests daily using carefully designed concurrency patterns.

**Context Package Origin**: Google created the `context` package to solve cancellation propagation across distributed systems:

```go
// Google's pattern for request-scoped cancellation
func handleRequest(ctx context.Context, req *Request) (*Response, error) {
    // Context flows through all operations
    userData, err := fetchUser(ctx, req.UserID)
    if err != nil {
        return nil, err
    }

    // Parallel operations with shared context
    g, ctx := errgroup.WithContext(ctx)

    var profile *Profile
    var preferences *Preferences

    g.Go(func() error {
        var err error
        profile, err = fetchProfile(ctx, userData.ID)
        return err
    })

    g.Go(func() error {
        var err error
        preferences, err = fetchPreferences(ctx, userData.ID)
        return err
    })

    if err := g.Wait(); err != nil {
        return nil, err  // Any error cancels all operations
    }

    return buildResponse(userData, profile, preferences), nil
}
```

**Bounded Concurrency (the pattern `x/sync/semaphore` codifies)**:

```go
// Semaphores bound concurrency on expensive operations
type RateLimitedClient struct {
    client *http.Client
    sem    *semaphore.Weighted
}

func NewRateLimitedClient(maxConcurrent int64) *RateLimitedClient {
    return &RateLimitedClient{
        client: &http.Client{Timeout: 30 * time.Second},
        sem:    semaphore.NewWeighted(maxConcurrent),
    }
}

func (c *RateLimitedClient) Get(ctx context.Context, url string) (*http.Response, error) {
    if err := c.sem.Acquire(ctx, 1); err != nil {
        return nil, err
    }
    defer c.sem.Release(1)

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    return c.client.Do(req)
}
```

### Uber: High-Throughput Service Mesh

A ride-hailing-scale Go service handles millions of requests with a recognisable set of concurrency patterns. The two below, circuit breaking around downstream calls and size-or-time batching of events, are the ones that show up in almost every such system.

**Circuit Breaker with Concurrent Health Checking**:

The shape below is the standard circuit breaker, not a transcription of any company's internal code. Note the mutex choice in particular. An `RWMutex` looks attractive because `allowRequest` is read-mostly, but the open-to-half-open transition is a *write* discovered during a read, and Go's `RWMutex` has no upgrade operation. Attempting one by unlocking the read lock and grabbing the write lock is a classic bug: the state can change in the gap, and two goroutines can both perform the transition. A plain `Mutex` sidesteps the whole problem, and at the cost of one uncontended lock per call it is not the bottleneck in anything that also makes a network round trip.

```go
type CircuitBreaker struct {
    mu          sync.Mutex
    state       State
    failures    int
    lastFailure time.Time
    threshold   int
    timeout     time.Duration
}

type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func() error) error {
    if !cb.allowRequest() {
        return ErrCircuitOpen
    }

    // Execute with timeout
    done := make(chan error, 1)
    go func() {
        done <- fn()
    }()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case err := <-done:
        cb.recordResult(err)
        return err
    }
}

func (cb *CircuitBreaker) allowRequest() bool {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true
    case StateOpen:
        // The transition is performed under the same lock that observed
        // the condition, so exactly one goroutine can make it.
        if time.Since(cb.lastFailure) > cb.timeout {
            cb.state = StateHalfOpen
            return true
        }
        return false
    case StateHalfOpen:
        return true
    }
    return false
}
```

**A Worker Pool for Batch Event Processing**:

```go
// Processing ride-style events in batches for efficiency
type EventProcessor struct {
    pool       *Pool
    batcher    *Batcher
    metrics    *Metrics
}

type Batcher struct {
    events   chan Event
    batch    []Event
    maxSize  int
    maxWait  time.Duration
    handler  func([]Event) error
}

func (b *Batcher) Start(ctx context.Context) {
    ticker := time.NewTicker(b.maxWait)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            b.flush()
            return
        case event := <-b.events:
            b.batch = append(b.batch, event)
            if len(b.batch) >= b.maxSize {
                b.flush()
            }
        case <-ticker.C:
            if len(b.batch) > 0 {
                b.flush()
            }
        }
    }
}

func (b *Batcher) flush() {
    if len(b.batch) == 0 {
        return
    }

    batch := b.batch
    b.batch = make([]Event, 0, b.maxSize)

    go func() {
        if err := b.handler(batch); err != nil {
            log.Printf("batch processing error: %v", err)
        }
    }()
}
```

### Netflix: Chaos Engineering with Concurrency

Netflix tests distributed systems using concurrent fault injection.

**Concurrent Chaos Testing Pattern**:

```go
// Netflix-style chaos testing with concurrent failures
type ChaosMonkey struct {
    services   []Service
    failRate   float64
    latencyMs  int
    mu         sync.Mutex
    active     bool
}

func (cm *ChaosMonkey) Start(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            cm.injectChaos()
        }
    }
}

func (cm *ChaosMonkey) injectChaos() {
    cm.mu.Lock()
    if !cm.active {
        cm.mu.Unlock()
        return
    }
    cm.mu.Unlock()

    // Randomly select services for chaos
    for _, svc := range cm.services {
        if rand.Float64() < cm.failRate {
            go cm.injectFailure(svc)
        }
    }
}

func (cm *ChaosMonkey) injectFailure(svc Service) {
    failures := []func(Service){
        cm.injectLatency,
        cm.injectError,
        cm.injectResourceExhaustion,
    }

    failure := failures[rand.IntN(len(failures))]
    failure(svc)
}
```

### Stripe: Financial Transaction Safety

Stripe uses specific patterns to ensure payment processing is safe with concurrent access.

**Idempotent Operations with Concurrent Requests**:

```go
// Stripe's idempotency pattern for payment processing
type IdempotencyStore struct {
    mu    sync.RWMutex
    store map[string]*IdempotentResult
    ttl   time.Duration
}

type IdempotentResult struct {
    Response  []byte
    Error     error
    CreatedAt time.Time
    InFlight  chan struct{}
}

func (s *IdempotencyStore) Execute(
    ctx context.Context,
    key string,
    fn func() ([]byte, error),
) ([]byte, error) {
    // Check for existing result
    s.mu.RLock()
    result, exists := s.store[key]
    s.mu.RUnlock()

    if exists {
        // Wait if request is in flight
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-result.InFlight:
            return result.Response, result.Error
        }
    }

    // Create new entry
    s.mu.Lock()
    // Double-check after acquiring write lock
    if result, exists = s.store[key]; exists {
        s.mu.Unlock()
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-result.InFlight:
            return result.Response, result.Error
        }
    }

    result = &IdempotentResult{
        CreatedAt: time.Now(),
        InFlight:  make(chan struct{}),
    }
    s.store[key] = result
    s.mu.Unlock()

    // Execute the function. The close is deferred so that a panic in fn
    // still releases every waiter. Closing only on the success path would
    // leave all coalesced callers blocked on InFlight forever.
    func() {
        defer close(result.InFlight)
        result.Response, result.Error = fn()
    }()

    return result.Response, result.Error
}
```

The synchronisation here is worth reading closely, because it is doing real memory-model work. Waiters block on `<-result.InFlight` and only touch `result.Response` after that receive returns. The close happens-before every receive that observes it, and the writes to `Response` and `Error` happen-before the close, so the waiters are guaranteed to see the completed values. No mutex is held while `fn` runs, which is the entire point: a slow call does not block unrelated keys.

Note: Stripe's real idempotency implementation is distributed, not in-process. The pattern shown is the in-process cousin, useful for coalescing duplicate concurrent requests within a single service instance. The distributed version is essentially the same logic backed by a durable store (Redis, database). The `singleflight` pattern from `golang.org/x/sync/singleflight` implements exactly this coalescing for in-process deduplication.

### DNS Resolver Concurrency at Cloudflare Scale

A DNS resolver serving Cloudflare-scale traffic handles millions of concurrent queries. Cloudflare's 1.1.1.1 data path itself is built on Knot Resolver (C) and Rust, but Go owns much of the DNS world elsewhere: Cloudflare's authoritative RRDNS server is Go, and CoreDNS, the CNCF-graduated resolver that ships as the default DNS server inside Kubernetes, is pure Go and uses exactly the patterns below:

**Per-query goroutine with strict context budget.** Each incoming DNS query spawns a goroutine with a tight context deadline (often under 100ms). If the upstream resolver does not respond, the context cancels, the goroutine exits, and the query returns SERVFAIL to the client. This hard deadline prevents slow upstreams from pinning goroutines.

**Racing queries for low latency.** For queries that can be sent to multiple upstream resolvers, Cloudflare races them concurrently and uses the first successful response, canceling the others. The pattern:

```go
func raceResolvers(ctx context.Context, query Query, resolvers []Resolver) (Response, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel() // Cancels the losers as soon as we return.

    // Both channels are buffered to len(resolvers) so that a goroutine
    // whose result is no longer wanted can always deposit it and exit
    // rather than blocking forever on a send nobody will receive.
    result := make(chan Response, len(resolvers))
    errCh := make(chan error, len(resolvers))

    for _, r := range resolvers {
        go func(r Resolver) {
            resp, err := r.Resolve(ctx, query)
            if err != nil {
                errCh <- err
                return
            }
            result <- resp
        }(r)
    }

    // Take the first success. Count failures so that "every resolver
    // failed" returns immediately with a real error instead of stalling
    // until the context deadline expires.
    var lastErr error
    for i := 0; i < len(resolvers); i++ {
        select {
        case r := <-result:
            return r, nil
        case err := <-errCh:
            lastErr = err
        case <-ctx.Done():
            return Response{}, ctx.Err()
        }
    }
    return Response{}, lastErr
}
```

Because both channels are buffered to the number of resolvers, no goroutine can leak: a loser always completes its send and exits even after the winner has returned. Draining in a loop rather than a bare `select` is what makes the all-failed case fast. The original mistake to avoid is sending errors to a channel nothing ever reads, which turns "all upstreams are down" into a full-deadline stall on every query.

This is a hedged request, the same idea as Happy Eyeballs applied to resolvers rather than to IPv4/IPv6 dual-stack. It trades CPU and network for lower tail latency, which is a good trade at Cloudflare's scale and usually a poor one below it.

### Staff Lens: Copy the Pattern, Not the Code

Each of these case studies represents a pattern that works at the specific scale of the specific company. Copying Uber's circuit breaker code into your service is not the lesson. The lesson is the shape: fan-out with context cancellation, idempotency via in-flight deduplication, batching with time-and-size triggers, racing with cancellation. Your service probably does not need any of these exactly. It does need to understand the shapes so when a similar problem arrives you recognize it and apply the right pattern. Every staff-level engineer should be able to sketch each of these patterns from memory and explain when each applies. That recognition is more valuable than any specific code snippet.

### Principal Lens: The Scale-Specific Pattern Trap

Each pattern in this section was designed for a scale threshold. Below that threshold, the pattern is overkill: a circuit breaker for a service that never fails is dead code, idempotency infrastructure for a service that does not have retries is ceremony, batching for low-volume events is latency cost without throughput benefit. The principal-level judgment is knowing when your team's scale is at or near the threshold where a given pattern pays off. Adopting the Netflix-scale pattern at a ten-request-per-second service is a career-shaping anti-pattern. Adopting the ten-request-per-second pattern at a million-request-per-second service is an incident waiting to happen. The pattern must fit the problem. Copying the most famous company's pattern is cargo culting unless your scale matches theirs.

---
