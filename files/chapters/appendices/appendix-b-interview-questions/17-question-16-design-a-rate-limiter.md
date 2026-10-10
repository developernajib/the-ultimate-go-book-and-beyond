## Question 16: Design a Rate Limiter

**Level**: Senior-Staff

**Question**: Design a rate limiter that allows N requests per second. Implement token bucket algorithm.

**Answer**:

```go
type RateLimiter struct {
    tokens     int
    maxTokens  int
    refillRate int           // tokens per second
    lastRefill time.Time
    mu         sync.Mutex
}

func NewRateLimiter(maxTokens, refillRate int) *RateLimiter {
    return &RateLimiter{
        tokens:     maxTokens,
        maxTokens:  maxTokens,
        refillRate: refillRate,
        lastRefill: time.Now(),
    }
}

func (rl *RateLimiter) Allow() bool {
    rl.mu.Lock()
    defer rl.mu.Unlock()

    // Refill tokens based on time elapsed
    now := time.Now()
    elapsed := now.Sub(rl.lastRefill)
    tokensToAdd := int(elapsed.Seconds() * float64(rl.refillRate))

    if tokensToAdd > 0 {
        rl.tokens = min(rl.tokens+tokensToAdd, rl.maxTokens)
        rl.lastRefill = now
    }

    if rl.tokens > 0 {
        rl.tokens--
        return true
    }

    return false
}

// HTTP middleware
func rateLimitMiddleware(limiter *RateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow() {
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

**Follow-up**: Implement per-user rate limiting using sync.Map:

```go
type PerUserRateLimiter struct {
    limiters sync.Map  // map[string]*RateLimiter
    maxTokens int
    refillRate int
}

func (purl *PerUserRateLimiter) Allow(userID string) bool {
    limiter, _ := purl.limiters.LoadOrStore(userID, NewRateLimiter(purl.maxTokens, purl.refillRate))
    return limiter.(*RateLimiter).Allow()
}
```

**Companies that asked this**: Google, Uber, Stripe, Cloudflare, Netflix

---

## Debugging Scenarios
