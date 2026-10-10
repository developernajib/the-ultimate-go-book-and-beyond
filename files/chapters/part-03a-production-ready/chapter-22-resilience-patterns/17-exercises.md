## Exercises

### Exercise 1: Circuit Breaker with Health Monitoring

Implement a circuit breaker that exposes health metrics and supports multiple trip conditions.

**Solution**:

This implementation uses the functional options pattern (`Option`) to configure the breaker, and accepts a pluggable `TripCondition`, a function that receives aggregate stats and returns `true` when the circuit should open. Three built-in trip conditions are provided: consecutive failure count, success rate threshold, and average latency threshold. A background health check goroutine can optionally probe the upstream service while the circuit is open, transitioning to half-open as soon as the probe succeeds rather than waiting for the full timeout.

```go
package circuit

import (
    "context"
    "errors"
    "sync"
    "time"
)

// TripCondition defines when circuit should open
type TripCondition func(stats Stats) bool

// Stats holds circuit breaker statistics
type Stats struct {
    TotalRequests        int64
    TotalSuccesses       int64
    TotalFailures        int64
    ConsecutiveFailures  int64
    ConsecutiveSuccesses int64 // resets on any failure; drives half-open -> closed
    SuccessRate          float64
    AverageResponseTime  time.Duration
    LastFailure          time.Time
}

// HealthyCircuitBreaker with comprehensive monitoring
type HealthyCircuitBreaker struct {
    mu sync.RWMutex

    name          string
    state         State
    stats         Stats
    tripCondition TripCondition
    timeout       time.Duration
    halfOpenMax   int

    // halfOpenInFlight counts probes STARTED and not yet finished. Gating on
    // completed probes would admit every concurrent caller at once.
    halfOpenInFlight int

    generation    int64
    expiry        time.Time

    // Response time tracking
    responseTimes []time.Duration
    maxSamples    int

    // Health check
    healthCheck func(context.Context) error
    healthCheckInterval time.Duration
    stopHealthCheck chan struct{}
}

// NewHealthyCircuitBreaker creates a circuit breaker with monitoring
func NewHealthyCircuitBreaker(name string, opts ...Option) *HealthyCircuitBreaker {
    cb := &HealthyCircuitBreaker{
        name:        name,
        state:       StateClosed,
        timeout:     30 * time.Second,
        halfOpenMax: 3,
        maxSamples:  100,
        tripCondition: DefaultTripCondition(),
        stopHealthCheck: make(chan struct{}),
    }

    for _, opt := range opts {
        opt(cb)
    }

    return cb
}

type Option func(*HealthyCircuitBreaker)

func WithTimeout(d time.Duration) Option {
    return func(cb *HealthyCircuitBreaker) {
        cb.timeout = d
    }
}

func WithTripCondition(tc TripCondition) Option {
    return func(cb *HealthyCircuitBreaker) {
        cb.tripCondition = tc
    }
}

func WithHealthCheck(check func(context.Context) error, interval time.Duration) Option {
    return func(cb *HealthyCircuitBreaker) {
        cb.healthCheck = check
        cb.healthCheckInterval = interval
    }
}

// DefaultTripCondition opens circuit after 5 consecutive failures
func DefaultTripCondition() TripCondition {
    return func(stats Stats) bool {
        return stats.ConsecutiveFailures >= 5
    }
}

// SuccessRateTripCondition opens when success rate drops below threshold
func SuccessRateTripCondition(threshold float64, minRequests int64) TripCondition {
    return func(stats Stats) bool {
        if stats.TotalRequests < minRequests {
            return false
        }
        return stats.SuccessRate < threshold
    }
}

// LatencyTripCondition opens when average latency exceeds threshold
func LatencyTripCondition(threshold time.Duration, minRequests int64) TripCondition {
    return func(stats Stats) bool {
        if stats.TotalRequests < minRequests {
            return false
        }
        return stats.AverageResponseTime > threshold
    }
}

// CombinedTripCondition combines multiple conditions with OR logic
func CombinedTripCondition(conditions ...TripCondition) TripCondition {
    return func(stats Stats) bool {
        for _, cond := range conditions {
            if cond(stats) {
                return true
            }
        }
        return false
    }
}

func (cb *HealthyCircuitBreaker) Execute(ctx context.Context, fn func() error) error {
    if err := cb.beforeRequest(); err != nil {
        return err
    }

    start := time.Now()
    err := fn()
    elapsed := time.Since(start)

    cb.afterRequest(err == nil, elapsed)
    return err
}

func (cb *HealthyCircuitBreaker) beforeRequest() error {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.updateState()

    switch cb.state {
    case StateOpen:
        return ErrCircuitOpen
    case StateHalfOpen:
        // Gate on probes IN FLIGHT. Two things make this the only correct
        // formulation:
        //
        //  1. Counting *completed* probes admits an unbounded stampede: while
        //     the first probe is still waiting on the recovering dependency,
        //     nothing has completed, so every concurrent caller passes.
        //  2. `TotalSuccesses - TotalFailures` is worse still. After the
        //     outage that opened the breaker, failures dominate, so the
        //     expression is NEGATIVE (say -6) and can never reach halfOpenMax.
        //     The gate is dead code.
        if cb.halfOpenInFlight >= cb.halfOpenMax {
            return ErrTooManyRequests
        }
        cb.halfOpenInFlight++ // reserve the slot under the same lock
    }

    return nil
}

func (cb *HealthyCircuitBreaker) afterRequest(success bool, elapsed time.Duration) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    cb.stats.TotalRequests++

    // Release the half-open slot this probe reserved in beforeRequest.
    // Forget this and halfOpenInFlight stays pinned at the max, so the
    // breaker rejects every later probe and can never close.
    if cb.state == StateHalfOpen && cb.halfOpenInFlight > 0 {
        cb.halfOpenInFlight--
    }

    // Track response time
    cb.responseTimes = append(cb.responseTimes, elapsed)
    if len(cb.responseTimes) > cb.maxSamples {
        cb.responseTimes = cb.responseTimes[1:]
    }
    cb.updateAverageResponseTime()

    if success {
        cb.stats.TotalSuccesses++
        cb.stats.ConsecutiveFailures = 0

        if cb.state == StateHalfOpen {
            // ConsecutiveSuccesses, not TotalSuccesses: the lifetime total
            // is already far above halfOpenMax on any busy breaker, so this
            // would close the circuit on the very first probe.
            cb.stats.ConsecutiveSuccesses++
            if cb.stats.ConsecutiveSuccesses >= int64(cb.halfOpenMax) {
                cb.setState(StateClosed)
            }
        }
    } else {
        cb.stats.TotalFailures++
        cb.stats.ConsecutiveFailures++
        cb.stats.ConsecutiveSuccesses = 0
        cb.stats.LastFailure = time.Now()

        if cb.state == StateClosed && cb.tripCondition(cb.stats) {
            cb.setState(StateOpen)
        } else if cb.state == StateHalfOpen {
            // One failed probe is enough: the dependency is still sick.
            cb.setState(StateOpen)
        }
    }

    cb.updateSuccessRate()
}

func (cb *HealthyCircuitBreaker) updateState() {
    if cb.state == StateOpen && time.Now().After(cb.expiry) {
        cb.setState(StateHalfOpen)
    }
}

func (cb *HealthyCircuitBreaker) setState(state State) {
    if cb.state == state {
        return
    }
    cb.state = state
    cb.generation++

    // Every transition starts a fresh half-open window. Without this reset,
    // a leftover in-flight count from a previous window silently shrinks
    // (or closes) the next one.
    cb.halfOpenInFlight = 0

    switch state {
    case StateOpen:
        cb.expiry = time.Now().Add(cb.timeout)
    case StateClosed, StateHalfOpen:
        cb.stats.ConsecutiveFailures = 0
        cb.stats.ConsecutiveSuccesses = 0
    }
}

func (cb *HealthyCircuitBreaker) updateSuccessRate() {
    if cb.stats.TotalRequests == 0 {
        cb.stats.SuccessRate = 1.0
        return
    }
    cb.stats.SuccessRate = float64(cb.stats.TotalSuccesses) / float64(cb.stats.TotalRequests)
}

func (cb *HealthyCircuitBreaker) updateAverageResponseTime() {
    if len(cb.responseTimes) == 0 {
        cb.stats.AverageResponseTime = 0
        return
    }

    var total time.Duration
    for _, rt := range cb.responseTimes {
        total += rt
    }
    cb.stats.AverageResponseTime = total / time.Duration(len(cb.responseTimes))
}

// Stats returns current statistics
func (cb *HealthyCircuitBreaker) Stats() Stats {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.stats
}

// State returns current state
func (cb *HealthyCircuitBreaker) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}

// StartHealthCheck starts background health checking
func (cb *HealthyCircuitBreaker) StartHealthCheck(ctx context.Context) {
    if cb.healthCheck == nil {
        return
    }

    go func() {
        ticker := time.NewTicker(cb.healthCheckInterval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-cb.stopHealthCheck:
                return
            case <-ticker.C:
                if cb.State() == StateOpen {
                    if err := cb.healthCheck(ctx); err == nil {
                        cb.mu.Lock()
                        cb.setState(StateHalfOpen)
                        cb.mu.Unlock()
                    }
                }
            }
        }
    }()
}

// Stop stops the health check
func (cb *HealthyCircuitBreaker) Stop() {
    close(cb.stopHealthCheck)
}
```

### Exercise 2: Adaptive Retry with Multiple Strategies

Build a retry system that adapts its strategy based on error types and system load.

**Solution**:

The `AdaptiveRetrier` classifies each error into one of four categories, transient, rate-limited, server error, or permanent, and selects a different backoff curve for each. It also tracks a sliding window of recent outcomes and adjusts the backoff multiplier dynamically: when the success rate is high, it reduces the multiplier to retry more aggressively. When failures dominate, it increases the multiplier to give the upstream more breathing room.

```go
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand/v2"
    "net"
    "time"
)

// ErrorClassifier categorizes errors for retry decisions
type ErrorClassifier func(error) ErrorClass

type ErrorClass int

const (
    ErrorClassTransient ErrorClass = iota // Retry immediately
    ErrorClassRateLimited                  // Retry with backoff
    ErrorClassServerError                  // Retry with longer backoff
    ErrorClassPermanent                    // Don't retry
    ErrorClassUnknown                      // Use default behavior
)

// AdaptiveRetrier adjusts strategy based on error type and history
type AdaptiveRetrier struct {
    config         Config
    classifier     ErrorClassifier
    successHistory []bool
    historySize    int

    // Adaptive parameters
    currentMultiplier float64
    baseMultiplier    float64
    maxMultiplier     float64
}

type Config struct {
    MaxRetries      int
    InitialInterval time.Duration
    MaxInterval     time.Duration
    BaseMultiplier  float64
    MaxMultiplier   float64
    HistorySize     int
}

// No Jitter knob: full jitter is not a tunable, it is the algorithm.
// A "jitter percentage" invites someone to set it to 0.1 and believe they
// are protected from thundering herds when they are not.
func DefaultAdaptiveConfig() Config {
    return Config{
        MaxRetries:      5,
        InitialInterval: 100 * time.Millisecond,
        MaxInterval:     60 * time.Second,
        BaseMultiplier:  2.0,
        MaxMultiplier:   4.0,
        HistorySize:     20,
    }
}

func NewAdaptiveRetrier(config Config, classifier ErrorClassifier) *AdaptiveRetrier {
    if classifier == nil {
        classifier = DefaultErrorClassifier
    }

    return &AdaptiveRetrier{
        config:            config,
        classifier:        classifier,
        successHistory:    make([]bool, 0, config.HistorySize),
        historySize:       config.HistorySize,
        currentMultiplier: config.BaseMultiplier,
        baseMultiplier:    config.BaseMultiplier,
        maxMultiplier:     config.MaxMultiplier,
    }
}

// DefaultErrorClassifier provides sensible error classification
func DefaultErrorClassifier(err error) ErrorClass {
    if err == nil {
        return ErrorClassPermanent // No error, don't retry
    }

    // Check for context errors
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        return ErrorClassPermanent
    }

    // Check for network errors
    var netErr net.Error
    if errors.As(err, &netErr) {
        if netErr.Timeout() {
            return ErrorClassTransient
        }
        return ErrorClassServerError
    }

    // Check for specific error types
    var rateLimitErr *RateLimitError
    if errors.As(err, &rateLimitErr) {
        return ErrorClassRateLimited
    }

    var serverErr *ServerError
    if errors.As(err, &serverErr) {
        if serverErr.StatusCode >= 500 {
            return ErrorClassServerError
        }
        if serverErr.StatusCode >= 400 {
            return ErrorClassPermanent
        }
    }

    return ErrorClassUnknown
}

type RateLimitError struct {
    RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
    return "rate limited"
}

type ServerError struct {
    StatusCode int
    Message    string
}

func (e *ServerError) Error() string {
    return e.Message
}

// Do executes with adaptive retry logic
func (r *AdaptiveRetrier) Do(ctx context.Context, fn func() error) error {
    var lastErr error
    interval := r.config.InitialInterval

    for attempt := 0; attempt <= r.config.MaxRetries; attempt++ {
        err := fn()
        if err == nil {
            r.recordSuccess()
            return nil
        }

        lastErr = err
        errorClass := r.classifier(err)

        // Don't retry permanent errors
        if errorClass == ErrorClassPermanent {
            r.recordFailure()
            return err
        }

        if attempt >= r.config.MaxRetries {
            break
        }

        // Calculate wait based on error class
        wait := r.calculateWait(interval, errorClass, err)

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(wait):
        }

        // Update interval for next attempt
        interval = r.nextInterval(interval, errorClass)
        r.recordFailure()
    }

    return lastErr
}

func (r *AdaptiveRetrier) calculateWait(base time.Duration, class ErrorClass, err error) time.Duration {
    var ceiling time.Duration

    // serverDirected: the server told us exactly when to come back, so the
    // value is an instruction rather than a ceiling to draw from.
    serverDirected := false

    switch class {
    case ErrorClassTransient:
        // Immediate retry with small delay
        ceiling = time.Duration(float64(base) * 0.5)

    case ErrorClassRateLimited:
        // Respect Retry-After if provided
        var rateLimitErr *RateLimitError
        if errors.As(err, &rateLimitErr) && rateLimitErr.RetryAfter > 0 {
            ceiling = rateLimitErr.RetryAfter
            serverDirected = true
        } else {
            ceiling = time.Duration(float64(base) * r.currentMultiplier * 2)
        }

    case ErrorClassServerError:
        // Longer backoff for server errors
        ceiling = time.Duration(float64(base) * r.currentMultiplier)

    default:
        ceiling = base
    }

    // Clamp BEFORE drawing, so `ceiling` really is the upper bound.
    if ceiling > r.config.MaxInterval {
        ceiling = r.config.MaxInterval
    }
    if ceiling <= 0 {
        ceiling = r.config.InitialInterval
    }

    if serverDirected {
        // Jittering a Retry-After downward would return EARLIER than the
        // server permitted, which is how a 429 turns into a ban. Add a small
        // positive spread instead, never a negative one.
        return ceiling + time.Duration(rand.Int64N(int64(time.Second)))
    }

    // Full jitter: draw uniformly from [0, ceiling). The exponential curve
    // bounds the RANGE - the sleep is drawn from inside it. A proportional
    // "+/- 30%" nudge leaves every client clustered around the same instant
    // and does not break up the herd.
    return time.Duration(rand.Int64N(int64(ceiling)))
}

func (r *AdaptiveRetrier) nextInterval(current time.Duration, class ErrorClass) time.Duration {
    multiplier := r.currentMultiplier

    switch class {
    case ErrorClassTransient:
        multiplier = 1.5 // Slower growth for transient errors
    case ErrorClassRateLimited:
        multiplier = r.currentMultiplier * 1.5 // Faster growth for rate limiting
    case ErrorClassServerError:
        multiplier = r.currentMultiplier
    }

    next := time.Duration(float64(current) * multiplier)
    if next > r.config.MaxInterval {
        next = r.config.MaxInterval
    }
    return next
}

func (r *AdaptiveRetrier) recordSuccess() {
    r.successHistory = append(r.successHistory, true)
    if len(r.successHistory) > r.historySize {
        r.successHistory = r.successHistory[1:]
    }
    r.adaptMultiplier()
}

func (r *AdaptiveRetrier) recordFailure() {
    r.successHistory = append(r.successHistory, false)
    if len(r.successHistory) > r.historySize {
        r.successHistory = r.successHistory[1:]
    }
    r.adaptMultiplier()
}

// adaptMultiplier adjusts the backoff multiplier based on recent history
func (r *AdaptiveRetrier) adaptMultiplier() {
    if len(r.successHistory) < 5 {
        return
    }

    // Calculate recent success rate
    successes := 0
    for _, success := range r.successHistory {
        if success {
            successes++
        }
    }
    successRate := float64(successes) / float64(len(r.successHistory))

    // Adjust multiplier based on success rate
    if successRate > 0.8 {
        // Things are going well, can be more aggressive
        r.currentMultiplier = math.Max(r.baseMultiplier, r.currentMultiplier*0.9)
    } else if successRate < 0.5 {
        // Many failures, back off more
        r.currentMultiplier = math.Min(r.maxMultiplier, r.currentMultiplier*1.2)
    }
}

// Stats returns retry statistics
func (r *AdaptiveRetrier) Stats() RetryStats {
    successes := 0
    for _, s := range r.successHistory {
        if s {
            successes++
        }
    }

    return RetryStats{
        RecentSuccessRate: float64(successes) / float64(max(len(r.successHistory), 1)),
        CurrentMultiplier: r.currentMultiplier,
        HistorySize:       len(r.successHistory),
    }
}

type RetryStats struct {
    RecentSuccessRate float64
    CurrentMultiplier float64
    HistorySize       int
}
```

### Exercise 3: Distributed Rate Limiter with Redis

Implement a rate limiter that works across multiple service instances using Redis.

**Solution**:

This limiter supports three algorithms, sliding window, token bucket, and leaky bucket, each implemented as an atomic Lua script executed on the Redis server. Lua scripts run as a single atomic operation in Redis, eliminating race conditions between multiple service instances without requiring distributed locks. The `Allow` method returns a `Result` struct containing not just the allow/deny decision but also the remaining quota and a `RetryAfter` duration, which the HTTP middleware sets as standard rate-limit response headers.

```go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

// Algorithm defines the rate limiting algorithm
type Algorithm int

const (
    AlgorithmSlidingWindow Algorithm = iota
    AlgorithmTokenBucket
    AlgorithmLeakyBucket
)

// DistributedLimiter provides rate limiting across multiple instances
type DistributedLimiter struct {
    redis     *redis.Client
    keyPrefix string
    limit     int
    window    time.Duration
    algorithm Algorithm
}

type Config struct {
    Redis     *redis.Client
    KeyPrefix string
    Limit     int
    Window    time.Duration
    Algorithm Algorithm
}

func NewDistributedLimiter(config Config) *DistributedLimiter {
    return &DistributedLimiter{
        redis:     config.Redis,
        keyPrefix: config.KeyPrefix,
        limit:     config.Limit,
        window:    config.Window,
        algorithm: config.Algorithm,
    }
}

// Result contains rate limit decision and metadata
type Result struct {
    Allowed    bool
    Remaining  int
    ResetAt    time.Time
    RetryAfter time.Duration
}

// Allow checks if request should be allowed
func (l *DistributedLimiter) Allow(ctx context.Context, identifier string) (Result, error) {
    switch l.algorithm {
    case AlgorithmSlidingWindow:
        return l.slidingWindowAllow(ctx, identifier)
    case AlgorithmTokenBucket:
        return l.tokenBucketAllow(ctx, identifier)
    case AlgorithmLeakyBucket:
        return l.leakyBucketAllow(ctx, identifier)
    default:
        return l.slidingWindowAllow(ctx, identifier)
    }
}

// Sliding Window implementation
func (l *DistributedLimiter) slidingWindowAllow(ctx context.Context, identifier string) (Result, error) {
    key := fmt.Sprintf("%s:sliding:%s", l.keyPrefix, identifier)
    now := time.Now()
    windowStart := now.Add(-l.window).UnixMicro()
    nowMicro := now.UnixMicro()

    // Lua script for atomic sliding window operation
    script := redis.NewScript(`
        local key = KEYS[1]
        local window_start = tonumber(ARGV[1])
        local now = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local window_ms = tonumber(ARGV[4])

        -- Remove old entries
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current entries
        local count = redis.call('ZCARD', key)

        if count < limit then
            -- Add new entry
            redis.call('ZADD', key, now, now)
            redis.call('PEXPIRE', key, window_ms)
            return {1, limit - count - 1}
        else
            -- Get oldest entry to calculate retry time
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local retry_after = 0
            if #oldest > 0 then
                retry_after = tonumber(oldest[2]) + window_ms * 1000 - now
            end
            return {0, 0, retry_after}
        end
    `)

    result, err := script.Run(ctx, l.redis, []string{key},
        windowStart,
        nowMicro,
        l.limit,
        l.window.Milliseconds(),
    ).Slice()

    if err != nil {
        return Result{}, fmt.Errorf("sliding window script: %w", err)
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))

    var retryAfter time.Duration
    if !allowed && len(result) > 2 {
        retryAfter = time.Duration(result[2].(int64)) * time.Microsecond
    }

    return Result{
        Allowed:    allowed,
        Remaining:  remaining,
        ResetAt:    now.Add(l.window),
        RetryAfter: retryAfter,
    }, nil
}

// Token Bucket implementation
func (l *DistributedLimiter) tokenBucketAllow(ctx context.Context, identifier string) (Result, error) {
    key := fmt.Sprintf("%s:bucket:%s", l.keyPrefix, identifier)
    now := time.Now()

    // Lua script for atomic token bucket operation
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local limit = tonumber(ARGV[2])
        local refill_rate = tonumber(ARGV[3]) -- tokens per second
        local window_ms = tonumber(ARGV[4])

        -- Get current state
        local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
        local tokens = tonumber(bucket[1]) or limit
        local last_update = tonumber(bucket[2]) or now

        -- Calculate tokens to add
        local elapsed = (now - last_update) / 1000000 -- convert to seconds
        local new_tokens = elapsed * refill_rate
        tokens = math.min(limit, tokens + new_tokens)

        if tokens >= 1 then
            -- Consume a token
            tokens = tokens - 1
            redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
            redis.call('PEXPIRE', key, window_ms)
            return {1, math.floor(tokens)}
        else
            -- Calculate when next token available
            local time_for_token = (1 - tokens) / refill_rate * 1000000 -- in microseconds
            redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
            redis.call('PEXPIRE', key, window_ms)
            return {0, 0, time_for_token}
        end
    `)

    refillRate := float64(l.limit) / l.window.Seconds()

    result, err := script.Run(ctx, l.redis, []string{key},
        now.UnixMicro(),
        l.limit,
        refillRate,
        l.window.Milliseconds()*2, // Keep bucket alive longer
    ).Slice()

    if err != nil {
        return Result{}, fmt.Errorf("token bucket script: %w", err)
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))

    var retryAfter time.Duration
    if !allowed && len(result) > 2 {
        retryAfter = time.Duration(result[2].(int64)) * time.Microsecond
    }

    return Result{
        Allowed:    allowed,
        Remaining:  remaining,
        ResetAt:    now.Add(l.window),
        RetryAfter: retryAfter,
    }, nil
}

// Leaky Bucket implementation
func (l *DistributedLimiter) leakyBucketAllow(ctx context.Context, identifier string) (Result, error) {
    key := fmt.Sprintf("%s:leaky:%s", l.keyPrefix, identifier)
    now := time.Now()

    // Leaky bucket: requests drain at constant rate
    script := redis.NewScript(`
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local limit = tonumber(ARGV[2])
        local leak_rate = tonumber(ARGV[3]) -- requests per second
        local window_ms = tonumber(ARGV[4])

        -- Get current water level
        local bucket = redis.call('HMGET', key, 'water', 'last_leak')
        local water = tonumber(bucket[1]) or 0
        local last_leak = tonumber(bucket[2]) or now

        -- Calculate leaked water
        local elapsed = (now - last_leak) / 1000000 -- convert to seconds
        local leaked = elapsed * leak_rate
        water = math.max(0, water - leaked)

        if water < limit then
            -- Add water (accept request)
            water = water + 1
            redis.call('HMSET', key, 'water', water, 'last_leak', now)
            redis.call('PEXPIRE', key, window_ms)
            return {1, math.floor(limit - water)}
        else
            -- Bucket full, calculate wait time
            local wait_time = (water - limit + 1) / leak_rate * 1000000
            redis.call('HMSET', key, 'water', water, 'last_leak', now)
            redis.call('PEXPIRE', key, window_ms)
            return {0, 0, wait_time}
        end
    `)

    leakRate := float64(l.limit) / l.window.Seconds()

    result, err := script.Run(ctx, l.redis, []string{key},
        now.UnixMicro(),
        l.limit,
        leakRate,
        l.window.Milliseconds()*2,
    ).Slice()

    if err != nil {
        return Result{}, fmt.Errorf("leaky bucket script: %w", err)
    }

    allowed := result[0].(int64) == 1
    remaining := int(result[1].(int64))

    var retryAfter time.Duration
    if !allowed && len(result) > 2 {
        retryAfter = time.Duration(result[2].(int64)) * time.Microsecond
    }

    return Result{
        Allowed:    allowed,
        Remaining:  remaining,
        ResetAt:    now.Add(l.window),
        RetryAfter: retryAfter,
    }, nil
}

// Middleware creates HTTP middleware for rate limiting
func (l *DistributedLimiter) Middleware(identifierFunc func(r *http.Request) string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            identifier := identifierFunc(r)
            result, err := l.Allow(r.Context(), identifier)

            if err != nil {
                http.Error(w, "Rate limit error", http.StatusInternalServerError)
                return
            }

            // Set rate limit headers
            w.Header().Set("X-RateLimit-Limit", strconv.Itoa(l.limit))
            w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(result.Remaining))
            w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(result.ResetAt.Unix(), 10))

            if !result.Allowed {
                w.Header().Set("Retry-After", strconv.Itoa(int(result.RetryAfter.Seconds())))
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Exercise 4: Complete Resilient Service Integration

Combine all patterns into a production-ready resilient service client.

**Solution**:

The `ServiceClient` composes all four resilience layers in the correct order: rate limiter (outermost) → bulkhead → circuit breaker → adaptive retry (innermost). Each layer acts on the right failure scope, the rate limiter rejects excess traffic before it enters the bulkhead, and the circuit breaker short-circuits the retry loop when the upstream is confirmed down. Per-endpoint fallback registration allows different degradation strategies for different API paths, and a `Health` method exposes the state of every layer for operational dashboards.

Note the breaker-outside-retry nesting here is the slower-to-trip arrangement documented in 22.8 and 22.9: one logical operation casts a single breaker vote, so a `ConsecutiveFailures > 5` policy needs many real requests before it opens. It is kept here so the exercise matches the flagship client - invert the two layers if you want the breaker to shed load promptly.

```go
package resilient

import (
    "context"
    "errors"
    "fmt"
    "net/http"
    "strconv"
    "sync"
    "time"
)

// ServiceClient provides a fully resilient service client
type ServiceClient struct {
    name           string
    baseURL        string
    httpClient     *http.Client

    circuitBreaker *HealthyCircuitBreaker
    retrier        *AdaptiveRetrier
    bulkhead       *Bulkhead
    rateLimiter    *DistributedLimiter

    fallbacks      map[string]FallbackFunc
    mu             sync.RWMutex

    metrics        *Metrics
}

type FallbackFunc func(ctx context.Context, req *http.Request, err error) (*http.Response, error)

type ClientConfig struct {
    Name    string
    BaseURL string

    // Circuit breaker
    CBTimeout       time.Duration
    CBTripCondition TripCondition

    // Retry
    RetryConfig Config

    // Bulkhead
    BulkheadMax     int
    BulkheadTimeout time.Duration

    // Rate limit
    RateLimiter *DistributedLimiter

    // HTTP
    HTTPTimeout time.Duration
}

func DefaultClientConfig(name, baseURL string) ClientConfig {
    return ClientConfig{
        Name:            name,
        BaseURL:         baseURL,
        CBTimeout:       30 * time.Second,
        CBTripCondition: DefaultTripCondition(),
        RetryConfig:     DefaultAdaptiveConfig(),
        BulkheadMax:     50,
        BulkheadTimeout: 30 * time.Second,
        HTTPTimeout:     30 * time.Second,
    }
}

func NewServiceClient(config ClientConfig) *ServiceClient {
    client := &ServiceClient{
        name:      config.Name,
        baseURL:   config.BaseURL,
        fallbacks: make(map[string]FallbackFunc),
        metrics:   NewMetrics(config.Name),
    }

    client.httpClient = &http.Client{
        Timeout: config.HTTPTimeout,
    }

    client.circuitBreaker = NewHealthyCircuitBreaker(
        config.Name,
        WithTimeout(config.CBTimeout),
        WithTripCondition(config.CBTripCondition),
    )

    client.retrier = NewAdaptiveRetrier(
        config.RetryConfig,
        DefaultErrorClassifier,
    )

    client.bulkhead = NewBulkhead(config.BulkheadMax, config.BulkheadTimeout)
    client.rateLimiter = config.RateLimiter

    return client
}

// RegisterFallback registers a fallback for a specific endpoint pattern
func (c *ServiceClient) RegisterFallback(pattern string, fn FallbackFunc) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.fallbacks[pattern] = fn
}

// Do executes a request with full resilience
func (c *ServiceClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    start := time.Now()
    defer func() {
        c.metrics.RecordLatency(time.Since(start))
    }()

    // Layer 1: Rate limiting (if configured)
    if c.rateLimiter != nil {
        result, err := c.rateLimiter.Allow(ctx, c.name)
        if err != nil {
            c.metrics.RecordError("rate_limit_error")
            return nil, fmt.Errorf("rate limiter error: %w", err)
        }
        if !result.Allowed {
            c.metrics.RecordRejection("rate_limited")
            return c.handleFallback(ctx, req, errors.New("rate limited"))
        }
    }

    // Layer 2: Bulkhead
    var resp *http.Response
    err := c.bulkhead.Execute(ctx, func() error {
        var execErr error
        resp, execErr = c.executeWithCircuitAndRetry(ctx, req)
        return execErr
    })

    if err != nil {
        if errors.Is(err, ErrBulkheadTimeout) || errors.Is(err, ErrBulkheadFull) {
            c.metrics.RecordRejection("bulkhead")
        }
        return c.handleFallback(ctx, req, err)
    }

    c.metrics.RecordSuccess()
    return resp, nil
}

func (c *ServiceClient) executeWithCircuitAndRetry(ctx context.Context, req *http.Request) (*http.Response, error) {
    var resp *http.Response

    // Layer 3: Circuit breaker
    err := c.circuitBreaker.Execute(ctx, func() error {
        // Layer 4: Retry
        return c.retrier.Do(ctx, func() error {
            var err error
            resp, err = c.doRequest(ctx, req)
            return err
        })
    })

    if err != nil {
        if errors.Is(err, ErrCircuitOpen) {
            c.metrics.RecordRejection("circuit_open")
        } else {
            c.metrics.RecordError("request_failed")
        }
        return nil, err
    }

    return resp, nil
}

func (c *ServiceClient) doRequest(ctx context.Context, req *http.Request) (*http.Response, error) {
    req = req.Clone(ctx)
    req.URL.Host = c.baseURL

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }

    // Check for error status codes
    if resp.StatusCode >= 500 {
        resp.Body.Close()
        return nil, &ServerError{
            StatusCode: resp.StatusCode,
            Message:    fmt.Sprintf("server error: %d", resp.StatusCode),
        }
    }

    if resp.StatusCode == http.StatusTooManyRequests {
        resp.Body.Close()
        retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
        return nil, &RateLimitError{RetryAfter: retryAfter}
    }

    if resp.StatusCode >= 400 {
        resp.Body.Close()
        return nil, &ClientError{
            StatusCode: resp.StatusCode,
            Message:    fmt.Sprintf("client error: %d", resp.StatusCode),
        }
    }

    return resp, nil
}

func (c *ServiceClient) handleFallback(ctx context.Context, req *http.Request, err error) (*http.Response, error) {
    c.mu.RLock()
    fallback, ok := c.fallbacks[req.URL.Path]
    c.mu.RUnlock()

    if !ok {
        // Try wildcard fallback
        c.mu.RLock()
        fallback, ok = c.fallbacks["*"]
        c.mu.RUnlock()
    }

    if ok {
        c.metrics.RecordFallback()
        return fallback(ctx, req, err)
    }

    return nil, err
}

// Health returns service health status
func (c *ServiceClient) Health() ServiceHealth {
    return ServiceHealth{
        Name:           c.name,
        CircuitState:   c.circuitBreaker.State().String(),
        CircuitStats:   c.circuitBreaker.Stats(),
        RetryStats:     c.retrier.Stats(),
        BulkheadStats:  c.bulkhead.Stats(),
        Metrics:        c.metrics.Snapshot(),
    }
}

type ServiceHealth struct {
    Name          string
    CircuitState  string
    CircuitStats  Stats
    RetryStats    RetryStats
    BulkheadStats BulkheadStats
    Metrics       MetricsSnapshot
}

type ClientError struct {
    StatusCode int
    Message    string
}

func (e *ClientError) Error() string { return e.Message }

func parseRetryAfter(header string) time.Duration {
    if header == "" {
        return 0
    }

    // Try parsing as seconds
    if seconds, err := strconv.Atoi(header); err == nil {
        return time.Duration(seconds) * time.Second
    }

    // Try parsing as HTTP date
    if t, err := http.ParseTime(header); err == nil {
        return time.Until(t)
    }

    return 0
}

// Metrics tracks client performance
type Metrics struct {
    name          string
    mu            sync.RWMutex
    totalRequests int64
    successes     int64
    failures      int64
    rejections    map[string]int64
    errors        map[string]int64
    fallbacks     int64
    latencies     []time.Duration
    maxLatencies  int
}

func NewMetrics(name string) *Metrics {
    return &Metrics{
        name:         name,
        rejections:   make(map[string]int64),
        errors:       make(map[string]int64),
        maxLatencies: 1000,
    }
}

func (m *Metrics) RecordSuccess() {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.totalRequests++
    m.successes++
}

func (m *Metrics) RecordRejection(reason string) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.totalRequests++
    m.rejections[reason]++
}

func (m *Metrics) RecordError(errorType string) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.totalRequests++
    m.failures++
    m.errors[errorType]++
}

func (m *Metrics) RecordFallback() {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.fallbacks++
}

func (m *Metrics) RecordLatency(d time.Duration) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.latencies = append(m.latencies, d)
    if len(m.latencies) > m.maxLatencies {
        m.latencies = m.latencies[1:]
    }
}

func (m *Metrics) Snapshot() MetricsSnapshot {
    m.mu.RLock()
    defer m.mu.RUnlock()

    snapshot := MetricsSnapshot{
        TotalRequests: m.totalRequests,
        Successes:     m.successes,
        Failures:      m.failures,
        Fallbacks:     m.fallbacks,
        Rejections:    make(map[string]int64),
        Errors:        make(map[string]int64),
    }

    for k, v := range m.rejections {
        snapshot.Rejections[k] = v
    }
    for k, v := range m.errors {
        snapshot.Errors[k] = v
    }

    if len(m.latencies) > 0 {
        var total time.Duration
        for _, l := range m.latencies {
            total += l
        }
        snapshot.AvgLatency = total / time.Duration(len(m.latencies))
    }

    if m.totalRequests > 0 {
        snapshot.SuccessRate = float64(m.successes) / float64(m.totalRequests)
    }

    return snapshot
}

type MetricsSnapshot struct {
    TotalRequests int64
    Successes     int64
    Failures      int64
    Fallbacks     int64
    Rejections    map[string]int64
    Errors        map[string]int64
    AvgLatency    time.Duration
    SuccessRate   float64
}
```

### Exercise 5: Chaos Testing Framework

Build a framework for testing resilience patterns with fault injection.

**Solution**:

The `ChaosTransport` implements `http.RoundTripper` and wraps the real transport with configurable fault injection, latency spikes, random errors, and full timeouts, each applied with a configurable probability. An `atomic.Bool` toggle lets tests enable and disable faults without restarting the client. The `ChaosRunner` drives a test scenario for a specified duration, collects success rates and latency percentiles, and runs assertions to verify that the resilience layers behaved correctly under the injected conditions.

```go
package chaos

import (
    "context"
    "errors"
    "fmt"
    "math/rand/v2"
    "net/http"
    "sort"
    "sync/atomic"
    "time"
)

// Fault defines injectable faults
type Fault interface {
    Apply(ctx context.Context, req *http.Request) error
    ShouldApply() bool
}

// LatencyFault injects network latency
type LatencyFault struct {
    MinLatency  time.Duration
    MaxLatency  time.Duration
    Probability float64
}

func (f *LatencyFault) ShouldApply() bool {
    return rand.Float64() < f.Probability
}

func (f *LatencyFault) Apply(ctx context.Context, req *http.Request) error {
    latency := f.MinLatency
    if f.MaxLatency > f.MinLatency {
        delta := f.MaxLatency - f.MinLatency
        latency += time.Duration(rand.Int64N(int64(delta)))
    }

    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(latency):
        return nil
    }
}

// ErrorFault injects errors
type ErrorFault struct {
    Error       error
    StatusCode  int
    Probability float64
}

func (f *ErrorFault) ShouldApply() bool {
    return rand.Float64() < f.Probability
}

func (f *ErrorFault) Apply(ctx context.Context, req *http.Request) error {
    return f.Error
}

// TimeoutFault causes requests to timeout
type TimeoutFault struct {
    Probability float64
}

func (f *TimeoutFault) ShouldApply() bool {
    return rand.Float64() < f.Probability
}

func (f *TimeoutFault) Apply(ctx context.Context, req *http.Request) error {
    <-ctx.Done()
    return ctx.Err()
}

// ChaosTransport wraps http.Transport with fault injection
type ChaosTransport struct {
    Transport http.RoundTripper
    Faults    []Fault
    enabled   atomic.Bool
}

func NewChaosTransport(base http.RoundTripper) *ChaosTransport {
    if base == nil {
        base = http.DefaultTransport
    }
    ct := &ChaosTransport{
        Transport: base,
        Faults:    make([]Fault, 0),
    }
    ct.enabled.Store(false)
    return ct
}

func (t *ChaosTransport) AddFault(fault Fault) {
    t.Faults = append(t.Faults, fault)
}

func (t *ChaosTransport) Enable()  { t.enabled.Store(true) }
func (t *ChaosTransport) Disable() { t.enabled.Store(false) }

func (t *ChaosTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    if !t.enabled.Load() {
        return t.Transport.RoundTrip(req)
    }

    // Apply faults
    for _, fault := range t.Faults {
        if fault.ShouldApply() {
            if err := fault.Apply(req.Context(), req); err != nil {
                return nil, err
            }
        }
    }

    return t.Transport.RoundTrip(req)
}

// ChaosTest defines a chaos testing scenario
type ChaosTest struct {
    Name        string
    Description string
    Faults      []Fault
    Duration    time.Duration
    Assertions  []Assertion
}

type Assertion func(results *TestResults) error

type TestResults struct {
    TotalRequests    int64
    SuccessfulReqs   int64
    FailedReqs       int64
    TimeoutReqs      int64
    CircuitOpenCount int64
    FallbackCount    int64
    AvgLatency       time.Duration
    P99Latency       time.Duration
}

// ChaosRunner executes chaos tests
type ChaosRunner struct {
    client    *ServiceClient
    transport *ChaosTransport
}

func NewChaosRunner(client *ServiceClient, transport *ChaosTransport) *ChaosRunner {
    return &ChaosRunner{
        client:    client,
        transport: transport,
    }
}

func (r *ChaosRunner) Run(ctx context.Context, test ChaosTest) (*TestResults, error) {
    // Configure faults
    r.transport.Faults = test.Faults
    r.transport.Enable()
    defer r.transport.Disable()

    results := &TestResults{}
    latencies := make([]time.Duration, 0)

    // Run test for duration
    ctx, cancel := context.WithTimeout(ctx, test.Duration)
    defer cancel()

    done := make(chan struct{})
    go func() {
        ticker := time.NewTicker(100 * time.Millisecond)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                close(done)
                return
            case <-ticker.C:
                start := time.Now()
                req, _ := http.NewRequestWithContext(ctx, "GET", "/test", nil)

                resp, err := r.client.Do(ctx, req)
                latency := time.Since(start)
                latencies = append(latencies, latency)

                atomic.AddInt64(&results.TotalRequests, 1)

                if err != nil {
                    atomic.AddInt64(&results.FailedReqs, 1)
                    if errors.Is(err, context.DeadlineExceeded) {
                        atomic.AddInt64(&results.TimeoutReqs, 1)
                    }
                    if errors.Is(err, ErrCircuitOpen) {
                        atomic.AddInt64(&results.CircuitOpenCount, 1)
                    }
                } else {
                    resp.Body.Close()
                    atomic.AddInt64(&results.SuccessfulReqs, 1)
                }
            }
        }
    }()

    <-done

    // Calculate latency stats
    if len(latencies) > 0 {
        var total time.Duration
        for _, l := range latencies {
            total += l
        }
        results.AvgLatency = total / time.Duration(len(latencies))

        // Sort for percentiles
        sort.Slice(latencies, func(i, j int) bool {
            return latencies[i] < latencies[j]
        })
        p99Index := int(float64(len(latencies)) * 0.99)
        if p99Index >= len(latencies) {
            p99Index = len(latencies) - 1
        }
        results.P99Latency = latencies[p99Index]
    }

    // Run assertions
    for _, assert := range test.Assertions {
        if err := assert(results); err != nil {
            return results, fmt.Errorf("assertion failed: %w", err)
        }
    }

    return results, nil
}

// Common assertions
func AssertSuccessRateAbove(threshold float64) Assertion {
    return func(r *TestResults) error {
        rate := float64(r.SuccessfulReqs) / float64(r.TotalRequests)
        if rate < threshold {
            return fmt.Errorf("success rate %.2f below threshold %.2f", rate, threshold)
        }
        return nil
    }
}

func AssertP99LatencyBelow(threshold time.Duration) Assertion {
    return func(r *TestResults) error {
        if r.P99Latency > threshold {
            return fmt.Errorf("P99 latency %v exceeds threshold %v", r.P99Latency, threshold)
        }
        return nil
    }
}

func AssertCircuitOpened() Assertion {
    return func(r *TestResults) error {
        if r.CircuitOpenCount == 0 {
            return fmt.Errorf("circuit breaker never opened")
        }
        return nil
    }
}

// Example test suite
func ExampleChaosTests() []ChaosTest {
    return []ChaosTest{
        {
            Name:        "High Latency",
            Description: "Test behavior under 500ms latency",
            Faults: []Fault{
                &LatencyFault{
                    MinLatency:  400 * time.Millisecond,
                    MaxLatency:  600 * time.Millisecond,
                    Probability: 1.0,
                },
            },
            Duration: 30 * time.Second,
            Assertions: []Assertion{
                AssertSuccessRateAbove(0.95),
                AssertP99LatencyBelow(2 * time.Second),
            },
        },
        {
            Name:        "Intermittent Failures",
            Description: "Test circuit breaker with 50% failure rate",
            Faults: []Fault{
                &ErrorFault{
                    Error:       errors.New("service unavailable"),
                    Probability: 0.5,
                },
            },
            Duration: 60 * time.Second,
            Assertions: []Assertion{
                AssertCircuitOpened(),
                AssertSuccessRateAbove(0.70), // With fallbacks
            },
        },
        {
            Name:        "Cascade Failure",
            Description: "Test behavior when dependency completely fails",
            Faults: []Fault{
                &ErrorFault{
                    Error:       errors.New("connection refused"),
                    Probability: 1.0,
                },
            },
            Duration: 30 * time.Second,
            Assertions: []Assertion{
                AssertCircuitOpened(),
            },
        },
    }
}
```

### Senior at FAANG Track

For one service, verify all external calls have: timeout, circuit breaker, retry with jitter, and fallback. Document gaps and close them.

Run a chaos test: inject downstream latency and verify the service degrades gracefully, not catastrophically.

### Staff / Principal Track

Standardize resilience patterns across the org via shared library or mesh configuration. Drive adoption.

Implement retry budget at the org level. Measure retry amplification during outages.

Build a resilience readiness check as part of production launch criteria. No service ships without it.
