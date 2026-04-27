export default `## 12.6 Rate Limiting Pattern

Control the rate of operations to prevent overload.

### Token Bucket Rate Limiter

The token bucket algorithm allows short bursts up to the bucket's capacity, then enforces the steady-state rate as tokens refill. Implementing it with a buffered channel makes \`Acquire\` a channel receive, naturally blocking when the bucket is empty, while a background goroutine refills tokens at the configured interval. Stopping the refiller via context cancellation prevents the goroutine from leaking after the limiter is no longer needed.

\`\`\`go
// TokenBucket implements the token bucket algorithm
type TokenBucket struct {
    tokens     chan struct{}
    capacity   int
    refillRate time.Duration
    ctx        context.Context
    cancel     context.CancelFunc
}

func NewTokenBucket(capacity int, refillRate time.Duration) *TokenBucket {
    ctx, cancel := context.WithCancel(context.Background())

    tb := &TokenBucket{
        tokens:     make(chan struct{}, capacity),
        capacity:   capacity,
        refillRate: refillRate,
        ctx:        ctx,
        cancel:     cancel,
    }

    // Fill initial tokens
    for i := 0; i < capacity; i++ {
        tb.tokens <- struct{}{}
    }

    // Start refill goroutine
    go tb.refill()

    return tb
}

func (tb *TokenBucket) refill() {
    ticker := time.NewTicker(tb.refillRate)
    defer ticker.Stop()

    for {
        select {
        case <-tb.ctx.Done():
            return
        case <-ticker.C:
            select {
            case tb.tokens <- struct{}{}:
            default:
                // Bucket full
            }
        }
    }
}

// Wait blocks until a token is available
func (tb *TokenBucket) Wait(ctx context.Context) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-tb.ctx.Done():
        return errors.New("rate limiter closed")
    case <-tb.tokens:
        return nil
    }
}

// TryAcquire returns immediately with success/failure
func (tb *TokenBucket) TryAcquire() bool {
    select {
    case <-tb.tokens:
        return true
    default:
        return false
    }
}

// Close stops the rate limiter
func (tb *TokenBucket) Close() {
    tb.cancel()
}
\`\`\`

### Sliding Window Rate Limiter

The token bucket algorithm allows bursts up to the bucket capacity, which may not be acceptable for APIs where you need a strict "N requests per window" guarantee. A sliding window limiter tracks the timestamp of each request and counts how many fall within the most recent window. This gives precise rate enforcement at the cost of storing individual timestamps. The implementation below uses a mutex-protected slice, pruning expired entries on each \`Allow\` call.

\`\`\`go
// SlidingWindowLimiter uses a sliding window for rate limiting
type SlidingWindowLimiter struct {
    mu          sync.Mutex
    requests    []time.Time
    limit       int
    window      time.Duration
}

func NewSlidingWindowLimiter(limit int, window time.Duration) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        requests: make([]time.Time, 0, limit),
        limit:    limit,
        window:   window,
    }
}

func (swl *SlidingWindowLimiter) Allow() bool {
    swl.mu.Lock()
    defer swl.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-swl.window)

    // Remove expired entries
    valid := swl.requests[:0]
    for _, t := range swl.requests {
        if t.After(windowStart) {
            valid = append(valid, t)
        }
    }
    swl.requests = valid

    // Check limit
    if len(swl.requests) >= swl.limit {
        return false
    }

    // Add new request
    swl.requests = append(swl.requests, now)
    return true
}

func (swl *SlidingWindowLimiter) Wait(ctx context.Context) error {
    for {
        if swl.Allow() {
            return nil
        }

        // Calculate wait time
        swl.mu.Lock()
        var waitDuration time.Duration
        if len(swl.requests) > 0 {
            oldest := swl.requests[0]
            waitDuration = oldest.Add(swl.window).Sub(time.Now())
            if waitDuration < 0 {
                waitDuration = time.Millisecond
            }
        } else {
            waitDuration = time.Millisecond
        }
        swl.mu.Unlock()

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(waitDuration):
        }
    }
}
\`\`\`

### Per-Key Rate Limiter

A global rate limiter treats all callers as one pool, so a single heavy user can exhaust the budget for everyone. Per-key limiting creates an independent \`SlidingWindowLimiter\` for each key (user ID, IP address, API key), isolating callers from each other. The implementation uses a double-checked locking pattern for efficient map access, and a background cleanup goroutine periodically removes limiters whose request slices are empty, preventing unbounded memory growth as keys come and go.

\`\`\`go
// PerKeyLimiter provides per-key rate limiting
type PerKeyLimiter struct {
    mu       sync.RWMutex
    limiters map[string]*SlidingWindowLimiter
    limit    int
    window   time.Duration
    cleanup  time.Duration
}

func NewPerKeyLimiter(limit int, window, cleanup time.Duration) *PerKeyLimiter {
    pkl := &PerKeyLimiter{
        limiters: make(map[string]*SlidingWindowLimiter),
        limit:    limit,
        window:   window,
        cleanup:  cleanup,
    }

    // Start cleanup goroutine
    go pkl.cleanupLoop()

    return pkl
}

func (pkl *PerKeyLimiter) getLimiter(key string) *SlidingWindowLimiter {
    pkl.mu.RLock()
    limiter, exists := pkl.limiters[key]
    pkl.mu.RUnlock()

    if exists {
        return limiter
    }

    pkl.mu.Lock()
    defer pkl.mu.Unlock()

    // Double-check after acquiring write lock
    if limiter, exists = pkl.limiters[key]; exists {
        return limiter
    }

    limiter = NewSlidingWindowLimiter(pkl.limit, pkl.window)
    pkl.limiters[key] = limiter
    return limiter
}

func (pkl *PerKeyLimiter) Allow(key string) bool {
    return pkl.getLimiter(key).Allow()
}

func (pkl *PerKeyLimiter) Wait(ctx context.Context, key string) error {
    return pkl.getLimiter(key).Wait(ctx)
}

func (pkl *PerKeyLimiter) cleanupLoop() {
    ticker := time.NewTicker(pkl.cleanup)
    defer ticker.Stop()

    for range ticker.C {
        pkl.mu.Lock()
        for key, limiter := range pkl.limiters {
            limiter.mu.Lock()
            if len(limiter.requests) == 0 {
                delete(pkl.limiters, key)
            }
            limiter.mu.Unlock()
        }
        pkl.mu.Unlock()
    }
}
\`\`\`

### Use \`golang.org/x/time/rate\` for Production

The hand-rolled limiters above are teaching material. Production Go services use \`golang.org/x/time/rate.Limiter\`. It provides:

- Correct token-bucket semantics with burst handling.
- \`Wait(ctx)\` that blocks until a token is available or the context cancels.
- \`Allow()\` for non-blocking checks.
- \`Reserve(n)\` for bulk requests.
- \`SetLimit\` and \`SetBurst\` for dynamic reconfiguration.

A per-service or per-user rate limiter in production is almost always backed by this primitive. Hand-rolling is a red flag in review.

### In-Process Limiter vs Distributed Limiter

An in-process rate limiter protects the local service. A distributed rate limiter (e.g., Redis-backed) protects a shared downstream across many service instances. The difference matters:

- If the goal is to protect the current process from overload, in-process is fine.
- If the goal is to honour a rate limit imposed by a downstream (e.g., third-party API allows 1000 QPS total across all callers), in-process is insufficient because every service instance would each limit to 1000 QPS locally, summing to catastrophe.

Choose the right scope. For downstream rate limits, use a distributed limiter (Redis + Lua script, or a managed service like \`golang.org/x/time/rate\` with a coordinator). For local process protection, in-process is correct.

### Staff Lens: Rate Limits as Contracts

Rate limits in production are contracts, not optimizations. The rate limit your service imposes on clients is an SLA. The rate limit a downstream imposes on you is a constraint you must honour. The staff-level design discipline: document the rate limits explicitly, expose them in the service catalog, monitor adherence to them, alert on violations. A service that sometimes rate-limits and sometimes does not is unpredictable. A service that rate-limits consistently and communicates the limits to clients is operational.

### Principal Lens: Back-Pressure Beyond Rate Limiting

Rate limiting is one of several back-pressure mechanisms. Others: adaptive concurrency control (AIMD, like TCP congestion control), load shedding (drop requests based on CPU or latency signals), request prioritisation (drop low-priority requests first under load). A principal engineer designing for scale thinks about all of these, not just rate limiting. The right mix depends on traffic patterns, SLO structure, and cost of each request. At minimum, every production service should have rate limiting at the edge, request timeouts throughout, and load shedding at the overload threshold. Without all three, the service has no answer to overload except to crash.

---
`;
