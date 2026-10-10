## Failure Handling

In a system processing millions of requests per second, failures are inevitable. DSPs go down, Redis nodes restart, and network partitions happen. The circuit breaker pattern protects the auction engine by detecting when a DSP is consistently failing and temporarily stopping requests to it, preventing cascading failures and wasted latency budget. Graceful degradation uses probabilistic load shedding to drop a controlled percentage of requests when the system is overloaded, keeping the remaining requests healthy instead of letting everything fail. When all else fails, the fallback bid returns a house ad so the publisher still shows something and the page does not break.

```go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
	"time"
)

type CircuitBreaker struct {
	name         string
	maxFailures  int
	resetTimeout time.Duration
	halfOpenMax  int

	mu           sync.Mutex
	failures     int
	state        string
	lastFailure  time.Time
	successCount int
}

func NewCircuitBreaker(name string, max int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{name: name, maxFailures: max, resetTimeout: timeout, halfOpenMax: 3, state: "closed"}
}

func (cb *CircuitBreaker) Execute(ctx context.Context, fn func(context.Context) error) error {
	cb.mu.Lock()
	if cb.state == "open" {
		if time.Since(cb.lastFailure) > cb.resetTimeout {
			cb.state = "half-open"
			cb.successCount = 0
		} else {
			cb.mu.Unlock()
			return errors.New("circuit open: " + cb.name)
		}
	}
	cb.mu.Unlock()

	err := fn(ctx)

	cb.mu.Lock()
	defer cb.mu.Unlock()
	if err != nil {
		cb.failures++
		cb.lastFailure = time.Now()
		if cb.failures >= cb.maxFailures {
			cb.state = "open"
		}
		return err
	}
	if cb.state == "half-open" {
		cb.successCount++
		if cb.successCount >= cb.halfOpenMax {
			cb.state = "closed"
			cb.failures = 0
		}
	} else {
		cb.failures = 0
	}
	return nil
}

type GracefulDegradation struct{ maxQueueDepth int }

func (g *GracefulDegradation) ShouldShed(depth int) bool {
	if depth < g.maxQueueDepth {
		return false
	}
	return rand.Float64() < math.Min((float64(depth)/float64(g.maxQueueDepth)-1.0)*0.5, 0.9)
}

type Bid struct {
	DSP      string
	Price    float64
	AdMarkup string
}

type AuctionResult struct {
	WinnerBid  Bid
	ClearPrice float64
}

func FallbackBid(w, h int) *AuctionResult {
	return &AuctionResult{
		WinnerBid: Bid{
			DSP:      "house",
			Price:    0.01,
			AdMarkup: fmt.Sprintf("<div style='width:%dpx;height:%dpx'>House Ad</div>", w, h),
		},
		ClearPrice: 0.01,
	}
}
```

---
