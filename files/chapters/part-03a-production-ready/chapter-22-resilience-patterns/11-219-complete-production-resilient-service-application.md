## 22.9 Complete Production Resilient Service Application

This section assembles a production-grade resilient HTTP client that combines all patterns from this chapter with Prometheus observability:

### Project Structure

```
resilient/
├── circuit/
│   └── breaker.go
├── retry/
│   └── retry.go
├── bulkhead/
│   └── bulkhead.go
├── ratelimit/
│   └── limiter.go
├── fallback/
│   └── fallback.go
├── client/
│   └── resilient.go
├── metrics/
│   └── metrics.go
├── main.go
├── go.mod
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

### circuit/breaker.go

This file implements the classic three-state circuit breaker (closed, open, half-open) backed by a generation counter that prevents stale goroutines from recording results for a previous generation after a state transition. The configurable `ReadyToTrip` function keeps the tripping logic outside the breaker itself, so callers can implement sliding-window error rates or custom thresholds without modifying this code. All state transitions, request outcomes, and latencies are exposed as Prometheus metrics, making circuit health directly observable in a running production system.

Context cancellations are treated as **neutral** events: they neither increment the failure counter nor influence whether the breaker trips, because a client hanging up says nothing about the upstream's health. Neutral is a genuinely third outcome, and getting it right requires care in two places that are easy to miss:

- **A cancellation must not count as a failure.** If it does, a service whose clients frequently cancel (a user navigating away, an upstream deadline firing) trips its own breaker against a dependency that is perfectly healthy, and then refuses traffic to it. Six pre-canceled calls are enough to open the breaker in the naive version, without a single request ever reaching the upstream.
- **A cancellation must still release the half-open slot it reserved.** `beforeRequest` increments `counts.Requests` *before* the call, and in half-open that counter is the admission gate. Returning early on cancellation without giving the slot back leaves the gate permanently shut: the breaker sits in half-open forever, rejecting every probe with `ErrTooManyRequests`, and can never close. One canceled probe strands the circuit for the life of the process.

That second one is why `releaseRequest` exists below. Skipping `afterRequest` is not enough. You have to actively undo the reservation.

```go
package circuit

import (
    "context"
    "errors"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    ErrCircuitOpen     = errors.New("circuit breaker is open")
    ErrTooManyRequests = errors.New("too many requests in half-open state")
)

type State int32

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "closed"
    case StateOpen:
        return "open"
    case StateHalfOpen:
        return "half-open"
    default:
        return "unknown"
    }
}

// Counts holds circuit breaker statistics
type Counts struct {
    Requests             uint32
    TotalSuccesses       uint32
    TotalFailures        uint32
    ConsecutiveSuccesses uint32
    ConsecutiveFailures  uint32
}

// Settings configures the circuit breaker
type Settings struct {
    Name          string
    MaxRequests   uint32        // Max requests in half-open state
    Interval      time.Duration // Rolling window for counting failures
    Timeout       time.Duration // Time to wait before half-open
    ReadyToTrip   func(counts Counts) bool
    OnStateChange func(name string, from, to State)
    IsSuccessful  func(err error) bool
}

// DefaultSettings returns sensible defaults
func DefaultSettings(name string) Settings {
    return Settings{
        Name:        name,
        MaxRequests: 3,
        Interval:    60 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts Counts) bool {
            return counts.ConsecutiveFailures > 5
        },
        IsSuccessful: func(err error) bool {
            return err == nil
        },
    }
}

// CircuitBreaker implements the circuit breaker pattern with metrics
type CircuitBreaker struct {
    name          string
    maxRequests   uint32
    interval      time.Duration
    timeout       time.Duration
    readyToTrip   func(counts Counts) bool
    isSuccessful  func(err error) bool
    onStateChange func(name string, from, to State)

    mu          sync.Mutex
    state       State
    generation  uint64
    counts      Counts
    expiry      time.Time

    // Metrics
    stateGauge     prometheus.Gauge
    requestsTotal  *prometheus.CounterVec
    failuresTotal  prometheus.Counter
    successesTotal prometheus.Counter
    latencyHist    prometheus.Histogram
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(settings Settings) *CircuitBreaker {
    cb := &CircuitBreaker{
        name:          settings.Name,
        maxRequests:   settings.MaxRequests,
        interval:      settings.Interval,
        timeout:       settings.Timeout,
        readyToTrip:   settings.ReadyToTrip,
        isSuccessful:  settings.IsSuccessful,
        onStateChange: settings.OnStateChange,
    }

    if cb.readyToTrip == nil {
        cb.readyToTrip = func(counts Counts) bool {
            return counts.ConsecutiveFailures > 5
        }
    }

    if cb.isSuccessful == nil {
        cb.isSuccessful = func(err error) bool { return err == nil }
    }

    cb.initMetrics()
    return cb
}

func (cb *CircuitBreaker) initMetrics() {
    cb.stateGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "circuit_breaker_state",
        Help: "Current state of the circuit breaker (0=closed, 1=open, 2=half-open)",
        ConstLabels: prometheus.Labels{"name": cb.name},
    })

    cb.requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "circuit_breaker_requests_total",
        Help: "Total requests through circuit breaker",
        ConstLabels: prometheus.Labels{"name": cb.name},
    }, []string{"result"})

    cb.latencyHist = promauto.NewHistogram(prometheus.HistogramOpts{
        Name: "circuit_breaker_request_duration_seconds",
        Help: "Request duration through circuit breaker",
        ConstLabels: prometheus.Labels{"name": cb.name},
        Buckets: prometheus.DefBuckets,
    })
}

// Execute runs the given function if the circuit breaker allows it
func (cb *CircuitBreaker) Execute(fn func() (any, error)) (any, error) {
    generation, err := cb.beforeRequest()
    if err != nil {
        cb.requestsTotal.WithLabelValues("rejected").Inc()
        return nil, err
    }

    start := time.Now()
    defer func() {
        cb.latencyHist.Observe(time.Since(start).Seconds())
    }()

    result, err := fn()
    cb.afterRequest(generation, cb.isSuccessful(err))

    if cb.isSuccessful(err) {
        cb.requestsTotal.WithLabelValues("success").Inc()
    } else {
        cb.requestsTotal.WithLabelValues("failure").Inc()
    }

    return result, err
}

// ExecuteWithContext adds context support
func (cb *CircuitBreaker) ExecuteWithContext(
    ctx context.Context,
    fn func(context.Context) (any, error),
) (any, error) {
    generation, err := cb.beforeRequest()
    if err != nil {
        cb.requestsTotal.WithLabelValues("rejected").Inc()
        return nil, err
    }

    start := time.Now()
    defer func() {
        cb.latencyHist.Observe(time.Since(start).Seconds())
    }()

    // Check context before execution.
    select {
    case <-ctx.Done():
        // Release the slot WITHOUT recording a failure. The upstream was
        // never called, so it has done nothing wrong.
        cb.releaseRequest(generation)
        cb.requestsTotal.WithLabelValues("canceled").Inc()
        return nil, ctx.Err()
    default:
    }

    result, err := fn(ctx)

    // Context cancellation is not a circuit failure, but the half-open slot
    // this request reserved MUST still be given back, or the breaker can
    // never leave half-open.
    if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
        cb.releaseRequest(generation)
        cb.requestsTotal.WithLabelValues("canceled").Inc()
        return result, err
    }

    cb.afterRequest(generation, cb.isSuccessful(err))

    if cb.isSuccessful(err) {
        cb.requestsTotal.WithLabelValues("success").Inc()
    } else {
        cb.requestsTotal.WithLabelValues("failure").Inc()
    }

    return result, err
}

func (cb *CircuitBreaker) beforeRequest() (uint64, error) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    now := time.Now()
    state, generation := cb.currentState(now)

    if state == StateOpen {
        return generation, ErrCircuitOpen
    }

    if state == StateHalfOpen && cb.counts.Requests >= cb.maxRequests {
        return generation, ErrTooManyRequests
    }

    cb.counts.Requests++
    return generation, nil
}

func (cb *CircuitBreaker) afterRequest(generation uint64, success bool) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    now := time.Now()
    state, currentGen := cb.currentState(now)
    if generation != currentGen {
        return
    }

    if success {
        cb.onSuccess(state, now)
    } else {
        cb.onFailure(state, now)
    }
}

// releaseRequest undoes the reservation made by beforeRequest without
// recording success or failure. It exists for genuinely neutral outcomes,
// which in practice means client-side cancellation.
//
// This is not bookkeeping pedantry. beforeRequest increments counts.Requests,
// and in half-open that counter is what gates admission. A neutral outcome
// that never gives the slot back leaves counts.Requests pinned at maxRequests
// forever, so every later probe is rejected with ErrTooManyRequests and the
// breaker can never close. One canceled probe would strand the circuit open
// for the life of the process.
func (cb *CircuitBreaker) releaseRequest(generation uint64) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    _, currentGen := cb.currentState(time.Now())
    if generation != currentGen {
        return // a transition already reset the counters
    }
    if cb.counts.Requests > 0 {
        cb.counts.Requests--
    }
}

func (cb *CircuitBreaker) onSuccess(state State, now time.Time) {
    switch state {
    case StateClosed:
        cb.counts.TotalSuccesses++
        cb.counts.ConsecutiveSuccesses++
        cb.counts.ConsecutiveFailures = 0

    case StateHalfOpen:
        cb.counts.TotalSuccesses++
        cb.counts.ConsecutiveSuccesses++
        cb.counts.ConsecutiveFailures = 0
        if cb.counts.ConsecutiveSuccesses >= cb.maxRequests {
            cb.setState(StateClosed, now)
        }
    }
}

func (cb *CircuitBreaker) onFailure(state State, now time.Time) {
    switch state {
    case StateClosed:
        cb.counts.TotalFailures++
        cb.counts.ConsecutiveFailures++
        cb.counts.ConsecutiveSuccesses = 0
        if cb.readyToTrip(cb.counts) {
            cb.setState(StateOpen, now)
        }

    case StateHalfOpen:
        cb.setState(StateOpen, now)
    }
}

func (cb *CircuitBreaker) currentState(now time.Time) (State, uint64) {
    switch cb.state {
    case StateClosed:
        if !cb.expiry.IsZero() && cb.expiry.Before(now) {
            cb.toNewGeneration(now)
        }

    case StateOpen:
        if cb.expiry.Before(now) {
            cb.setState(StateHalfOpen, now)
        }
    }
    return cb.state, cb.generation
}

func (cb *CircuitBreaker) setState(state State, now time.Time) {
    if cb.state == state {
        return
    }

    prev := cb.state
    cb.state = state
    cb.stateGauge.Set(float64(state))

    cb.toNewGeneration(now)

    if cb.onStateChange != nil {
        cb.onStateChange(cb.name, prev, state)
    }
}

func (cb *CircuitBreaker) toNewGeneration(now time.Time) {
    cb.generation++
    cb.counts = Counts{}

    var zero time.Time
    switch cb.state {
    case StateClosed:
        if cb.interval == 0 {
            cb.expiry = zero
        } else {
            cb.expiry = now.Add(cb.interval)
        }
    case StateOpen:
        cb.expiry = now.Add(cb.timeout)
    default:
        cb.expiry = zero
    }
}

// State returns the current state
func (cb *CircuitBreaker) State() State {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    now := time.Now()
    state, _ := cb.currentState(now)
    return state
}

// Counts returns current counts
func (cb *CircuitBreaker) Counts() Counts {
    cb.mu.Lock()
    defer cb.mu.Unlock()
    return cb.counts
}
```

### retry/retry.go

The `Retryer` supports three backoff strategies (exponential, linear, and constant) and defaults to **full jitter**, drawing each sleep uniformly from `[0, interval)` rather than nudging the interval by a small percentage. That default is the single most consequential line in this package: a proportional `±20%` jitter leaves a recovering dependency facing a wall of near-simultaneous retries, whereas full jitter spreads them across the whole window. Two sentinel error types, `RetryableError` and `PermanentError`, let the wrapped function signal whether a failure is worth retrying or should short-circuit immediately. `DoWithValue` is a generic **function** rather than a method, because Go does not allow type parameters on methods, and it removes the boilerplate of capturing a result into a local variable through a closure. All attempt counts, retries, successes, failures, and total durations are tracked as Prometheus counters and histograms so retry pressure on downstream services is visible in real time.

```go
package retry

import (
    "context"
    "errors"
    "math"
    "math/rand/v2"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// BackoffStrategy defines how to calculate wait time between retries
type BackoffStrategy int

const (
    BackoffExponential BackoffStrategy = iota
    BackoffLinear
    BackoffConstant
)

// JitterStrategy selects how the backoff interval is randomized.
type JitterStrategy int

const (
    JitterFull  JitterStrategy = iota // random(0, interval). The default.
    JitterEqual                       // interval/2 + random(0, interval/2)
    JitterNone                        // exactly interval. Fleets will sync up.
)

// Config holds retry configuration
type Config struct {
    MaxRetries      int
    InitialInterval time.Duration
    MaxInterval     time.Duration
    Multiplier      float64
    Jitter          JitterStrategy
    Strategy        BackoffStrategy
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        MaxRetries:      3,
        InitialInterval: 100 * time.Millisecond,
        MaxInterval:     30 * time.Second,
        Multiplier:      2.0,
        Jitter:          JitterFull,
        Strategy:        BackoffExponential,
    }
}

// RetryableError marks an error as retryable
type RetryableError struct {
    Err error
}

func (e RetryableError) Error() string { return e.Err.Error() }
func (e RetryableError) Unwrap() error { return e.Err }

// PermanentError marks an error as non-retryable
type PermanentError struct {
    Err error
}

func (e PermanentError) Error() string { return e.Err.Error() }
func (e PermanentError) Unwrap() error { return e.Err }

// IsRetryable checks if an error should be retried
func IsRetryable(err error) bool {
    var permanent PermanentError
    if errors.As(err, &permanent) {
        return false
    }
    var retryable RetryableError
    return errors.As(err, &retryable)
}

// Retryer provides retry functionality with metrics
type Retryer struct {
    config  Config
    name    string
    metrics *retryMetrics
}

type retryMetrics struct {
    attemptsTotal *prometheus.CounterVec
    retriesTotal  prometheus.Counter
    successTotal  prometheus.Counter
    failureTotal  prometheus.Counter
    latencyHist   prometheus.Histogram
}

// NewRetryer creates a new retryer with metrics
func NewRetryer(name string, config Config) *Retryer {
    r := &Retryer{
        config: config,
        name:   name,
    }
    r.initMetrics()
    return r
}

func (r *Retryer) initMetrics() {
    r.metrics = &retryMetrics{
        attemptsTotal: promauto.NewCounterVec(prometheus.CounterOpts{
            Name: "retry_attempts_total",
            Help: "Total retry attempts",
            ConstLabels: prometheus.Labels{"name": r.name},
        }, []string{"attempt"}),
        retriesTotal: promauto.NewCounter(prometheus.CounterOpts{
            Name: "retry_retries_total",
            Help: "Total retries (not including first attempt)",
            ConstLabels: prometheus.Labels{"name": r.name},
        }),
        successTotal: promauto.NewCounter(prometheus.CounterOpts{
            Name: "retry_success_total",
            Help: "Total successful operations",
            ConstLabels: prometheus.Labels{"name": r.name},
        }),
        failureTotal: promauto.NewCounter(prometheus.CounterOpts{
            Name: "retry_failure_total",
            Help: "Total failed operations after all retries",
            ConstLabels: prometheus.Labels{"name": r.name},
        }),
        latencyHist: promauto.NewHistogram(prometheus.HistogramOpts{
            Name: "retry_duration_seconds",
            Help: "Total duration including all retries",
            ConstLabels: prometheus.Labels{"name": r.name},
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        }),
    }
}

// Do executes the function with retry logic
func (r *Retryer) Do(ctx context.Context, fn func(ctx context.Context) error) error {
    start := time.Now()
    defer func() {
        r.metrics.latencyHist.Observe(time.Since(start).Seconds())
    }()

    var lastErr error
    interval := r.config.InitialInterval

    for attempt := 0; attempt <= r.config.MaxRetries; attempt++ {
        r.metrics.attemptsTotal.WithLabelValues(string(rune('0' + attempt))).Inc()

        if attempt > 0 {
            r.metrics.retriesTotal.Inc()
        }

        err := fn(ctx)
        if err == nil {
            r.metrics.successTotal.Inc()
            return nil
        }

        lastErr = err

        // Check if error is non-retryable
        var permanent PermanentError
        if errors.As(err, &permanent) {
            r.metrics.failureTotal.Inc()
            return err
        }

        if attempt == r.config.MaxRetries {
            break
        }

        // Draw the actual sleep from the interval (full jitter by default).
        wait := r.calculateWait(interval)

        select {
        case <-ctx.Done():
            r.metrics.failureTotal.Inc()
            // Keep the real error: a bare ctx.Err() tells the caller the
            // deadline blew but not that every attempt got a 503.
            return errors.Join(lastErr, ctx.Err())
        case <-time.After(wait):
        }

        // Update interval for next attempt
        interval = r.nextInterval(interval)
    }

    r.metrics.failureTotal.Inc()
    return lastErr
}

// DoWithValue executes a value-returning function with retry logic.
//
// This is a FUNCTION, not a method. Go does not permit type parameters on
// methods ("method must have no type parameters" is a compile error), because
// a method set must be fixed at compile time for interface satisfaction.
// The Retryer is passed as the first argument instead.
func DoWithValue[T any](
    ctx context.Context,
    r *Retryer,
    fn func(ctx context.Context) (T, error),
) (T, error) {
    var result T
    err := r.Do(ctx, func(ctx context.Context) error {
        var err error
        result, err = fn(ctx)
        return err
    })
    return result, err
}

// calculateWait turns the backoff interval into an actual sleep.
//
// `interval` is a CEILING, not the wait itself. Full jitter draws uniformly
// from [0, interval), which is what actually de-correlates a fleet of clients
// retrying after a shared outage. A proportional "+/- 20%" nudge does not:
// it leaves every client clustered in a narrow band around the same instant,
// which is the thundering herd you were trying to avoid.
func (r *Retryer) calculateWait(interval time.Duration) time.Duration {
    if interval <= 0 {
        return 0
    }
    switch r.config.Jitter {
    case JitterNone:
        return interval
    case JitterEqual:
        // Keeps a floor under the wait: [interval/2, interval).
        half := interval / 2
        if half <= 0 {
            return interval
        }
        return half + time.Duration(rand.Int64N(int64(half)))
    default: // JitterFull
        return time.Duration(rand.Int64N(int64(interval)))
    }
}

func (r *Retryer) nextInterval(current time.Duration) time.Duration {
    var next time.Duration

    switch r.config.Strategy {
    case BackoffExponential:
        next = time.Duration(float64(current) * r.config.Multiplier)
    case BackoffLinear:
        next = current + r.config.InitialInterval
    case BackoffConstant:
        next = current
    }

    if next > r.config.MaxInterval {
        next = r.config.MaxInterval
    }
    return next
}

// DoWithBackoff is a standalone function for simple retry
func DoWithBackoff(
    ctx context.Context,
    maxRetries int,
    initialInterval time.Duration,
    fn func() error,
) error {
    var lastErr error
    interval := initialInterval

    for attempt := 0; attempt <= maxRetries; attempt++ {
        err := fn()
        if err == nil {
            return nil
        }
        lastErr = err

        if attempt == maxRetries {
            break
        }

        // Exponential backoff with full jitter
        jitter := time.Duration(rand.Int64N(int64(interval)))
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(jitter):
        }

        interval = time.Duration(math.Min(
            float64(interval)*2,
            float64(30*time.Second),
        ))
    }

    return lastErr
}
```

### bulkhead/bulkhead.go

The bulkhead uses a buffered channel as a semaphore to cap the number of concurrently executing functions, with a separate atomic counter tracking how many callers are queued so new arrivals can be rejected immediately when the wait queue is at capacity. An optimistic non-blocking `select` attempts to acquire the semaphore first. Only if that fails does the goroutine increment the waiting counter and block with a context-aware timeout, avoiding unnecessary atomic operations on the uncontended fast path. `ServiceBulkheads` manages a named map of bulkheads with double-checked locking to create per-service isolation pools lazily, ensuring that a flood of requests to one downstream service cannot exhaust concurrency slots reserved for others.

```go
package bulkhead

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    ErrBulkheadFull    = errors.New("bulkhead is full")
    ErrQueueFull       = errors.New("bulkhead queue is full")
    ErrBulkheadTimeout = errors.New("bulkhead timeout waiting for slot")
)

// Config configures the bulkhead
type Config struct {
    MaxConcurrent int
    MaxWaiting    int
    Timeout       time.Duration
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        MaxConcurrent: 10,
        MaxWaiting:    100,
        Timeout:       30 * time.Second,
    }
}

// Bulkhead implements the bulkhead pattern with queuing
type Bulkhead struct {
    name          string
    maxConcurrent int
    maxWaiting    int
    timeout       time.Duration

    sem     chan struct{}
    waiting int64

    // Metrics
    activeGauge   prometheus.Gauge
    waitingGauge  prometheus.Gauge
    acceptedTotal prometheus.Counter
    rejectedTotal prometheus.Counter
    timeoutTotal  prometheus.Counter
    waitHist      prometheus.Histogram
}

// New creates a new bulkhead
func New(name string, config Config) *Bulkhead {
    b := &Bulkhead{
        name:          name,
        maxConcurrent: config.MaxConcurrent,
        maxWaiting:    config.MaxWaiting,
        timeout:       config.Timeout,
        sem:           make(chan struct{}, config.MaxConcurrent),
    }
    b.initMetrics()
    return b
}

func (b *Bulkhead) initMetrics() {
    b.activeGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "bulkhead_active_count",
        Help: "Number of active requests in bulkhead",
        ConstLabels: prometheus.Labels{"name": b.name},
    })

    b.waitingGauge = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "bulkhead_waiting_count",
        Help: "Number of requests waiting for bulkhead",
        ConstLabels: prometheus.Labels{"name": b.name},
    })

    b.acceptedTotal = promauto.NewCounter(prometheus.CounterOpts{
        Name: "bulkhead_accepted_total",
        Help: "Total requests accepted by bulkhead",
        ConstLabels: prometheus.Labels{"name": b.name},
    })

    b.rejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
        Name: "bulkhead_rejected_total",
        Help: "Total requests rejected by bulkhead",
        ConstLabels: prometheus.Labels{"name": b.name},
    })

    b.timeoutTotal = promauto.NewCounter(prometheus.CounterOpts{
        Name: "bulkhead_timeout_total",
        Help: "Total requests that timed out waiting",
        ConstLabels: prometheus.Labels{"name": b.name},
    })

    b.waitHist = promauto.NewHistogram(prometheus.HistogramOpts{
        Name: "bulkhead_wait_duration_seconds",
        Help: "Time spent waiting for bulkhead slot",
        ConstLabels: prometheus.Labels{"name": b.name},
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 12),
    })
}

// Execute runs the function within the bulkhead
func (b *Bulkhead) Execute(ctx context.Context, fn func() error) error {
    // Check if queue is full
    currentWaiting := atomic.LoadInt64(&b.waiting)
    if currentWaiting >= int64(b.maxWaiting) {
        b.rejectedTotal.Inc()
        return ErrQueueFull
    }

    // Try non-blocking acquire first
    select {
    case b.sem <- struct{}{}:
        b.acceptedTotal.Inc()
        b.activeGauge.Inc()
        defer func() {
            <-b.sem
            b.activeGauge.Dec()
        }()
        return fn()
    default:
    }

    // Must wait - increment waiting counter
    atomic.AddInt64(&b.waiting, 1)
    b.waitingGauge.Inc()
    defer func() {
        atomic.AddInt64(&b.waiting, -1)
        b.waitingGauge.Dec()
    }()

    // Set up timeout
    timeout := b.timeout
    if timeout == 0 {
        timeout = 30 * time.Second
    }

    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    start := time.Now()

    select {
    case b.sem <- struct{}{}:
        b.waitHist.Observe(time.Since(start).Seconds())
        b.acceptedTotal.Inc()
        b.activeGauge.Inc()
        defer func() {
            <-b.sem
            b.activeGauge.Dec()
        }()
        return fn()

    case <-ctx.Done():
        b.waitHist.Observe(time.Since(start).Seconds())
        if errors.Is(ctx.Err(), context.DeadlineExceeded) {
            b.timeoutTotal.Inc()
            return ErrBulkheadTimeout
        }
        return ctx.Err()
    }
}

// TryExecute attempts non-blocking execution, reporting ErrBulkheadFull when
// no slot is free.
//
// It returns an ERROR on rejection, never (false, nil). Reporting "we did not
// run your work" as a nil error means every caller using the standard
// `if err != nil` reflex treats a shed request as a success and proceeds with
// a zero-valued result. Silent success on the shed path corrupts data, and it
// does so precisely when the system is already overloaded.
func (b *Bulkhead) TryExecute(fn func() error) error {
    select {
    case b.sem <- struct{}{}:
        b.acceptedTotal.Inc()
        b.activeGauge.Inc()
        defer func() {
            <-b.sem
            b.activeGauge.Dec()
        }()
        return fn()
    default:
        b.rejectedTotal.Inc()
        return ErrBulkheadFull
    }
}

// ExecuteWithValue provides generic value return
func ExecuteWithValue[T any](
    b *Bulkhead,
    ctx context.Context,
    fn func() (T, error),
) (T, error) {
    var result T
    err := b.Execute(ctx, func() error {
        var err error
        result, err = fn()
        return err
    })
    return result, err
}

// Stats returns current bulkhead statistics
type Stats struct {
    Active   int
    Waiting  int
    Capacity int
}

func (b *Bulkhead) Stats() Stats {
    return Stats{
        Active:   len(b.sem),
        Waiting:  int(atomic.LoadInt64(&b.waiting)),
        Capacity: b.maxConcurrent,
    }
}

// ServiceBulkheads manages multiple bulkheads for different services
type ServiceBulkheads struct {
    mu        sync.RWMutex
    bulkheads map[string]*Bulkhead
    defaults  Config
}

// NewServiceBulkheads creates a manager for service bulkheads
func NewServiceBulkheads(defaults Config) *ServiceBulkheads {
    return &ServiceBulkheads{
        bulkheads: make(map[string]*Bulkhead),
        defaults:  defaults,
    }
}

// Get returns or creates a bulkhead for the service
func (sb *ServiceBulkheads) Get(service string) *Bulkhead {
    sb.mu.RLock()
    b, ok := sb.bulkheads[service]
    sb.mu.RUnlock()
    if ok {
        return b
    }

    sb.mu.Lock()
    defer sb.mu.Unlock()

    // Double-check
    if b, ok := sb.bulkheads[service]; ok {
        return b
    }

    b = New(service, sb.defaults)
    sb.bulkheads[service] = b
    return b
}

// Configure sets custom config for a service. It must be called before the
// first Get for that service.
//
// Calling it for a service that already has a bulkhead PANICS, because New
// re-registers metrics that already exist under the same name. See the
// promauto note below.
func (sb *ServiceBulkheads) Configure(service string, config Config) {
    sb.mu.Lock()
    defer sb.mu.Unlock()
    if _, exists := sb.bulkheads[service]; exists {
        // Replacing would panic on duplicate metric registration, and would
        // also orphan the in-flight requests holding the old semaphore.
        panic("bulkhead: Configure called after the bulkhead for " + service + " was created")
    }
    sb.bulkheads[service] = New(service, config)
}
```

**`promauto` makes construction a landmine.** Every constructor in this application (`NewCircuitBreaker`, `New` for bulkheads, `NewRetryer`) calls `promauto.New*`, which registers into the **default** registry and **panics** on a duplicate. Build two components with the same `name` and the process dies at startup:

```
PANIC: duplicate metrics collector registration attempted
```

This is not hypothetical. It fires when a service is configured twice, when a test constructs the same client in two test cases, or when a bulkhead is recreated with new settings. It is the reason `Configure` above must reject a second call rather than silently replacing.

Two ways to make this safe, and production code should pick one:

- **Inject a `prometheus.Registerer`** into every constructor rather than reaching for the global default, and use `prometheus.NewRegistry()` per test. This is the version that keeps tests independent. It is why the bulkhead in section 22.4 takes `reg prometheus.Registerer` as a parameter.
- **Register once, label per instance.** Create each collector a single time at package level as a `*prometheus.CounterVec` with a `name` label, and have instances call `WithLabelValues(cb.name)`. Constructors then allocate nothing global and can never collide.

The second scales better: one metric family with a `name` label is also what you want in Prometheus, rather than N distinct metric names carrying `ConstLabels`.

### client/resilient.go

`Client` composes all four resilience layers in an explicit order: rate limiter → bulkhead → circuit breaker → retry, so that cheap checks (rate limiting) gate expensive ones (bulkhead queuing) before the circuit breaker decides whether to allow the call at all. HTTP 4xx responses are wrapped as `PermanentError` to prevent the retry layer from wasting attempts on client errors, while 5xx and gateway errors are wrapped as `RetryableError` to enable automatic recovery from transient upstream failures. The optional `fallback` function gives callers a hook to return cached data or a degraded response when all resilience layers have been exhausted, enabling graceful degradation rather than a hard error surfaced to end users.

```go
package client

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net"
    "net/http"
    "time"

    "resilient/bulkhead"
    "resilient/circuit"
    "resilient/retry"

    "golang.org/x/time/rate"
)

// Config configures the resilient client
type Config struct {
    // HTTP client settings
    Timeout             time.Duration
    MaxIdleConns        int
    MaxIdleConnsPerHost int
    IdleConnTimeout     time.Duration

    // Circuit breaker settings
    CBMaxFailures uint32
    CBTimeout     time.Duration
    CBMaxRequests uint32

    // Retry settings
    RetryMaxRetries      int
    RetryInitialInterval time.Duration
    RetryMaxInterval     time.Duration

    // Bulkhead settings
    BulkheadMaxConcurrent int
    BulkheadMaxWaiting    int
    BulkheadTimeout       time.Duration

    // Rate limiting
    RateLimit rate.Limit
    RateBurst int
}

// DefaultConfig returns production-ready defaults
func DefaultConfig() Config {
    return Config{
        Timeout:             30 * time.Second,
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        IdleConnTimeout:     90 * time.Second,

        CBMaxFailures: 5,
        CBTimeout:     30 * time.Second,
        CBMaxRequests: 3,

        RetryMaxRetries:      3,
        RetryInitialInterval: 100 * time.Millisecond,
        RetryMaxInterval:     10 * time.Second,

        BulkheadMaxConcurrent: 50,
        BulkheadMaxWaiting:    100,
        BulkheadTimeout:       30 * time.Second,

        RateLimit: 100,
        RateBurst: 200,
    }
}

// Client is a resilient HTTP client with circuit breaker, retry, bulkhead
type Client struct {
    name           string
    config         Config
    httpClient     *http.Client
    circuitBreaker *circuit.CircuitBreaker
    retryer        *retry.Retryer
    bulkhead       *bulkhead.Bulkhead
    rateLimiter    *rate.Limiter
    fallback       func(ctx context.Context, req *http.Request, err error) (*http.Response, error)
}

// New creates a new resilient client
func New(name string, config Config) *Client {
    transport := &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext,
        MaxIdleConns:        config.MaxIdleConns,
        MaxIdleConnsPerHost: config.MaxIdleConnsPerHost,
        IdleConnTimeout:     config.IdleConnTimeout,
        TLSHandshakeTimeout: 10 * time.Second,
    }

    httpClient := &http.Client{
        Transport: transport,
        Timeout:   config.Timeout,
    }

    cbSettings := circuit.Settings{
        Name:        name,
        MaxRequests: config.CBMaxRequests,
        Interval:    60 * time.Second,
        Timeout:     config.CBTimeout,
        ReadyToTrip: func(counts circuit.Counts) bool {
            return counts.ConsecutiveFailures > config.CBMaxFailures
        },
        OnStateChange: func(name string, from, to circuit.State) {
            fmt.Printf("[%s] Circuit breaker state change: %s -> %s\n", name, from, to)
        },
    }

    retryConfig := retry.Config{
        MaxRetries:      config.RetryMaxRetries,
        InitialInterval: config.RetryInitialInterval,
        MaxInterval:     config.RetryMaxInterval,
        Multiplier:      2.0,
        Jitter:          retry.JitterFull, // not a percentage nudge
        Strategy:        retry.BackoffExponential,
    }

    bulkheadConfig := bulkhead.Config{
        MaxConcurrent: config.BulkheadMaxConcurrent,
        MaxWaiting:    config.BulkheadMaxWaiting,
        Timeout:       config.BulkheadTimeout,
    }

    return &Client{
        name:           name,
        config:         config,
        httpClient:     httpClient,
        circuitBreaker: circuit.NewCircuitBreaker(cbSettings),
        retryer:        retry.NewRetryer(name, retryConfig),
        bulkhead:       bulkhead.New(name, bulkheadConfig),
        rateLimiter:    rate.NewLimiter(config.RateLimit, config.RateBurst),
    }
}

// WithFallback sets a fallback function
func (c *Client) WithFallback(
    fn func(ctx context.Context, req *http.Request, err error) (*http.Response, error),
) *Client {
    c.fallback = fn
    return c
}

// Do executes an HTTP request with all resilience patterns
func (c *Client) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Layer 1: Rate limiting
    if err := c.rateLimiter.Wait(ctx); err != nil {
        return c.handleError(ctx, req, fmt.Errorf("rate limit: %w", err))
    }

    // Layer 2: Bulkhead
    var resp *http.Response
    err := c.bulkhead.Execute(ctx, func() error {
        var err error
        resp, err = c.executeWithCircuitAndRetry(ctx, req)
        return err
    })

    if err != nil {
        return c.handleError(ctx, req, err)
    }

    return resp, nil
}

func (c *Client) executeWithCircuitAndRetry(
    ctx context.Context,
    req *http.Request,
) (*http.Response, error) {
    // Layer 3: Circuit breaker wrapping retry.
    //
    // Note the consequence of this nesting: the breaker records ONE result
    // for the whole retry sequence, so with MaxRetries=3 it takes 4 real
    // requests to the failing dependency to produce a single failure vote.
    // A ConsecutiveFailures>5 policy then needs 24 requests to trip. If you
    // want the breaker to shed load promptly, invert these two layers.
    result, err := c.circuitBreaker.ExecuteWithContext(ctx,
        func(ctx context.Context) (any, error) {
            // Layer 4: Retry logic. DoWithValue is a generic FUNCTION, not a
            // method: Go does not allow type parameters on methods.
            return retry.DoWithValue(ctx, c.retryer,
                func(ctx context.Context) (*http.Response, error) {
                    return c.doRequest(ctx, req)
                },
            )
        },
    )

    if err != nil {
        return nil, err
    }

    // Comma-ok, not a bare assertion: a bare one panics if a layer ever
    // returns a nil result with a nil error.
    resp, ok := result.(*http.Response)
    if !ok || resp == nil {
        return nil, fmt.Errorf("resilient: unexpected result type %T", result)
    }
    return resp, nil
}

func (c *Client) doRequest(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Clone gives this attempt its own header/URL copy and context. It does
    // NOT restore the body: Clone shallow-copies the Body io.ReadCloser, so
    // once attempt 1 drains it, attempt 2 would send an empty body.
    // GetBody is the only thing that rebuilds it.
    attempt := req.Clone(ctx)
    if req.GetBody != nil {
        body, err := req.GetBody()
        if err != nil {
            // Cannot rebuild the body: permanent, retrying is pointless.
            return nil, retry.PermanentError{Err: err}
        }
        attempt.Body = body
    }

    resp, err := c.httpClient.Do(attempt)
    if err != nil {
        // Network errors are retryable
        var netErr net.Error
        if errors.As(err, &netErr) {
            return nil, retry.RetryableError{Err: err}
        }
        return nil, err
    }

    // Check for retryable status codes
    if isRetryableStatusCode(resp.StatusCode) {
        resp.Body.Close()
        return nil, retry.RetryableError{
            Err: fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status),
        }
    }

    // Check for permanent failures
    if resp.StatusCode >= 400 && resp.StatusCode < 500 {
        return nil, retry.PermanentError{
            Err: fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status),
        }
    }

    return resp, nil
}

func (c *Client) handleError(
    ctx context.Context,
    req *http.Request,
    err error,
) (*http.Response, error) {
    if c.fallback != nil {
        return c.fallback(ctx, req, err)
    }
    return nil, err
}

func isRetryableStatusCode(code int) bool {
    switch code {
    case http.StatusTooManyRequests,
        http.StatusBadGateway,
        http.StatusServiceUnavailable,
        http.StatusGatewayTimeout:
        return true
    }
    return false
}

// Convenience methods

// Get performs a GET request
func (c *Client) Get(ctx context.Context, url string) (*http.Response, error) {
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, err
    }
    return c.Do(ctx, req)
}

// GetJSON performs GET and decodes JSON response
func (c *Client) GetJSON(ctx context.Context, url string, target any) error {
    resp, err := c.Get(ctx, url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return fmt.Errorf("reading response: %w", err)
    }

    if err := json.Unmarshal(body, target); err != nil {
        return fmt.Errorf("decoding JSON: %w", err)
    }

    return nil
}

// CircuitState returns the current circuit breaker state
func (c *Client) CircuitState() circuit.State {
    return c.circuitBreaker.State()
}

// BulkheadStats returns current bulkhead statistics
func (c *Client) BulkheadStats() bulkhead.Stats {
    return c.bulkhead.Stats()
}
```

### main.go

The main function wires the resilient client to a lightweight HTTP server that exposes three endpoints: a `/health` endpoint that reports live circuit breaker state and bulkhead stats, a `/metrics` endpoint for Prometheus scraping, and a `/api/` proxy that forwards requests through all resilience layers. A fallback function is registered to log degradation events and return a structured error, ensuring the proxy never silently swallows failures. Graceful shutdown is handled by a goroutine that listens for OS signals and calls `server.Shutdown` with a 30-second deadline, giving in-flight proxy requests time to complete before the process exits.

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "resilient/client"

    "github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
    // Create resilient client for external API
    apiClient := client.New("external-api", client.Config{
        Timeout:               10 * time.Second,
        CBMaxFailures:         5,
        CBTimeout:             30 * time.Second,
        RetryMaxRetries:       3,
        RetryInitialInterval:  100 * time.Millisecond,
        BulkheadMaxConcurrent: 20,
        RateLimit:             50,
        RateBurst:             100,
    })

    // Add fallback for graceful degradation
    apiClient.WithFallback(func(ctx context.Context, req *http.Request, err error) (*http.Response, error) {
        log.Printf("Fallback triggered: %v", err)
        // Return cached or default response
        return nil, fmt.Errorf("service unavailable, fallback: %w", err)
    })

    // Create HTTP server
    mux := http.NewServeMux()

    // Health endpoints
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]any{
            "status":        "healthy",
            "circuit_state": apiClient.CircuitState().String(),
            "bulkhead":      apiClient.BulkheadStats(),
        })
    })

    // Metrics endpoint
    mux.Handle("/metrics", promhttp.Handler())

    // API proxy endpoint
    mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
        ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
        defer cancel()

        // Proxy to external API
        resp, err := apiClient.Get(ctx, "https://api.example.com"+r.URL.Path)
        if err != nil {
            http.Error(w, err.Error(), http.StatusServiceUnavailable)
            return
        }
        defer resp.Body.Close()

        // Copy response
        for k, v := range resp.Header {
            w.Header()[k] = v
        }
        w.WriteHeader(resp.StatusCode)
        io.Copy(w, resp.Body)
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh

        log.Println("Shutting down...")
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        server.Shutdown(ctx)
    }()

    log.Printf("Server starting on :8080")
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("Server error: %v", err)
    }
}
```

### Dockerfile

The two-stage Dockerfile compiles a fully static binary in the `golang:1.27.1-alpine` builder stage using `CGO_ENABLED=0` so no C runtime is needed in the final image. The runtime stage is built on `alpine:3.19` and adds only `ca-certificates` and `tzdata`, keeping the image small while still supporting HTTPS outbound calls and timezone-aware logging. Stripping debug symbols with `-ldflags="-s -w"` further reduces the binary size without affecting runtime behavior.

```dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /resilient-service .

FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /resilient-service .

EXPOSE 8080

ENTRYPOINT ["./resilient-service"]
```

### docker-compose.yml

The Compose file defines four services on a shared `resilience-net` bridge network: the resilient service itself, a MockServer instance used to simulate upstream API responses including failure scenarios, and a Prometheus/Grafana observability stack for metrics collection and dashboarding. The service depends on both the mock API and Prometheus so Docker starts them in the correct order, and the mock API is configured via a JSON initialization file mounted as a volume so failure patterns can be changed without rebuilding the image.

```yaml
# Images are pinned: :latest moves under you.

services:
  resilient-service:
    build: .
    ports:
      - "8080:8080"
    environment:
      - EXTERNAL_API_URL=http://mock-api:3000
    depends_on:
      - mock-api
      - prometheus
    networks:
      - resilience-net

  mock-api:
    image: mockserver/mockserver:7.6.0
    ports:
      - "3000:1080"
    environment:
      - MOCKSERVER_INITIALIZATION_JSON_PATH=/config/init.json
    volumes:
      - ./mock-config:/config
    networks:
      - resilience-net

  prometheus:
    image: prom/prometheus:v3.14.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    networks:
      - resilience-net

  grafana:
    image: grafana/grafana:13.2.1
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    depends_on:
      - prometheus
    networks:
      - resilience-net

networks:
  resilience-net:
    driver: bridge
```

### Makefile

The Makefile provides a standard set of development and CI targets: `test` runs the full suite with the race detector and coverage enabled, `lint` invokes `golangci-lint`, and `benchmark` runs all benchmarks with memory allocation reporting. The three `chaos-*` targets inject Linux `tc netem` network faults, latency, packet loss, and their removal, directly into the running container, enabling manual verification that the circuit breaker and retry logic behave correctly under real degraded network conditions without an external chaos tool.

```makefile
.PHONY: build test run docker-build docker-run clean lint

BINARY_NAME=resilient-service
DOCKER_IMAGE=resilient-service:latest

build:
	go build -o bin/$(BINARY_NAME) .

test:
	go test -v -race -cover ./...

test-integration:
	go test -v -tags=integration ./...

run:
	go run .

docker-build:
	docker build -t $(DOCKER_IMAGE) .

docker-run:
	docker-compose up -d

docker-stop:
	docker-compose down

lint:
	golangci-lint run

benchmark:
	go test -bench=. -benchmem ./...

clean:
	rm -rf bin/
	docker-compose down -v

# Chaos testing
chaos-network-delay:
	docker exec resilient-service tc qdisc add dev eth0 root netem delay 100ms 20ms

chaos-network-loss:
	docker exec resilient-service tc qdisc add dev eth0 root netem loss 10%

chaos-reset:
	docker exec resilient-service tc qdisc del dev eth0 root
```

### Staff Lens: Test Resilience in Chaos

The patterns above only matter if they work under real failure. Chaos engineering (Netflix origin) validates resilience by injecting failures: latency, packet loss, service crashes. Do this regularly in staging. Services that survive chaos tests are production-ready. Those that do not have resilience bugs waiting to be found.

---
