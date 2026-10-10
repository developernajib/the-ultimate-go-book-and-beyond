## 115.7 Error Handling with Retries and Circuit Breakers

Production LLM integration must handle transient failures, rate limits, and service outages.

### Exponential Backoff with Jitter

Exponential backoff with jitter prevents retry storms by spreading retry attempts over an increasing, randomized time window.

The jitter is the part people get wrong, and the failure is quiet. A common shape is to compute an exponential delay and then perturb it by some small percentage, say plus or minus ten percent. That looks like jitter and satisfies a code review, but it barely works. If a thousand clients are rate-limited at the same instant, they all compute the same base delay, and a ten percent spread means they all come back inside the same narrow window and re-trigger the limit together. The randomness has to be large enough to actually decorrelate the clients, and a fixed fraction of a shared base never is.

The implementation below uses **full jitter**: sleep a uniformly random duration between zero and the exponentially growing cap. The exponential term controls the ceiling, and the randomness fills the whole interval beneath it, which is what spreads a synchronized herd across the window instead of merely blurring its edges.

```go
// retry/backoff.go
package retry

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"time"
)

type Backoff struct {
	InitialDelay time.Duration
	MaxDelay     time.Duration
	Multiplier   float64
}

var DefaultBackoff = Backoff{
	InitialDelay: 100 * time.Millisecond,
	MaxDelay:     30 * time.Second,
	Multiplier:   2.0,
}

// Delay implements full jitter: a uniformly random duration in [0, cap),
// where cap = min(MaxDelay, InitialDelay * Multiplier^attempt).
//
// Do not "improve" this by narrowing the random range around the cap. The
// wide range is the entire point: it is what decorrelates clients that all
// failed at the same instant.
func (b *Backoff) Delay(attempt int) time.Duration {
	capped := float64(b.InitialDelay) * math.Pow(b.Multiplier, float64(attempt))
	if capped > float64(b.MaxDelay) {
		capped = float64(b.MaxDelay)
	}
	return time.Duration(rand.Float64() * capped)
}

type RetryFunc func(context.Context) error

func Retry(ctx context.Context, maxAttempts int, backoff Backoff, fn RetryFunc) error {
	var lastErr error

	for attempt := 0; attempt < maxAttempts; attempt++ {
		err := fn(ctx)
		if err == nil {
			return nil
		}

		lastErr = err

		// Don't retry on context cancellation
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Check if error is retryable
		if !IsRetryable(err) {
			return err
		}

		if attempt < maxAttempts-1 {
			delay := backoff.Delay(attempt)
			timer := time.NewTimer(delay)

			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
				// Continue to next attempt
			}
		}
	}

	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// StatusError is implemented by provider errors that carry an HTTP status.
// Each provider client in this chapter should return an error satisfying this
// interface rather than a flat fmt.Errorf string, precisely so that the retry
// layer can make this decision without parsing prose.
type StatusError interface {
	error
	StatusCode() int
}

// IsRetryable reports whether err represents a transient failure.
//
// Getting this wrong is expensive in both directions. Retry a 400 and you burn
// attempts on a request that can never succeed. Retry a 401 and you hammer the
// provider with bad credentials until they throttle you. Fail to retry a 429 or
// a 503 and you surface a transient blip to the user as a hard error.
//
// Note the default: unknown errors are NOT retried. Failing closed is the right
// bias here, because a retry loop against a paid API turns an unrecognised
// error into a recurring charge.
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}

	// Cancellation and deadline expiry are decisions, not failures.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var se StatusError
	if errors.As(err, &se) {
		switch code := se.StatusCode(); {
		case code == http.StatusTooManyRequests, // 429: back off and retry
			code == http.StatusRequestTimeout: // 408
			return true
		case code >= 500 && code <= 599: // provider-side, retry
			return true
		default:
			// 400 bad request, 401 unauthorized, 403 forbidden, 404 unknown
			// model, 413 payload too large, 422 validation. All permanent.
			// Retrying any of these is pure waste.
			return false
		}
	}

	// Transport-level failures (connection refused, reset, DNS, I/O timeout).
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}

	return false
}
```

One refinement worth making before this reaches production: a 429 usually arrives with a `Retry-After` header naming the exact time the provider wants you back. When it is present, obey it instead of your own backoff curve. Your exponential guess is at best uninformed and at worst returns sooner than the provider will accept, which earns you another 429 and makes the throttling last longer. Plumb that value out of the client alongside the status code, and let it override the computed delay.

### Circuit Breaker

The circuit breaker pattern prevents cascading failures by stopping requests to a failing dependency until it recovers, giving it time to stabilize. It has three states: **closed** (traffic flows), **open** (fail fast, do not call the dependency at all), and **half-open** (let a single probe through to see whether the dependency came back).

That word *single* is load-bearing, and it is where naive implementations fall down. If the reset window expires and you let every waiting caller through at once, you have not written a recovery probe, you have written a thundering herd aimed at a service that is, by hypothesis, still fragile. Half-open must admit exactly one request and make everyone else keep failing fast until that probe reports back.

The other trap is a self-inflicted deadlock. `sync.Mutex` and `sync.RWMutex` in Go are **not reentrant**. If you take the write lock to perform the open-to-half-open transition, hold it via `defer` for the rest of the function, then call the guarded function and try to take the lock again to record the outcome, the goroutine blocks on a lock it already owns and never returns. Because it still holds the write lock, every other caller (including any `State()` reader) piles up behind it and the whole breaker wedges. The circuit never recovers, which is the exact opposite of the pattern's purpose, and the failure only appears on the recovery path, so it survives any test that just checks that the breaker opens.

The structure below avoids both problems by splitting lock acquisition into two short critical sections, `beforeCall` and `afterCall`, with the guarded call in between holding no lock at all.

```go
// circuitbreaker/breaker.go
package circuitbreaker

import (
	"errors"
	"sync"
	"time"
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

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

type CircuitBreaker struct {
	maxFailures  int
	resetTimeout time.Duration

	mu           sync.Mutex
	state        State
	failures     int
	lastFailTime time.Time
	probing      bool // a half-open probe is currently in flight
}

func New(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures:  maxFailures,
		resetTimeout: resetTimeout,
		state:        StateClosed,
	}
}

// Call runs fn if the breaker permits it. fn is invoked while holding no lock,
// so a slow dependency cannot block other callers from being rejected quickly.
func (cb *CircuitBreaker) Call(fn func() error) error {
	if err := cb.beforeCall(); err != nil {
		return err
	}

	err := fn()
	cb.afterCall(err)
	return err
}

// beforeCall decides admission and returns ErrCircuitOpen to reject.
func (cb *CircuitBreaker) beforeCall() error {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	switch cb.state {
	case StateOpen:
		if time.Since(cb.lastFailTime) <= cb.resetTimeout {
			return ErrCircuitOpen
		}
		// Reset window elapsed: promote to half-open and become the probe.
		cb.state = StateHalfOpen
		cb.probing = true
		return nil

	case StateHalfOpen:
		// Exactly one probe at a time - everyone else keeps failing fast.
		if cb.probing {
			return ErrCircuitOpen
		}
		cb.probing = true
		return nil

	default: // StateClosed
		return nil
	}
}

// afterCall records the outcome and moves the state machine.
func (cb *CircuitBreaker) afterCall(err error) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	wasProbe := cb.state == StateHalfOpen
	if wasProbe {
		cb.probing = false
	}

	if err != nil {
		cb.failures++
		cb.lastFailTime = time.Now()
		// A failed probe re-opens immediately: the dependency is still sick,
		// so serve another full reset window rather than trickling traffic in.
		if wasProbe || cb.failures >= cb.maxFailures {
			cb.state = StateOpen
		}
		return
	}

	// Success closes the circuit and clears the counter. Resetting on every
	// success is deliberate: maxFailures should mean "consecutive failures".
	// Without this reset, isolated failures accumulate over the process
	// lifetime and eventually trip a breaker whose dependency is perfectly
	// healthy, which is a maddening bug to diagnose in production.
	cb.failures = 0
	cb.state = StateClosed
}

func (cb *CircuitBreaker) State() State {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return cb.state
}
```

### Resilient LLM Client

The resilient client wraps a provider client with both patterns. Note the nesting order, which is a design decision rather than an accident: the breaker is on the **outside** and the retry loop on the inside. Each logical operation therefore consumes one breaker slot no matter how many times it retries internally. Invert them and every retry votes separately, so a single user request can trip a five-failure breaker on its own, and an open circuit still admits the retry loop it was supposed to stop.

Note also the `Completer` interface. The earlier draft of this type held its dependency as `any` and switched on the concrete type, which throws away every compile-time guarantee Go offers and forces a type assertion on the hot path. A one-method interface is both smaller and safer, and it is what makes the provider genuinely swappable.

```go
// llm/resilient.go
package llm

import (
	"context"
	"time"

	"yourproject/circuitbreaker"
	"yourproject/retry"
)

// Completer is the narrow contract every provider adapter satisfies.
type Completer interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

type ResilientClient struct {
	client  Completer
	breaker *circuitbreaker.CircuitBreaker
	backoff retry.Backoff
}

func NewResilientClient(client Completer) *ResilientClient {
	return &ResilientClient{
		client:  client,
		breaker: circuitbreaker.New(5, 30*time.Second),
		backoff: retry.DefaultBackoff,
	}
}

func (rc *ResilientClient) Complete(
	ctx context.Context,
	prompt string,
) (string, error) {
	var result string

	// Breaker outside, retry inside: one breaker slot per logical operation.
	err := rc.breaker.Call(func() error {
		return retry.Retry(ctx, 3, rc.backoff, func(ctx context.Context) error {
			resp, err := rc.client.Complete(ctx, prompt)
			if err != nil {
				return err
			}
			result = resp
			return nil
		})
	})
	if err != nil {
		return "", err
	}

	return result, nil
}
```

### Junior → FAANG: Circuit Breakers as Production Hygiene

A circuit breaker is the pattern that prevents a single degraded downstream service from causing a cascading failure in your entire application. Without a circuit breaker, a slow or unavailable LLM API causes every user request to hang for the full timeout duration, consuming goroutine stack, connection pool capacity, and downstream request budgets. With a circuit breaker, after a threshold of consecutive failures, the breaker opens and subsequent requests fail immediately (fast fail) without reaching the LLM API. This protects your service's resources and allows the LLM API time to recover.

Implementing a circuit breaker correctly requires understanding the three states: closed (normal operation, requests pass through), open (failure threshold exceeded, requests fail immediately), and half-open (recovery probe, one request is allowed through to test if the service has recovered). The transition from open to half-open requires a configurable delay (typically 30 to 60 seconds), and a successful probe in half-open transitions back to closed. A failed probe returns to open. Practice implementing this state machine in Go with a mutex protecting the state, a configurable failure threshold, and a configurable recovery delay.

Exponential backoff with jitter is the retry strategy for transient errors. Without jitter, all retrying clients from a rate-limited period retry simultaneously after the same delay, causing a thundering herd that immediately re-triggers the rate limit. The formula to know is full jitter: `sleep = random(0, min(cap, base * 2^attempt))`, where `base` is the initial delay and `cap` is the maximum. Be able to implement it in Go from memory, and be able to say why the random range spans the entire interval rather than hugging the cap: the exponential term bounds the worst case, while the uniform draw underneath it is what actually decorrelates a synchronized herd. A small percentage wobble around a shared base delay is the common wrong answer, and interviewers do notice.

Two follow-ups that separate a memorized formula from operational experience. Retries multiply load on a service that is already struggling, so cap the attempt count and let the circuit breaker take over rather than retrying indefinitely. And when the provider tells you when to come back via a `Retry-After` header, that instruction outranks whatever your formula computed.

### Senior @ FAANG: Resilience Architecture for LLM-Dependent Services

At FAANG scale, LLM API resilience is a systems design problem, not an individual service problem. The LLM gateway handles circuit breaking, retry, and fallback centrally so that individual services do not need to implement these patterns. The gateway maintains one circuit breaker per provider and one per model, allowing granular control: if a large frontier model is degraded while a smaller model from the same provider is healthy, route requests to the smaller model rather than opening the circuit entirely. This provider-aware routing is a senior-level resilience feature that requires the gateway to know which models are interchangeable for each use case.

Fallback strategy design requires explicit quality tradeoff decisions. When the primary LLM provider is unavailable, the options are: fall back to a secondary provider (adds provider cost and operational complexity), fall back to a local model (adds GPU infrastructure cost, lower quality), return a cached response for similar prompts (may be stale or irrelevant), return a graceful degraded response that acknowledges the service is temporarily limited, or return an error. The right fallback depends on the feature: a critical product feature should fall back to a secondary provider rather than fail, while a nice-to-have AI enhancement might gracefully degrade to a non-AI behavior. Document the fallback strategy per feature in the service runbook.

At L7, LLM resilience strategy includes SLA negotiation with LLM API providers. Enterprise agreements with OpenAI, Anthropic, and Google typically include SLA commitments, dedicated capacity allocations, and escalation paths for outages. Negotiating these agreements, understanding what they guarantee (and what they do not), and designing the platform to operate within the guarantees is a staff-level responsibility that intersects with procurement, legal, and finance. The cost of enterprise agreements must be weighed against the cost of building and operating multi-provider redundancy internally.

Chaos engineering for LLM-dependent services is an underinvested practice at most organizations but is standard at FAANG. Regularly injecting LLM API failures (high latency, error responses, rate limit responses) into the production or staging environment and observing whether the circuit breakers, fallbacks, and graceful degradation mechanisms behave as designed is the only way to verify that the resilience architecture actually works. Setting up automated chaos experiments and reviewing the results quarterly is a senior-level reliability engineering practice.
