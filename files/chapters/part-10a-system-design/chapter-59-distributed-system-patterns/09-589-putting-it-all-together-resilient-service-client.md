## 59.9 Putting It All Together: Resilient Service Client

A production-grade HTTP client for calling external services should compose all the resilience patterns covered in this chapter, circuit breaking, bulkheads, retries with exponential backoff, and idempotency keys, into a single, cohesive abstraction. Each pattern addresses a different failure mode: the circuit breaker handles sustained downstream failures, the bulkhead prevents resource exhaustion, the retry logic handles transient errors, and idempotency keys make retries safe for non-idempotent operations. Composing them in the correct order (bulkhead → circuit breaker → retry) ensures that expensive retry attempts only occur when the circuit is closed and resources are available.

```go
// client/resilient.go
package client

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"

    "yourproject/bulkhead"
    "yourproject/circuitbreaker"
    "yourproject/idempotency"
    "yourproject/ratelimit"
    "yourproject/retry"
)

// ResilientClient combines all resilience patterns
type ResilientClient struct {
    httpClient     *http.Client
    circuitBreaker *circuitbreaker.CircuitBreaker
    bulkhead       *bulkhead.Bulkhead
    rateLimiter    *ratelimit.TokenBucketLimiter
    retrier        *retry.Retrier
    idempotency    *idempotency.IdempotencyKey
}

// Config for resilient client
type Config struct {
    BaseURL         string
    Timeout         time.Duration
    MaxConcurrent   int
    MaxWaiting      int
    RateLimit       float64
    RateBurst       int64
    RetryAttempts   int
    CircuitBreaker  circuitbreaker.Options
}

// NewResilientClient creates a new resilient HTTP client
func NewResilientClient(cfg Config, redisClient *redis.Client) *ResilientClient {
    return &ResilientClient{
        httpClient: &http.Client{
            Timeout: cfg.Timeout,
        },
        circuitBreaker: circuitbreaker.New("http-client", cfg.CircuitBreaker),
        bulkhead:       bulkhead.NewBulkhead("http-client", cfg.MaxConcurrent, cfg.MaxWaiting),
        rateLimiter:    ratelimit.NewTokenBucketLimiter(redisClient, "http-client", cfg.RateBurst, cfg.RateLimit),
        retrier:        retry.WithExponentialBackoff(cfg.RetryAttempts, 100*time.Millisecond, 5*time.Second),
        idempotency:    idempotency.NewIdempotencyKey(redisClient, "http-client", 24*time.Hour),
    }
}

// Do executes an HTTP request with all resilience patterns
func (c *ResilientClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    // 1. Rate limiting
    allowed, err := c.rateLimiter.Allow(ctx, req.URL.Host)
    if err != nil {
        return nil, fmt.Errorf("rate limiter error: %w", err)
    }
    if !allowed {
        return nil, fmt.Errorf("rate limit exceeded for %s", req.URL.Host)
    }

    var resp *http.Response

    // 2. Bulkhead
    err = c.bulkhead.ExecuteWithContext(ctx, func(ctx context.Context) error {
        // 3. Circuit breaker
        return c.circuitBreaker.ExecuteWithContext(ctx, func(ctx context.Context) error {
            // 4. Retry
            return c.retrier.DoWithContext(ctx, func(ctx context.Context) error {
                // Each attempt needs a fresh, replayable body. The
                // first attempt consumes req.Body, so later attempts
                // must rewind via GetBody (http.NewRequest sets it
                // for common body types) or they send no payload.
                attemptReq := req.Clone(ctx)
                if req.GetBody != nil {
                    body, bodyErr := req.GetBody()
                    if bodyErr != nil {
                        return bodyErr
                    }
                    attemptReq.Body = body
                }

                var reqErr error
                resp, reqErr = c.httpClient.Do(attemptReq)
                if reqErr != nil {
                    return reqErr
                }

                // Check for server errors (retry-worthy)
                if resp.StatusCode >= 500 {
                    resp.Body.Close()
                    return fmt.Errorf("server error: %d", resp.StatusCode)
                }

                return nil
            })
        })
    })

    return resp, err
}

// DoIdempotent executes a request with idempotency
func (c *ResilientClient) DoIdempotent(ctx context.Context, key string, req *http.Request) (*http.Response, error) {
    result, err := c.idempotency.Execute(ctx, key, func() (*idempotency.Result, error) {
        resp, err := c.Do(ctx, req)
        if err != nil {
            return nil, err
        }

        // Read and cache response
        body, _ := io.ReadAll(resp.Body)
        resp.Body.Close()

        return &idempotency.Result{
            StatusCode: resp.StatusCode,
            Body:       body,
        }, nil
    })

    if err != nil {
        return nil, err
    }

    // Reconstruct response from cached result
    return &http.Response{
        StatusCode: result.StatusCode,
        Body:       io.NopCloser(bytes.NewReader(result.Body)),
    }, nil
}
```

### Junior -> FAANG: Reading the Composition Order

The `ResilientClient.Do` method nests four patterns: rate limiter, then bulkhead, then circuit breaker, then retry. This ordering is not arbitrary. Each layer has a reason for its position.

Rate limiter is outermost because it protects the downstream service from the perspective of "how many requests are we sending per second." It applies before any work is done, so a rejected request consumes no bulkhead or circuit-breaker resources.

Bulkhead is second because it limits how many requests can be in-flight simultaneously, regardless of the downstream health. It protects your own process's goroutine pool.

Circuit breaker is inside the bulkhead because the circuit breaker's state (open/closed) reflects the downstream's health. Once inside the bulkhead, we want to know whether it even makes sense to attempt the call.

Retry is innermost because it operates on individual attempt failures. A retry must consume a new bulkhead slot for each attempt, which is why it cannot be outside the bulkhead: if retries were outside, they would bypass the concurrency limit.

For your first-job interview, be ready to explain why putting retry outside the circuit breaker is wrong: every individual attempt failure would land in the breaker's failure count, so a burst of transient errors that the retries would have absorbed can trip the breaker, and once it opens the remaining retries just burn their backoff sleeps on ErrCircuitOpen without ever reaching the network. With retry innermost, the breaker only sees the final outcome after retries have done their job.

### Senior @ FAANG: The Resilient Client as a Platform Primitive

The `ResilientClient` in this section is a correct starting point but an incomplete platform primitive. At the senior level, the gaps to address before shipping to a team of 50 engineers are:

Observability integration: every layer should emit metrics. Rate limiter rejections, bulkhead rejections, circuit breaker state transitions, retry attempt counts, and final outcome (success, failure, timeout) should all produce named, labeled metrics that feed into dashboards and alerts. Without this, diagnosing a latency spike requires correlating logs from five different components.

Per-host vs per-service configuration: the implementation above uses a single circuit breaker and bulkhead for the entire HTTP client. A production client needs per-host (or per-endpoint) configuration because `payment-service` and `search-service` have vastly different latency profiles, failure rates, and retry policies. A single circuit breaker trips on the combined error rate of all downstreams, which is almost never what you want.

Connection pool management: the `http.Client` in this implementation uses Go's default transport, which has default limits that are often wrong for production (`MaxIdleConns: 100`, `MaxIdleConnsPerHost: 2`). The `MaxIdleConnsPerHost` default of 2 means that a service handling 1,000 concurrent requests to the same host will create hundreds of new TCP connections, each with its own TLS handshake latency. Set `MaxIdleConnsPerHost` to match your bulkhead's `maxConcurrent` value so idle connections are available when the bulkhead grants a permit.

Timeout hierarchy: the implementation has a single `Timeout` at the HTTP client level. Production clients need a hierarchy: per-attempt timeout (how long a single request attempt may take), retry timeout (how long all attempts combined may take), and overall deadline (from the incoming request's context). Without the hierarchy, a 30-second client timeout plus 3 retries can block a goroutine for 90 seconds after the caller has already given up.

ADR for platform adoption: should `ResilientClient` be a package every team imports, or should it be the only HTTP client allowed in your service template? The latter enforces consistency but limits teams that need non-standard behavior (streaming responses, websockets). A layered approach works: the platform package provides `NewResilientClient` with sensible defaults, teams can pass options to override individual parameters, and the options API makes non-standard use explicit rather than accidental.

---
