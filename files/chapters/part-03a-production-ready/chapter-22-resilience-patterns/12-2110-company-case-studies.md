## 22.10 Company Case Studies

### Google: Defense in Depth

Google's approach to resilience involves multiple layers of protection:

**Load Shedding**: When a service is overloaded, Google uses admission control to reject excess requests early:

```go
// Google-style admission control
type AdmissionController struct {
    loadEstimator *LoadEstimator
    threshold     float64
}

func (ac *AdmissionController) ShouldAdmit(ctx context.Context) bool {
    load := ac.loadEstimator.CurrentLoad()

    if load > ac.threshold {
        // Probabilistic rejection based on overload
        rejectProbability := (load - ac.threshold) / load
        return rand.Float64() > rejectProbability
    }
    return true
}

// Load estimation using exponential moving average
type LoadEstimator struct {
    mu       sync.Mutex
    load     float64
    alpha    float64 // Smoothing factor
    lastTime time.Time
}

func (le *LoadEstimator) RecordRequest(latency time.Duration) {
    le.mu.Lock()
    defer le.mu.Unlock()

    // Simple load calculation based on latency
    instantLoad := float64(latency) / float64(time.Millisecond)
    le.load = le.alpha*instantLoad + (1-le.alpha)*le.load
}
```

**Cascading Failure Prevention**: Google uses deadline propagation to prevent cascading failures:

```go
// Deadline propagation
func (c *Client) CallWithDeadline(ctx context.Context, req *Request) (*Response, error) {
    deadline, ok := ctx.Deadline()
    if !ok {
        // Set default deadline
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
        defer cancel()
        deadline, _ = ctx.Deadline()
    }

    // Propagate deadline to downstream service
    req.Header.Set("X-Deadline", deadline.Format(time.RFC3339Nano))

    // Calculate remaining budget
    remaining := time.Until(deadline)
    if remaining < 100*time.Millisecond {
        return nil, errors.New("insufficient deadline budget")
    }

    return c.doRequest(ctx, req)
}
```

### Uber: Adaptive Retry Budgets

Uber implements adaptive retry budgets to prevent retry storms:

```go
// Uber-style retry budget
type RetryBudget struct {
    mu            sync.Mutex
    tokenBucket   float64
    maxTokens     float64
    refillRate    float64 // Tokens per second
    lastRefill    time.Time
    retryRatio    float64 // Target ratio of retries to total requests
    windowSize    time.Duration

    totalRequests int64
    retries       int64
}

func NewRetryBudget(maxTokens float64, retryRatio float64) *RetryBudget {
    return &RetryBudget{
        tokenBucket: maxTokens,
        maxTokens:   maxTokens,
        refillRate:  maxTokens / 10, // Refill over 10 seconds
        lastRefill:  time.Now(),
        retryRatio:  retryRatio,
        windowSize:  time.Minute,
    }
}

func (rb *RetryBudget) CanRetry() bool {
    rb.mu.Lock()
    defer rb.mu.Unlock()

    rb.refillTokens()

    // Check if under retry budget
    currentRatio := float64(rb.retries) / float64(max(rb.totalRequests, 1))
    if currentRatio >= rb.retryRatio {
        return false
    }

    // Check token bucket
    if rb.tokenBucket < 1 {
        return false
    }

    rb.tokenBucket--
    rb.retries++
    return true
}

func (rb *RetryBudget) RecordRequest() {
    rb.mu.Lock()
    defer rb.mu.Unlock()
    rb.totalRequests++
}

func (rb *RetryBudget) refillTokens() {
    now := time.Now()
    elapsed := now.Sub(rb.lastRefill)

    tokens := float64(elapsed) / float64(time.Second) * rb.refillRate
    rb.tokenBucket = math.Min(rb.tokenBucket+tokens, rb.maxTokens)
    rb.lastRefill = now
}
```

### Netflix: Hystrix-Style Patterns

Netflix pioneered many resilience patterns with Hystrix:

```go
// Netflix-style command pattern
type Command[T any] struct {
    name           string
    run            func(context.Context) (T, error)
    fallback       func(context.Context, error) (T, error)
    circuitBreaker *circuit.CircuitBreaker
    timeout        time.Duration

    // Thread pool isolation
    pool           chan struct{}
}

func NewCommand[T any](
    name string,
    run func(context.Context) (T, error),
) *Command[T] {
    return &Command[T]{
        name:    name,
        run:     run,
        timeout: 10 * time.Second,
        pool:    make(chan struct{}, 10), // Semaphore for isolation
    }
}

func (c *Command[T]) WithFallback(fn func(context.Context, error) (T, error)) *Command[T] {
    c.fallback = fn
    return c
}

func (c *Command[T]) Execute(ctx context.Context) (T, error) {
    var zero T

    // Thread pool isolation
    select {
    case c.pool <- struct{}{}:
        defer func() { <-c.pool }()
    default:
        if c.fallback != nil {
            return c.fallback(ctx, errors.New("thread pool full"))
        }
        return zero, errors.New("thread pool full")
    }

    // Timeout
    ctx, cancel := context.WithTimeout(ctx, c.timeout)
    defer cancel()

    // Circuit breaker
    if c.circuitBreaker != nil {
        result, err := c.circuitBreaker.ExecuteWithContext(ctx,
            func(ctx context.Context) (any, error) {
                return c.run(ctx)
            },
        )
        if err != nil {
            if c.fallback != nil {
                return c.fallback(ctx, err)
            }
            return zero, err
        }
        return result.(T), nil
    }

    result, err := c.run(ctx)
    if err != nil && c.fallback != nil {
        return c.fallback(ctx, err)
    }
    return result, err
}

// Usage
func GetUserProfile(ctx context.Context, userID string) (*Profile, error) {
    cmd := NewCommand("get-user-profile", func(ctx context.Context) (*Profile, error) {
        return userService.GetProfile(ctx, userID)
    }).WithFallback(func(ctx context.Context, err error) (*Profile, error) {
        // Return cached or default profile
        return cache.GetProfile(userID)
    })

    return cmd.Execute(ctx)
}
```

### Stripe: Idempotent Retries

Stripe's approach emphasizes idempotent operations for safe retries:

```go
// Stripe-style idempotent request handling
type IdempotentClient struct {
    client       *Client
    store        IdempotencyStore
    keyGenerator func(req *http.Request) string
}

type IdempotencyStore interface {
    Get(ctx context.Context, key string) (*CachedResponse, error)
    Set(ctx context.Context, key string, resp *CachedResponse, ttl time.Duration) error
    Lock(ctx context.Context, key string, ttl time.Duration) (bool, error)
    Unlock(ctx context.Context, key string) error
}

type CachedResponse struct {
    StatusCode int
    Headers    http.Header
    Body       []byte
    CreatedAt  time.Time
}

func (ic *IdempotentClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Generate idempotency key
    key := ic.keyGenerator(req)
    if key == "" {
        // Non-idempotent request, execute directly
        return ic.client.Do(ctx, req)
    }

    // Check for cached response
    cached, err := ic.store.Get(ctx, key)
    if err == nil && cached != nil {
        return ic.cachedToResponse(cached), nil
    }

    // Try to acquire lock
    locked, err := ic.store.Lock(ctx, key, 30*time.Second)
    if err != nil {
        return nil, fmt.Errorf("idempotency lock: %w", err)
    }

    if !locked {
        // Another request in progress, wait and check cache
        time.Sleep(100 * time.Millisecond)
        cached, err := ic.store.Get(ctx, key)
        if err == nil && cached != nil {
            return ic.cachedToResponse(cached), nil
        }
        return nil, errors.New("concurrent request in progress")
    }
    defer ic.store.Unlock(ctx, key)

    // Execute request
    resp, err := ic.client.Do(ctx, req)
    if err != nil {
        return nil, err
    }

    // Cache successful responses
    if resp.StatusCode >= 200 && resp.StatusCode < 300 {
        body, _ := io.ReadAll(resp.Body)
        resp.Body.Close()

        cached := &CachedResponse{
            StatusCode: resp.StatusCode,
            Headers:    resp.Header,
            Body:       body,
            CreatedAt:  time.Now(),
        }
        ic.store.Set(ctx, key, cached, 24*time.Hour)

        resp.Body = io.NopCloser(bytes.NewReader(body))
    }

    return resp, nil
}

func (ic *IdempotentClient) cachedToResponse(cached *CachedResponse) *http.Response {
    return &http.Response{
        StatusCode: cached.StatusCode,
        Header:     cached.Headers,
        Body:       io.NopCloser(bytes.NewReader(cached.Body)),
    }
}
```

### Staff Lens: Each Case Study Reflects Scale

Netflix's Hystrix came from their scale: thousands of services, millions of requests per second. For smaller services, lighter patterns work. Do not adopt Hystrix-scale infrastructure for a ten-service startup, and do not adopt startup-scale patterns for Hystrix-scale traffic. Match the pattern to your scale.

---
