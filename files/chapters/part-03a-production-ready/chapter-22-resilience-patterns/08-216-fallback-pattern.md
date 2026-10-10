## 22.6 Fallback Pattern

When a dependency is unavailable, returning an error is not always the best option. A cached result, a degraded response, or a static default may be perfectly acceptable to the user. The fallback pattern wraps a primary operation with an alternative execution path invoked on failure, turning hard errors into degraded-but-functional responses. The fallback function receives the original error so it can log, record metrics, or choose between alternatives.

The subtlety is deciding **which** failures deserve a fallback. "Any non-nil error" is the wrong answer.

```go
type FallbackExecutor struct {
    primary  func(ctx context.Context) (any, error)
    fallback func(ctx context.Context, err error) (any, error)
}

func (f *FallbackExecutor) Execute(ctx context.Context) (any, error) {
    result, err := f.primary(ctx)
    if err == nil {
        return result, nil
    }

    // Do NOT fall back when the caller gave up or the deadline expired.
    // There is nobody left to serve, the context is dead so the fallback
    // would fail anyway, and pretending otherwise hides real timeouts.
    if ctx.Err() != nil {
        return nil, err
    }

    fbResult, fbErr := f.fallback(ctx, err)
    if fbErr != nil {
        // Report both. The fallback's error alone ("cache miss") is a
        // useless description of what actually went wrong.
        return nil, errors.Join(err, fbErr)
    }
    return fbResult, nil
}

// Usage
executor := &FallbackExecutor{
    primary: func(ctx context.Context) (any, error) {
        return fetchFromAPI(ctx)
    },
    fallback: func(ctx context.Context, err error) (any, error) {
        log.Printf("Primary failed: %v, using cache", err)
        return fetchFromCache(ctx)
    },
}

result, err := executor.Execute(ctx)
```

**Why cancellation must not trigger a fallback.** If the caller went away or the deadline expired, `ctx` is already dead. Calling `fetchFromCache(ctx)` with it either fails instantly (so the fallback was pointless) or, if the cache client ignores its context, does real work to build a response for a client that stopped listening. Either way you have spent resources during an overload to produce nothing. Worse, when it happens to succeed, a timeout gets recorded as a *successful degraded response*, so your error rate stays green while users see nothing. Check `ctx.Err()` first and return the original error.

### Graceful Degradation

Graceful degradation returns a partial or cached response instead of an error when a dependency is unavailable. Exposing a `Degraded` flag lets API clients tell fresh data from stale and adjust their UX.

The trap is that a degradation path is a very effective way to hide an outage from yourself. Every branch that turns an error into a 200 also deletes a signal from your monitoring.

```go
type DegradedResponse struct {
    Data     any
    Degraded bool
    Message  string
}

func getProductDetails(ctx context.Context, productID string) (DegradedResponse, error) {
    product, err := productService.Get(ctx, productID)
    if err == nil {
        return DegradedResponse{Data: product}, nil
    }

    // The caller is gone or out of time. Do not manufacture a response.
    if ctx.Err() != nil {
        return DegradedResponse{}, errors.Join(err, ctx.Err())
    }

    // A permanent error is not something a stale cache should paper over.
    // "Product does not exist" must stay a 404, not become a hollow shell
    // of a product page.
    if errors.Is(err, ErrProductNotFound) {
        return DegradedResponse{}, err
    }

    degradedTotal.WithLabelValues("product", "cache").Inc() // stay visible

    if cached, cacheErr := cache.Get(ctx, productID); cacheErr == nil {
        return DegradedResponse{
            Data:     cached,
            Degraded: true,
            Message:  "Showing cached data",
        }, nil
    }

    degradedTotal.WithLabelValues("product", "minimal").Inc()

    return DegradedResponse{
        Data:     MinimalProduct{ID: productID},
        Degraded: true,
        Message:  "Limited information available",
    }, nil
}
```

Three changes from the naive version, each of which is a real incident waiting to happen:

**Return an error alongside the response.** The original signature made it impossible for a caller to know anything went wrong except by reading `Degraded`, which nothing enforces. Cancellation now surfaces as an error rather than a cheerful `MinimalProduct`.

**Distinguish permanent from transient.** `ErrProductNotFound` is not a reason to serve stale data, it is the correct answer. Falling back on it converts a clean 404 into a broken-looking page and trains users to distrust the site.

**Count every degradation.** A fallback that fires silently means your dashboards show 100% success while the service returns placeholders. Increment a metric on every degraded path and alert on the *rate*, because degradation is only "graceful" if you know it is happening. The most dangerous outage is the one your SLO cannot see, and unmetered fallbacks are the standard way to build one.

### Staff Lens: Fallback Requires Business Decision

What does "degraded" look like for each request type? The engineering answer is code. The business answer is acceptable UX during failure. Product managers and operators decide: do we show cached data (possibly stale)? Return an empty state? Fail closed?

Different requests have different acceptable degradation modes. Make the business decision explicit, then implement accordingly.

---
