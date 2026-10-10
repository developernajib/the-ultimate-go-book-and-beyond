package circuitbreaker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrCircuitOpen     = errors.New("circuit breaker is open")
	ErrTooManyRequests = errors.New("too many requests")
)

// State represents the circuit breaker state
type State int

const (
	StateClosed State = iota
	StateHalfOpen
	StateOpen
)

func (s State) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateHalfOpen:
		return "half-open"
	case StateOpen:
		return "open"
	default:
		return "unknown"
	}
}

// Config holds circuit breaker configuration
type Config struct {
	MaxRequests   uint32
	Interval      time.Duration
	Timeout       time.Duration
	ReadyToTrip   func(counts Counts) bool
	OnStateChange func(name string, from State, to State)
}

// Counts holds the statistics of the circuit breaker
type Counts struct {
	Requests             uint32
	TotalSuccesses       uint32
	TotalFailures        uint32
	ConsecutiveSuccesses uint32
	ConsecutiveFailures  uint32
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	name          string
	maxRequests   uint32
	interval      time.Duration
	timeout       time.Duration
	readyToTrip   func(counts Counts) bool
	onStateChange func(name string, from State, to State)

	mu         sync.Mutex
	state      State
	generation uint64
	counts     Counts
	expiry     time.Time
}

// New creates a new CircuitBreaker
func New(name string, cfg Config) *CircuitBreaker {
	cb := &CircuitBreaker{
		name:          name,
		maxRequests:   cfg.MaxRequests,
		interval:      cfg.Interval,
		timeout:       cfg.Timeout,
		readyToTrip:   cfg.ReadyToTrip,
		onStateChange: cfg.OnStateChange,
	}

	if cb.maxRequests == 0 {
		cb.maxRequests = 1
	}
	if cb.interval <= 0 {
		cb.interval = time.Second * 60
	}
	if cb.timeout <= 0 {
		cb.timeout = time.Second * 60
	}
	if cb.readyToTrip == nil {
		cb.readyToTrip = func(counts Counts) bool {
			return counts.ConsecutiveFailures > 5
		}
	}

	cb.toNewGeneration(time.Now())
	return cb
}

// Execute runs the given function if the circuit breaker is closed or half-open
func (cb *CircuitBreaker) Execute(fn func() error) error {
	generation, err := cb.beforeRequest()
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			cb.afterRequest(generation, false)
			panic(r)
		}
	}()

	err = fn()
	cb.afterRequest(generation, err == nil)
	return err
}

// ExecuteCtx runs the given function with context support
func (cb *CircuitBreaker) ExecuteCtx(ctx context.Context, fn func(context.Context) error) error {
	generation, err := cb.beforeRequest()
	if err != nil {
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			cb.afterRequest(generation, false)
			panic(r)
		}
	}()

	err = fn(ctx)
	cb.afterRequest(generation, err == nil)
	return err
}

// State returns the current state
func (cb *CircuitBreaker) State() State {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	now := time.Now()
	state, _ := cb.currentState(now)
	return state
}

// Counts returns a copy of the current counts
func (cb *CircuitBreaker) Counts() Counts {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.counts
}

func (cb *CircuitBreaker) beforeRequest() (uint64, error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	now := time.Now()
	state, generation := cb.currentState(now)
	if state == StateOpen {
		return generation, ErrCircuitOpen
	} else if state == StateHalfOpen && cb.counts.Requests >= cb.maxRequests {
		return generation, ErrTooManyRequests
	}
	cb.counts.Requests++
	return generation, nil
}

func (cb *CircuitBreaker) afterRequest(before uint64, success bool) {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	now := time.Now()
	state, generation := cb.currentState(now)
	if generation != before {
		return
	}
	if success {
		cb.onSuccess(state, now)
	} else {
		cb.onFailure(state, now)
	}
}

func (cb *CircuitBreaker) onSuccess(state State, now time.Time) {
	cb.counts.TotalSuccesses++
	cb.counts.ConsecutiveSuccesses++
	cb.counts.ConsecutiveFailures = 0
	if state == StateHalfOpen && cb.counts.ConsecutiveSuccesses >= cb.maxRequests {
		cb.setState(StateClosed, now)
	}
}

func (cb *CircuitBreaker) onFailure(state State, now time.Time) {
	cb.counts.TotalFailures++
	cb.counts.ConsecutiveFailures++
	cb.counts.ConsecutiveSuccesses = 0
	if cb.readyToTrip(cb.counts) {
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

// ensure fmt is used
var _ = fmt.Sprintf
