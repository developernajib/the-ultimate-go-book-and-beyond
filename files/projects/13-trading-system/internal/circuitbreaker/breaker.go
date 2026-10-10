// internal/circuitbreaker/breaker.go
package circuitbreaker

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrCircuitOpen = errors.New("circuit breaker is open")
)

// State represents circuit breaker state
type State int

const (
	StateClosed State = iota
	StateOpen
	StateHalfOpen
)

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	maxFailures  int
	resetTimeout time.Duration

	failures    int
	lastFailure time.Time
	state       State
	mu          sync.RWMutex
}

// NewCircuitBreaker creates a circuit breaker
func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures:  maxFailures,
		resetTimeout: resetTimeout,
		state:        StateClosed,
	}
}

// Call executes function with circuit breaker protection
func (cb *CircuitBreaker) Call(fn func() error) error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	// Check if circuit should transition to half-open
	if cb.state == StateOpen && time.Since(cb.lastFailure) > cb.resetTimeout {
		cb.state = StateHalfOpen
		cb.failures = 0
	}

	// Reject if circuit is open
	if cb.state == StateOpen {
		return ErrCircuitOpen
	}

	// Execute function
	err := fn()

	if err != nil {
		cb.failures++
		cb.lastFailure = time.Now()

		if cb.failures >= cb.maxFailures {
			cb.state = StateOpen
		}

		return err
	}

	// Success - reset circuit
	cb.failures = 0
	cb.state = StateClosed

	return nil
}

// GetState returns current circuit breaker state
func (cb *CircuitBreaker) GetState() State {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}
