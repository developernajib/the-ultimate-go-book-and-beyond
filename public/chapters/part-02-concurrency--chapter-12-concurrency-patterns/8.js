export default `## 12.7 Circuit Breaker Pattern

Prevent cascading failures by failing fast.

### Production Circuit Breaker

A production circuit breaker tracks failure counts and transitions through closed (normal), open (fast-fail), and half-open (probe) states. The half-open state allows a single test request through after the reset timeout expires. If that request succeeds, the breaker resets to closed and normal traffic resumes, if it fails, the breaker returns to open and waits again.

\`\`\`go
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

func (cb *CircuitBreaker) transitionTo(newState State) {
    if cb.state == newState {
        return
    }

    oldState := cb.state
    cb.state = newState
    cb.lastStateChange = time.Now()

    if cb.onStateChange != nil {
        go cb.onStateChange(oldState, newState)
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
\`\`\`

### Prefer Production-Tested Libraries

For production circuit breakers, use \`github.com/sony/gobreaker\` or \`github.com/afex/hystrix-go\`. These implement the pattern with proper state machines, observability hooks, and battle-tested failure semantics. Hand-rolling a circuit breaker is acceptable for teaching. Shipping a hand-rolled one to production is usually a mistake. The library authors have already thought through the edge cases your implementation is about to discover.

### Circuit Breaker vs Retry vs Both

Retry and circuit breaker are complementary, not alternatives.

- **Retry without circuit breaker.** A persistent downstream failure causes endless retries, amplifying load on an already-failing system. This is the thundering-herd-on-recovery pattern.
- **Circuit breaker without retry.** A transient failure causes one request to fail. The caller sees the error instantly with no recovery attempt.
- **Both.** The retry handles transient failures (network jitter, brief downstream hiccup). The circuit breaker kicks in when retries consistently fail, stopping the amplification. This is the production-correct combination.

The order: retry inside the circuit breaker (retries count as attempts, so the breaker sees repeated failures), not circuit breaker inside retry (which would open and close the breaker on each retry). Each outbound call goes through the breaker once, and the retry wrapper decides whether to call again if it returns an error.

### Staff Lens: Per-Dependency Circuit Breakers, Not Per-Service

A common mistake: one circuit breaker for the whole service. A transient failure in one downstream trips the breaker and blocks calls to unrelated downstreams. The correct pattern: one circuit breaker per downstream dependency, each with its own failure threshold. The staff-level invariant: if downstream A is failing but B is healthy, calls to B should still succeed. The per-dependency circuit breaker enforces this.

### Principal Lens: Circuit Breaker as Part of the Service Mesh

At scale, circuit breaking moves out of the application and into the service mesh (Envoy, Linkerd, Istio). Benefits: consistent implementation across services, centralised observability, no client library to maintain. Trade-offs: less application-level control, an additional infrastructure dependency. Principal engineers who work in service-mesh environments delegate circuit breaking to the mesh when possible. Applications that rely on mesh circuit breaking should not also have their own, because two breakers in series is hard to reason about. Pick one level.

---
`;
