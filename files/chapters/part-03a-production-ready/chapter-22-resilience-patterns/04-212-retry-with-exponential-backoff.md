## 22.2 Retry with Exponential Backoff

Transient failures (network blips, temporary resource exhaustion, brief load spikes) resolve themselves within seconds. Retrying with increasing delays recovers from these failures automatically without operator intervention. Retrying badly turns a brief blip into a sustained outage, so the details below are not stylistic.

### Basic Implementation

Exponential backoff multiplies the wait duration by a configurable factor after each failure. On its own it does **not** prevent a thundering herd: clients that failed together still back off by the same amount and return together. Jitter is what breaks the synchronisation, and how much jitter you add decides whether it works.

> **Senior track**: the AWS Architecture Blog's canonical analysis identifies three strategies. **No jitter** is the clear loser: every client lands at the same instant. **Full jitter** draws `sleep = random(0, backoff)`, giving uniform spread and the lowest server-side work. **Equal jitter** (`backoff/2 + random(0, backoff/2)`) preserves a floor under the wait, useful when hammering early is worse than waiting. **Decorrelated jitter** (`sleep = random(base, prev*3)`) is debated, and Thom Wright's 2024 analysis finds its convergence worse than full jitter for most workloads. Default to full jitter unless a specific constraint argues otherwise.

**A proportional "plus or minus" jitter is not jitter in the sense that matters.** It is tempting to write `sleep = backoff ± 10%`, and it looks like it spreads load. Measure it and the illusion collapses. Release 1000 clients that all backed off to the same 800ms after a shared outage, and count how many land in the same 10ms window:

```
no jitter (sleep exactly 800ms)
  spread: 800ms .. 800ms          PEAK: 1000 of 1000 clients in one 10ms bucket
+/-10% jitter  (Jitter: 0.1)
  spread: 720ms .. 880ms          PEAK:   71 of 1000
equal jitter   (400 + rand(400))
  spread: 401ms .. 800ms          PEAK:   34 of 1000
full jitter    (rand(0, 800))
  spread:   1ms .. 799ms          PEAK:   21 of 1000
```

The `±10%` version concentrates 71 clients into a single 10ms window, **3.4 times the peak of full jitter**, and every one of them arrives in a narrow band around 800ms because a proportional nudge cannot move a client far from where it started. It converts a perfect spike into a slightly rounded spike. Full jitter smears the same 1000 clients across the entire interval, and the recovering service sees a roughly flat arrival rate instead of a wall.

Note also that `±10%` is *not* the "equal jitter" strategy, despite superficially resembling a compromise. Equal jitter spans `[backoff/2, backoff]`, halving the wait in the best case. The `±10%` scheme spans `[0.9*backoff, 1.1*backoff]` and never meaningfully departs from the unjittered value. The implementation below therefore defaults to full jitter, and keeps the proportional mode only as an explicit opt-in.

```go
package retry

// Imports for every snippet in this section, which together form one package.
import (
    "context"
    "errors"
    "fmt"
    "io"
    "math/rand/v2"
    "net"
    "net/http"
    "time"
)

// JitterStrategy selects how the backoff is randomized.
type JitterStrategy int

const (
    // JitterFull sleeps for random(0, backoff). The default, and the right
    // answer for essentially every high-contention retry path.
    JitterFull JitterStrategy = iota
    // JitterEqual sleeps for backoff/2 + random(0, backoff/2). Use when a
    // minimum wait matters more than maximum spread.
    JitterEqual
    // JitterNone sleeps for exactly backoff. Only for a single client with
    // no peers to collide with. Never for a fleet.
    JitterNone
)

type Config struct {
    MaxRetries  int
    InitialWait time.Duration
    MaxWait     time.Duration
    Multiplier  float64
    Jitter      JitterStrategy
}

func DefaultConfig() Config {
    return Config{
        MaxRetries:  3,
        InitialWait: 100 * time.Millisecond,
        MaxWait:     10 * time.Second,
        Multiplier:  2.0,
        Jitter:      JitterFull,
    }
}

// sleepFor turns the current backoff ceiling into an actual sleep duration.
func sleepFor(backoff time.Duration, s JitterStrategy) time.Duration {
    switch s {
    case JitterEqual:
        half := float64(backoff) / 2
        return time.Duration(half + rand.Float64()*half)
    case JitterNone:
        return backoff
    default: // JitterFull
        return time.Duration(rand.Float64() * float64(backoff))
    }
}

func Do(ctx context.Context, cfg Config, fn func() error) error {
    var lastErr error
    // backoff is the CEILING for the next sleep, not the sleep itself.
    // It grows exponentially. The actual sleep is drawn from it.
    backoff := cfg.InitialWait

    for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
        err := fn()
        if err == nil {
            return nil
        }
        lastErr = err

        if attempt == cfg.MaxRetries {
            break
        }

        select {
        case <-ctx.Done():
            // Return the cause, keeping the last real error for context.
            return errors.Join(lastErr, ctx.Err())
        case <-time.After(sleepFor(backoff, cfg.Jitter)):
        }

        // Exponential growth of the ceiling
        backoff = time.Duration(float64(backoff) * cfg.Multiplier)
        if backoff > cfg.MaxWait {
            backoff = cfg.MaxWait
        }
    }

    return lastErr
}
```

Two details in that loop are easy to get wrong.

**`backoff` is a ceiling, not a sleep.** With full jitter the exponential curve bounds the *range* you draw from, and the value you actually sleep is uniform within it. A fleet's mean wait is therefore about half the nominal backoff, which is the point: full jitter is not just better spread, it is also less total waiting. It reaches the same de-correlation with fewer wasted seconds.

**The context branch should not discard the error you already have.** Returning a bare `ctx.Err()` throws away the reason you were retrying, and the caller gets `context deadline exceeded` with no clue that the real problem was a downstream 503 on every attempt. `errors.Join` keeps both, so logs show the deadline *and* what kept failing.

### Retryable Errors

Not all errors should be retried: authentication failures, malformed request errors, and business logic errors are permanent and retrying them wastes resources. Wrapping an error in `RetryableError` gives the caller a type-safe way to signal that a specific failure is transient and safe to retry.

```go
type RetryableError struct {
    Err error
}

func (e RetryableError) Error() string { return e.Err.Error() }
func (e RetryableError) Unwrap() error { return e.Err }

func IsRetryable(err error) bool {
    var re RetryableError
    return errors.As(err, &re)
}

func DoWithCheck(ctx context.Context, cfg Config, fn func() error) error {
    var lastErr error
    backoff := cfg.InitialWait

    for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
        err := fn()
        if err == nil {
            return nil
        }
        lastErr = err

        // Non-retryable errors are returned immediately
        if !IsRetryable(err) {
            return err
        }

        if attempt == cfg.MaxRetries {
            break
        }

        select {
        case <-ctx.Done():
            return errors.Join(lastErr, ctx.Err())
        case <-time.After(sleepFor(backoff, cfg.Jitter)):
        }

        backoff = time.Duration(float64(backoff) * cfg.Multiplier)
        if backoff > cfg.MaxWait {
            backoff = cfg.MaxWait
        }
    }

    return lastErr
}
```

Note the default here: `IsRetryable` returns false unless an error is *explicitly* wrapped as retryable, so `DoWithCheck` fails closed. An unrecognised error is treated as permanent and returned immediately. That is the safe direction. The opposite default, retrying everything you do not recognise, turns a bug that returns a wrapped `ErrInvalidArgument` into four times the load on a service that was never going to succeed.

### HTTP-Aware Retry

HTTP-level retry decisions differ from application-level ones: network timeouts and 5xx status codes from infrastructure issues (`503`, `502`, `504`) are retryable, while `400`, `401`, and `404` responses are permanent errors. Implementing retry logic in an HTTP transport wrapper keeps this concern out of application handlers.

```go
func IsRetryableHTTPError(err error) bool {
    // Note: net.Error.Temporary() is deprecated since Go 1.18.
    // Check for specific error types instead.
    var netErr net.Error
    if errors.As(err, &netErr) && netErr.Timeout() {
        return true
    }
    return false
}

func IsRetryableStatusCode(code int) bool {
    switch code {
    case http.StatusTooManyRequests,
        http.StatusServiceUnavailable,
        http.StatusGatewayTimeout,
        http.StatusBadGateway:
        return true
    }
    return false
}

func RetryableHTTPClient(client *http.Client, cfg Config) *http.Client {
    transport := client.Transport
    if transport == nil {
        transport = http.DefaultTransport
    }

    client.Transport = &retryTransport{
        base: transport,
        cfg:  cfg,
    }
    return client
}

type retryTransport struct {
    base http.RoundTripper
    cfg  Config
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
    // Only retry requests whose body we can replay. req.Body is a one-shot
    // reader: once the first attempt consumes it, a naive retry sends an
    // empty body and the server sees a malformed request. GetBody is set
    // automatically by http.NewRequest for the common body types.
    if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
        return t.base.RoundTrip(req) // not replayable: one attempt only
    }

    backoff := t.cfg.InitialWait
    var lastErr error

    for attempt := 0; attempt <= t.cfg.MaxRetries; attempt++ {
        r := req.Clone(req.Context())
        if req.GetBody != nil {
            body, err := req.GetBody()
            if err != nil {
                return nil, err
            }
            r.Body = body
        }

        resp, err := t.base.RoundTrip(r)
        switch {
        case err != nil:
            if !IsRetryableHTTPError(err) {
                return nil, err
            }
            lastErr = err
        case IsRetryableStatusCode(resp.StatusCode):
            // Drain and close, or the connection cannot be reused and the
            // retry opens a brand new one against a struggling server.
            io.Copy(io.Discard, resp.Body)
            resp.Body.Close()
            lastErr = fmt.Errorf("http %d", resp.StatusCode)
        default:
            return resp, nil // success, or a permanent error the caller must see
        }

        if attempt == t.cfg.MaxRetries {
            break
        }

        // A production version would also honour a Retry-After header here,
        // preferring the server's stated wait over the computed backoff.
        sleep := sleepFor(backoff, t.cfg.Jitter)
        select {
        case <-req.Context().Done():
            return nil, errors.Join(lastErr, req.Context().Err())
        case <-time.After(sleep):
        }

        backoff = time.Duration(float64(backoff) * t.cfg.Multiplier)
        if backoff > t.cfg.MaxWait {
            backoff = t.cfg.MaxWait
        }
    }

    return nil, lastErr
}
```

Three things in that transport are the difference between working and subtly broken.

**Bodies are one-shot.** `req.Body` is an `io.ReadCloser` that the first attempt drains. Retrying with the same request object sends an empty body, and the server rejects it with a 400 that looks nothing like the original failure. `http.NewRequest` populates `req.GetBody` for `*bytes.Reader`, `*bytes.Buffer`, and `*strings.Reader`, which is what makes replay possible. For an arbitrary streaming body it is `nil`, and the honest response is to not retry at all rather than to send garbage.

**Draining the response body matters.** Abandoning a response without reading it to EOF prevents connection reuse. So every retry opens a fresh TCP connection (plus TLS handshake) against a server that is already unhealthy, which is precisely the load you were trying to avoid adding.

**Retrying in a `RoundTripper` is invisible to callers.** `RoundTrip` has no idea whether the request is idempotent. A `POST /charges` gets retried exactly like a `GET /health`. If you install this transport globally, scope it to safe methods or require an idempotency key, or you will silently double-charge someone.

### A Retry Without a Deadline Multiplies Load

Jitter fixes *when* retries arrive. It does nothing about *how many*. Those are separate problems, and the second one is what turns a partial outage into a total one.

Consider the arithmetic during a brownout. Every client retries 3 times, so a dependency already failing at 50% now receives roughly **4x its normal request rate** at exactly the moment it has the least capacity to serve it. The extra load causes more failures, which cause more retries. That feedback loop is retry amplification, and it does not stabilise on its own: it is why a dependency that would have recovered in 10 seconds stays down for 10 minutes.

Two mechanisms bound it.

**A deadline on the whole operation.** Retries must be *inside* a deadline, not beside one. Without a total deadline, each layer multiplies: a handler that retries 3 times, calling a client that retries 3 times, is 9 requests for one user action, and each layer thinks it is being reasonable. With a deadline, the budget is fixed no matter how many layers there are, and a retry that cannot finish in the remaining time is simply not attempted:

```go
// Do not start an attempt we cannot finish. Without this check, the last
// retry fires with 5ms left, fails on timeout, and we paid full price for it.
if deadline, ok := ctx.Deadline(); ok {
    if time.Until(deadline) < perAttemptTimeout {
        return lastErr // no time to try again, fail now
    }
}
```

**A retry budget.** Cap retries as a fraction of *successful* traffic, typically around 10%, measured over a rolling window. When retries exceed the budget, stop retrying and fail fast, even for errors that are perfectly retryable. This is the mechanism that breaks the feedback loop, because it makes the retry rate a function of the *success* rate: as the dependency degrades, the budget shrinks with it, and the system automatically stops adding load exactly when adding load is most harmful. A fixed "3 retries per request" cannot do this, since it happily scales retries *up* as failures increase. Google's SRE book covers this at length, and gRPC implements it directly as `retryThrottling`.

The two compose: the deadline bounds one user's latency, the budget bounds the fleet's aggregate pressure on a sick dependency.

### Staff Lens: Retry Only Idempotent Operations

Idempotency is not a nice-to-have alongside retries. It is the **precondition** that makes retrying legal at all. Everything else in this section (backoff curves, jitter strategies, budgets) is tuning. This is correctness.

The trap is that a timeout tells you nothing about whether the work happened. A request that times out may have been dropped before arriving, or it may have committed the charge and died on the way back with the response. The client cannot distinguish these, and retrying the second case charges the customer twice. This is why "retry on timeout" is the most dangerous retry rule in any codebase: timeouts are exactly the case where the outcome is unknown.

So every retryable operation needs an idempotency key or an equivalent (a natural unique key, a conditional write, a sequence number) that lets the server recognise a duplicate and return the original result instead of performing the work again. Review this at API design time, not client implementation time, because it is a property of the protocol and it cannot be bolted on by the caller afterwards.

The practical rule: if you cannot articulate what makes an operation safe to run twice, you have not earned the right to retry it. Fail fast and surface the error instead.

---
