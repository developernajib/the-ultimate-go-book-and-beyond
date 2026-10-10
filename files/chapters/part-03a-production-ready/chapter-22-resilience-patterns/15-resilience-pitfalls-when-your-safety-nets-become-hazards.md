## Resilience Pitfalls: When Your Safety Nets Become Hazards

This section covers the most dangerous resilience pattern mistakes that make systems less reliable instead of more.

### The Retry Storm

**The Incident**: A database hiccup triggered retries from 1000 servers. Each retry multiplied by 3 attempts. The database received 3000x normal load and crashed completely.

```go
// WRONG: Aggressive retries without backoff

func getUser(id string) (*User, error) {
    for i := 0; i < 3; i++ {
        user, err := db.GetUser(id)
        if err == nil {
            return user, nil
        }
        // 🚨 Immediate retry - amplifies load on struggling service
        log.Printf("Retry %d: %v", i, err)
    }
    return nil, errors.New("all retries failed")
}

// 1000 servers × 3 retries × 100 req/sec = 300,000 req/sec to dying DB
```

Adding exponential backoff with full jitter spreads retry attempts over progressively longer windows, giving the database time to recover between waves. The `isRetryable` check prevents wasting attempts on permanent errors like constraint violations:

```go
// CORRECT: Exponential backoff with FULL jitter, and cancellable.

func getUser(ctx context.Context, id string) (*User, error) {
    // ceiling grows exponentially. The actual sleep is drawn from it.
    ceiling := 100 * time.Millisecond
    var lastErr error

    for attempt := 0; attempt < 3; attempt++ {
        user, err := db.GetUserContext(ctx, id)
        if err == nil {
            return user, nil
        }
        lastErr = err

        if !isRetryable(err) {
            return nil, err // Don't retry non-transient errors
        }

        if attempt == 2 {
            break // no sleep after the final attempt
        }

        // Full jitter: random(0, ceiling), NOT ceiling + random(...).
        // The additive form only ever lengthens the wait and leaves every
        // client bunched just above the same instant.
        sleep := time.Duration(rand.Int64N(int64(ceiling)))
        log.Printf("Retry %d in %v: %v", attempt, sleep, err)

        // time.Sleep is not cancellable. If the caller has already given up,
        // sleeping here burns a goroutine to produce a result nobody wants.
        select {
        case <-ctx.Done():
            return nil, errors.Join(lastErr, ctx.Err())
        case <-time.After(sleep):
        }

        ceiling *= 2 // 100ms -> 200ms -> 400ms
    }
    return nil, lastErr
}

func isRetryable(err error) bool {
    // Only retry transient errors
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout() // Temporary() is deprecated since Go 1.18
    }
    return false  // Don't retry business logic errors
}
```

### The Timeout That Wasn't

**The Problem**: You set timeouts but they don't actually work because the underlying operation doesn't respect context cancellation.

```go
// WRONG: Timeout that doesn't actually cancel

func fetchData(ctx context.Context) ([]byte, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // 🚨 http.Get doesn't use context!
    resp, err := http.Get("http://slow-service/data")
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)  // Can still hang here
}
```

The fix uses `http.NewRequestWithContext` so the context deadline propagates into the HTTP transport, and configures per-phase timeouts (dial, TLS handshake, response header) so no single phase can silently consume the entire budget. An `io.LimitReader` on the response body prevents a malicious or misconfigured upstream from sending unbounded data:

```go
// CORRECT: Timeouts that actually work

func fetchData(ctx context.Context) ([]byte, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    // Use http.NewRequestWithContext
    req, err := http.NewRequestWithContext(ctx, "GET", "http://slow-service/data", nil)
    if err != nil {
        return nil, err
    }

    // Use client with timeouts at every level
    client := &http.Client{
        Timeout: 6 * time.Second,  // Overall timeout
        Transport: &http.Transport{
            DialContext: (&net.Dialer{
                Timeout:   2 * time.Second,  // Connection timeout
                KeepAlive: 30 * time.Second,
            }).DialContext,
            TLSHandshakeTimeout:   2 * time.Second,
            ResponseHeaderTimeout: 3 * time.Second,
            ExpectContinueTimeout: 1 * time.Second,
        },
    }

    resp, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // Limited read with context
    return io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))  // Max 10MB
}
```

### The Circuit Breaker That Never Opens

**The Bug**: Circuit breaker only counts errors, but most failures are timeouts that return without error.

```go
// WRONG: Circuit breaker ignores slow calls

type BrokenCircuitBreaker struct {
    failures int
    threshold int
}

func (cb *BrokenCircuitBreaker) Execute(fn func() error) error {
    if cb.failures >= cb.threshold {
        return ErrCircuitOpen
    }

    err := fn()
    if err != nil {
        cb.failures++  // 🚨 Only counts errors
    }
    return err
}

// Problem: Slow calls (5+ seconds) don't return errors
// They return valid responses after the timeout
// Circuit never opens, system keeps timing out
```

The corrected version records both errors and latency, treating any call that exceeds `slowThreshold` as a failure for circuit-tripping purposes. This catches the common scenario where an overloaded upstream returns valid but extremely late responses:

```go
// CORRECT: Circuit breaker counts slow calls as failures

type CircuitBreaker struct {
    mu              sync.Mutex
    failures        int
    successes       int
    state           State
    threshold       int
    slowThreshold   time.Duration
    halfOpenLimit   int
    lastStateChange time.Time
    cooldown        time.Duration
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if !cb.allowRequest() {
        return ErrCircuitOpen
    }

    start := time.Now()
    err := fn()
    duration := time.Since(start)

    cb.recordResult(err, duration)
    return err
}

func (cb *CircuitBreaker) recordResult(err error, duration time.Duration) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    // Count BOTH errors AND slow calls as failures
    if err != nil || duration > cb.slowThreshold {
        cb.failures++
        cb.successes = 0

        if cb.failures >= cb.threshold {
            cb.state = StateOpen
            cb.lastStateChange = time.Now()
        }
    } else {
        cb.successes++
        if cb.state == StateHalfOpen && cb.successes >= cb.halfOpenLimit {
            cb.state = StateClosed
            cb.failures = 0
        }
    }
}
```

### The Fallback Cascade

**The Disaster**: Primary fails → fallback fails → fallback's fallback fails → catastrophic failure.

```go
// WRONG: Nested fallbacks without limits

func getData() ([]byte, error) {
    // Try primary
    data, err := primaryDB.Get()
    if err == nil {
        return data, nil
    }

    // Fallback to replica
    data, err = replicaDB.Get()  // 🚨 If primary is down, replica likely is too
    if err == nil {
        return data, nil
    }

    // Fallback to cache
    data, err = cache.Get()  // 🚨 Cache might be overwhelmed
    if err == nil {
        return data, nil
    }

    // Fallback to static defaults
    return staticDefaults, nil
}

// Problem: Each fallback adds latency
// Thundering herd hits every fallback in sequence
// Total latency: sum of all timeouts
```

Instead of trying each fallback in sequence, where total latency is the sum of all individual timeouts, launch fallback sources in parallel and return the first success. The static default serves as a guaranteed last resort that never blocks on I/O:

```go
// CORRECT: Parallel fallbacks with fast failure

func getData(ctx context.Context) ([]byte, error) {
    // Try primary with short timeout
    primaryCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    data, err := primaryDB.Get(primaryCtx)
    if err == nil {
        return data, nil
    }

    // On primary failure, try fallbacks in parallel
    type result struct {
        data []byte
        err  error
        source string
    }
    results := make(chan result, 2)

    go func() {
        d, e := replicaDB.Get(ctx)
        results <- result{d, e, "replica"}
    }()

    go func() {
        d, e := cache.Get(ctx)
        results <- result{d, e, "cache"}
    }()

    // Return first success
    for i := 0; i < 2; i++ {
        select {
        case r := <-results:
            if r.err == nil {
                log.Printf("Served from fallback: %s", r.source)
                return r.data, nil
            }
        case <-ctx.Done():
            return staticDefaults, ctx.Err()
        }
    }

    // All fallbacks failed - return static
    log.Printf("All sources failed, using static defaults")
    return staticDefaults, nil
}
```

### The Rate Limiter That Blocked Everyone

**The Incident**: Global rate limiter of 1000 req/sec. One misbehaving client consumed 999 req/sec. All other users got 1 req/sec combined.

```go
// WRONG: Global rate limit

var globalLimiter = rate.NewLimiter(1000, 100)

func handleRequest(w http.ResponseWriter, r *http.Request) {
    if !globalLimiter.Allow() {
        http.Error(w, "Rate limited", 429)
        return
    }
    // 🚨 One bad actor can exhaust entire limit
    processRequest(w, r)
}
```

A multi-level limiter applies a global cap first, then enforces a per-client cap so no single caller can monopolise the total budget. Each client gets its own token bucket, created lazily on first request:

```go
// CORRECT: Per-client + global limits

type MultiLevelLimiter struct {
    global     *rate.Limiter
    perClient  map[string]*rate.Limiter
    mu         sync.RWMutex
    clientRate rate.Limit
    clientBurst int
}

func (l *MultiLevelLimiter) Allow(clientID string) bool {
    // Check global limit first
    if !l.global.Allow() {
        return false
    }

    // Check per-client limit
    l.mu.RLock()
    limiter, exists := l.perClient[clientID]
    l.mu.RUnlock()

    if !exists {
        l.mu.Lock()
        limiter = rate.NewLimiter(l.clientRate, l.clientBurst)
        l.perClient[clientID] = limiter
        l.mu.Unlock()
    }

    return limiter.Allow()
}

func handleRequest(w http.ResponseWriter, r *http.Request) {
    clientID := extractClientID(r)

    if !multiLimiter.Allow(clientID) {
        w.Header().Set("Retry-After", "1")
        http.Error(w, "Rate limited", 429)
        return
    }
    processRequest(w, r)
}
```

### Quick Reference: Resilience Anti-Patterns

| Anti-Pattern | Impact | Fix |
|--------------|--------|-----|
| Immediate retries | Retry storm, amplified failures | Exponential backoff + jitter |
| Context-less timeouts | Operations hang forever | Use context at every layer |
| Error-only circuit breaker | Never opens on slow calls | Count slow calls as failures |
| Nested fallbacks | Latency cascade | Parallel fallbacks, static default |
| Global rate limiting | Bad actor blocks everyone | Per-client limits |
| No bulkheads | One failure cascades | Isolate by criticality |

### Staff Lens: Resilience Is Tested by Chaos

Periodically simulate failures in staging: kill a downstream, inject latency, fail DNS. Verify the service responds as designed. Resilience untested is resilience unvalidated.

---
