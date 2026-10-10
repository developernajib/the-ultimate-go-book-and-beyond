## Failure Handling

### Circuit Breaker for External Services

When an external service like the payment provider goes down, naive retry logic can make things worse by flooding the failing service with requests. A circuit breaker solves this by tracking consecutive failures and "opening" the circuit when a threshold is reached, immediately rejecting new requests without hitting the downstream service. After a cooldown period, the circuit enters a "half-open" state where it allows a few test requests through to see if the service has recovered. This pattern prevents cascading failures and gives the external service time to recover.

```go
package resilience

import (
	"context"
	"errors"
	"sync"
	"time"
)

// CircuitBreaker prevents cascading failures when external services are down
type CircuitBreaker struct {
	name         string
	maxFailures  int
	resetTimeout time.Duration
	halfOpenMax  int

	mu           sync.Mutex
	state        string // "closed", "open", "half-open"
	failureCount int
	successCount int
	lastFailure  time.Time
}

var ErrCircuitOpen = errors.New("circuit breaker is open")

func NewCircuitBreaker(name string, maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		name:         name,
		maxFailures:  maxFailures,
		resetTimeout: resetTimeout,
		halfOpenMax:  3,
		state:        "closed",
	}
}

// Execute wraps a function call with circuit breaker logic
func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	cb.mu.Lock()

	switch cb.state {
	case "open":
		if time.Since(cb.lastFailure) > cb.resetTimeout {
			cb.state = "half-open"
			cb.successCount = 0
			cb.mu.Unlock()
		} else {
			cb.mu.Unlock()
			return ErrCircuitOpen
		}
	case "half-open":
		cb.mu.Unlock()
	default:
		cb.mu.Unlock()
	}

	err := fn(ctx)

	cb.mu.Lock()
	defer cb.mu.Unlock()

	if err != nil {
		cb.failureCount++
		cb.lastFailure = time.Now()
		if cb.failureCount >= cb.maxFailures {
			cb.state = "open"
		}
		return err
	}

	if cb.state == "half-open" {
		cb.successCount++
		if cb.successCount >= cb.halfOpenMax {
			cb.state = "closed"
			cb.failureCount = 0
		}
	} else {
		cb.failureCount = 0
	}

	return nil
}

// Usage in Order Service:
// paymentCB := NewCircuitBreaker("payment", 5, 30*time.Second)
// err := paymentCB.Execute(ctx, func(ctx context.Context) error {
//     return paymentSvc.Charge(ctx, req)
// })
// if errors.Is(err, ErrCircuitOpen) {
//     return queueForRetry(order)
// }
```

### Retry with Exponential Backoff

Transient failures like network timeouts or temporary server overloads often resolve on their own if you wait briefly before retrying. Exponential backoff increases the wait time between each retry attempt (100ms, 200ms, 400ms, and so on), which prevents a thundering herd of retries from overwhelming a recovering service. Adding random jitter ensures that multiple callers who failed at the same time do not all retry simultaneously. This pattern works hand-in-hand with the circuit breaker: retries handle short-lived blips, while the circuit breaker handles sustained outages.

```go
package resilience

import (
	"context"
	"math"
	"math/rand/v2"
	"time"
)

type RetryConfig struct {
	MaxRetries int
	BaseDelay  time.Duration
	MaxDelay   time.Duration
	Multiplier float64
	Jitter     bool
}

func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxRetries: 3,
		BaseDelay:  100 * time.Millisecond,
		MaxDelay:   10 * time.Second,
		Multiplier: 2.0,
		Jitter:     true,
	}
}

// Retry executes a function with exponential backoff
func Retry(ctx context.Context, cfg RetryConfig, fn func(ctx context.Context) error) error {
	var lastErr error
	for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
		lastErr = fn(ctx)
		if lastErr == nil {
			return nil
		}
		if attempt == cfg.MaxRetries {
			break
		}
		delay := time.Duration(float64(cfg.BaseDelay) * math.Pow(cfg.Multiplier, float64(attempt)))
		if delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}
		if cfg.Jitter {
			delay = time.Duration(float64(delay) * (0.5 + rand.Float64()))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return lastErr
}
```

### Graceful Degradation Strategies

A production food delivery platform cannot afford to go fully offline when a single component fails. Graceful degradation means designing each failure mode with a specific fallback strategy that keeps the system partially operational. The goal is to preserve the core user experience (placing and tracking orders) even when supporting services are degraded. Each scenario below defines what breaks, what the user sees, and how the system recovers automatically.

```
Scenario: Payment service is down
  - Accept orders with "payment_pending" status
  - Queue payment processing for when service recovers
  - Notify customer: "Order confirmed, payment processing"
  - Set 30-minute deadline for payment resolution

Scenario: Location service is degraded
  - Fall back to last known driver location (cached in Redis)
  - Increase location update interval from 4s to 10s
  - Show "approximate" location to customer
  - Disable ETA updates temporarily

Scenario: Restaurant service timeout
  - Use cached menu data (5-minute stale OK)
  - Show "estimated" prep times from historical data
  - Skip real-time queue depth in ETA calculation

Scenario: Dispatch cannot find a driver
  - Expand search radius incrementally (2km -> 4km -> 8km)
  - Increase driver incentive (surge bonus)
  - After 15 minutes: offer customer full refund or continued wait
  - Alert ops team for manual intervention

Scenario: Kafka is down (event bus)
  - Write events to local disk (WAL pattern)
  - Replay events when Kafka recovers
  - Critical events (payment, status changes) also written to DB
  - Non-critical events (analytics) can be dropped
```

---
