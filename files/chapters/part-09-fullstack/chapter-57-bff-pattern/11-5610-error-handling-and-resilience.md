## 57.10 Error Handling and Resilience

A BFF that calls three downstream services in parallel must handle partial failures gracefully, returning degraded responses with available data rather than failing the entire request when one service is down. Circuit breakers prevent the BFF from hammering a struggling service, while fallback values or cached stale data keep the UI functional during downstream outages. The resilience layer below combines `errgroup` parallel fan-out with per-service circuit breakers and structured error responses that distinguish degraded from failed states.

```go
// shared/pkg/resilience/resilience.go
package resilience

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/sony/gobreaker"
    "golang.org/x/sync/singleflight"
)

// Resilience provides patterns for handling failures
type Resilience struct {
    circuitBreaker *gobreaker.CircuitBreaker
    singleFlight   singleflight.Group
    fallbackCache  Cache
}

// Call executes a function with circuit breaker and fallback
func (r *Resilience) Call(
    ctx context.Context,
    name string,
    primary func() (any, error),
    fallback func() (any, error),
) (any, error) {
    // Try primary with circuit breaker
    result, err := r.circuitBreaker.Execute(func() (any, error) {
        return primary()
    })

    if err == nil {
        // Cache successful result as fallback data
        r.fallbackCache.Set(ctx, name, result, 5*time.Minute)
        return result, nil
    }

    // Primary failed - try fallback
    if fallback != nil {
        if fallbackResult, fallbackErr := fallback(); fallbackErr == nil {
            return fallbackResult, nil
        }
    }

    // Try cached fallback data
    var cached any
    if cacheErr := r.fallbackCache.Get(ctx, name, &cached); cacheErr == nil {
        return cached, nil
    }

    return nil, err
}

// Deduplicated prevents multiple identical requests
func (r *Resilience) Deduplicated(
    ctx context.Context,
    key string,
    fn func() (any, error),
) (any, error) {
    result, err, _ := r.singleFlight.Do(key, fn)
    return result, err
}

// GracefulDegradation returns partial results on partial failure
type PartialResult struct {
    Data    any
    Errors  []error
    Partial bool
}

func AggregateWithDegradation(
    ctx context.Context,
    funcs map[string]func() (any, error),
) *PartialResult {
    result := &PartialResult{
        Data:   make(map[string]any),
        Errors: []error{},
    }

    var wg sync.WaitGroup
    var mu sync.Mutex

    for name, fn := range funcs {
        wg.Add(1)
        go func(name string, fn func() (any, error)) {
            defer wg.Done()

            data, err := fn()
            mu.Lock()
            if err != nil {
                result.Errors = append(result.Errors, fmt.Errorf("%s: %w", name, err))
                result.Partial = true
            } else {
                result.Data.(map[string]any)[name] = data
            }
            mu.Unlock()
        }(name, fn)
    }

    wg.Wait()
    return result
}
```

### Junior -> FAANG: Resilience Primitives to Know Cold

Three resilience primitives appear in every FAANG system design interview and every production BFF: circuit breaker, retry with exponential backoff, and singleflight deduplication. Know what each one does, when to use each, and what problem each solves.

Circuit breaker: when a downstream service starts failing, the circuit breaker stops sending requests to it for a recovery period, instead returning an error or cached fallback immediately. This prevents your BFF from becoming the bottleneck that amplifies a downstream service failure into a full outage. Use it on every downstream HTTP call.

Retry with exponential backoff: on transient failures (network blip, momentary service restart), retry with increasing delays between attempts. The backoff prevents retry storms. The maximum retry count prevents infinite retry loops. Do not retry non-idempotent operations (POST, PUT, DELETE) unless you are certain the operation is safe to repeat. Use it on GET operations and on POST operations only when the backend guarantees idempotency (usually via an idempotency key header).

Singleflight: when multiple goroutines make the same downstream call concurrently (common on cache miss), singleflight ensures only one call is made and all waiters share the result. This prevents the thundering herd problem on cache expiry. Use it in cache-aside patterns where a miss triggers a downstream call.

For interviews: if asked "how do you handle a downstream service that starts returning 503s?", describe all three: circuit breaker to stop sending requests, retry with backoff for transient errors, and cached or default fallback for the response while the circuit is open.

### Senior @ FAANG: Resilience as a System-Level Property

At senior level, resilience is not a per-service property. It is a system-level property that requires coordination between services, monitoring systems, and incident response processes. The code primitives (circuit breaker, retry, singleflight) are necessary but not sufficient.

The circuit breaker's thresholds require tuning to the specific failure modes of each downstream service. A circuit breaker that trips on three consecutive failures is appropriate for a payment service where any failure is significant. For a recommendation service that is expected to occasionally return 500s under load, three failures will trip the circuit continuously, causing the BFF to serve default recommendations even when the service is healthy. The threshold should be calibrated based on the service's historical error rate at normal load, not arbitrary defaults.

Fallback strategy is where resilience design meets product design. "What does the user see when the recommendation service is down?" is a product decision, not a technical one. The BFF engineer's job is to implement whatever the product team decides (empty section, cached stale data, generic popular items fallback, or an error indicator) and to make the decision visible through an explicit product feature, not buried in error handling code.

At staff level, resilience design includes capacity planning. Circuit breakers and retries can mask capacity problems that will surface catastrophically during traffic spikes. A downstream service that handles 100 requests per second normally might receive 300 requests per second when retries are included during a degradation. If the service's capacity limit is 250 requests per second, the retries push it past its limit, causing more failures, triggering more retries, and creating a positive feedback loop that cascades into a full outage. Staff engineers model this behavior before designing retry policies, not after incidents.

---
