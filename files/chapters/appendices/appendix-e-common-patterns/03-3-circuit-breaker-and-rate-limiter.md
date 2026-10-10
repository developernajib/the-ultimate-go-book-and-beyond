## 3. Circuit Breaker and Rate Limiter

These patterns protect services from cascading failures and resource exhaustion.

### Circuit Breaker

A circuit breaker tracks failures to a downstream service. After a threshold of consecutive failures, it "opens" and short-circuits requests for a cooldown period. This prevents a failing dependency from consuming your resources.

```go
package circuitbreaker

import (
    "errors"
    "sync"
    "time"
)

var (
    ErrCircuitOpen     = errors.New("circuit breaker is open")
    ErrTooManyRequests = errors.New("too many requests")
)

// State represents circuit breaker state
type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
    maxFailures  uint32
    resetTimeout time.Duration

    mu            sync.RWMutex
    state         State
    failures      uint32
    lastFailTime  time.Time
    lastStateTime time.Time
}

// NewCircuitBreaker creates a circuit breaker
func NewCircuitBreaker(maxFailures uint32, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        maxFailures:   maxFailures,
        resetTimeout:  resetTimeout,
        state:         StateClosed,
        lastStateTime: time.Now(),
    }
}

// Execute runs the function if the circuit allows it
func (cb *CircuitBreaker) Execute(fn func() error) error {
    if err := cb.beforeRequest(); err != nil {
        return err
    }

    err := fn()
    cb.afterRequest(err)
    return err
}

// beforeRequest checks if request should proceed
func (cb *CircuitBreaker) beforeRequest() error {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    now := time.Now()

    switch cb.state {
    case StateOpen:
        if now.Sub(cb.lastStateTime) > cb.resetTimeout {
            // Transition to half-open
            cb.state = StateHalfOpen
            cb.lastStateTime = now
            return nil
        }
        return ErrCircuitOpen

    case StateHalfOpen:
        // Allow one request in half-open state
        return nil

    case StateClosed:
        return nil

    default:
        return ErrCircuitOpen
    }
}

// afterRequest updates circuit state based on result
func (cb *CircuitBreaker) afterRequest(err error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    now := time.Now()

    if err != nil {
        cb.failures++
        cb.lastFailTime = now

        if cb.state == StateHalfOpen {
            // Failed in half-open, back to open
            cb.state = StateOpen
            cb.lastStateTime = now
        } else if cb.failures >= cb.maxFailures {
            // Too many failures, open the circuit
            cb.state = StateOpen
            cb.lastStateTime = now
        }
    } else {
        // Success
        if cb.state == StateHalfOpen {
            // Success in half-open, close the circuit
            cb.state = StateClosed
            cb.failures = 0
            cb.lastStateTime = now
        } else if cb.state == StateClosed {
            cb.failures = 0
        }
    }
}

// State returns current state
func (cb *CircuitBreaker) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}

// Reset resets the circuit breaker
func (cb *CircuitBreaker) Reset() {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    cb.state = StateClosed
    cb.failures = 0
    cb.lastStateTime = time.Now()
}
```

### Rate Limiter (Token Bucket)

```go
package ratelimiter

import (
    "context"
    "sync"
    "time"
)

// TokenBucket implements a token bucket rate limiter
type TokenBucket struct {
    capacity    int64
    refillRate  int64         // tokens per second
    tokens      int64
    lastRefill  time.Time
    mu          sync.Mutex
}

// NewTokenBucket creates a token bucket rate limiter
func NewTokenBucket(capacity, refillRate int64) *TokenBucket {
    return &TokenBucket{
        capacity:   capacity,
        refillRate: refillRate,
        tokens:     capacity,
        lastRefill: time.Now(),
    }
}

// Allow checks if a request is allowed
func (tb *TokenBucket) Allow() bool {
    return tb.AllowN(1)
}

// AllowN checks if n tokens are available
func (tb *TokenBucket) AllowN(n int64) bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    tb.refill()

    if tb.tokens >= n {
        tb.tokens -= n
        return true
    }
    return false
}

// Wait blocks until a token is available or context is done
func (tb *TokenBucket) Wait(ctx context.Context) error {
    return tb.WaitN(ctx, 1)
}

// WaitN blocks until n tokens are available
func (tb *TokenBucket) WaitN(ctx context.Context, n int64) error {
    for {
        if tb.AllowN(n) {
            return nil
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(10 * time.Millisecond):
            // Continue checking
        }
    }
}

// refill adds tokens based on elapsed time
func (tb *TokenBucket) refill() {
    now := time.Now()
    elapsed := now.Sub(tb.lastRefill)

    tokensToAdd := int64(elapsed.Seconds() * float64(tb.refillRate))
    if tokensToAdd > 0 {
        tb.tokens += tokensToAdd
        if tb.tokens > tb.capacity {
            tb.tokens = tb.capacity
        }
        tb.lastRefill = now
    }
}

// Available returns current token count
func (tb *TokenBucket) Available() int64 {
    tb.mu.Lock()
    defer tb.mu.Unlock()
    tb.refill()
    return tb.tokens
}
```

### Rate Limiter (Sliding Window)

```go
package ratelimiter

import (
    "sync"
    "time"
)

// SlidingWindow implements sliding window rate limiting
type SlidingWindow struct {
    limit      int
    window     time.Duration
    requests   []time.Time
    mu         sync.Mutex
}

// NewSlidingWindow creates a sliding window rate limiter
func NewSlidingWindow(limit int, window time.Duration) *SlidingWindow {
    return &SlidingWindow{
        limit:    limit,
        window:   window,
        requests: make([]time.Time, 0, limit),
    }
}

// Allow checks if request is allowed
func (sw *SlidingWindow) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-sw.window)

    // Remove old requests
    valid := 0
    for _, reqTime := range sw.requests {
        if reqTime.After(cutoff) {
            sw.requests[valid] = reqTime
            valid++
        }
    }
    sw.requests = sw.requests[:valid]

    // Check if under limit
    if len(sw.requests) < sw.limit {
        sw.requests = append(sw.requests, now)
        return true
    }

    return false
}

// Count returns current request count in window
func (sw *SlidingWindow) Count() int {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-sw.window)

    count := 0
    for _, reqTime := range sw.requests {
        if reqTime.After(cutoff) {
            count++
        }
    }

    return count
}
```

---
