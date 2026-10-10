## Distributed System Patterns Pitfalls: When Patterns Backfire

Each pattern in this chapter solves a real problem, but a misconfigured implementation can create new ones. The pitfalls below are drawn from production incidents where distributed system patterns were applied without sufficient attention to their underlying assumptions. Each includes the failure scenario, the root cause, and a corrected implementation.

### Pitfall 1: Consistent Hashing Without Virtual Nodes Causes Hot Spots

**Incident Report**: A new caching layer with consistent hashing caused 60% of requests to hit a single node. Investigation revealed only 5 physical nodes were on the hash ring, and one happened to cover 60% of the hash space.

```go
// WRONG: Basic consistent hashing without virtual nodes
type SimpleHashRing struct {
    nodes    []string
    hashRing map[uint32]string
}

func (r *SimpleHashRing) AddNode(node string) {
    // Only one point on the ring per physical node
    hash := crc32.ChecksumIEEE([]byte(node))
    r.hashRing[hash] = node

    // Problem: 5 nodes don't distribute evenly
    // One node might cover 60% of the ring by chance
}

// CORRECT: Virtual nodes for even distribution
type VirtualNodeHashRing struct {
    nodes        []string
    hashRing     []hashNode
    virtualNodes int  // 150-200 per physical node
}

type hashNode struct {
    hash uint32
    node string
}

func (r *VirtualNodeHashRing) AddNode(node string) {
    for i := 0; i < r.virtualNodes; i++ {
        // Create virtual node identifier
        virtualKey := fmt.Sprintf("%s#%d", node, i)
        hash := crc32.ChecksumIEEE([]byte(virtualKey))

        r.hashRing = append(r.hashRing, hashNode{
            hash: hash,
            node: node,
        })
    }

    // Sort for binary search
    sort.Slice(r.hashRing, func(i, j int) bool {
        return r.hashRing[i].hash < r.hashRing[j].hash
    })
}

func (r *VirtualNodeHashRing) GetNode(key string) string {
    if len(r.hashRing) == 0 {
        return ""
    }

    hash := crc32.ChecksumIEEE([]byte(key))

    // Binary search for first node >= hash
    idx := sort.Search(len(r.hashRing), func(i int) bool {
        return r.hashRing[i].hash >= hash
    })

    // Wrap around if past the end
    if idx == len(r.hashRing) {
        idx = 0
    }

    return r.hashRing[idx].node
}

// Verify distribution is even
func (r *VirtualNodeHashRing) GetDistribution() map[string]int {
    dist := make(map[string]int)
    testKeys := 100000

    for i := 0; i < testKeys; i++ {
        key := fmt.Sprintf("key-%d", i)
        node := r.GetNode(key)
        dist[node]++
    }

    return dist
    // With 150 virtual nodes per physical node:
    // node1: 20,123 (20.1%)
    // node2: 19,987 (19.9%)
    // node3: 20,234 (20.2%)
    // node4: 19,876 (19.9%)
    // node5: 19,780 (19.8%)
    // Much better than 60% / 10% / 10% / 10% / 10%
}
```

### Pitfall 2: Distributed Lock Without Fencing Tokens Causes Split-Brain

**Incident Report**: Two workers processed the same job simultaneously despite distributed locking. Worker A acquired lock, then experienced a GC pause. Lock expired. Worker B acquired lock and started processing. Worker A resumed from GC pause, believing it still held the lock.

```go
// WRONG: Lock without fencing token
type NaiveDistributedLock struct {
    redis  *redis.Client
    lockID string
}

func (l *NaiveDistributedLock) Acquire(ctx context.Context, ttl time.Duration) error {
    return l.redis.SetNX(ctx, l.lockID, "locked", ttl).Err()
}

func (l *NaiveDistributedLock) DoWork(ctx context.Context) error {
    // Worker A: Acquires lock
    if err := l.Acquire(ctx, 10*time.Second); err != nil {
        return err
    }

    // Worker A: GC pause for 15 seconds
    // Lock expires after 10 seconds
    // Worker B: Acquires same lock, starts processing

    // Worker A: Resumes, thinks it has lock
    // Both workers now processing same job!
    l.process()

    return nil
}

// CORRECT: Fencing token to detect expired locks
type FencedDistributedLock struct {
    redis       *redis.Client
    lockID      string
    fenceToken  int64
    localExpiry time.Time
}

func (l *FencedDistributedLock) Acquire(ctx context.Context, ttl time.Duration) (int64, error) {
    // Increment global fence token
    fenceToken, err := l.redis.Incr(ctx, l.lockID+":fence").Result()
    if err != nil {
        return 0, err
    }

    // Try to acquire lock with our fence token
    acquired, err := l.redis.SetNX(ctx, l.lockID, fenceToken, ttl).Result()
    if err != nil || !acquired {
        return 0, errors.New("failed to acquire lock")
    }

    l.fenceToken = fenceToken
    l.localExpiry = time.Now().Add(ttl - 2*time.Second)  // Conservative local expiry

    return fenceToken, nil
}

func (l *FencedDistributedLock) DoWork(ctx context.Context) error {
    fenceToken, err := l.Acquire(ctx, 30*time.Second)
    if err != nil {
        return err
    }

    // Check local expiry before each critical operation
    if time.Now().After(l.localExpiry) {
        return errors.New("lock expired locally, aborting")
    }

    // Pass fence token to storage layer
    if err := l.storage.ProcessWithFence(ctx, fenceToken, data); err != nil {
        return err
    }

    return nil
}

// Storage layer validates fence token. The compare and the write must
// be one atomic step: a separate GET-then-SET would let a stale worker
// pass the check, interleave with a newer worker, and overwrite its
// write, which is exactly the race fencing exists to prevent.
func (s *Storage) ProcessWithFence(ctx context.Context, fenceToken int64, data []byte) error {
    script := redis.NewScript(`
        local current = tonumber(redis.call('GET', KEYS[1]) or '0')
        local token = tonumber(ARGV[1])
        if token <= current then
            return 0
        end
        redis.call('SET', KEYS[1], token)
        redis.call('SET', KEYS[2], ARGV[2])
        return 1
    `)

    ok, err := script.Run(ctx, s.redis,
        []string{"current_fence", "data"}, fenceToken, data).Int()
    if err != nil {
        return err
    }
    if ok == 0 {
        return errors.New("stale fence token, another worker has taken over")
    }
    return nil
}
```

### Pitfall 3: Circuit Breaker Opening Too Aggressively on Network Blips

**Incident Report**: Circuit breaker opened after 5 errors in 10 seconds, but 3 of those were legitimate network timeouts during a minor blip. The circuit stayed open for 60 seconds, causing thousands of unnecessary failures.

```go
// WRONG: Simple error counting
type NaiveCircuitBreaker struct {
    failures    int
    threshold   int  // 5
    timeout     time.Duration  // 60 seconds
    state       string
}

func (cb *NaiveCircuitBreaker) Execute(fn func() error) error {
    if cb.state == "open" {
        return errors.New("circuit open")
    }

    err := fn()
    if err != nil {
        cb.failures++
        if cb.failures >= cb.threshold {
            cb.state = "open"  // Opens on ANY 5 errors, even transient ones
        }
    }

    return err
}

// CORRECT: Sophisticated circuit breaker with error classification
type SmartCircuitBreaker struct {
    name          string
    state         atomic.Value  // "closed", "open", "half-open"
    metrics       *CircuitMetrics
    config        CircuitConfig

    lastStateChange time.Time
}

type CircuitConfig struct {
    ErrorThreshold        float64       // Percentage: 50%
    MinimumRequests       int           // Minimum requests before calculating: 10
    EvaluationWindow      time.Duration // Rolling window: 30 seconds
    OpenDuration          time.Duration // How long to stay open: 30 seconds
    HalfOpenRequests      int           // Requests to try in half-open: 3
    TransientErrorIgnore  bool          // Don't count transient errors
}

func (cb *SmartCircuitBreaker) Execute(ctx context.Context, fn func() error) error {
    state := cb.state.Load().(string)

    switch state {
    case "open":
        // Check if we should try half-open
        if time.Since(cb.lastStateChange) > cb.config.OpenDuration {
            cb.setState("half-open")
        } else {
            return &CircuitOpenError{Name: cb.name, RetryAfter: cb.lastStateChange.Add(cb.config.OpenDuration)}
        }

    case "half-open":
        // Limited requests in half-open state
        if cb.metrics.HalfOpenRequests() >= cb.config.HalfOpenRequests {
            return &CircuitOpenError{Name: cb.name}
        }
    }

    // Execute the function
    start := time.Now()
    err := fn()
    duration := time.Since(start)

    // Record result
    cb.recordResult(err, duration)

    // Evaluate state
    cb.evaluate()

    return err
}

func (cb *SmartCircuitBreaker) recordResult(err error, duration time.Duration) {
    if err == nil {
        cb.metrics.RecordSuccess(duration)
        return
    }

    // Classify error
    if cb.isTransientError(err) && cb.config.TransientErrorIgnore {
        cb.metrics.RecordTransient()
        return
    }

    cb.metrics.RecordFailure(duration)
}

func (cb *SmartCircuitBreaker) isTransientError(err error) bool {
    // Network timeouts, connection refused, DNS errors
    var netErr net.Error
    if errors.As(err, &netErr) && netErr.Timeout() {
        return true
    }

    // Specific transient HTTP status codes
    var httpErr *HTTPError
    if errors.As(err, &httpErr) {
        switch httpErr.StatusCode {
        case 408, 429, 502, 503, 504:
            return true
        }
    }

    return false
}

func (cb *SmartCircuitBreaker) evaluate() {
    metrics := cb.metrics.GetWindow(cb.config.EvaluationWindow)

    state := cb.state.Load().(string)

    switch state {
    case "closed":
        if metrics.TotalRequests < cb.config.MinimumRequests {
            return  // Not enough data
        }

        errorRate := float64(metrics.Failures) / float64(metrics.TotalRequests)
        if errorRate > cb.config.ErrorThreshold {
            cb.setState("open")
        }

    case "half-open":
        if metrics.HalfOpenSuccesses >= cb.config.HalfOpenRequests {
            cb.setState("closed")
        } else if metrics.HalfOpenFailures > 0 {
            cb.setState("open")
        }
    }
}
```

### Pitfall 4: Retry Without Idempotency Causes Duplicate Operations

**Incident Report**: Payment retry logic caused customers to be charged 3 times. The initial request succeeded but timed out before the client received confirmation. Two retries each created new charges.

```go
// WRONG: Retry without idempotency
func (c *PaymentClient) ChargeCustomer(ctx context.Context, customerID string, amount int64) error {
    var lastErr error

    for attempt := 0; attempt < 3; attempt++ {
        err := c.paymentAPI.Charge(customerID, amount)
        if err == nil {
            return nil
        }

        lastErr = err

        // Problem: If request succeeded but response timed out,
        // retry creates another charge!
        if isRetryable(err) {
            time.Sleep(time.Duration(attempt+1) * time.Second)
            continue
        }

        return err
    }

    return lastErr
}

// CORRECT: Idempotency key prevents duplicate operations
type PaymentClient struct {
    paymentAPI    *PaymentAPI
    idempotencyDB *IdempotencyStore
}

func (c *PaymentClient) ChargeCustomer(ctx context.Context, req *ChargeRequest) (*ChargeResult, error) {
    // Generate or use provided idempotency key
    idempotencyKey := req.IdempotencyKey
    if idempotencyKey == "" {
        idempotencyKey = fmt.Sprintf("charge_%s_%d_%d", req.CustomerID, req.Amount, time.Now().UnixNano())
    }

    // Check if we've already processed this request
    existing, err := c.idempotencyDB.Get(ctx, idempotencyKey)
    if err == nil && existing != nil {
        // Return cached result
        return existing, nil
    }

    // Lock to prevent concurrent duplicate processing
    lock, err := c.idempotencyDB.Lock(ctx, idempotencyKey, 30*time.Second)
    if err != nil {
        return nil, fmt.Errorf("failed to acquire idempotency lock: %w", err)
    }
    defer lock.Release(ctx)

    // Double-check after acquiring lock
    existing, err = c.idempotencyDB.Get(ctx, idempotencyKey)
    if err == nil && existing != nil {
        return existing, nil
    }

    // Process with retries
    var result *ChargeResult
    var lastErr error

    for attempt := 0; attempt < 3; attempt++ {
        result, err = c.paymentAPI.ChargeWithIdempotencyKey(ctx, req, idempotencyKey)
        if err == nil {
            // Store successful result
            c.idempotencyDB.Store(ctx, idempotencyKey, result, 24*time.Hour)
            return result, nil
        }

        lastErr = err

        // Only retry on network errors, not on payment failures
        if !isNetworkError(err) {
            break
        }

        time.Sleep(time.Duration(attempt+1) * time.Second)
    }

    // Store failed result too (to prevent retrying failed operations)
    if !isNetworkError(lastErr) {
        c.idempotencyDB.Store(ctx, idempotencyKey, &ChargeResult{
            Status: "failed",
            Error:  lastErr.Error(),
        }, 24*time.Hour)
    }

    return nil, lastErr
}

type IdempotencyStore struct {
    redis *redis.Client
}

func (s *IdempotencyStore) Store(ctx context.Context, key string, result *ChargeResult, ttl time.Duration) error {
    data, _ := json.Marshal(result)
    return s.redis.Set(ctx, "idempotency:"+key, data, ttl).Err()
}

func (s *IdempotencyStore) Get(ctx context.Context, key string) (*ChargeResult, error) {
    data, err := s.redis.Get(ctx, "idempotency:"+key).Bytes()
    if err != nil {
        return nil, err
    }

    var result ChargeResult
    json.Unmarshal(data, &result)
    return &result, nil
}
```

### Pitfall 5: Rate Limiter Synchronized Across Instances Causes Thundering Herd

**Incident Report**: Distributed rate limiter reset at the same time across all instances, causing 10,000 queued requests to fire simultaneously at the reset, overwhelming the downstream service.

```go
// WRONG: Fixed window with synchronized reset
type FixedWindowRateLimiter struct {
    redis  *redis.Client
    limit  int
    window time.Duration
}

func (r *FixedWindowRateLimiter) Allow(ctx context.Context, key string) bool {
    windowKey := fmt.Sprintf("ratelimit:%s:%d", key, time.Now().Unix()/int64(r.window.Seconds()))

    count, _ := r.redis.Incr(ctx, windowKey).Result()
    r.redis.Expire(ctx, windowKey, r.window)

    return count <= int64(r.limit)
    // Problem: All requests hit window boundary at same instant
    // 10,000 requests queued at 11:59:59 all fire at 12:00:00
}

// CORRECT: Sliding window with jitter
type SlidingWindowRateLimiter struct {
    redis        *redis.Client
    limit        int
    window       time.Duration
    jitterWindow time.Duration  // Spread resets over this window
}

func (r *SlidingWindowRateLimiter) Allow(ctx context.Context, key string) (bool, time.Duration) {
    now := time.Now()
    windowStart := now.Add(-r.window)

    // Use sorted set for sliding window
    zsetKey := "ratelimit:" + key

    pipe := r.redis.Pipeline()

    // Remove old entries
    pipe.ZRemRangeByScore(ctx, zsetKey, "0", fmt.Sprintf("%d", windowStart.UnixNano()))

    // Count current entries
    countCmd := pipe.ZCard(ctx, zsetKey)

    // Add current request (if under limit, we'll remove it if over)
    requestID := fmt.Sprintf("%d-%d", now.UnixNano(), rand.Int64())
    pipe.ZAdd(ctx, zsetKey, redis.Z{Score: float64(now.UnixNano()), Member: requestID})

    // Set expiry with jitter to prevent synchronized expiry
    jitter := time.Duration(rand.Int64N(int64(r.jitterWindow)))
    pipe.Expire(ctx, zsetKey, r.window+jitter)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return false, 0
    }

    count := countCmd.Val()

    if count >= int64(r.limit) {
        // Over limit, remove the request we just added
        r.redis.ZRem(ctx, zsetKey, requestID)

        // Calculate retry-after
        oldestEntry, _ := r.redis.ZRangeWithScores(ctx, zsetKey, 0, 0).Result()
        if len(oldestEntry) > 0 {
            oldestTime := time.Unix(0, int64(oldestEntry[0].Score))
            retryAfter := oldestTime.Add(r.window).Sub(now)
            return false, retryAfter
        }

        return false, r.window
    }

    return true, 0
}

// Token bucket with smooth refill (no thundering herd)
type TokenBucketRateLimiter struct {
    redis      *redis.Client
    capacity   int
    refillRate float64  // tokens per second
}

func (r *TokenBucketRateLimiter) Allow(ctx context.Context, key string) bool {
    now := time.Now()
    bucketKey := "tokenbucket:" + key

    // Lua script for atomic token bucket
    script := redis.NewScript(`
        local key = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local refill_rate = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
        local tokens = tonumber(bucket[1]) or capacity
        local last_refill = tonumber(bucket[2]) or now

        -- Calculate tokens to add based on time elapsed
        local elapsed = now - last_refill
        local tokens_to_add = elapsed * refill_rate
        tokens = math.min(capacity, tokens + tokens_to_add)

        -- Try to consume a token
        if tokens >= 1 then
            tokens = tokens - 1
            redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
            redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
            return 1
        else
            redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
            return 0
        end
    `)

    result, _ := script.Run(ctx, r.redis, []string{bucketKey},
        r.capacity, r.refillRate, float64(now.UnixNano())/1e9).Int()

    return result == 1
}
```

### Quick Reference: Distributed System Patterns Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| No virtual nodes | Hot spots, uneven distribution | 150+ virtual nodes per physical node |
| No fencing token | Split-brain, duplicate processing | Fencing tokens validated at storage |
| Aggressive circuit | Unnecessary downtime | Error classification, minimum requests |
| Retry without idempotency | Duplicate charges/operations | Idempotency keys, result caching |
| Synchronized reset | Thundering herd at reset | Sliding window, jitter, token bucket |

### Junior -> FAANG: Learning from Incident Reports

The five pitfalls in this section are presented as incident reports because that is how engineers actually learn production lessons. Incident reports have a standard structure: the symptom (what the user experienced), the timeline (when things went wrong and in what order), the root cause (what actually failed), and the fix (what was changed). Practicing writing and reading incident reports is a skill that FAANG interviews sometimes probe directly.

For the consistent hashing pitfall: the symptom was a single cache node receiving 60% of traffic. This is observable with a `rate(cache_requests_total{node="..."})` metric. The root cause (no virtual nodes) is diagnosable by printing the ring and counting entries per physical node. Practice framing it this way: "the monitoring alerted on elevated latency from one node, we checked request distribution and found 60% concentration, we checked the hash ring configuration and found it was using single-point placement."

For the GC pause pitfall: this is a classic race condition between a timer-based lease and a runtime event (garbage collection). The key learning is that process-level events (GC, thread scheduling) can violate assumptions about time that seemed reasonable in testing. Production systems must be designed assuming that any process can pause for an arbitrary duration at any point.

For the circuit breaker pitfall: the incident happened because the threshold was too sensitive (any error opened the circuit) rather than because circuit breakers are a bad idea. The lesson is that the threshold is a first-class configuration value that requires the same care as a database schema: it should be tested under load, reviewed by someone with production experience, and documented.

### Senior @ FAANG: Pitfalls as Architectural Review Signals

At the senior level, these pitfalls are not just individual mistakes. They are signals about gaps in your team's architectural review process.

The consistent hashing pitfall indicates the review process did not ask "what is the expected load distribution across nodes?" This question should appear in the design review checklist for any data partitioning decision. A simulation or calculation should accompany the design: "with N nodes and M virtual nodes, the expected standard deviation of key distribution is X%."

The GC pause pitfall indicates the review process did not ask "what is the worst-case execution time for the critical section?" For any code that holds a distributed lock, this question is mandatory. Measure p99.9 execution time in load testing, compare it against the lock TTL, and add a safety margin of at least 2x. If the critical section's p99.9 is 8 seconds and the lock TTL is 10 seconds, the design is one GC pause away from split-brain.

The thundering herd pitfall from Pitfall 5 indicates the review process did not ask "what happens at window boundary?" This is a specific case of a general principle: distributed systems must be reviewed for synchronized global events. Other examples: all instances reloading a configuration file at the same time (use jittered reload intervals), all instances rotating a TLS certificate at the same time (stagger certificate expiry across the fleet), and all instances publishing metrics at the same time (use randomized publish intervals within each metric collection window).

ADR requirement: for any pattern in this chapter, the ADR should include a "failure mode analysis" section that lists the top three ways the pattern can backfire and how each is mitigated. This forces engineers to think adversarially about their own designs before shipping, which is significantly cheaper than thinking adversarially during an incident at 2 AM.

---
