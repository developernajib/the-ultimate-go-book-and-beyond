## 90G.8 GitHub's Three-Day Database Nightmare

### The Incident

In May 2023, GitHub experienced three separate but related database incidents over three days. The chain of events
illustrates how a single configuration change can trigger a cascade of failures when automated systems interact
in unexpected ways.

**Timeline:**

```
Day 1: Config change deployed to database cluster
       → Triggers unexpected automated failover
       → Failover promotes a replica to primary
       → Old primary and new primary briefly accept writes (split-brain risk)
       → Issue detected, manual intervention begins

Day 2: Rollback attempted on the config change
       → Rollback triggers ANOTHER automated failover
       → Read replicas not properly reattached during automated failover
       → Authentication service loses database connectivity
       → Auth failure rate spikes to 76%
       → GitHub login/API failures cascade globally

Day 3: Team attempts to stabilize
       → Additional replica issues discovered
       → Manual replica reattachment required
       → Service gradually restored
```

**Auth Failure Rate:**

```
  Auth Success Rate (%)
  100│──────────┐
     │          │
   90│          │
     │          │
   80│          │
     │          │
   76│          └──┐
     │             │  ← Day 2: 76% auth failure rate
   50│             │
     │             │
   24│             │─────────── only 24% of auth succeeding
     │             │
    0│─────────────┴────────────────────────────────────
     Day 1      Day 2      Day 3      Day 4
```

### Go Implementation: Circuit Breaker with Retry Storm Prevention

The GitHub incident demonstrates why circuit breakers and retry budgets are essential. When the auth database
went down, every service that depended on auth started retrying, creating a retry storm that made recovery harder.

```go
package circuitbreaker

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// State represents the circuit breaker state.
type State int

const (
	StateClosed   State = iota // normal operation - requests pass through
	StateOpen                   // circuit tripped - requests fail fast
	StateHalfOpen               // testing - limited requests pass through
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

var (
	ErrCircuitOpen = errors.New("circuit breaker is open")
	ErrTooManyRequests = errors.New("too many requests in half-open state")
)

// CircuitBreaker implements the circuit breaker pattern with retry budget.
type CircuitBreaker struct {
	name         string
	config       Config

	mu           sync.Mutex
	state        State
	failures     int64
	successes    int64
	lastFailure  time.Time
	halfOpenReqs atomic.Int64

	// Retry budget: limits total retries across all callers
	retryBudget  *RetryBudget
}

// Config configures circuit breaker behavior.
type Config struct {
	// FailureThreshold: number of failures before opening the circuit
	FailureThreshold int64
	// SuccessThreshold: number of successes in half-open before closing
	SuccessThreshold int64
	// OpenDuration: how long the circuit stays open before half-opening
	OpenDuration time.Duration
	// HalfOpenMaxRequests: max concurrent requests in half-open state
	HalfOpenMaxRequests int64
	// RetryBudgetPercent: max retry rate as percentage of successful requests
	RetryBudgetPercent float64
	// RetryBudgetWindow: time window for retry budget calculation
	RetryBudgetWindow time.Duration
}

// DefaultConfig returns sensible defaults for most services.
func DefaultConfig() Config {
	return Config{
		FailureThreshold:    5,
		SuccessThreshold:    3,
		OpenDuration:        30 * time.Second,
		HalfOpenMaxRequests: 3,
		RetryBudgetPercent:  20.0, // retries can be at most 20% of successful requests
		RetryBudgetWindow:   10 * time.Second,
	}
}

// RetryBudget limits the total number of retries to prevent retry storms.
// Modeled after the approach described in the Google SRE book.
type RetryBudget struct {
	mu             sync.Mutex
	windowDuration time.Duration
	maxPercent     float64

	successes []time.Time
	retries   []time.Time
}

func newRetryBudget(window time.Duration, maxPercent float64) *RetryBudget {
	return &RetryBudget{
		windowDuration: window,
		maxPercent:     maxPercent,
	}
}

// AllowRetry returns true if the retry budget allows another retry.
func (rb *RetryBudget) AllowRetry() bool {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rb.windowDuration)

	// Clean old entries
	rb.successes = filterAfter(rb.successes, cutoff)
	rb.retries = filterAfter(rb.retries, cutoff)

	successCount := float64(len(rb.successes))
	retryCount := float64(len(rb.retries))

	// Allow at least 3 retries per window even with 0 successes
	minRetries := 3.0
	maxRetries := max(minRetries, successCount*rb.maxPercent/100.0)

	if retryCount >= maxRetries {
		return false
	}

	rb.retries = append(rb.retries, now)
	return true
}

// RecordSuccess records a successful request for budget calculation.
func (rb *RetryBudget) RecordSuccess() {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.successes = append(rb.successes, time.Now())
}

func filterAfter(times []time.Time, cutoff time.Time) []time.Time {
	n := 0
	for _, t := range times {
		if t.After(cutoff) {
			times[n] = t
			n++
		}
	}
	return times[:n]
}

// NewCircuitBreaker creates a new circuit breaker.
func NewCircuitBreaker(name string, cfg Config) *CircuitBreaker {
	return &CircuitBreaker{
		name:        name,
		config:      cfg,
		state:       StateClosed,
		retryBudget: newRetryBudget(cfg.RetryBudgetWindow, cfg.RetryBudgetPercent),
	}
}

// Execute runs the given function through the circuit breaker.
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	if err := cb.canExecute(); err != nil {
		return err
	}

	err := fn(ctx)
	cb.recordResult(err)
	return err
}

// ExecuteWithRetry runs the function with retries, respecting the circuit
// breaker state and the global retry budget.
func (cb *CircuitBreaker) ExecuteWithRetry(
	ctx context.Context,
	maxRetries int,
	fn func(ctx context.Context) error,
) error {
	var lastErr error

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Check retry budget before retrying
			if !cb.retryBudget.AllowRetry() {
				return fmt.Errorf("retry budget exhausted after %d attempts: %w", attempt, lastErr)
			}

			// Exponential backoff with full jitter
			baseDelay := time.Duration(1<<uint(attempt-1)) * 100 * time.Millisecond
			maxDelay := min(baseDelay, 10*time.Second)
			jitter := time.Duration(rand.Int64N(int64(maxDelay)))

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(jitter):
			}
		}

		if err := cb.canExecute(); err != nil {
			lastErr = err
			continue
		}

		err := fn(ctx)
		cb.recordResult(err)

		if err == nil {
			cb.retryBudget.RecordSuccess()
			return nil
		}
		lastErr = err
	}

	return fmt.Errorf("all %d attempts failed: %w", maxRetries+1, lastErr)
}

func (cb *CircuitBreaker) canExecute() error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case StateClosed:
		return nil
	case StateOpen:
		// Check if enough time has passed to transition to half-open
		if time.Since(cb.lastFailure) >= cb.config.OpenDuration {
			cb.state = StateHalfOpen
			cb.halfOpenReqs.Store(0)
			return nil
		}
		return ErrCircuitOpen
	case StateHalfOpen:
		if cb.halfOpenReqs.Add(1) > cb.config.HalfOpenMaxRequests {
			return ErrTooManyRequests
		}
		return nil
	}
	return nil
}

func (cb *CircuitBreaker) recordResult(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err != nil {
		cb.failures++
		cb.lastFailure = time.Now()

		switch cb.state {
		case StateClosed:
			if cb.failures >= cb.config.FailureThreshold {
				cb.state = StateOpen
			}
		case StateHalfOpen:
			// Any failure in half-open reopens the circuit
			cb.state = StateOpen
			cb.failures = 0
		}
	} else {
		switch cb.state {
		case StateClosed:
			cb.failures = 0
		case StateHalfOpen:
			cb.successes++
			if cb.successes >= cb.config.SuccessThreshold {
				cb.state = StateClosed
				cb.failures = 0
				cb.successes = 0
			}
		}
	}
}

// State returns the current circuit breaker state.
func (cb *CircuitBreaker) State() State {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}
```

### Key Lessons

**Lesson 1: Automated failover can make things worse.** GitHub's automated failover system triggered unexpectedly
and then compounded the problem when a rollback triggered another failover. Automated systems must be tested
against the full matrix of failure scenarios, including cascading failures.

**Lesson 2: Retry storms are the #1 cause of cascading failures.** When GitHub's auth database went down, every
service that depended on auth started retrying. Millions of retries per second overwhelmed the recovering
database. Retry budgets (limiting total retries as a percentage of successful requests) are essential.

**Lesson 3: Read replicas need explicit reattachment.** GitHub's automated failover promoted a replica to primary
but did not reattach other read replicas to the new primary. This left the auth service without read capacity.
Failover runbooks must include replica reattachment verification.

### Junior → FAANG: Circuit Breaker and Retry Budget as Required Patterns

The circuit breaker and retry budget patterns in this section are required knowledge for any system design interview involving distributed services. Know the three states (closed, open, half-open), the transition conditions, and why half-open exists (to probe recovery without flooding the recovering system). The retry budget (limiting retries to 20% of successful requests) is the specific mechanism that prevents retry storms, which is the single most common cause of cascading failure at scale.

### Senior @ FAANG: Database Failover as a Platform Problem

At L6, database failover is not a per-service runbook item. It is a platform-level system that requires: automated primary detection, replica promotion with the correct replica (based on replication lag, not random selection), automatic reattachment of read replicas to the new primary, downstream service notification (invalidate connection pools), and a verification step before declaring recovery complete. GitHub's three-day nightmare was caused by missing the reattachment step in the automation. At staff level, you design the automation to handle the full state machine, not just the primary failure and promotion steps.

The retry storm pattern is also a governance issue: every service in your org needs a retry budget, not just the ones you build. The platform approach is a shared circuit breaker library with a default retry budget configuration that any service can adopt with two lines of code, and a CI lint rule that flags services with unconfigured retry logic.

---
