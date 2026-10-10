## 12.7 Circuit Breaker Pattern

Prevent cascading failures by failing fast.

### Production Circuit Breaker

A production circuit breaker tracks failure counts and transitions through closed (normal), open (fast-fail), and half-open (probe) states. Once the reset timeout expires, the breaker moves to half-open and admits a limited number of probe requests, capped by `HalfOpenMaxCalls`, while continuing to reject everything else. If `SuccessThreshold` of those probes succeed, the breaker closes and normal traffic resumes. A single failure sends it straight back to open, and the timeout starts again.

The half-open state is where breakers are most often subtly wrong, and the reason is that two of its knobs constrain each other. Admitting probes and requiring successes are separate counters, and if the required successes exceed the admitted probes the breaker can never close. It will exhaust its probe budget, sit below its threshold, and reject every subsequent call forever, no matter how healthy the downstream becomes. The constructor below clamps the config rather than allowing that state to be constructed.

```go
// State represents circuit breaker state
type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

func (s State) String() string {
    switch s {
    case StateClosed:
        return "CLOSED"
    case StateOpen:
        return "OPEN"
    case StateHalfOpen:
        return "HALF_OPEN"
    default:
        return "UNKNOWN"
    }
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
    name string

    mu              sync.RWMutex
    state           State
    failures        int
    successes       int
    consecutiveFails int

    // Configuration
    failureThreshold   int
    successThreshold   int
    timeout           time.Duration
    halfOpenMaxCalls  int
    halfOpenCalls     int

    // Timing
    lastStateChange time.Time
    lastFailure     time.Time

    // Callbacks
    onStateChange func(from, to State)

    // Metrics
    totalRequests  atomic.Int64
    totalSuccesses atomic.Int64
    totalFailures  atomic.Int64
}

// CircuitBreakerConfig configures a circuit breaker
type CircuitBreakerConfig struct {
    Name              string
    FailureThreshold  int
    SuccessThreshold  int
    Timeout           time.Duration
    HalfOpenMaxCalls  int
    OnStateChange     func(from, to State)
}

func NewCircuitBreaker(cfg CircuitBreakerConfig) *CircuitBreaker {
    // Guard the half-open invariant. HalfOpenMaxCalls caps how many
    // probes are admitted - SuccessThreshold is how many must succeed to
    // close. If the threshold exceeds the cap, the breaker admits its
    // probes, never reaches the threshold, and then refuses every
    // further call: a permanent open circuit that no downstream recovery
    // can clear. Clamp rather than ship that deadlock.
    if cfg.HalfOpenMaxCalls < 1 {
        cfg.HalfOpenMaxCalls = 1
    }
    if cfg.SuccessThreshold < 1 {
        cfg.SuccessThreshold = 1
    }
    if cfg.SuccessThreshold > cfg.HalfOpenMaxCalls {
        cfg.HalfOpenMaxCalls = cfg.SuccessThreshold
    }

    return &CircuitBreaker{
        name:             cfg.Name,
        state:            StateClosed,
        failureThreshold: cfg.FailureThreshold,
        successThreshold: cfg.SuccessThreshold,
        timeout:          cfg.Timeout,
        halfOpenMaxCalls: cfg.HalfOpenMaxCalls,
        onStateChange:    cfg.OnStateChange,
        lastStateChange:  time.Now(),
    }
}

// Execute runs a function through the circuit breaker
func (cb *CircuitBreaker) Execute(fn func() error) error {
    if err := cb.beforeRequest(); err != nil {
        return err
    }

    cb.totalRequests.Add(1)

    err := fn()

    cb.afterRequest(err == nil)

    return err
}

// ExecuteWithFallback runs with a fallback on circuit open
func (cb *CircuitBreaker) ExecuteWithFallback(fn func() error, fallback func() error) error {
    err := cb.Execute(fn)

    if errors.Is(err, ErrCircuitOpen) && fallback != nil {
        return fallback()
    }

    return err
}

var ErrCircuitOpen = errors.New("circuit breaker is open")

func (cb *CircuitBreaker) beforeRequest() error {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    now := time.Now()

    switch cb.state {
    case StateClosed:
        return nil

    case StateOpen:
        if now.Sub(cb.lastStateChange) > cb.timeout {
            cb.transitionTo(StateHalfOpen)
            cb.halfOpenCalls = 1
            return nil
        }
        return ErrCircuitOpen

    case StateHalfOpen:
        if cb.halfOpenCalls >= cb.halfOpenMaxCalls {
            return ErrCircuitOpen
        }
        cb.halfOpenCalls++
        return nil
    }

    return nil
}

func (cb *CircuitBreaker) afterRequest(success bool) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    if success {
        cb.totalSuccesses.Add(1)
        cb.recordSuccess()
    } else {
        cb.totalFailures.Add(1)
        cb.recordFailure()
    }
}

func (cb *CircuitBreaker) recordSuccess() {
    cb.consecutiveFails = 0

    switch cb.state {
    case StateClosed:
        cb.failures = 0

    case StateHalfOpen:
        cb.successes++
        if cb.successes >= cb.successThreshold {
            cb.transitionTo(StateClosed)
            cb.failures = 0
            cb.successes = 0
        }
    }
}

func (cb *CircuitBreaker) recordFailure() {
    cb.lastFailure = time.Now()
    cb.consecutiveFails++

    switch cb.state {
    case StateClosed:
        cb.failures++
        if cb.failures >= cb.failureThreshold {
            cb.transitionTo(StateOpen)
        }

    case StateHalfOpen:
        cb.transitionTo(StateOpen)
        cb.successes = 0
    }
}

// transitionTo must be called with cb.mu held.
func (cb *CircuitBreaker) transitionTo(newState State) {
    if cb.state == newState {
        return
    }

    oldState := cb.state
    cb.state = newState
    cb.lastStateChange = time.Now()

    // Reset the per-state counters on every entry, so a state is always
    // entered from a known baseline rather than inheriting the previous
    // state's tallies.
    cb.successes = 0
    cb.halfOpenCalls = 0

    if cb.onStateChange != nil {
        // The callback runs in its own goroutine so that a slow or
        // blocking callback cannot stall the request holding cb.mu.
        // Two caveats come with that. The callback must not call back
        // into the breaker, and callbacks are not ordered: two rapid
        // transitions can be observed out of order. Callbacks that must
        // see an ordered history should push onto a channel that a
        // single consumer drains. The recover is mandatory, since a
        // panic in a bare goroutine takes down the process.
        go func() {
            defer func() { _ = recover() }()
            cb.onStateChange(oldState, newState)
        }()
    }
}

// State returns the current state
func (cb *CircuitBreaker) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}

// Stats returns circuit breaker statistics
type CircuitBreakerStats struct {
    State          State
    TotalRequests  int64
    TotalSuccesses int64
    TotalFailures  int64
    ConsecutiveFails int
    LastFailure    time.Time
}

func (cb *CircuitBreaker) Stats() CircuitBreakerStats {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    return CircuitBreakerStats{
        State:            cb.state,
        TotalRequests:    cb.totalRequests.Load(),
        TotalSuccesses:   cb.totalSuccesses.Load(),
        TotalFailures:    cb.totalFailures.Load(),
        ConsecutiveFails: cb.consecutiveFails,
        LastFailure:      cb.lastFailure,
    }
}
```

### Prefer Production-Tested Libraries

For production circuit breakers, reach for `github.com/sony/gobreaker`, which is maintained and implements the pattern with a proper state machine and observability hooks. You will also meet `github.com/afex/hystrix-go` in older codebases, a port of Netflix's Hystrix, but treat it as legacy: Hystrix itself was retired upstream years ago, and the Go port is no longer actively developed. Do not start there. Hand-rolling a circuit breaker is acceptable for teaching. Shipping a hand-rolled one to production is usually a mistake. The library authors have already thought through the edge cases your implementation is about to discover.

### Circuit Breaker vs Retry vs Both

Retry and circuit breaker are complementary, not alternatives.

- **Retry without circuit breaker.** A persistent downstream failure causes endless retries, amplifying load on an already-failing system. This is the thundering-herd-on-recovery pattern.
- **Circuit breaker without retry.** A transient failure causes one request to fail. The caller sees the error instantly with no recovery attempt.
- **Both.** The retry handles transient failures (network jitter, brief downstream hiccup). The circuit breaker kicks in when retries consistently fail, stopping the amplification. This is the production-correct combination.

The order matters, and the correct one is **circuit breaker inside, retry outside**: `retry(func() { return breaker.Execute(call) })`. Every individual attempt passes through the breaker, so the breaker counts each failure and can open partway through a retry sequence. The moment it opens, the remaining attempts cost nothing, because `Execute` returns `ErrCircuitOpen` without touching the network.

Inverting it, wrapping the whole retry loop in a single `Execute`, defeats the purpose. The breaker then sees one composite outcome per sequence rather than each attempt, which means the retry loop hammers a dead downstream to exhaustion before the breaker learns anything at all. The breaker's entire job is to stop that hammering, and it cannot do it from outside the loop.

One consequence follows and is easy to miss: **the retry must treat `ErrCircuitOpen` as non-retryable**. Otherwise, once the breaker opens, the retry spins through its remaining attempts and backoff sleeps against an error that is guaranteed not to change on this call. Fail fast, return the error, and let the breaker's timeout govern recovery.

### Staff Lens: Per-Dependency Circuit Breakers, Not Per-Service

A common mistake: one circuit breaker for the whole service. A transient failure in one downstream trips the breaker and blocks calls to unrelated downstreams. The correct pattern: one circuit breaker per downstream dependency, each with its own failure threshold. The staff-level invariant: if downstream A is failing but B is healthy, calls to B should still succeed. The per-dependency circuit breaker enforces this.

### Principal Lens: Circuit Breaker as Part of the Service Mesh

At scale, circuit breaking moves out of the application and into the service mesh (Envoy, Linkerd, Istio). Benefits: consistent implementation across services, centralized observability, no client library to maintain. Trade-offs: less application-level control, an additional infrastructure dependency. Principal engineers who work in service-mesh environments delegate circuit breaking to the mesh when possible. Applications that rely on mesh circuit breaking should not also have their own, because two breakers in series is hard to reason about. Pick one level.

---
