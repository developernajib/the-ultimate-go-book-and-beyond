export default `## 11.11 Company Case Studies: Concurrency at Scale

### Google: Concurrency in Infrastructure Services

Google's Go services process billions of requests daily using carefully designed concurrency patterns.

**Context Package Origin**: Google created the \`context\` package to solve cancellation propagation across distributed systems:

\`\`\`go
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
\`\`\`

**Google's Bounded Concurrency Pattern**:

\`\`\`go
// Google uses semaphores for rate limiting expensive operations
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
\`\`\`

### Uber: High-Throughput Service Mesh

Uber's Go microservices handle millions of ride requests with specific concurrency patterns.

**Circuit Breaker with Concurrent Health Checking**:

\`\`\`go
// Uber's circuit breaker pattern for service calls
type CircuitBreaker struct {
    mu          sync.RWMutex
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
\`\`\`

**Uber's Worker Pool for Batch Processing**:

\`\`\`go
// Uber processes ride events in batches for efficiency
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
\`\`\`

### Netflix: Chaos Engineering with Concurrency

Netflix tests distributed systems using concurrent fault injection.

**Concurrent Chaos Testing Pattern**:

\`\`\`go
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
\`\`\`

### Stripe: Financial Transaction Safety

Stripe uses specific patterns to ensure payment processing is safe with concurrent access.

**Idempotent Operations with Concurrent Requests**:

\`\`\`go
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

    // Execute the function
    result.Response, result.Error = fn()
    close(result.InFlight)  // Signal completion

    return result.Response, result.Error
}
\`\`\`

Note: Stripe's real idempotency implementation is distributed, not in-process. The pattern shown is the in-process cousin, useful for coalescing duplicate concurrent requests within a single service instance. The distributed version is essentially the same logic backed by a durable store (Redis, database). The \`singleflight\` pattern from \`golang.org/x/sync/singleflight\` implements exactly this coalescing for in-process deduplication.

### Cloudflare: DNS Resolver Concurrency

Cloudflare's 1.1.1.1 DNS resolver handles millions of concurrent queries. Key patterns:

**Per-query goroutine with strict context budget.** Each incoming DNS query spawns a goroutine with a tight context deadline (often under 100ms). If the upstream resolver does not respond, the context cancels, the goroutine exits, and the query returns SERVFAIL to the client. This hard deadline prevents slow upstreams from pinning goroutines.

**Racing queries for low latency.** For queries that can be sent to multiple upstream resolvers, Cloudflare races them concurrently and uses the first successful response, cancelling the others. The pattern:

\`\`\`go
func raceResolvers(ctx context.Context, query Query, resolvers []Resolver) (Response, error) {
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()
    result := make(chan Response, len(resolvers))
    errCh := make(chan error, len(resolvers))
    for _, r := range resolvers {
        go func(r Resolver) {
            resp, err := r.Resolve(ctx, query)
            if err != nil { errCh <- err; return }
            select {
            case result <- resp:
            case <-ctx.Done():
            }
        }(r)
    }
    select {
    case r := <-result: return r, nil
    case <-ctx.Done(): return Response{}, ctx.Err()
    }
}
\`\`\`

This is the "happy eyeballs" pattern adapted to Go. Trading CPU and network for lower latency. Appropriate at Cloudflare's scale. Overkill for most services.

### Staff Lens: Copy the Pattern, Not the Code

Each of these case studies represents a pattern that works at the specific scale of the specific company. Copying Uber's circuit breaker code into your service is not the lesson. The lesson is the shape: fan-out with context cancellation, idempotency via in-flight deduplication, batching with time-and-size triggers, racing with cancellation. Your service probably does not need any of these exactly. It does need to understand the shapes so when a similar problem arrives you recognise it and apply the right pattern. Every staff-level engineer should be able to sketch each of these patterns from memory and explain when each applies. That recognition is more valuable than any specific code snippet.

### Principal Lens: The Scale-Specific Pattern Trap

Each pattern in this section was designed for a scale threshold. Below that threshold, the pattern is overkill: a circuit breaker for a service that never fails is dead code, idempotency infrastructure for a service that does not have retries is ceremony, batching for low-volume events is latency cost without throughput benefit. The principal-level judgment is knowing when your team's scale is at or near the threshold where a given pattern pays off. Adopting the Netflix-scale pattern at a ten-request-per-second service is a career-shaping anti-pattern. Adopting the ten-request-per-second pattern at a million-request-per-second service is an incident waiting to happen. The pattern must fit the problem. Copying the most famous company's pattern is cargo culting unless your scale matches theirs.

---
`;
