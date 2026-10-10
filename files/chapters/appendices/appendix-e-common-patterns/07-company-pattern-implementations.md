## Company Pattern Implementations

### Google's Functional Options Pattern

**From Google Cloud Go Libraries:**

```go
// Google Cloud's functional options pattern (from google-cloud-go)
package storage

import (
    "context"
    "time"

    "google.golang.org/api/option"
)

// ClientOption configures a Client
type ClientOption interface {
    apply(*clientConfig)
}

type clientConfig struct {
    endpoint        string
    credentials     []byte
    scopes          []string
    userAgent       string
    timeout         time.Duration
    retryConfig     *retryConfig
    enableTracing   bool
}

// funcOption wraps a function as a ClientOption
type funcOption struct {
    f func(*clientConfig)
}

func (fo *funcOption) apply(cfg *clientConfig) {
    fo.f(cfg)
}

// WithEndpoint configures custom endpoint
func WithEndpoint(endpoint string) ClientOption {
    return &funcOption{func(cfg *clientConfig) {
        cfg.endpoint = endpoint
    }}
}

// WithTimeout configures request timeout
func WithTimeout(timeout time.Duration) ClientOption {
    return &funcOption{func(cfg *clientConfig) {
        cfg.timeout = timeout
    }}
}

// WithRetry configures retry behavior
func WithRetry(maxRetries int, backoff time.Duration) ClientOption {
    return &funcOption{func(cfg *clientConfig) {
        cfg.retryConfig = &retryConfig{
            maxRetries:     maxRetries,
            initialBackoff: backoff,
        }
    }}
}

// NewClient creates a storage client with options
func NewClient(ctx context.Context, opts ...ClientOption) (*Client, error) {
    cfg := &clientConfig{
        endpoint: "storage.googleapis.com",
        timeout:  30 * time.Second,
    }

    for _, opt := range opts {
        opt.apply(cfg)
    }

    // Build client with config
    return &Client{config: cfg}, nil
}
```

### Uber's Worker Pool Pattern

**High-Performance Worker Pools:**

```go
// Uber's approach to worker pools (from internal services)
package workerpool

import (
    "context"
    "sync"
    "sync/atomic"
    "time"

    "go.uber.org/zap"
)

// Pool manages a fixed pool of workers
type Pool struct {
    workers    int
    taskQueue  chan Task
    wg         sync.WaitGroup
    ctx        context.Context
    cancel     context.CancelFunc
    logger     *zap.Logger
    metrics    *Metrics
    inFlight   int64
}

type Task interface {
    Execute(ctx context.Context) error
}

type Metrics struct {
    Submitted   int64
    Completed   int64
    Failed      int64
    Latency     *HistogramVec
}

// NewPool creates a worker pool with instrumentation
func NewPool(workers, queueSize int, logger *zap.Logger) *Pool {
    ctx, cancel := context.WithCancel(context.Background())

    p := &Pool{
        workers:   workers,
        taskQueue: make(chan Task, queueSize),
        ctx:       ctx,
        cancel:    cancel,
        logger:    logger,
        metrics:   &Metrics{},
    }

    // Start workers
    for i := 0; i < workers; i++ {
        p.wg.Add(1)
        go p.worker(i)
    }

    return p
}

func (p *Pool) worker(id int) {
    defer p.wg.Done()

    for {
        select {
        case <-p.ctx.Done():
            return
        case task, ok := <-p.taskQueue:
            if !ok {
                return
            }

            atomic.AddInt64(&p.inFlight, 1)
            start := time.Now()

            if err := task.Execute(p.ctx); err != nil {
                atomic.AddInt64(&p.metrics.Failed, 1)
                p.logger.Error("task failed",
                    zap.Int("worker", id),
                    zap.Error(err),
                )
            } else {
                atomic.AddInt64(&p.metrics.Completed, 1)
            }

            atomic.AddInt64(&p.inFlight, -1)
            p.metrics.Latency.Observe(time.Since(start).Seconds())
        }
    }
}

// Submit adds a task to the pool
func (p *Pool) Submit(task Task) error {
    select {
    case p.taskQueue <- task:
        atomic.AddInt64(&p.metrics.Submitted, 1)
        return nil
    case <-p.ctx.Done():
        return p.ctx.Err()
    }
}

// Shutdown gracefully stops the pool
func (p *Pool) Shutdown(timeout time.Duration) error {
    p.cancel()
    close(p.taskQueue)

    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return ErrShutdownTimeout
    }
}
```

### Netflix's Circuit Breaker Pattern

**Production Circuit Breaker:**

```go
// Netflix Hystrix-inspired circuit breaker for Go
package circuitbreaker

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"
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
    name        string
    state       int32
    failures    int64
    successes   int64
    lastFailure time.Time
    mu          sync.RWMutex

    // Configuration
    failureThreshold int64
    successThreshold int64
    timeout          time.Duration
    onStateChange    func(name string, from, to State)
}

type Config struct {
    Name             string
    FailureThreshold int64
    SuccessThreshold int64
    Timeout          time.Duration
    OnStateChange    func(name string, from, to State)
}

// New creates a circuit breaker with configuration
func New(cfg Config) *CircuitBreaker {
    return &CircuitBreaker{
        name:             cfg.Name,
        failureThreshold: cfg.FailureThreshold,
        successThreshold: cfg.SuccessThreshold,
        timeout:          cfg.Timeout,
        onStateChange:    cfg.OnStateChange,
    }
}

// Execute runs a function with circuit breaker protection
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
    if !cb.allowRequest() {
        return ErrCircuitOpen
    }

    // Execute with timeout
    done := make(chan error, 1)
    go func() {
        done <- fn(ctx)
    }()

    select {
    case err := <-done:
        cb.recordResult(err)
        return err
    case <-ctx.Done():
        cb.recordResult(ctx.Err())
        return ctx.Err()
    }
}

func (cb *CircuitBreaker) allowRequest() bool {
    state := State(atomic.LoadInt32(&cb.state))

    switch state {
    case StateClosed:
        return true
    case StateOpen:
        cb.mu.RLock()
        shouldTry := time.Since(cb.lastFailure) > cb.timeout
        cb.mu.RUnlock()

        if shouldTry {
            cb.transitionTo(StateHalfOpen)
            return true
        }
        return false
    case StateHalfOpen:
        return true
    default:
        return false
    }
}

func (cb *CircuitBreaker) recordResult(err error) {
    state := State(atomic.LoadInt32(&cb.state))

    if err != nil {
        failures := atomic.AddInt64(&cb.failures, 1)
        atomic.StoreInt64(&cb.successes, 0)

        cb.mu.Lock()
        cb.lastFailure = time.Now()
        cb.mu.Unlock()

        if state == StateClosed && failures >= cb.failureThreshold {
            cb.transitionTo(StateOpen)
        } else if state == StateHalfOpen {
            cb.transitionTo(StateOpen)
        }
    } else {
        successes := atomic.AddInt64(&cb.successes, 1)

        if state == StateHalfOpen && successes >= cb.successThreshold {
            atomic.StoreInt64(&cb.failures, 0)
            cb.transitionTo(StateClosed)
        }
    }
}

func (cb *CircuitBreaker) transitionTo(to State) {
    from := State(atomic.SwapInt32(&cb.state, int32(to)))
    if from != to && cb.onStateChange != nil {
        cb.onStateChange(cb.name, from, to)
    }
}

var ErrCircuitOpen = errors.New("circuit breaker is open")
```

### Stripe's Rate Limiter Pattern

**Token Bucket with Redis Backend:**

```go
// Stripe's distributed rate limiting approach
package ratelimit

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

// RateLimiter implements distributed rate limiting
type RateLimiter struct {
    redis     *redis.Client
    keyPrefix string
}

type Limit struct {
    Rate   int           // Requests per window
    Window time.Duration // Time window
    Burst  int           // Max burst size
}

type Result struct {
    Allowed    bool
    Remaining  int
    RetryAfter time.Duration
    ResetAt    time.Time
}

// Stripe's sliding window rate limiter
const slidingWindowScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Remove old entries outside window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current requests
local count = redis.call('ZCARD', key)

if count < limit then
    -- Add current request
    redis.call('ZADD', key, now, now .. '-' .. math.random())
    redis.call('EXPIRE', key, window / 1000)
    return {1, limit - count - 1, 0}
else
    -- Get oldest entry for retry-after calculation
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry_after = oldest[2] and (oldest[2] + window - now) or window
    return {0, 0, retry_after}
end
`

// Allow checks if request is allowed
func (rl *RateLimiter) Allow(ctx context.Context, key string, limit Limit) (*Result, error) {
    now := time.Now().UnixMilli()
    windowMs := limit.Window.Milliseconds()

    res, err := rl.redis.Eval(ctx, slidingWindowScript, []string{rl.keyPrefix + key},
        now, windowMs, limit.Rate).Result()
    if err != nil {
        return nil, err
    }

    vals := res.([]any)
    allowed := vals[0].(int64) == 1
    remaining := int(vals[1].(int64))
    retryAfterMs := vals[2].(int64)

    return &Result{
        Allowed:    allowed,
        Remaining:  remaining,
        RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
        ResetAt:    time.Now().Add(limit.Window),
    }, nil
}

// AllowN checks if N requests are allowed (for batch operations)
func (rl *RateLimiter) AllowN(ctx context.Context, key string, limit Limit, n int) (*Result, error) {
    // For batch requests, check if N tokens are available
    result, err := rl.Allow(ctx, key, limit)
    if err != nil {
        return nil, err
    }

    if !result.Allowed || result.Remaining < n-1 {
        return &Result{
            Allowed:    false,
            Remaining:  result.Remaining,
            RetryAfter: result.RetryAfter,
            ResetAt:    result.ResetAt,
        }, nil
    }

    return result, nil
}
```

### Company Patterns Comparison

| Pattern | Google | Uber | Netflix | Stripe |
|---------|--------|------|---------|--------|
| **Options** | Functional options | Builder | Config struct | Functional options |
| **Workers** | errgroup | Custom pool | Fork-join | Task queue |
| **Circuit Breaker** | Built-in retry | Hystrix-like | Native Hystrix | Failsafe |
| **Rate Limiting** | Quota system | leakybucket | Zuul filters | Sliding window |
| **Error Handling** | Error wrapping | Multi-error | Fallbacks | Structured errors |
| **Context** | First param | Request scoped | Timeout focused | API versioned |

---
