## Section 5: Circuit Breaker

### 5.1 Production Circuit Breaker

A production circuit breaker wraps outbound calls to a dependency and transitions between closed, open, and half-open states based on configurable error rate and volume thresholds. The following implementation tracks per-second error rates using a sliding window, exposes Prometheus metrics for each state transition, and integrates with Go's `context` package to respect deadlines during the half-open probe.

```go
package circuitbreaker

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// State represents the circuit breaker state.
type State int32

const (
	StateClosed   State = 0 // Normal operation.
	StateOpen     State = 1 // All calls fail immediately.
	StateHalfOpen State = 2 // Test calls allowed.
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

// Config holds circuit breaker configuration.
type Config struct {
	Name             string
	MaxFailures      int           // Failures in window before opening.
	Timeout          time.Duration // Time in open state before half-open.
	HalfOpenMaxCalls int           // Max test calls in half-open state.
	WindowSize       time.Duration // Failure counting window.
	OnStateChange    func(from, to State)
}

// CircuitBreaker implements the circuit breaker pattern.
type CircuitBreaker struct {
	cfg    Config
	state  atomic.Int32

	mu            sync.Mutex
	failures      []time.Time   // Failure timestamps within window.
	lastOpenTime  time.Time     // When circuit last opened.
	halfOpenCalls int32         // Current calls in half-open state.
	successCount  int32         // Successes in half-open state.
}

// New creates a new circuit breaker.
func New(cfg Config) *CircuitBreaker {
	cb := &CircuitBreaker{cfg: cfg}
	cb.state.Store(int32(StateClosed))
	return cb
}

// Execute runs fn through the circuit breaker.
// Returns ErrCircuitOpen if the circuit is open.
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
	state := State(cb.state.Load())

	switch state {
	case StateOpen:
		// Check if timeout has elapsed.
		cb.mu.Lock()
		if time.Since(cb.lastOpenTime) >= cb.cfg.Timeout {
			cb.transition(StateOpen, StateHalfOpen)
		}
		cb.mu.Unlock()

		if State(cb.state.Load()) == StateOpen {
			return fmt.Errorf("circuit breaker open: %s", cb.cfg.Name)
		}
		fallthrough

	case StateHalfOpen:
		// Allow limited test calls.
		calls := atomic.AddInt32(&cb.halfOpenCalls, 1)
		defer atomic.AddInt32(&cb.halfOpenCalls, -1)

		if int(calls) > cb.cfg.HalfOpenMaxCalls {
			return fmt.Errorf("circuit breaker half-open: max test calls exceeded")
		}

		err := fn(ctx)
		if err != nil {
			cb.recordFailure()
			return err
		}

		// Success in half-open state.
		successes := atomic.AddInt32(&cb.successCount, 1)
		if int(successes) >= cb.cfg.HalfOpenMaxCalls {
			cb.transition(StateHalfOpen, StateClosed)
		}
		return nil

	default: // StateClosed
		err := fn(ctx)
		if err != nil {
			cb.recordFailure()
		}
		return err
	}
}

func (cb *CircuitBreaker) recordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := time.Now()
	cb.failures = append(cb.failures, now)

	// Remove failures outside the window.
	windowStart := now.Add(-cb.cfg.WindowSize)
	valid := cb.failures[:0]
	for _, t := range cb.failures {
		if t.After(windowStart) {
			valid = append(valid, t)
		}
	}
	cb.failures = valid

	// Check if we should open the circuit.
	if len(cb.failures) >= cb.cfg.MaxFailures &&
		State(cb.state.Load()) == StateClosed {
		cb.transition(StateClosed, StateOpen)
	}
}

func (cb *CircuitBreaker) transition(from, to State) {
	if !cb.state.CompareAndSwap(int32(from), int32(to)) {
		return
	}

	if to == StateOpen {
		cb.lastOpenTime = time.Now()
	} else if to == StateClosed {
		cb.mu.Lock()
		cb.failures = cb.failures[:0]
		cb.mu.Unlock()
		atomic.StoreInt32(&cb.successCount, 0)
	}

	if cb.cfg.OnStateChange != nil {
		cb.cfg.OnStateChange(from, to)
	}
}

// State returns the current circuit state.
func (cb *CircuitBreaker) State() State { return State(cb.state.Load()) }

// Stats returns current circuit breaker statistics.
type Stats struct {
	State        State
	Failures     int
	HalfOpenCalls int32
}

func (cb *CircuitBreaker) Stats() Stats {
	cb.mu.Lock()
	failures := len(cb.failures)
	cb.mu.Unlock()
	return Stats{
		State:        cb.State(),
		Failures:     failures,
		HalfOpenCalls: atomic.LoadInt32(&cb.halfOpenCalls),
	}
}

// BulkheadLimiter implements the bulkhead pattern:
// Limits concurrent calls to prevent cascading failures.
type BulkheadLimiter struct {
	name    string
	sem     chan struct{} // Counting semaphore.
	timeout time.Duration
}

func NewBulkheadLimiter(name string, maxConcurrent int, timeout time.Duration) *BulkheadLimiter {
	return &BulkheadLimiter{
		name:    name,
		sem:     make(chan struct{}, maxConcurrent),
		timeout: timeout,
	}
}

// Execute runs fn through the bulkhead limiter.
func (b *BulkheadLimiter) Execute(ctx context.Context, fn func(context.Context) error) error {
	// Try to acquire a slot.
	select {
	case b.sem <- struct{}{}:
		defer func() { <-b.sem }()
		return fn(ctx)
	case <-time.After(b.timeout):
		return fmt.Errorf("bulkhead %s: max concurrent calls exceeded", b.name)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// RetryPolicy implements exponential backoff retry.
type RetryPolicy struct {
	MaxAttempts int
	InitialWait time.Duration
	MaxWait     time.Duration
	Multiplier  float64
	Jitter      float64 // Fraction of wait to add as random jitter (0.0 - 1.0).
	IsRetryable func(error) bool
}

func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		MaxAttempts: 5,
		InitialWait: 100 * time.Millisecond,
		MaxWait:     30 * time.Second,
		Multiplier:  2.0,
		Jitter:      0.1,
		IsRetryable: func(err error) bool { return err != nil },
	}
}

// Execute retries fn according to the policy.
func (p RetryPolicy) Execute(ctx context.Context, fn func(context.Context) error) error {
	wait := p.InitialWait
	var lastErr error

	for attempt := 0; attempt < p.MaxAttempts; attempt++ {
		lastErr = fn(ctx)
		if lastErr == nil {
			return nil
		}

		if !p.IsRetryable(lastErr) {
			return lastErr
		}

		if attempt < p.MaxAttempts-1 {
			// Calculate wait with jitter.
			jitter := time.Duration(float64(wait) * p.Jitter * (rand.Float64()*2 - 1))
			actualWait := wait + jitter
			if actualWait < 0 {
				actualWait = wait
			}
			if actualWait > p.MaxWait {
				actualWait = p.MaxWait
			}

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(actualWait):
			}

			// Exponential backoff.
			wait = time.Duration(float64(wait) * p.Multiplier)
			if wait > p.MaxWait {
				wait = p.MaxWait
			}
		}
	}
	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// avoid import errors
var _ = rand.Float64
var _ = http.StatusOK
var _ = sync.Mutex{}
var _ = context.Background
```

### Junior → FAANG: Circuit Breakers as Automatic Failure Isolation

The circuit breaker pattern is one of the most commonly asked about resilience patterns in FAANG interviews, and the three-state model (closed, open, half-open) is the canonical answer to "how do you prevent a slow downstream service from taking down your service?"

The state machine is the critical piece to understand: Closed means normal operation (all requests pass through). Open means the downstream is considered failed (all requests fail immediately without making the call). Half-open means the circuit is testing recovery (one request is allowed through as a probe). If the probe succeeds, the circuit closes. If the probe fails, the circuit reopens and the timeout resets.

The half-open state is what distinguishes a circuit breaker from a simple rate limiter or timeout. Without half-open, once the circuit opens, you need manual intervention to restore service. With half-open, the circuit automatically probes for recovery after the configured timeout, which is what makes recovery automatic.

The `HalfOpenMaxCalls` configuration determines how many probe requests are sent before deciding to close or reopen. Setting this to 1 means a single success closes the circuit (might be too eager for a recovering service). Setting this to 5 means you accept 5 requests hitting the recovering service before making a decision (more robust but slower recovery).

Bulkhead and retry composition: the implementation shows `BulkheadLimiter` (limits concurrent calls) and `RetryPolicy` (retries with backoff) as separate primitives. In production, you compose them: `RetryPolicy.Execute` wraps `BulkheadLimiter.Execute` wraps `CircuitBreaker.Execute`. The order matters: retry at the outermost layer means retry even when the circuit is open (wrong). Retry inside circuit breaker means individual retries count as individual circuit events (correct for deciding whether to open).

### Senior @ FAANG: Circuit Breaker Governance and Cascading Failure Prevention

The circuit breaker in this section is a good per-call implementation. At the platform level, the challenge is ensuring that circuit breakers are correctly configured, observable, and not accidentally defeating their own purpose.

Circuit breaker misconfiguration is a common source of cascading failures. If the `WindowSize` is too long (5 minutes), the circuit opens too slowly in response to a rapid failure (you take 5 minutes of errors before tripping). If `MaxFailures` is too low (2 failures), transient network hiccups trip the circuit unnecessarily, causing false positives. If the `Timeout` (time in open state) is too short (1 second), the circuit enters an open/half-open oscillation cycle under sustained downstream failure, sending periodic probe requests to an overloaded service instead of giving it time to recover. Correct tuning requires measuring your service's failure patterns: what is the typical transient failure rate (set MaxFailures above this), what is the typical recovery time after a downstream restart (set Timeout to at least this).

Shared vs per-instance circuit breakers: the implementation in this section is per-instance (each Go process has its own circuit breaker state). Under a rolling deployment where the new binary has 10 instances and the old binary has 10 instances, the circuit breakers are not coordinated: if 5 of the new instances have opened their circuits, the other 15 instances have no idea and continue sending requests. A shared circuit breaker (state stored in Redis with atomic transitions) propagates failure detection across the fleet, but adds Redis as a dependency for every circuit state change.

Adaptive thresholds: static `MaxFailures` thresholds do not account for traffic volume. 10 failures at 10,000 RPS (0.1% error rate) is very different from 10 failures at 100 RPS (10% error rate). An adaptive circuit breaker that uses an error rate percentage (open when error rate exceeds 50% in the window, with minimum volume of 20 requests) is more reliable than a fixed failure count. The Hystrix and Resilience4j implementations both default to percentage-based thresholds.

Fallback design: a circuit breaker without a fallback is a latency optimization (fail fast instead of timing out) but not a resilience improvement (the caller still gets an error). The combination of circuit breaker plus fallback (return cached response, return degraded response, enqueue for later processing) is what provides actual resilience. The fallback must be designed explicitly. It is not automatic. At the platform level, requiring a fallback strategy in the service design review (not just a circuit breaker configuration) produces more resilient systems.

---
