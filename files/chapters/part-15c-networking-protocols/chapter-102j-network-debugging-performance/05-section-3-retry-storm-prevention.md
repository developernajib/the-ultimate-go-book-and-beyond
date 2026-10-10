## 102J.3 Retry Storm Prevention

### 3.1 Adaptive Retry with Circuit Breaking

When a downstream service becomes degraded, naive retry logic amplifies load by re-sending every failed request immediately, potentially turning a partial outage into a complete one. The implementation below combines exponential backoff with jitter, which spreads retry pressure across time, and a circuit breaker that trips after consecutive failures and blocks further calls for a configurable recovery window, giving the downstream service room to recover before being inundated again.

```go
package netdebug

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// RetryableError indicates a transient failure suitable for retry.
type RetryableError struct {
	StatusCode int
	Err        error
	Retryable  bool
}

func (e *RetryableError) Error() string {
	return fmt.Sprintf("HTTP %d: %v", e.StatusCode, e.Err)
}

func (e *RetryableError) Unwrap() error { return e.Err }

// IsRetryable classifies HTTP status codes.
func IsRetryable(statusCode int) bool {
	switch statusCode {
	case 429, 500, 502, 503, 504:
		return true
	default:
		return false
	}
}

// RetryConfig controls retry behavior.
type RetryConfig struct {
	MaxAttempts     int
	InitialBackoff  time.Duration
	MaxBackoff      time.Duration
	BackoffFactor   float64
	Jitter          float64 // 0-1: fraction of backoff to randomize
	BudgetPerSecond float64 // max retries per second (retry budget)
}

// DefaultRetryConfig is safe for most services.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxAttempts:     3,
		InitialBackoff:  100 * time.Millisecond,
		MaxBackoff:      30 * time.Second,
		BackoffFactor:   2.0,
		Jitter:          0.5,
		BudgetPerSecond: 10,
	}
}

// RetryTransport wraps http.RoundTripper with retry logic and a retry budget.
type RetryTransport struct {
	base   http.RoundTripper
	cfg    RetryConfig
	tokens atomic.Int64 // token bucket for retry budget
	lastRefill time.Time
	mu     sync.Mutex
}

// NewRetryTransport creates a retry-capable transport.
func NewRetryTransport(base http.RoundTripper, cfg RetryConfig) *RetryTransport {
	rt := &RetryTransport{
		base:       base,
		cfg:        cfg,
		lastRefill: time.Now(),
	}
	rt.tokens.Store(int64(cfg.BudgetPerSecond))
	return rt
}

func (t *RetryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Only retry on safe methods
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return t.base.RoundTrip(req)
	}
	// Cannot retry if body is set and not seekable
	if req.Body != nil && req.GetBody == nil {
		return t.base.RoundTrip(req)
	}

	var lastErr error
	for attempt := 0; attempt < t.cfg.MaxAttempts; attempt++ {
		// Restore body for retries
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			req.Body = body
		}

		resp, err := t.base.RoundTrip(req)
		if err == nil && !IsRetryable(resp.StatusCode) {
			return resp, nil
		}

		if err == nil {
			// Must drain body before retrying
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			lastErr = &RetryableError{StatusCode: resp.StatusCode, Retryable: true}
		} else {
			lastErr = err
			// Only retry network errors, not context cancellation
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, err
			}
		}

		// Check retry budget
		if !t.consumeToken() {
			return nil, fmt.Errorf("retry budget exhausted: %w", lastErr)
		}

		// Calculate backoff with jitter
		backoff := t.backoffDuration(attempt)

		select {
		case <-time.After(backoff):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	}

	return nil, fmt.Errorf("max retries (%d) exceeded: %w", t.cfg.MaxAttempts, lastErr)
}

func (t *RetryTransport) consumeToken() bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	// Refill tokens based on time elapsed
	now := time.Now()
	elapsed := now.Sub(t.lastRefill).Seconds()
	refill := int64(elapsed * t.cfg.BudgetPerSecond)
	if refill > 0 {
		current := t.tokens.Load()
		max := int64(t.cfg.BudgetPerSecond)
		newTokens := current + refill
		if newTokens > max {
			newTokens = max
		}
		t.tokens.Store(newTokens)
		t.lastRefill = now
	}

	if t.tokens.Load() <= 0 {
		return false
	}
	t.tokens.Add(-1)
	return true
}

func (t *RetryTransport) backoffDuration(attempt int) time.Duration {
	base := float64(t.cfg.InitialBackoff) * math.Pow(t.cfg.BackoffFactor, float64(attempt))
	// Apply jitter: base * (1 + random(-jitter, +jitter))
	jitterRange := base * t.cfg.Jitter
	jittered := base + (rand.Float64()*2-1)*jitterRange

	duration := time.Duration(jittered)
	if duration > t.cfg.MaxBackoff {
		duration = t.cfg.MaxBackoff
	}
	return duration
}

// RetryStormSimulator demonstrates retry amplification.
// When N services simultaneously retry, traffic can spike N*maxAttempts fold.
func RetryStormSimulator(concurrentClients, maxRetries int, successRate float64) map[string]any {
	requests := 0
	successes := 0
	failures := 0

	for i := 0; i < concurrentClients; i++ {
		for attempt := 0; attempt < maxRetries; attempt++ {
			requests++
			if rand.Float64() < successRate {
				successes++
				break
			}
			failures++
		}
	}

	amplification := float64(requests) / float64(concurrentClients)

	return map[string]any{
		"clients":         concurrentClients,
		"total_requests":  requests,
		"successes":       successes,
		"failures":        failures,
		"amplification":   fmt.Sprintf("%.2fx", amplification),
		"recommendation":  "Use retry budget + jitter to limit amplification",
	}
}
```

### Junior → FAANG: Why Retry Storms Happen and the Simple Prevention

Retry storms start when a service experiences a transient error, all clients retry simultaneously, and the combined load of retries overwhelms the recovering service, preventing it from recovering. The amplification factor is the number of clients multiplied by the retry count. With 1,000 clients each retrying 3 times, a 1-second outage turns into 3,000 × the normal request rate hitting the recovering service.

The prevention is exponential backoff with jitter. Exponential backoff spreads retries over time (first retry after 100ms, second after 200ms, fourth after 400ms). Jitter (random variation in the delay) desynchronizes clients so they do not all retry at the same moment after the backoff period. `fullJitter = random(0, exponentialDelay)` is the standard formula from AWS's backoff-and-jitter blog post.

First-job habit: any code that makes an external call and retries on failure must use exponential backoff with jitter. No exceptions. If the team uses a platform retry library, use it. If not, implement it correctly rather than using `time.Sleep(1 * time.Second)` between retries.

### Senior @ FAANG: Circuit Breaking as Cascade Failure Prevention

Circuit breaking complements retry backoff by preventing requests from being sent to a known-failing downstream during the recovery period. Without circuit breaking, clients continue sending requests to a failing service even when those requests are guaranteed to fail (the service is down), wasting resources on both sides and slowing recovery.

The circuit breaker state machine has three states: closed (normal operation, requests pass through), open (too many failures, requests are rejected immediately without attempting the downstream), and half-open (probe state, one request is allowed through to test whether the downstream has recovered). The transition thresholds (failure rate that opens the circuit, timeout before moving to half-open, success count that closes it again) must be tuned for each service based on its failure characteristics.

At FAANG scale, circuit breaking is a platform concern. Every service that calls external dependencies should have circuit breakers configured by default. The platform service mesh (Envoy) provides circuit breaking at the proxy level, applying it consistently without requiring application code changes. Application-level circuit breaking (using `gobreaker` or similar) provides finer-grained control for cases where the proxy cannot distinguish between different failure modes. Documenting which level of circuit breaking applies to which call path is the L6 governance contribution.

---
