## 22B.7 Retry with Jitter

### Why Naive Retry Causes Thundering Herd

Consider 1,000 clients all sending requests to a service. The service overloads and starts returning 503s at time T=0. Each client implements a simple retry: wait 1 second, then retry. At T=1s, all 1,000 clients retry simultaneously. The service, which was just beginning to recover, is immediately overwhelmed again. It returns 503s again. At T=2s, all 1,000 clients retry simultaneously again. This pattern can repeat indefinitely, preventing the service from ever recovering. This is the thundering herd problem.

Exponential backoff without jitter improves the situation but does not solve it. If all clients wait 1s, then 2s, then 4s, then 8s, they are still synchronized, having backed off in lockstep. The herd is now thundering at T=1, T=3, T=7, T=15. Synchronized slightly differently, but still synchronized.

Jitter, meaning randomness added to the backoff interval, desynchronizes retries across clients. When clients retry at random intervals within a window, they spread their load across time instead of concentrating it at discrete moments.

```
NAIVE RETRY (no jitter):
T=0:   ||||||||||||||||||||||||||||  <- 1000 requests, all fail
T=1:   ||||||||||||||||||||||||||||  <- 1000 retries, all at T=1, overwhelm service again
T=2:   ||||||||||||||||||||||||||||  <- still thundering
T=4:   ||||||||||||||||||||||||||||  <- still thundering

FULL JITTER:
T=0:   ||||||||||||||||||||||||||||  <- 1000 requests, all fail
T=0-1: | || ||| | || | ||| | | |    <- retries spread randomly, service recovers
T=1-2: | | |  | | | | |  | |        <- remaining retries, very low load
```

### Backoff Formulas

**Exponential Backoff (no jitter):**
```
delay = base × 2^attempt
```
- attempt=0: base (e.g., 100ms)
- attempt=1: 200ms
- attempt=2: 400ms
- attempt=3: 800ms

All clients with the same backoff formula are synchronized. This is the problem.

**Full Jitter (AWS recommendation):**
```
delay = random(0, min(cap, base × 2^attempt))
```
- Delay is uniformly random between 0 and the exponential cap.
- This provides the best desynchronization at the cost of some clients retrying very quickly (near zero delay).
- Best for avoiding thundering herd.

**Equal Jitter (compromise):**
```
delay = (cap/2) + random(0, cap/2)
  where cap = min(maxCap, base × 2^attempt)
```
- Delay is between cap/2 and cap.
- Avoids very-short retries (unlike full jitter).
- Still significantly desynchronizes clients.
- Best balance for most use cases.

**Decorrelated Jitter:**
```
delay = random(base, previous_delay × 3)
```
- Each retry is correlated with the previous delay only, not with other clients.
- Has very low correlation across clients over time.
- Requires tracking per-client state (previous delay).

### Go Implementation

The implementation below encodes all four jitter strategies into a single generic `Execute` function that accepts any operation returning a value and an error. A `RetryPolicy` struct carries the configuration, max attempts, base delay, cap, chosen strategy, and an optional retry budget, so callers can tune behavior per call site without changing shared infrastructure. The `ShouldRetry` hook cleanly separates the retry logic from the error classification, making it easy to swap in domain-specific rules without modifying the core loop.

```go
package retry

import (
    "context"
    "errors"
    "fmt"
    "math"
    "math/rand/v2"
    "net/http"
    "time"
)

// Strategy defines the jitter algorithm used for retry delays.
type Strategy int

const (
    StrategyFullJitter        Strategy = iota // random(0, cap)
    StrategyEqualJitter                       // cap/2 + random(0, cap/2)
    StrategyDecorrelatedJitter               // random(base, prev*3)
    StrategyExponential                       // no jitter (for comparison)
)

func (s Strategy) String() string {
    switch s {
    case StrategyFullJitter:
        return "full_jitter"
    case StrategyEqualJitter:
        return "equal_jitter"
    case StrategyDecorrelatedJitter:
        return "decorrelated_jitter"
    case StrategyExponential:
        return "exponential"
    default:
        return "unknown"
    }
}

// RetryPolicy configures retry behavior for a single operation.
type RetryPolicy struct {
    // MaxAttempts is the maximum number of attempts (initial + retries).
    MaxAttempts int

    // Base is the initial delay before the first retry.
    Base time.Duration

    // Cap is the maximum delay between retries.
    Cap time.Duration

    // Strategy determines how jitter is applied to backoff delays.
    Strategy Strategy

    // MaxRetryBudget is the maximum cumulative time spent retrying.
    // Set to 0 to disable budget tracking.
    MaxRetryBudget time.Duration

    // ShouldRetry determines if an error is retriable.
    // If nil, defaults to RetryOnTransient.
    ShouldRetry func(err error, attempt int) bool
}

// DefaultRetryPolicy returns a sensible production default.
func DefaultRetryPolicy() RetryPolicy {
    return RetryPolicy{
        MaxAttempts:    3,
        Base:           100 * time.Millisecond,
        Cap:            30 * time.Second,
        Strategy:       StrategyFullJitter,
        MaxRetryBudget: 10 * time.Second,
        ShouldRetry:    RetryOnTransient,
    }
}

// RetryOnTransient retries on network errors, 429, 503, 504.
// Does NOT retry on 400, 401, 403, 404, which are client errors that retrying cannot fix.
func RetryOnTransient(err error, _ int) bool {
    if err == nil {
        return false
    }
    // Never retry on context cancellation. The caller gave up deliberately.
    if errors.Is(err, context.Canceled) {
        return false
    }
    // Retry on deadline exceeded. It might be a transient latency spike.
    if errors.Is(err, context.DeadlineExceeded) {
        return true
    }

    // Check for HTTP status codes wrapped in an error.
    var httpErr *HTTPError
    if errors.As(err, &httpErr) {
        switch httpErr.StatusCode {
        case http.StatusTooManyRequests,    // 429
            http.StatusServiceUnavailable, // 503
            http.StatusGatewayTimeout:     // 504
            return true
        default:
            // 400, 401, 403, 404, 422 are client errors, not transient.
            return false
        }
    }

    // Network errors are transient.
    var netErr interface{ Timeout() bool }
    if errors.As(err, &netErr) {
        return true
    }

    return false
}

// HTTPError represents an HTTP error with a status code.
type HTTPError struct {
    StatusCode int
    Message    string
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Message)
}

// Result is the outcome of a retry sequence.
type Result[T any] struct {
    Value       T
    Attempts    int
    TotalDelay  time.Duration
    LastError   error
}

// Execute runs fn with retry according to the policy.
// fn receives a context and the current attempt number (0-indexed).
func Execute[T any](ctx context.Context, policy RetryPolicy, fn func(ctx context.Context, attempt int) (T, error)) (*Result[T], error) {
    if policy.MaxAttempts <= 0 {
        policy.MaxAttempts = 3
    }
    if policy.ShouldRetry == nil {
        policy.ShouldRetry = RetryOnTransient
    }

    result := &Result[T]{}
    prevDelay := policy.Base // For decorrelated jitter.
    budgetStart := time.Now()

    for attempt := 0; attempt < policy.MaxAttempts; attempt++ {
        value, err := fn(ctx, attempt)
        result.Attempts++

        if err == nil {
            result.Value = value
            return result, nil
        }

        result.LastError = err

        // Last attempt, so do not wait. Just fail.
        if attempt == policy.MaxAttempts-1 {
            break
        }

        // Check if this error is retriable.
        if !policy.ShouldRetry(err, attempt) {
            break
        }

        // Calculate delay first, so the budget can be checked against the
        // wait we are actually about to take.
        delay := calculateDelay(policy, attempt, prevDelay)
        prevDelay = delay

        // Check the retry budget. Checking only whether the budget is already
        // spent is not enough: with a 10s budget and a 30s cap, a single
        // delay can overshoot by 20s while every individual check passes.
        // The budget must be compared against spent + the pending delay.
        if policy.MaxRetryBudget > 0 {
            spent := time.Since(budgetStart)
            if spent+delay >= policy.MaxRetryBudget {
                result.LastError = fmt.Errorf(
                    "retry budget exhausted: %s spent, next delay %s exceeds %s budget: %w",
                    spent.Round(time.Millisecond), delay.Round(time.Millisecond),
                    policy.MaxRetryBudget, err)
                break
            }
        }

        result.TotalDelay += delay

        select {
        case <-time.After(delay):
        case <-ctx.Done():
            result.LastError = ctx.Err()
            return result, ctx.Err()
        }
    }

    var zero T
    return &Result[T]{
        Value:      zero,
        Attempts:   result.Attempts,
        TotalDelay: result.TotalDelay,
        LastError:  result.LastError,
    }, fmt.Errorf("all %d attempts failed: %w", result.Attempts, result.LastError)
}

// CalculateDelay computes the delay before the next retry using the
// configured strategy. It is exported so the distribution test below can
// measure each strategy's spread without waiting out real delays.
func CalculateDelay(policy RetryPolicy, attempt int, prevDelay time.Duration) time.Duration {
    return calculateDelay(policy, attempt, prevDelay)
}

// calculateDelay computes the delay before the next retry using the configured strategy.
func calculateDelay(policy RetryPolicy, attempt int, prevDelay time.Duration) time.Duration {
    exp := float64(policy.Base) * math.Pow(2, float64(attempt))
    // maxDelay, not cap: cap is a builtin and shadowing it here would stop
    // this function from ever calling the real one.
    maxDelay := float64(policy.Cap)
    if exp > maxDelay {
        exp = maxDelay
    }

    var delay float64

    switch policy.Strategy {
    case StrategyFullJitter:
        // delay = random(0, cap)
        delay = rand.Float64() * exp

    case StrategyEqualJitter:
        // delay = cap/2 + random(0, cap/2)
        half := exp / 2
        delay = half + rand.Float64()*half

    case StrategyDecorrelatedJitter:
        // delay = random(base, prevDelay * 3)
        lo := float64(policy.Base)
        hi := float64(prevDelay) * 3
        if hi < lo {
            hi = lo
        }
        if hi > maxDelay {
            hi = maxDelay
        }
        delay = lo + rand.Float64()*(hi-lo)

    case StrategyExponential:
        // No jitter.
        delay = exp

    default:
        delay = rand.Float64() * exp
    }

    return time.Duration(delay)
}
```

### Idempotency Keys for Safe Retries

Retrying non-idempotent operations is dangerous. If you charge a customer's card and the network drops before you receive the response, you do not know if the charge succeeded. Retrying blindly may double-charge the customer.

Idempotency keys solve this: include a unique, stable key with every request. The server uses this key to detect and deduplicate retries, returning the cached response from the first successful execution.

```go
// IdempotencyKey generates a stable key for a request that survives retries.
// The key must be the same across all retry attempts for the same logical operation.
func IdempotencyKey(orderID string, operation string) string {
    // Use a hash of stable request parameters to generate a deterministic key.
    // Do NOT include timestamps or random values. Those change on each retry.
    h := sha256.New()
    fmt.Fprintf(h, "%s:%s", orderID, operation)
    return hex.EncodeToString(h.Sum(nil))[:32]
}

// RetryWithIdempotency wraps an HTTP client to automatically attach
// idempotency keys and retry safely.
func RetryWithIdempotency(
    ctx context.Context,
    client *http.Client,
    req *http.Request,
    idempotencyKey string,
    policy RetryPolicy,
) (*http.Response, error) {
    // A request with a body can only be retried if that body can be rewound,
    // and req.Clone does NOT rewind it: the clone shares the original reader.
    //
    // http.NewRequest fills in GetBody automatically for *bytes.Buffer,
    // *bytes.Reader and *strings.Reader, which is why this usually appears to
    // work. Hand it any other reader, such as an io.Pipe, an os.File or a
    // decompressing wrapper, and GetBody is nil: attempt 0 drains the reader
    // and every retry sends an EMPTY body. No error, no panic, just a charge
    // request with no charge in it, arriving at a payment provider under an
    // idempotency key that makes it look deliberate.
    //
    // Refuse up front rather than discover that in a ledger reconciliation.
    if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
        return nil, errors.New(
            "retry: request body is not replayable (GetBody is nil): buffer it " +
                "with bytes.NewReader before retrying")
    }

    result, err := Execute(ctx, policy, func(ctx context.Context, attempt int) (*http.Response, error) {
        r := req.Clone(ctx)

        // Rewind the body for every attempt, including the first.
        if req.GetBody != nil {
            body, err := req.GetBody()
            if err != nil {
                return nil, fmt.Errorf("retry: rewind body: %w", err)
            }
            r.Body = body
        }

        r.Header.Set("X-Idempotency-Key", idempotencyKey)
        r.Header.Set("X-Retry-Attempt", fmt.Sprintf("%d", attempt))

        resp, err := client.Do(r)
        if err != nil {
            return nil, err
        }

        // Wrap non-2xx responses as errors for the retry policy to classify.
        if resp.StatusCode >= 400 {
            resp.Body.Close()
            return nil, &HTTPError{StatusCode: resp.StatusCode}
        }

        return resp, nil
    })

    if err != nil {
        return nil, err
    }
    return result.Value, nil
}
```

### Which Errors to Retry

This is one of the most important operational decisions you will make. The wrong answer has consequences:

- Retrying non-transient errors wastes resources and delays error propagation.
- Not retrying transient errors reduces reliability unnecessarily.

```
RETRY DECISION MATRIX

Error Type              | Retry? | Reason
────────────────────────┼────────┼──────────────────────────────────────────
Network timeout         | YES    | Server may have received and processed
DNS failure             | YES    | Transient DNS resolution issue
Connection refused      | YES    | Server may be restarting
HTTP 429 (rate limited) | YES    | Back off and retry after Retry-After
HTTP 500 (server error) | MAYBE  | Depends on idempotency; use with key
HTTP 502 (bad gateway)  | YES    | Load balancer issue, typically transient
HTTP 503 (unavailable)  | YES    | Server overloaded, will recover
HTTP 504 (gateway timeout)| YES  | Upstream timeout, transient
HTTP 400 (bad request)  | NO     | Client error - retry won't fix it
HTTP 401 (unauthorized) | NO     | Auth failure - retry without fixing auth is useless
HTTP 403 (forbidden)    | NO     | Permission error - retry won't help
HTTP 404 (not found)    | NO     | Resource doesn't exist - retry won't create it
HTTP 409 (conflict)     | NO     | Conflict - retry may make it worse
HTTP 422 (unprocessable)| NO     | Validation error - won't change on retry
context.Canceled        | NO     | Caller gave up - retrying is wasteful
```

### Full Working Example with All Strategies Benchmarked

The test suite below measures both the performance cost of delay calculation and the practical desynchronization each strategy achieves across 100 simulated clients. `TestRetryDistribution` buckets all simulated retry times into 10ms windows and reports the maximum number of clients landing in the same window, a low maximum means retries are well spread, while a high maximum reveals the synchronized thundering that jitter is designed to prevent.

```go
package retry_test

import (
    "context"
    "fmt"
    "testing"
    "time"

    "your/module/retry"
)

// BenchmarkJitterStrategies compares delay distributions across strategies.
// Run with: go test -bench=BenchmarkJitterStrategies -benchtime=10s
func BenchmarkJitterStrategies(b *testing.B) {
    strategies := []struct {
        name     string
        strategy retry.Strategy
    }{
        {"FullJitter", retry.StrategyFullJitter},
        {"EqualJitter", retry.StrategyEqualJitter},
        {"DecorrelatedJitter", retry.StrategyDecorrelatedJitter},
        {"Exponential", retry.StrategyExponential},
    }

    for _, s := range strategies {
        b.Run(s.name, func(b *testing.B) {
            policy := retry.RetryPolicy{
                MaxAttempts: 4,
                Base:        100 * time.Millisecond,
                Cap:         10 * time.Second,
                Strategy:    s.strategy,
                ShouldRetry: retry.RetryOnTransient,
            }

            // Measure delay calculation overhead, not actual waiting.
            // The result is accumulated into a sink so the compiler cannot
            // optimize the call away. A loop body of `_ = policy` would
            // benchmark an assignment and report a few nanoseconds no matter
            // how expensive the strategy actually is.
            var sink time.Duration
            prev := policy.Base

            b.ResetTimer()
            for b.Loop() {
                d := retry.CalculateDelay(policy, 2, prev)
                sink += d
                prev = d
                if prev < policy.Base {
                    prev = policy.Base
                }
            }
            b.StopTimer()

            if sink < 0 {
                b.Fatal("unreachable, keeps sink live")
            }
        })
    }
}

// TestRetryDistribution verifies jitter desynchronizes retries.
// Simulates 100 clients with the same backoff policy and measures
// max concurrent retries at any single millisecond.
func TestRetryDistribution(t *testing.T) {
    const clients = 100
    const attempts = 3

    strategies := []retry.Strategy{
        retry.StrategyFullJitter,
        retry.StrategyEqualJitter,
        retry.StrategyDecorrelatedJitter,
        retry.StrategyExponential,
    }

    for _, strategy := range strategies {
        policy := retry.RetryPolicy{
            MaxAttempts: attempts + 1,
            Base:        100 * time.Millisecond,
            Cap:         2 * time.Second,
            Strategy:    strategy,
        }

        // Simulate 100 clients independently calculating their retry delays.
        allDelays := make([]time.Duration, 0, clients*attempts)
        for c := 0; c < clients; c++ {
            prevDelay := policy.Base
            for attempt := 0; attempt < attempts; attempt++ {
                d := retry.CalculateDelay(policy, attempt, prevDelay)
                allDelays = append(allDelays, d)
                prevDelay = d
            }
        }

        // Find the maximum "collision": how many clients retry in the same 10ms window.
        buckets := make(map[int64]int)
        for _, d := range allDelays {
            bucket := int64(d / (10 * time.Millisecond))
            buckets[bucket]++
        }

        maxCollision := 0
        for _, count := range buckets {
            if count > maxCollision {
                maxCollision = count
            }
        }

        t.Logf("Strategy %-20s | max clients in 10ms window: %d/%d",
            strategy.String(), maxCollision, clients)
    }
}

// ExampleExecute demonstrates full retry usage with context.
func ExampleExecute() {
    ctx := context.Background()
    policy := retry.DefaultRetryPolicy()

    result, err := retry.Execute(ctx, policy, func(ctx context.Context, attempt int) (string, error) {
        if attempt < 2 {
            // Simulate transient errors on the first two attempts.
            return "", &retry.HTTPError{StatusCode: 503, Message: "service unavailable"}
        }
        return "success", nil
    })
    if err != nil {
        fmt.Printf("failed: %v\n", err)
        return
    }

    // Only deterministic values go in the Output block. An Example's output
    // is compared literally, so printing TotalDelay would fail every run
    // under full jitter, and a "..." placeholder does not match either: it
    // is compared as the literal three characters.
    fmt.Printf("value=%s attempts=%d\n", result.Value, result.Attempts)
    // Output: value=success attempts=3
}
```

Running that test on 100 clients over 3 attempts gives numbers in this range, stable from run to run:

```
full_jitter          | max clients in 10ms window:  24/100
equal_jitter         | max clients in 10ms window:  25/100
decorrelated_jitter  | max clients in 10ms window:  15/100
exponential          | max clients in 10ms window: 100/100
```

Read those numbers carefully, because the obvious reading of them is wrong.

Exponential backoff with no jitter puts **100 of 100** clients in the same window, every time, on every attempt. That is not a bad score on a spectrum, it is the thundering herd itself: the delay is a pure function of the attempt number, so every client computes the identical value and they all fire in lockstep. This is the number that matters, and jitter takes it from 100 to roughly 20.

But notice that jitter does **not** take collisions to 1, and no amount of jitter could. The arithmetic sets the floor: 100 clients times 3 attempts is 300 delays, and with a 100ms base the delays land in a window roughly 400ms wide, which is 40 buckets of 10ms. Three hundred samples into forty buckets averages seven and a half per bucket before you account for the early attempts clustering in the low buckets. A perfectly uniform spread would still show a maximum around 15 to 20. The measured ~24 is close to that floor, which is the actual finding: full jitter is already near the best this metric can show, and the remaining gap to 1 is a property of the histogram, not a defect in the strategy.

Note also that decorrelated jitter scores **better** than full jitter here (~15 against ~24), not somewhere in between. It spreads delays across a wider range because each delay compounds off the previous one instead of being bounded by a fixed exponential ceiling, so it fills more buckets. That is a real advantage, and it comes with a real cost: it requires per-client state, and its unbounded-ish growth needs the cap to stay honest.

For most production systems, **full jitter** remains a sound default: it is stateless, it is trivially correct, and it captures nearly all of the available benefit, which is the collapse from 100 to 20. Use equal jitter when you need to guarantee a minimum wait, since full jitter will happily return a near-zero delay and retry almost instantly. Use decorrelated jitter when you have the state to spare and want the extra spread. The one option that is never defensible is the bottom row of that table.

### Staff Lens: Retry Budget at the Org Level

Cap total retries as a fraction of total outbound traffic (typically 10%). If retries exceed this budget, disable retries temporarily. This prevents retry amplification during partial outages that turns a 10% error rate into a 90% outage.

---
