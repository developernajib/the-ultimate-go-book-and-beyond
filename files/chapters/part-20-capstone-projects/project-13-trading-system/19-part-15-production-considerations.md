## Part 15: Production Considerations

Running a trading system in production introduces challenges that do not exist in development. You need disaster recovery mechanisms to restore the system's state after a crash, circuit breakers to automatically halt trading when anomalies are detected, and GC tuning to keep garbage collection pauses well below your latency budget. This section covers the operational patterns that separate a hobby project from a system you can trust with real capital.

### Disaster Recovery
The snapshot-based recovery system periodically serializes the order book, position tracker, and risk state to disk. On restart, it replays from the latest snapshot and then applies any events that occurred after the snapshot timestamp.

```go
// internal/recovery/snapshot.go
package recovery

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/yourusername/trading-system/pkg/types"
)

// Snapshot represents system state snapshot
type Snapshot struct {
	Timestamp time.Time
	Orders    map[types.OrderID]*types.Order
	Positions map[types.AccountID]map[types.Symbol]*types.Position
	Accounts  map[types.AccountID]*types.Account
	Sequence  uint64
}

// SnapshotManager manages state snapshots
type SnapshotManager struct {
	interval time.Duration
	storage  SnapshotStorage
}

// SnapshotStorage defines storage interface
type SnapshotStorage interface {
	Save(ctx context.Context, snapshot *Snapshot) error
	Load(ctx context.Context) (*Snapshot, error)
	List(ctx context.Context, limit int) ([]*Snapshot, error)
}

// NewSnapshotManager creates a snapshot manager
func NewSnapshotManager(interval time.Duration, storage SnapshotStorage) *SnapshotManager {
	return &SnapshotManager{
		interval: interval,
		storage:  storage,
	}
}

// CreateSnapshot creates a system snapshot
func (sm *SnapshotManager) CreateSnapshot(
	orders map[types.OrderID]*types.Order,
	positions map[types.AccountID]map[types.Symbol]*types.Position,
	accounts map[types.AccountID]*types.Account,
	sequence uint64,
) (*Snapshot, error) {
	return &Snapshot{
		Timestamp: time.Now(),
		Orders:    orders,
		Positions: positions,
		Accounts:  accounts,
		Sequence:  sequence,
	}, nil
}

// SaveSnapshot saves a snapshot
func (sm *SnapshotManager) SaveSnapshot(ctx context.Context, snapshot *Snapshot) error {
	return sm.storage.Save(ctx, snapshot)
}

// LoadSnapshot loads the latest snapshot
func (sm *SnapshotManager) LoadSnapshot(ctx context.Context) (*Snapshot, error) {
	return sm.storage.Load(ctx)
}

// Recover recovers system state from snapshot
func (sm *SnapshotManager) Recover(ctx context.Context) (*Snapshot, error) {
	snapshot, err := sm.LoadSnapshot(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load snapshot: %w", err)
	}

	// Validate snapshot
	if time.Since(snapshot.Timestamp) > 24*time.Hour {
		return nil, fmt.Errorf("snapshot too old: %v", snapshot.Timestamp)
	}

	return snapshot, nil
}
```

### Circuit Breaker

The trading circuit breaker automatically halts order submission when anomalies are detected: excessive loss rate, abnormal position sizes, or connectivity failures with the exchange. It transitions through closed, open, and half-open states.

```go
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
```

### Rate Limiting

Rate limiting protects the service from abuse by enforcing per-client request quotas using a token bucket or sliding window algorithm. This middleware intercepts requests before they reach application handlers and returns HTTP 429 responses when a client's quota is exhausted.

```go
// internal/ratelimit/limiter.go
package ratelimit

import (
	"context"
	"time"

	"golang.org/x/time/rate"
)

// Limiter implements token bucket rate limiting
type Limiter struct {
	limiter *rate.Limiter
}

// NewLimiter creates a rate limiter
func NewLimiter(requestsPerSecond float64, burst int) *Limiter {
	return &Limiter{
		limiter: rate.NewLimiter(rate.Limit(requestsPerSecond), burst),
	}
}

// Allow checks if a request is allowed
func (l *Limiter) Allow() bool {
	return l.limiter.Allow()
}

// Wait waits for permission to proceed
func (l *Limiter) Wait(ctx context.Context) error {
	return l.limiter.Wait(ctx)
}

// Reserve reserves capacity for a request
func (l *Limiter) Reserve() *rate.Reservation {
	return l.limiter.Reserve()
}

// SetLimit updates the rate limit
func (l *Limiter) SetLimit(requestsPerSecond float64) {
	l.limiter.SetLimit(rate.Limit(requestsPerSecond))
}

// SetBurst updates the burst size
func (l *Limiter) SetBurst(burst int) {
	l.limiter.SetBurst(burst)
}
```

---
```
```
