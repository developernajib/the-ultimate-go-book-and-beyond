## Failure Handling

At the scale of YouTube or Netflix, failures are not exceptional events, they are constant. Network partitions, service crashes, and overloaded databases happen every minute across thousands of servers. The goal is not to prevent all failures but to contain them so that a single broken component does not bring down the entire platform. The patterns below show how to build resilience into your streaming system.

### Circuit Breaker

A circuit breaker prevents cascading failures when a downstream service becomes unhealthy. Without it, a failing recommendation service causes request timeouts that back up through the API gateway and take the platform with it. The breaker counts failures, opens after a threshold and fails fast without calling the downstream, and after a timeout admits a small number of probe requests (half-open). If the probes succeed it closes again.

The phrase "a few test requests" is doing critical work in that sentence, and it is the part naive implementations drop. If the half-open transition is a bare state check followed by an unguarded call, then every request that arrives the instant the timeout expires sees half-open and goes through. At this scale that is not "a few", it is thousands, arriving simultaneously at a service that is still on its knees. The breaker then knocks over the service it exists to protect, at exactly the moment of maximum fragility, and the resulting failures reopen the circuit, producing a loop that repeats forever on the openTimeout period. Half-open **must** be a concurrency limit, not just a state.

The counter is worth thinking about too. Counting *consecutive* failures means a downstream failing 50% of the time never trips the breaker at all, since a success keeps resetting the count, and a service that is half-broken is broken. Production breakers count failures over a rolling window instead. The version below keeps the consecutive count for clarity and admits exactly one probe at a time.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type CircuitState int

const (
	CircuitClosed CircuitState = iota
	CircuitOpen
	CircuitHalfOpen
)

// ErrCircuitOpen is returned without calling the downstream. Callers should
// treat it as a signal to degrade, not as a downstream error.
var ErrCircuitOpen = errors.New("circuit open")

type CircuitBreaker struct {
	name string

	failureThreshold int
	successThreshold int
	openTimeout      time.Duration

	mu           sync.Mutex
	state        CircuitState
	failureCount int
	successCount int
	lastFailure  time.Time
	// probeInFlight admits exactly one request while half-open. Everything else
	// keeps failing fast. This is the difference between probing a recovering
	// service and finishing it off.
	probeInFlight bool
}

func NewCircuitBreaker(name string, failureThreshold, successThreshold int, openTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		name:             name,
		failureThreshold: failureThreshold,
		successThreshold: successThreshold,
		openTimeout:      openTimeout,
	}
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
	isProbe, err := cb.admit()
	if err != nil {
		return err
	}

	callErr := fn(ctx)
	cb.record(isProbe, callErr)
	return callErr
}

// admit decides whether this call proceeds. All state transitions happen here,
// under one lock, so the check and the claim on the probe slot cannot be
// separated by another goroutine.
func (cb *CircuitBreaker) admit() (isProbe bool, err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case CircuitClosed:
		return false, nil

	case CircuitOpen:
		if time.Since(cb.lastFailure) <= cb.openTimeout {
			return false, fmt.Errorf("%w: %s", ErrCircuitOpen, cb.name)
		}
		// Timeout elapsed. Move to half-open and take the probe slot.
		cb.state = CircuitHalfOpen
		cb.successCount = 0
		cb.probeInFlight = true
		return true, nil

	case CircuitHalfOpen:
		if cb.probeInFlight {
			// Another probe is already out. Do not pile on.
			return false, fmt.Errorf("%w: %s (probing)", ErrCircuitOpen, cb.name)
		}
		cb.probeInFlight = true
		return true, nil
	}
	return false, nil
}

func (cb *CircuitBreaker) record(isProbe bool, callErr error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if isProbe {
		cb.probeInFlight = false
	}

	if callErr != nil {
		cb.failureCount++
		cb.lastFailure = time.Now()
		if cb.state == CircuitHalfOpen || cb.failureCount >= cb.failureThreshold {
			// A failed probe reopens immediately: one failure while half-open is
			// proof the downstream is still sick, and the clock restarts.
			cb.state = CircuitOpen
			cb.successCount = 0
		}
		return
	}

	if cb.state == CircuitHalfOpen {
		cb.successCount++
		if cb.successCount >= cb.successThreshold {
			cb.state = CircuitClosed
			cb.failureCount = 0
			cb.successCount = 0
		}
		return
	}
	cb.failureCount = 0
}

// State exposes the current state for metrics. Export this: a breaker you
// cannot see is a breaker you will not know has been open for two hours.
func (cb *CircuitBreaker) State() CircuitState {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}
```

### Graceful Degradation

When a component fails, the platform should degrade gracefully rather than return errors to users. Graceful degradation means providing a reduced but functional experience, for example, showing cached recommendations instead of personalized ones, or limiting video quality instead of refusing to play. The table below maps common failure scenarios to their degradation strategies.

| Failure | Degradation |
|---------|-------------|
| Recommendation down | Cached recs, fall back to popularity |
| Transcoding backlog | Prioritize top creators |
| CDN overload | Lower max quality, extend TTLs |
| View count lag | Show stale counts |
| Search stale | Serve last-known index |
| DRM license server down | Cached licenses still work |

---
