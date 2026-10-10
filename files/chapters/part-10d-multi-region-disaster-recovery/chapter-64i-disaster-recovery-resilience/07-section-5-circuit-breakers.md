## Section 5: Circuit Breakers

A circuit breaker prevents cascading failures by stopping calls to a failing downstream service, giving it time to recover. It has three states:

- **Closed**: Normal operation. Calls pass through. Failures are counted.
- **Open**: Calls fail fast without attempting the downstream. Triggered when failure threshold is exceeded.
- **Half-Open**: Trial state. A limited number of calls are attempted to test recovery.

```go
// file: internal/resilience/circuit_breaker.go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// ErrCircuitOpen is returned when the circuit breaker is open.
var ErrCircuitOpen = errors.New("circuit breaker open: downstream unavailable")

// State represents the circuit breaker state machine.
type State int

const (
	StateClosed   State = iota // normal operation
	StateOpen                  // fast-fail
	StateHalfOpen              // probing recovery
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

// CircuitBreakerConfig controls the breaker's behavior.
type CircuitBreakerConfig struct {
	Name             string
	FailureThreshold int           // consecutive failures to trip open
	SuccessThreshold int           // consecutive successes to close from half-open
	Timeout          time.Duration // how long to stay open before going half-open
	MaxHalfOpenCalls int           // max concurrent calls in half-open state
}

// CircuitBreaker is a generic, thread-safe circuit breaker.
type CircuitBreaker[T any] struct {
	cfg              CircuitBreakerConfig
	mu               sync.Mutex
	state            State
	failures         int
	successes        int
	lastStateChange  time.Time
	halfOpenInflight int
	logger           *slog.Logger
}

func NewCircuitBreaker[T any](cfg CircuitBreakerConfig, logger *slog.Logger) *CircuitBreaker[T] {
	return &CircuitBreaker[T]{
		cfg:             cfg,
		state:           StateClosed,
		lastStateChange: time.Now(),
		logger:          logger.With("component", "circuit_breaker", "name", cfg.Name),
	}
}

// Execute calls fn if the circuit is closed or half-open - returns ErrCircuitOpen otherwise.
func (cb *CircuitBreaker[T]) Execute(ctx context.Context, fn func(ctx context.Context) (T, error)) (T, error) {
	var zero T

	cb.mu.Lock()
	state := cb.currentState()

	switch state {
	case StateOpen:
		cb.mu.Unlock()
		return zero, fmt.Errorf("%w: name=%s", ErrCircuitOpen, cb.cfg.Name)

	case StateHalfOpen:
		if cb.halfOpenInflight >= cb.cfg.MaxHalfOpenCalls {
			cb.mu.Unlock()
			return zero, fmt.Errorf("%w: half-open capacity exhausted: name=%s", ErrCircuitOpen, cb.cfg.Name)
		}
		cb.halfOpenInflight++
		cb.mu.Unlock()

		result, err := fn(ctx)
		cb.recordHalfOpen(err)
		return result, err

	default: // StateClosed
		cb.mu.Unlock()
		result, err := fn(ctx)
		cb.recordClosed(err)
		return result, err
	}
}

// currentState transitions Open→HalfOpen if timeout has elapsed. Must be called under mu.
func (cb *CircuitBreaker[T]) currentState() State {
	if cb.state == StateOpen && time.Since(cb.lastStateChange) >= cb.cfg.Timeout {
		cb.transitionTo(StateHalfOpen)
	}
	return cb.state
}

func (cb *CircuitBreaker[T]) recordClosed(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err != nil {
		cb.failures++
		cb.successes = 0
		if cb.failures >= cb.cfg.FailureThreshold {
			cb.transitionTo(StateOpen)
		}
	} else {
		cb.failures = 0
		cb.successes++
	}
}

func (cb *CircuitBreaker[T]) recordHalfOpen(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.halfOpenInflight--

	if err != nil {
		cb.transitionTo(StateOpen)
	} else {
		cb.successes++
		if cb.successes >= cb.cfg.SuccessThreshold {
			cb.transitionTo(StateClosed)
		}
	}
}

func (cb *CircuitBreaker[T]) transitionTo(next State) {
	prev := cb.state
	cb.state = next
	cb.lastStateChange = time.Now()

	if next == StateClosed {
		cb.failures = 0
		cb.successes = 0
	} else if next == StateOpen {
		cb.successes = 0
		cb.halfOpenInflight = 0
	} else if next == StateHalfOpen {
		cb.successes = 0
	}

	cb.logger.Info("circuit breaker state transition",
		"from", prev.String(),
		"to", next.String(),
	)
}

// Stats returns a snapshot of the current breaker state.
func (cb *CircuitBreaker[T]) Stats() map[string]any {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return map[string]any{
		"name":              cb.cfg.Name,
		"state":             cb.state.String(),
		"failures":          cb.failures,
		"successes":         cb.successes,
		"last_state_change": cb.lastStateChange,
	}
}
```

---

### Junior -> FAANG: Circuit Breakers as Failure Isolation Tools

A circuit breaker does not fix a failing downstream service. It prevents a failing downstream from taking down the caller. This distinction is critical for interviews: the value of a circuit breaker is protecting the upstream, not healing the downstream.

The three-state model (closed, open, half-open) is the entry point for any circuit breaker question. In the closed state, calls pass through and failures are counted. When the failure count exceeds the threshold, the breaker opens and calls fail fast without attempting the downstream. After a timeout, the breaker enters half-open and allows a single probe call. If the probe succeeds, the breaker closes (downstream recovered). If it fails, the breaker re-opens (downstream still degraded).

The interview follow-up question is always: "What should the caller do when the circuit breaker is open?" The correct answer is: return a fallback (cached response, default value, graceful degradation), not an error. If the payment service circuit breaker is open, the checkout page should show "payment processing may be delayed" rather than a 500 error. Designing fallbacks for every circuit breaker is as important as implementing the breaker itself.

### Senior @ FAANG: Circuit Breaker Configuration, Observability, and Failure Mode Analysis

**Threshold calibration is a workload-specific task.** A circuit breaker that opens after 5 consecutive failures may be too aggressive for a payment service (5 transient timeouts during a network blip should not cut off payment processing entirely) and too lenient for a fraud detection service (5 failures may indicate the fraud model is serving garbage scores that are being accepted as legitimate). At L6, you calibrate circuit breaker thresholds based on measured failure rates and the business impact of false opens (unnecessary outages) versus false closes (allowing degraded service through).

**Error classification: what counts as a failure?** The circuit breaker implementation above counts all errors. But not all errors should count toward the failure threshold. A 400 Bad Request is the client's fault, not the downstream's. A 429 Too Many Requests means the downstream is healthy but rate limiting. A 503 Service Unavailable means the downstream is degraded. A 504 Gateway Timeout means the network or the downstream is slow. A production circuit breaker classifies errors and only counts 5xx responses and timeouts toward the failure threshold, excluding 4xx client errors.

**Half-open probe concurrency.** When the circuit breaker transitions to half-open, a flood of concurrent requests may all attempt the probe simultaneously, overwhelming a recovering downstream. A production circuit breaker allows exactly one probe request at a time in half-open state. Additional requests during the probe period fail fast (same as open state). Only after the single probe succeeds does the breaker fully close and allow concurrent traffic. This single-probe semantics is the critical correctness property of half-open.

**Circuit breaker observability.** Every state transition (closed to open, open to half-open, half-open to closed, half-open to open) should emit a structured log event and increment a labeled metric. The key metrics are: `circuit_open_total` (how often the breaker has opened, labeled by downstream), `circuit_open_duration_seconds` (how long breakers stay open), and `circuit_probe_success_rate` (how often half-open probes succeed). These metrics reveal whether your downstreams are degrading in specific patterns (same service opens repeatedly, indicating a chronic stability problem) or randomly (occasional blips that self-resolve).

**Distributed circuit breaker state.** The circuit breaker above holds state in memory per process. In a deployment with 100 instances of the caller service, each instance has its own circuit breaker state. One instance may see 10 failures and open its breaker while other instances see no failures and continue calling the downstream. This is inconsistent but often acceptable: eventually all instances will open their breakers if the downstream is truly degraded. For cases where consistent state is required (all instances must open simultaneously to protect a fragile downstream), use a distributed circuit breaker backed by Redis with atomic CAS operations for state transitions.

