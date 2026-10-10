## Common Mistakes and How to Avoid Them

### 1. Not Using Virtual Nodes in Consistent Hashing

Without virtual nodes, physical nodes with sequential identifiers may cluster on the hash ring, causing severe load imbalance.

```go
// ❌ Wrong: No virtual nodes leads to uneven distribution
type BadHashRing struct {
    nodes map[uint32]string
}

func NewBadHashRing() *BadHashRing {
    return &BadHashRing{
        nodes: make(map[uint32]string),
    }
}

func (r *BadHashRing) AddNode(node string) {
    // Single point per node - terrible distribution!
    hash := fnv32(node)
    r.nodes[hash] = node
}

// With 3 nodes, one might get 70% of keys, another 25%, third only 5%
```

```go
// ✅ Correct: Use virtual nodes for even distribution
type GoodHashRing struct {
    virtualNodes int
    ring         []uint32
    nodeMap      map[uint32]string
}

func NewGoodHashRing(virtualNodes int) *GoodHashRing {
    if virtualNodes < 100 {
        virtualNodes = 150 // Minimum 100-200 for good distribution
    }
    return &GoodHashRing{
        virtualNodes: virtualNodes,
        ring:         make([]uint32, 0),
        nodeMap:      make(map[uint32]string),
    }
}

func (r *GoodHashRing) AddNode(node string) {
    for i := 0; i < r.virtualNodes; i++ {
        // Create virtual node with unique identifier
        virtualKey := fmt.Sprintf("%s#%d", node, i)
        hash := fnv32(virtualKey)
        r.ring = append(r.ring, hash)
        r.nodeMap[hash] = node
    }
    sort.Slice(r.ring, func(i, j int) bool {
        return r.ring[i] < r.ring[j]
    })
}

// Distribution now approximately equal across all nodes
```

### 2. Ignoring Clock Drift in Distributed Locks

In distributed systems, clocks drift. A lock TTL of 30 seconds might actually be 29 or 31 seconds on different machines, leading to dangerous overlapping lock ownership.

```go
// ❌ Wrong: Assumes clocks are perfectly synchronized
type BadDistributedLock struct {
    redis *redis.Client
}

func (l *BadDistributedLock) Acquire(ctx context.Context, key string, ttl time.Duration) (bool, error) {
    acquired, err := l.redis.SetNX(ctx, key, "locked", ttl).Result()
    if err != nil {
        return false, err
    }
    return acquired, nil
}

func (l *BadDistributedLock) DoWork(ctx context.Context, key string, work func()) error {
    acquired, err := l.Acquire(ctx, key, 30*time.Second)
    if err != nil || !acquired {
        return fmt.Errorf("failed to acquire lock")
    }
    defer l.Release(ctx, key)

    start := time.Now()
    work()
    elapsed := time.Since(start)

    // DANGER: If clock drifted, lock might have expired
    // Another process might already have the lock!
    if elapsed > 30*time.Second {
        return fmt.Errorf("work took too long")
    }
    return nil
}
```

```go
// ✅ Correct: Account for clock drift with safety margin
type SafeDistributedLock struct {
    redis      *redis.Client
    driftFactor float64 // Typically 0.01 (1%)
}

func NewSafeDistributedLock(redis *redis.Client) *SafeDistributedLock {
    return &SafeDistributedLock{
        redis:      redis,
        driftFactor: 0.01, // 1% drift factor
    }
}

func (l *SafeDistributedLock) Acquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error) {
    token := uuid.New().String()
    acquired, err := l.redis.SetNX(ctx, key, token, ttl).Result()
    if err != nil || !acquired {
        return nil, fmt.Errorf("failed to acquire lock")
    }

    // Calculate safe validity period accounting for drift
    drift := time.Duration(float64(ttl) * l.driftFactor)
    networkLatency := 10 * time.Millisecond // Assume some latency

    return &Lock{
        Key:      key,
        Token:    token,
        Validity: ttl - drift - networkLatency,
        AcquiredAt: time.Now(),
    }, nil
}

func (l *SafeDistributedLock) DoWork(ctx context.Context, lock *Lock, work func() error) error {
    // Check remaining validity before starting
    remaining := lock.Validity - time.Since(lock.AcquiredAt)
    if remaining <= 0 {
        return fmt.Errorf("lock already expired")
    }

    // Set deadline based on safe validity
    ctx, cancel := context.WithTimeout(ctx, remaining)
    defer cancel()

    errCh := make(chan error, 1)
    go func() {
        errCh <- work()
    }()

    select {
    case err := <-errCh:
        return err
    case <-ctx.Done():
        return fmt.Errorf("lock validity expired during work: %w", ctx.Err())
    }
}

type Lock struct {
    Key        string
    Token      string
    Validity   time.Duration
    AcquiredAt time.Time
}
```

### 3. Retrying Non-Idempotent Operations Without Idempotency Keys

Retrying operations like payments or inventory updates without idempotency can cause double charges or over-allocation.

```go
// ❌ Wrong: Retrying can cause duplicate charges
type BadPaymentService struct {
    gateway PaymentGateway
}

func (s *BadPaymentService) ChargeCustomer(ctx context.Context, customerID string, amountCents int64) error {
    return retry.Do(
        func() error {
            // If this succeeds but response is lost, retry will charge again!
            return s.gateway.Charge(customerID, amountCents)
        },
        retry.Attempts(3),
        retry.Delay(100*time.Millisecond),
    )
}

// Customer could be charged 3 times if network issues cause response loss!
```

```go
// ✅ Correct: Use idempotency keys for safe retries
type SafePaymentService struct {
    gateway PaymentGateway
    redis   *redis.Client
}

type IdempotentResult struct {
    Success      bool   `json:"success"`
    TransactionID string `json:"transaction_id"`
    AmountCents  int64   `json:"amount_cents"`
}

func (s *SafePaymentService) ChargeCustomer(
    ctx context.Context,
    idempotencyKey string,
    customerID string,
    amountCents int64,
) (*IdempotentResult, error) {
    // Check if we've already processed this request
    cached, err := s.redis.Get(ctx, "idempotency:"+idempotencyKey).Result()
    if err == nil {
        var result IdempotentResult
        if err := json.Unmarshal([]byte(cached), &result); err == nil {
            return &result, nil // Return cached result
        }
    }

    // Try to set processing lock
    set, err := s.redis.SetNX(ctx, "idempotency:lock:"+idempotencyKey, "processing", 5*time.Minute).Result()
    if err != nil {
        return nil, fmt.Errorf("failed to set idempotency lock: %w", err)
    }
    if !set {
        // Another request is processing, wait and retry
        return nil, fmt.Errorf("request in progress")
    }
    defer s.redis.Del(ctx, "idempotency:lock:"+idempotencyKey)

    // Process with retries - gateway must support idempotency key
    var result *IdempotentResult
    err = retry.Do(
        func() error {
            txn, err := s.gateway.ChargeWithKey(idempotencyKey, customerID, amountCents)
            if err != nil {
                return err
            }
            result = &IdempotentResult{
                Success:       true,
                TransactionID: txn.ID,
                AmountCents:   amountCents,
            }
            return nil
        },
        retry.Attempts(3),
        retry.Delay(100*time.Millisecond),
        retry.RetryIf(func(err error) bool {
            // Only retry on transient errors, not business logic failures
            return isTransientError(err)
        }),
    )

    if err != nil {
        return nil, err
    }

    // Cache result for 24 hours
    resultJSON, _ := json.Marshal(result)
    s.redis.Set(ctx, "idempotency:"+idempotencyKey, resultJSON, 24*time.Hour)

    return result, nil
}

func isTransientError(err error) bool {
    // Timeouts are transient. net.Error.Temporary is deprecated
    // (since Go 1.18) because "temporary" was never well defined,
    // classify anything else by concrete error type or status code.
    var netErr net.Error
    if errors.As(err, &netErr) {
        return netErr.Timeout()
    }
    return false
}
```

### 4. Circuit Breaker Without Proper Thresholds

Setting thresholds too low causes unnecessary service degradation. Too high means the circuit never protects you.

```go
// ❌ Wrong: Opens too easily on transient errors
type OverSensitiveBreaker struct {
    failures int
    state    string
}

func NewOverSensitiveBreaker() *OverSensitiveBreaker {
    return &OverSensitiveBreaker{state: "closed"}
}

func (cb *OverSensitiveBreaker) Execute(fn func() error) error {
    if cb.state == "open" {
        return ErrCircuitOpen
    }

    err := fn()
    if err != nil {
        cb.failures++
        if cb.failures >= 1 { // Single failure opens circuit!
            cb.state = "open"
        }
    }
    return err
}
// One transient network blip takes down all traffic!
```

```go
// ✅ Correct: Use percentage-based thresholds with minimum volume
type WellTunedBreaker struct {
    mu sync.RWMutex

    // Thresholds
    failureThreshold float64 // Percentage (e.g., 0.5 = 50%)
    volumeThreshold  int     // Minimum requests before circuit can trip

    // Rolling window
    window     time.Duration
    buckets    []*bucket
    bucketSize time.Duration
    current    int

    // State
    state           int32
    lastStateChange time.Time
    sleepWindow     time.Duration
}

type bucket struct {
    successes int64
    failures  int64
    timestamp time.Time
}

func NewWellTunedBreaker(opts BreakerOptions) *WellTunedBreaker {
    if opts.FailureThreshold == 0 {
        opts.FailureThreshold = 0.5 // 50% failures
    }
    if opts.VolumeThreshold == 0 {
        opts.VolumeThreshold = 20 // Minimum 20 requests
    }
    if opts.Window == 0 {
        opts.Window = 10 * time.Second
    }
    if opts.SleepWindow == 0 {
        opts.SleepWindow = 5 * time.Second
    }

    numBuckets := 10
    bucketSize := opts.Window / time.Duration(numBuckets)

    buckets := make([]*bucket, numBuckets)
    for i := range buckets {
        buckets[i] = &bucket{}
    }

    return &WellTunedBreaker{
        failureThreshold: opts.FailureThreshold,
        volumeThreshold:  opts.VolumeThreshold,
        window:           opts.Window,
        buckets:          buckets,
        bucketSize:       bucketSize,
        sleepWindow:      opts.SleepWindow,
        lastStateChange:  time.Now(),
    }
}

func (cb *WellTunedBreaker) shouldTrip() bool {
    total, failures := cb.getMetrics()

    // Must have minimum volume before tripping
    if total < int64(cb.volumeThreshold) {
        return false
    }

    // Check failure percentage
    failurePct := float64(failures) / float64(total)
    return failurePct >= cb.failureThreshold
}

func (cb *WellTunedBreaker) getMetrics() (total, failures int64) {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    cutoff := time.Now().Add(-cb.window)
    for _, b := range cb.buckets {
        if b.timestamp.After(cutoff) {
            total += b.successes + b.failures
            failures += b.failures
        }
    }
    return
}

type BreakerOptions struct {
    FailureThreshold float64
    VolumeThreshold  int
    Window           time.Duration
    SleepWindow      time.Duration
}
```

### 5. Bulkhead Without Proper Sizing

Bulkheads that are too small starve services. Too large and they don't provide isolation.

```go
// ❌ Wrong: All services share a single connection pool
type BadServiceClient struct {
    httpClient *http.Client
}

func NewBadServiceClient() *BadServiceClient {
    return &BadServiceClient{
        httpClient: &http.Client{
            Transport: &http.Transport{
                MaxIdleConns:        100,
                MaxIdleConnsPerHost: 100, // All services share this pool!
            },
        },
    }
}

func (c *BadServiceClient) CallCriticalService(ctx context.Context) error {
    // If non-critical service is slow, it consumes all connections
    // Critical service can't get connections!
    resp, err := c.httpClient.Get("http://critical-service/api")
    // ...
}
```

```go
// ✅ Correct: Isolated bulkheads per service with adaptive sizing
type BulkheadedClient struct {
    bulkheads map[string]*Bulkhead
    mu        sync.RWMutex
}

type Bulkhead struct {
    name       string
    semaphore  chan struct{}
    maxSize    int
    waiting    atomic.Int64
    maxWaiting int

    // Metrics for adaptive sizing
    metrics *BulkheadMetrics
}

type BulkheadMetrics struct {
    mu              sync.RWMutex
    successLatency  []time.Duration
    rejections      atomic.Int64
    activeRequests  atomic.Int64
}

func NewBulkheadedClient() *BulkheadedClient {
    client := &BulkheadedClient{
        bulkheads: make(map[string]*Bulkhead),
    }

    // Configure bulkheads per service based on criticality
    client.AddBulkhead("critical-service", BulkheadConfig{
        MaxConcurrent: 50,  // Reserve capacity for critical service
        MaxWaiting:    100,
        Priority:      "high",
    })

    client.AddBulkhead("analytics-service", BulkheadConfig{
        MaxConcurrent: 10,  // Less important, limit impact
        MaxWaiting:    20,
        Priority:      "low",
    })

    client.AddBulkhead("notification-service", BulkheadConfig{
        MaxConcurrent: 20,
        MaxWaiting:    50,
        Priority:      "medium",
    })

    return client
}

func (c *BulkheadedClient) AddBulkhead(name string, config BulkheadConfig) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.bulkheads[name] = &Bulkhead{
        name:       name,
        semaphore:  make(chan struct{}, config.MaxConcurrent),
        maxSize:    config.MaxConcurrent,
        maxWaiting: config.MaxWaiting,
        metrics:    &BulkheadMetrics{},
    }
}

func (c *BulkheadedClient) Execute(ctx context.Context, service string, fn func() error) error {
    c.mu.RLock()
    bulkhead, ok := c.bulkheads[service]
    c.mu.RUnlock()

    if !ok {
        return fmt.Errorf("no bulkhead configured for service: %s", service)
    }

    // Check waiting queue
    if bulkhead.waiting.Load() >= int64(bulkhead.maxWaiting) {
        bulkhead.metrics.rejections.Add(1)
        return fmt.Errorf("bulkhead %s: too many waiting requests", service)
    }

    bulkhead.waiting.Add(1)
    defer bulkhead.waiting.Add(-1)

    // Try to acquire semaphore
    select {
    case bulkhead.semaphore <- struct{}{}:
        defer func() { <-bulkhead.semaphore }()

        bulkhead.metrics.activeRequests.Add(1)
        defer bulkhead.metrics.activeRequests.Add(-1)

        start := time.Now()
        err := fn()
        latency := time.Since(start)

        // Record metrics for adaptive sizing
        bulkhead.recordLatency(latency)

        return err

    case <-ctx.Done():
        bulkhead.metrics.rejections.Add(1)
        return ctx.Err()
    }
}

func (b *Bulkhead) recordLatency(latency time.Duration) {
    b.metrics.mu.Lock()
    defer b.metrics.mu.Unlock()

    b.metrics.successLatency = append(b.metrics.successLatency, latency)
    if len(b.metrics.successLatency) > 1000 {
        b.metrics.successLatency = b.metrics.successLatency[500:]
    }
}

type BulkheadConfig struct {
    MaxConcurrent int
    MaxWaiting    int
    Priority      string
}
```

### Junior -> FAANG: Turning Mistakes into Interview Answers

The five mistakes in this section map directly to five common FAANG interview follow-up questions. Knowing the failure mode, the root cause, and the fix for each gives you a complete answer rather than just a vague "you should use virtual nodes."

For virtual nodes: the interviewer wants to hear that without them, the expected key distribution is only as good as the random chance that five hash values are evenly spaced, which is bad. With 150 virtual nodes per physical node, the law of large numbers makes the distribution near-perfect. Know the number 150 and be able to justify it.

For fencing tokens: the GC pause scenario is the canonical interview trap. If you say "distributed locks prevent concurrent access," the follow-up is "what if the lock holder is paused for 30 seconds by the garbage collector?" The correct answer is fencing tokens validated at the storage layer, not longer TTLs.

For circuit breaker thresholds: the interviewer will ask "what threshold would you use?" Know that the answer depends on the service's baseline error rate and traffic volume, and that a minimum request volume is required before any threshold is meaningful. A circuit breaker that trips after 5 errors on a service handling 10 rps is very different from one handling 10k rps.

For idempotency: know the difference between "safe to retry" (GET, idempotent POSTs with keys) and "not safe to retry" (payment charges, inventory decrements without keys). The payment double-charge is the production incident that every interviewer knows about.

For thundering herd: know that jitter is the solution and that the amount of jitter determines how spread the retry wave is. Full jitter (`rand.Float64() * maxDelay`) is more effective than capped jitter (`rand.Float64() * baseDelay * 0.1`) but less predictable.

### Senior @ FAANG: Systematic Mistake Prevention Through Design Reviews

At the senior level, preventing these mistakes across a team of engineers requires process, not just knowledge. Individual engineers knowing the correct patterns is necessary but not sufficient.

For virtual nodes: add a linter rule or code review checklist item that any `HashRing` instantiation must specify a virtual node count above 100. Make the constructor fail loudly if the count is below 50 rather than silently using a bad default.

For fencing tokens: the review question for any distributed lock usage is "what happens if the lock expires while the holder is in the critical section?" If the answer is not "the storage layer validates the fencing token and rejects the stale write," the design is incomplete. This question should appear in your team's design review template for any feature involving distributed coordination.

For circuit breaker thresholds: require teams to document their threshold choices with supporting data. "Failure threshold: 50%, minimum volume: 20 requests" is not sufficient. "Failure threshold: 50% (service's normal error rate is 0.1%, so 50% represents a genuine outage), minimum volume: 20 requests (at 500 rps average, 20 requests represents 40ms of traffic)" is a design decision that survives personnel changes.

For retry and idempotency: require idempotency design as part of any API design review. Every mutating endpoint should have a documented answer to "how does the client safely retry this?" If the answer is "it cannot," document why and add a warning to the API documentation.

For thundering herd: capacity plan for retry amplification. If your service handles 10k rps at p50 and the retry amplification factor is 3x, your downstream must be able to handle 30k rps during recovery from a full outage. If it cannot, either reduce the retry factor (fewer retries, higher jitter) or provision more downstream capacity.

---
