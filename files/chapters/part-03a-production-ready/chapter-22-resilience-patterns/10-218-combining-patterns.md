## 22.8 Combining Patterns

### Resilient HTTP Client

Applying rate limiting, circuit breaking, and retries individually is straightforward. Composing them is where the bugs live, and the two hardest parts are the **order** of the layers and the **resource hygiene** of the innermost call.

Rate limiting runs first, so that locally-generated bursts are shaped before they can look like downstream failures. Below it, the retry loop sits outside the circuit breaker, so each individual attempt is recorded by the breaker and an opened breaker fails the next attempt instantly. That is the composition `failsafe-go` uses, and the trade-off against the reverse ordering is discussed after the code.

```go
type ResilientClient struct {
    client         *http.Client
    circuitBreaker *gobreaker.CircuitBreaker
    rateLimiter    *rate.Limiter
    retryConfig    retry.Config
}

func (c *ResilientClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // Layer 1: rate limit. Shapes our own outbound burst.
    if err := c.rateLimiter.Wait(ctx); err != nil {
        return nil, fmt.Errorf("rate limit: %w", err)
    }

    // Only replayable requests may be retried. req.Body is a one-shot
    // reader: without GetBody, attempt 2 sends an empty body.
    if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
        return c.client.Do(req.WithContext(ctx))
    }

    var resp *http.Response

    // Layer 2: retry, OUTSIDE the breaker, so the breaker sees every attempt.
    // DoWithCheck (not Do) is what honours RetryableError.
    err := retry.DoWithCheck(ctx, c.retryConfig, func() error {
        // Layer 3: circuit breaker, per attempt.
        _, cbErr := c.circuitBreaker.Execute(func() (any, error) {
            attempt := req.Clone(ctx)
            if req.GetBody != nil {
                body, err := req.GetBody()
                if err != nil {
                    return nil, err // not retryable: we cannot rebuild the body
                }
                attempt.Body = body
            }

            r, err := c.client.Do(attempt)
            if err != nil {
                return nil, retry.RetryableError{Err: err}
            }
            if r.StatusCode >= 500 && r.StatusCode != http.StatusNotImplemented {
                // Drain and close, or this connection cannot be reused and
                // the response body leaks for the whole retry sequence.
                io.Copy(io.Discard, r.Body)
                r.Body.Close()
                return nil, retry.RetryableError{Err: fmt.Errorf("status %d", r.StatusCode)}
            }
            resp = r // success (or a permanent 4xx the caller must see)
            return nil, nil
        })

        if cbErr != nil {
            // An open breaker is not worth retrying against: fail fast so
            // the caller reaches its fallback now rather than in 3 backoffs.
            if errors.Is(cbErr, gobreaker.ErrOpenState) ||
                errors.Is(cbErr, gobreaker.ErrTooManyRequests) {
                return cbErr // NOT wrapped as RetryableError -> stops the loop
            }
            return cbErr
        }
        return nil
    })

    if err != nil {
        return nil, err
    }
    return resp, nil
}
```

### What Composition Actually Buys, and What It Costs

**Close every response you abandon.** The single most common bug in code like this is retrying a 5xx without reading and closing `r.Body`. Go cannot return that connection to the idle pool until the body is drained to EOF, so each retry opens a *new* connection (with a new TLS handshake) against a server that is already struggling. A retry policy meant to ride out a blip instead multiplies connection pressure on the failing dependency at its worst moment, and leaks file descriptors in your own process while doing it.

**Retry outside the breaker, or inside?** Both orderings are defensible and they fail differently:

- **Retry outside (shown above).** The breaker records each attempt, so it trips on real evidence and trips quickly. Once open, the next attempt returns `ErrOpenState` instantly, which the loop recognises as non-retryable and stops. Cost: one flapping call can contribute several failures to the breaker on its own.
- **Breaker outside retry.** One logical operation contributes exactly one vote, so a single request's retries cannot trip the breaker alone. Cost: the breaker is now very slow to trip. With `ConsecutiveFailures > 5` and 3 retries per operation, it takes 6 operations, which is **24 real requests** to the failing dependency, before the breaker opens at all. The breaker's timing is also distorted, because the duration it observes includes all the backoff sleeps.

Pick deliberately. The important part is that `ErrOpenState` must never be treated as retryable in either arrangement. If it is, the retry loop sleeps through its full backoff schedule to re-ask a breaker that will keep saying no, converting a fast fail into a slow one and defeating the entire point of the breaker.

**A rate limiter that blocks is not free.** `rateLimiter.Wait(ctx)` is correct here (this is an *outbound* call, where blocking is the backpressure you want) but it means `Do` can return long after it was called. That time comes out of the same `ctx` budget the retries need. Without a deadline on `ctx`, this composition has no bound at all: rate-limit wait, plus 4 attempts, plus 3 backoffs, each unbounded.

### Staff Lens: Pattern Order Matters

A defensible outer-to-inner ordering, and the one `failsafe-go` composes by default:

```
fallback -> rate limit -> bulkhead -> retry -> circuit breaker -> timeout -> call
```

Fallback is outermost so it can catch everything beneath it, including an open breaker and an exhausted retry budget. Timeout is innermost so it bounds a single attempt. Retry sits outside the breaker so each attempt gets a vote and an open breaker aborts the loop on the next pass.

The measured payoff for getting the retry/breaker interaction right is stark. With `ErrOpenState` correctly treated as non-retryable, a call against an open breaker returns in **under 4 microseconds and sends zero requests** to the failing dependency. Treat it as retryable instead and the same call sleeps through the entire backoff schedule before failing anyway, which is slower than having no breaker at all.

Verify the order you actually shipped, because the layering is invisible in the code: it is just nested closures, and nesting them wrongly still compiles, still passes tests, and only misbehaves during an outage. Prefer `failsafe-go` or a similar policy library, where the composition is declared rather than implied by indentation.

---
