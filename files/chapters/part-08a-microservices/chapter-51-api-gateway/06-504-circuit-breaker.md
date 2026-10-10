## 51.4 Circuit Breaker

### Circuit Breaker Implementation

A circuit breaker monitors calls to a dependency and opens the circuit, failing fast, when the error rate exceeds a threshold. After a configurable cooldown period, the circuit transitions to half-open, allowing a probe request to test whether the dependency has recovered.

```go
// pkg/gateway/circuitbreaker.go
package gateway

import (
	"sync"
	"time"
)

// CircuitState represents the circuit breaker state
type CircuitState int

const (
	CircuitClosed CircuitState = iota
	CircuitOpen
	CircuitHalfOpen
)

func (s CircuitState) String() string {
	switch s {
	case CircuitClosed:
		return "closed"
	case CircuitOpen:
		return "open"
	case CircuitHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// CircuitBreakerConfig holds circuit breaker configuration
type CircuitBreakerConfig struct {
	FailureThreshold    int
	SuccessThreshold    int
	Timeout             time.Duration
	HalfOpenMaxRequests int
}

// DefaultCircuitBreakerConfig returns sensible defaults
func DefaultCircuitBreakerConfig() CircuitBreakerConfig {
	return CircuitBreakerConfig{
		FailureThreshold:    5,
		SuccessThreshold:    3,
		Timeout:             30 * time.Second,
		HalfOpenMaxRequests: 3,
	}
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	config       CircuitBreakerConfig
	state        CircuitState
	failures     int
	successes    int
	lastFailure  time.Time
	halfOpenReqs int

	mu sync.RWMutex
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(config CircuitBreakerConfig) *CircuitBreaker {
	return &CircuitBreaker{
		config: config,
		state:  CircuitClosed,
	}
}

// Allow checks if a request should be allowed
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case CircuitClosed:
		return true

	case CircuitOpen:
		// Check if timeout has elapsed
		if time.Since(cb.lastFailure) > cb.config.Timeout {
			cb.state = CircuitHalfOpen
			cb.halfOpenReqs = 0
			cb.successes = 0
			return true
		}
		return false

	case CircuitHalfOpen:
		// Allow limited requests in half-open state
		if cb.halfOpenReqs < cb.config.HalfOpenMaxRequests {
			cb.halfOpenReqs++
			return true
		}
		return false
	}

	return false
}

// RecordSuccess records a successful request
func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case CircuitHalfOpen:
		cb.successes++
		if cb.successes >= cb.config.SuccessThreshold {
			cb.state = CircuitClosed
			cb.failures = 0
		}
	case CircuitClosed:
		cb.failures = 0
	}
}

// RecordFailure records a failed request
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures++
	cb.lastFailure = time.Now()

	switch cb.state {
	case CircuitClosed:
		if cb.failures >= cb.config.FailureThreshold {
			cb.state = CircuitOpen
		}
	case CircuitHalfOpen:
		cb.state = CircuitOpen
	}
}

// State returns current state
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// Stats returns circuit breaker statistics
func (cb *CircuitBreaker) Stats() CircuitBreakerStats {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	return CircuitBreakerStats{
		State:       cb.state.String(),
		Failures:    cb.failures,
		Successes:   cb.successes,
		LastFailure: cb.lastFailure,
	}
}

// CircuitBreakerStats holds statistics
type CircuitBreakerStats struct {
	State       string
	Failures    int
	Successes   int
	LastFailure time.Time
}
```

### Junior -> FAANG: Circuit Breaker State Machine Fundamentals

The circuit breaker has three states: closed (requests pass through), open (requests fail immediately), and half-open (a probe request is allowed to test recovery). Interviewers ask you to draw this state machine and label the transitions. Know it by heart.

The transition rules: closed transitions to open when failure count exceeds `FailureThreshold`. Open transitions to half-open after `Timeout` elapses. Half-open transitions to closed when `SuccessThreshold` consecutive successes occur. Half-open transitions back to open if any failure occurs.

The practical question: "what counts as a failure?" The implementation here records failures and successes externally via `RecordFailure` and `RecordSuccess`. In practice you count HTTP 5xx responses from the upstream (not 4xx, which are client errors), connection timeouts, and context deadline exceeded errors. You do not count 429 (rate limit) as a failure because the upstream is healthy, just throttling you.

Common interview mistake: confusing circuit breaker with retry logic. They are complementary. Retries handle transient errors on healthy upstreams. Circuit breakers stop sending requests to unhealthy upstreams so they have time to recover. Using retries without a circuit breaker under a sustained outage causes a retry storm that worsens the outage.

### Senior @ FAANG: Circuit Breaker Reliability at Scale

**Failure percentage vs failure count.** The implementation here uses an absolute failure count threshold. Under variable load this is misleading: 5 failures out of 10 requests (50% error rate) is very different from 5 failures out of 10000 requests (0.05% error rate). Production circuit breakers use a failure percentage threshold with a minimum request count floor (e.g., open if error rate exceeds 50% AND at least 20 requests have been made in the last 10 seconds). Netflix Hystrix, Envoy's outlier detection, and resilience4j all use percentage-based thresholds.

**Half-open probe count vs concurrent requests.** `HalfOpenMaxRequests: 3` allows up to 3 concurrent probes. If all 3 succeed, the circuit closes. But if a recovering service can only handle 1 request per second, sending 3 concurrent probes may trip it again. A safer model limits half-open to 1 probe at a time and closes the circuit after N consecutive successful singles.

**Thundering herd on synchronized recovery.** If 100 gateway instances all have the same `Timeout` value and the upstream fails at the same moment, all 100 instances will transition to half-open at the same moment. The `HalfOpenMaxRequests` limit applies per instance, so you still send 300 concurrent probes to a recovering upstream. The fix is jitter: add `Timeout + rand(0, Timeout/4)` per instance, as shown in the pitfalls chapter. This staggers recovery across instances, giving the upstream time to establish health before the full fleet re-engages.

**Observability for circuit breaker state.** `Stats()` returns the current state, failure count, and last failure time. In production this data is exported as a Prometheus gauge per service (0 = closed, 1 = half-open, 2 = open) so SREs can alert when any service circuit opens. The alert threshold is typically "any circuit open for more than 2 minutes" which indicates a sustained outage rather than a transient spike. Pair this with the upstream's own SLO dashboard so the on-call engineer sees both the gateway-side evidence and the service-side evidence in one view.

**Interaction with load balancing.** A circuit breaker at the service level (per service name) is coarser than a circuit breaker at the instance level. If one instance of a service is unhealthy and two are healthy, a service-level circuit breaker will open after enough failures route to the bad instance, blocking traffic to the healthy instances too. Instance-level circuit breakers (one per discovered endpoint) with passive health ejection are more precise: eject the failing instance from the load balancer pool, keep routing to healthy instances. Envoy's outlier detection implements this natively. For a custom Go gateway, this means tracking failure counts per `ServiceInstance` rather than per service name.

---
