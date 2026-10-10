## 59.7 Retry Patterns

Transient failures, network timeouts, brief service restarts, DNS blips, are inevitable in distributed systems. A well-designed retry strategy recovers from these transparently, but a naive one can amplify the problem by hammering an already-struggling service. The `Retrier` below supports exponential backoff (doubling the delay between attempts), configurable jitter (randomizing delay to prevent synchronized retries across clients), a maximum delay cap, and pluggable error classification so that permanent errors like `404 Not Found` are not retried. It also respects context cancellation at every wait point, ensuring that callers retain control over total request duration.

```go
// retry/retry.go
package retry

import (
    "context"
    "errors"
    "math/rand/v2"
    "time"
)

// Config defines retry behavior
type Config struct {
    MaxAttempts     int
    InitialDelay    time.Duration
    MaxDelay        time.Duration
    Multiplier      float64
    Jitter          float64 // 0-1, percentage of delay to add as jitter
    RetryableErrors []error
    RetryIf         func(error) bool
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        MaxAttempts:  3,
        InitialDelay: 100 * time.Millisecond,
        MaxDelay:     30 * time.Second,
        Multiplier:   2.0,
        Jitter:       0.1,
    }
}

// Retrier implements retry logic
type Retrier struct {
    config Config
}

// New creates a new retrier
func New(config Config) *Retrier {
    return &Retrier{config: config}
}

// Do executes a function with retries
func (r *Retrier) Do(fn func() error) error {
    return r.DoWithContext(context.Background(), func(ctx context.Context) error {
        return fn()
    })
}

// DoWithContext executes with context support
func (r *Retrier) DoWithContext(ctx context.Context, fn func(context.Context) error) error {
    var lastErr error
    delay := r.config.InitialDelay

    for attempt := 0; attempt < r.config.MaxAttempts; attempt++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        err := fn(ctx)
        if err == nil {
            return nil
        }

        lastErr = err

        // Check if error is retryable
        if !r.isRetryable(err) {
            return err
        }

        // Don't sleep after last attempt
        if attempt < r.config.MaxAttempts-1 {
            sleepDuration := r.calculateDelay(delay)

            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(sleepDuration):
            }

            // Calculate next delay
            delay = time.Duration(float64(delay) * r.config.Multiplier)
            if delay > r.config.MaxDelay {
                delay = r.config.MaxDelay
            }
        }
    }

    return lastErr
}

// DoWithResult executes and returns a result. It is a free function
// rather than a method because Go methods cannot have their own type
// parameters.
func DoWithResult[T any](r *Retrier, fn func() (T, error)) (T, error) {
    return DoWithResultContext(context.Background(), r, func(ctx context.Context) (T, error) {
        return fn()
    })
}

// DoWithResultContext executes with context and returns a result
func DoWithResultContext[T any](ctx context.Context, r *Retrier, fn func(context.Context) (T, error)) (T, error) {
    var lastErr error
    var zero T
    delay := r.config.InitialDelay

    for attempt := 0; attempt < r.config.MaxAttempts; attempt++ {
        select {
        case <-ctx.Done():
            return zero, ctx.Err()
        default:
        }

        result, err := fn(ctx)
        if err == nil {
            return result, nil
        }

        lastErr = err

        if !r.isRetryable(err) {
            return zero, err
        }

        if attempt < r.config.MaxAttempts-1 {
            sleepDuration := r.calculateDelay(delay)

            select {
            case <-ctx.Done():
                return zero, ctx.Err()
            case <-time.After(sleepDuration):
            }

            delay = time.Duration(float64(delay) * r.config.Multiplier)
            if delay > r.config.MaxDelay {
                delay = r.config.MaxDelay
            }
        }
    }

    return zero, lastErr
}

func (r *Retrier) isRetryable(err error) bool {
    // A shed retry is a final answer, never retried: looping on it
    // would burn MaxAttempts worth of backoff sleeps doing nothing.
    if errors.Is(err, ErrBudgetExhausted) {
        return false
    }

    if r.config.RetryIf != nil {
        return r.config.RetryIf(err)
    }

    if len(r.config.RetryableErrors) > 0 {
        for _, retryableErr := range r.config.RetryableErrors {
            if errors.Is(err, retryableErr) {
                return true
            }
        }
        return false
    }

    // By default, retry all errors
    return true
}

func (r *Retrier) calculateDelay(baseDelay time.Duration) time.Duration {
    if r.config.Jitter <= 0 {
        return baseDelay
    }

    jitterRange := float64(baseDelay) * r.config.Jitter
    jitter := (rand.Float64() * 2 * jitterRange) - jitterRange

    return baseDelay + time.Duration(jitter)
}

// Convenience functions

// WithExponentialBackoff creates a retrier with exponential backoff
func WithExponentialBackoff(maxAttempts int, initialDelay, maxDelay time.Duration) *Retrier {
    return New(Config{
        MaxAttempts:  maxAttempts,
        InitialDelay: initialDelay,
        MaxDelay:     maxDelay,
        Multiplier:   2.0,
        Jitter:       0.1,
    })
}

// WithConstantDelay creates a retrier with constant delay
func WithConstantDelay(maxAttempts int, delay time.Duration) *Retrier {
    return New(Config{
        MaxAttempts:  maxAttempts,
        InitialDelay: delay,
        MaxDelay:     delay,
        Multiplier:   1.0,
        Jitter:       0,
    })
}

// WithSlowExponentialBackoff creates a retrier that grows delays
// gently (1.5x) for callers that want something between constant and
// full doubling. True additive-increment backoff would need its own
// delay schedule, this Config only expresses multiplicative growth.
func WithSlowExponentialBackoff(maxAttempts int, initialDelay, maxDelay time.Duration) *Retrier {
    return New(Config{
        MaxAttempts:  maxAttempts,
        InitialDelay: initialDelay,
        MaxDelay:     maxDelay,
        Multiplier:   1.5,
        Jitter:       0.1,
    })
}
```

### Retry with Backoff Budget

Per-request exponential backoff works well in isolation, but when thousands of requests fail simultaneously, during a partial outage, each one independently retries, creating a synchronized flood that can overwhelm a recovering service. A retry budget solves this by enforcing a global cap on how many retries the entire process may issue within a sliding time window, converting the thundering-herd problem into a controlled trickle. The sliding-window implementation here evicts timestamps older than the window before every check, so the budget naturally replenishes as time passes without allocating a fixed-size ring buffer.

```go
// retry/budget.go
package retry

import (
    "context"
    "errors"
    "sync"
    "time"
)

// ErrBudgetExhausted reports that the process-wide retry budget is
// spent and the retry was shed rather than executed.
var ErrBudgetExhausted = errors.New("retry budget exhausted")

// RetryBudget limits total retry time across all requests
type RetryBudget struct {
    mu          sync.Mutex
    maxRetries  int64
    window      time.Duration
    timestamps  []time.Time
}

// NewRetryBudget creates a retry budget
func NewRetryBudget(maxRetries int64, window time.Duration) *RetryBudget {
    return &RetryBudget{
        maxRetries: maxRetries,
        window:     window,
        timestamps: make([]time.Time, 0),
    }
}

// Allow checks if a retry is allowed within budget
func (rb *RetryBudget) Allow() bool {
    rb.mu.Lock()
    defer rb.mu.Unlock()

    now := time.Now()
    cutoff := now.Add(-rb.window)

    // Remove old timestamps
    valid := rb.timestamps[:0]
    for _, ts := range rb.timestamps {
        if ts.After(cutoff) {
            valid = append(valid, ts)
        }
    }
    rb.timestamps = valid

    // Check if under budget
    if int64(len(rb.timestamps)) >= rb.maxRetries {
        return false
    }

    rb.timestamps = append(rb.timestamps, now)
    return true
}

// WithBudget wraps a retrier with a budget
func WithBudget(r *Retrier, budget *RetryBudget) *BudgetedRetrier {
    return &BudgetedRetrier{
        retrier: r,
        budget:  budget,
    }
}

// BudgetedRetrier applies budget constraints to retries
type BudgetedRetrier struct {
    retrier *Retrier
    budget  *RetryBudget
}

// Do executes with budget constraints. The first attempt is always
// allowed. Every subsequent attempt must draw from the shared budget,
// and when the budget is spent the retry is shed with
// ErrBudgetExhausted, which the retrier treats as non-retryable.
func (br *BudgetedRetrier) Do(fn func() error) error {
    attempt := 0
    return br.retrier.DoWithContext(context.Background(), func(ctx context.Context) error {
        attempt++
        if attempt > 1 && !br.budget.Allow() {
            return ErrBudgetExhausted
        }
        return fn()
    })
}
```

### Junior -> FAANG: Building the Retry Intuition

Retries seem simple but have two failure modes that juniors miss. The first is retrying non-idempotent operations. A POST to create a payment is not idempotent: retrying it after a timeout can create duplicate charges. Retries are only safe for operations that are explicitly idempotent (GET, DELETE with the same ID) or operations backed by idempotency keys. Before adding retry logic to any call, ask: "if this executes twice, what happens?" If the answer is "something bad," the call needs an idempotency key before it can be retried.

The second failure mode is synchronized retries causing a thundering herd. If 1,000 clients all fail at the same moment (because a downstream restarted), and they all retry after exactly 100ms, they produce a synchronized wave that hits the recovering service harder than the original traffic. Jitter breaks this: adding a random value to each client's backoff delay spreads the retry wave across a window, reducing peak load by a factor proportional to the jitter range.

For interviews, be able to calculate: "if base delay is 100ms with 2x multiplier and 3 attempts, what is the worst-case wait before giving up?" Answer: 100ms + 200ms = 300ms plus the third attempt's execution time. With jitter at 10%, the range is roughly 270ms to 330ms. Know that this adds up quickly for users waiting synchronously, which is why retries in synchronous request paths should be bounded very tightly (2-3 attempts, small delays) compared to background workers (5-10 attempts, larger delays).

Entry-level habit: always pass a context to your retry loop and check for cancellation before each wait. A user who closes their browser should not cause your backend to silently continue retrying a downstream call that no longer serves anyone.

### Senior @ FAANG: Retry Budgets, Deadline Propagation, and the Retry Amplification Problem

The retry budget concept addresses a systemic risk that is invisible when looking at a single service but catastrophic at scale. Consider a call chain: client calls A, A calls B, B calls C. If each layer has a retry policy of 3 attempts, a single failure at C triggers: C's caller (B) retries 3 times, for 3 calls to C. A retries 3 calls to B, each of which generates 3 calls to C, for 9 total calls to C. The client retries 3 calls to A, for 27 total calls to C. This is the retry amplification problem: `retries ^ depth` calls reach the bottom of the call chain. In a five-layer microservice architecture with 3 retries per layer, a single failure can generate 243 calls to the bottom-most service.

Retry budgets cap total retries across all requests in a process window, not just per-request retries. Google SRE's recommendation is that retries should never exceed 10% of total traffic. If your service handles 1,000 rps and retries are generating 150 rps of additional traffic (15%), the retry budget is exhausted and additional retries are shed rather than executed.

Deadline propagation is the complementary mechanism. When a client sets a 500ms deadline on a request, that deadline must propagate to every downstream call so that downstream services do not continue work after the client has already given up. Without deadline propagation, a retry at the top of the call chain can cause work to accumulate in every layer below it, all of which will be discarded when the results arrive too late. Go's `context.WithDeadline` propagates naturally when you pass context to every call, but verify that your HTTP middleware and gRPC interceptors actually forward the deadline header.

ADR question for retry governance: should retries be opt-out (default on, teams turn them off for non-idempotent operations) or opt-in (default off, teams enable them when they have verified idempotency)? Opt-out is operationally convenient but creates a footgun: a team adds retry to a non-idempotent endpoint and does not notice until a production incident. Opt-in is safer but creates friction. The recommended approach is opt-in with an idempotency check in the retry wrapper: the wrapper refuses to retry unless the caller has provided an idempotency key or explicitly marked the operation as idempotent.

---
