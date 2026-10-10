## 26.11 Common Mistakes and How to Avoid Them

### Mistake 1: Not Using Consistent Hashing for Percentage Rollouts

Using `rand.IntN` for percentage rollouts evaluates to different buckets on every call, causing the same user to see the feature enabled on one request and disabled on the next, a non-deterministic experience that invalidates A/B test results. Hashing the user ID with the flag key produces a stable bucket value so the same user always receives the same treatment.

**Problematic Code:**
```go
import "math/rand/v2"

func isEnabled(userID string, percentage int) bool {
    // Random - user gets different result each time!
    return rand.IntN(100) < percentage
}
```

**Correct Approach:**
```go
import (
    "crypto/sha256"
    "encoding/binary"
)

func isEnabled(userID, flagKey string, percentage int) bool {
    // Consistent hash - same user always gets same result
    h := sha256.New()
    h.Write([]byte(userID + ":" + flagKey))
    hash := h.Sum(nil)
    bucket := int(binary.BigEndian.Uint32(hash[:4]) % 100)
    return bucket < percentage
}
```

### Mistake 2: No Default Values or Error Handling

Accessing a flag's fields without checking for a nil return causes panics when the flag key does not exist in the store. Always accept a default value parameter and return it on any error or missing key, logging the fallback so operators can detect misconfigured flag references.

**Problematic Code:**
```go
func getFeature(flagKey string) bool {
    flag := flagService.Get(flagKey)
    return flag.Enabled // Panics if flag is nil!
}
```

**Correct Approach:**
```go
func getFeature(flagKey string, defaultValue bool) bool {
    flag, err := flagService.Get(flagKey)
    if err != nil || flag == nil {
        logger.Warn("flag not found, using default",
            "flag", flagKey,
            "default", defaultValue,
        )
        return defaultValue
    }
    return flag.Enabled
}
```

### Mistake 3: No Flag Cleanup Strategy

Feature flags that are never removed accumulate into a permanent conditional maze that makes the codebase harder to understand and test. Tagging flags with an expiration date and owner, and running an automated cleanup job that notifies owners when flags expire, creates organizational pressure to remove flags and keeps the codebase clean.

**Problematic Code:**
```go
// Flags accumulate forever
if featureFlags.IsEnabled("old-feature-from-2020") {
    // Dead code that no one removes
}
```

**Correct Approach:**
```go
// Flag with expiration and cleanup tracking
type Flag struct {
    Key       string
    ExpiresAt *time.Time
    Temporary bool
    Owner     string
}

// Automated cleanup job
func cleanupExpiredFlags(ctx context.Context) {
    flags, _ := flagRepo.FindExpired(ctx)
    for _, flag := range flags {
        if flag.Temporary && time.Now().After(*flag.ExpiresAt) {
            logger.Info("flag expired, notifying owner",
                "flag", flag.Key,
                "owner", flag.Owner,
            )
            notifyOwner(flag.Owner, flag.Key)
        }
    }
}
```

### Mistake 4: Evaluating Flags in Hot Paths Without Caching

Calling a remote flag service on every iteration of an inner loop adds a network round trip per iteration, turning a microsecond operation into a millisecond one. Evaluating the flag once before the loop and using a local SDK that serves flags from an in-memory cache reduces flag evaluation to a single map lookup with no network latency.

**Problematic Code:**
```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    for i := 0; i < 1000; i++ {
        // Network call on every iteration!
        if flagService.IsEnabled("feature-x", userCtx) {
            // ...
        }
    }
}
```

**Correct Approach:**
```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Evaluate once, use the result
    featureXEnabled := flagService.IsEnabled("feature-x", userCtx)

    for i := 0; i < 1000; i++ {
        if featureXEnabled {
            // ...
        }
    }
}

// Or use local SDK with cached flags
type FlagClient struct {
    cache *sync.Map // Local cache of all flags
}

func (c *FlagClient) IsEnabled(key string, ctx *UserContext, defaultValue bool) bool {
    v, ok := c.cache.Load(key) // No network call
    if !ok {
        return defaultValue // unknown key is normal, not exceptional
    }
    flag, ok := v.(*Flag)
    if !ok {
        return defaultValue // something else put a wrong type in the cache
    }
    return c.evaluate(flag, ctx)
}
```

> **Look carefully at what that example said before it was fixed**, because it made the exact mistake this section warns about two headings earlier:
>
> ```go
> flag, _ := c.cache.Load(key)     // discards the "not found" signal
> return c.evaluate(flag.(*Flag), ctx)  // panics on a cache miss
> ```
>
> `sync.Map.Load` returns `(any, bool)`, and the `_` throws away the only thing that tells you whether the key exists. On a miss, `flag` is a nil `any`, and `flag.(*Flag)` is an unchecked type assertion on nil, which panics. So the "correct" version of "cache your flags" panicked on any flag key not yet in the cache: a typo'd key, a newly created flag, or, worst of all, **every key during the window before the first successful sync**. A process restart during a flag service blip would panic on the first request to touch a flag.
>
> This is worth sitting with. The bug is not that someone forgot the lesson from Mistake 2. It is that `_` and a bare type assertion are both *shorter* than the correct code, and code review rewards brevity. Whenever you write `x, _ := m.Load(k)` followed by `x.(T)`, you have written a panic with extra steps.

### Mistake 5: Not Tracking Flag Impressions

Without impression tracking, there is no way to measure experiment exposure or correlate feature flag state with downstream metrics such as conversion rate or error rate. Recording every flag evaluation with user ID, variation, and timestamp feeds the analytics pipeline that turns feature flags from deployment tools into controlled experiments.

**Problematic Code:**
```go
func isEnabled(flagKey string, userCtx *UserContext) bool {
    // No tracking - can't analyze experiments
    return evaluateFlag(flagKey, userCtx)
}
```

**Correct Approach:**
```go
func isEnabled(flagKey string, userCtx *UserContext, defaultValue bool) bool {
    result := evaluateFlag(flagKey, userCtx)

    // Track impression for analytics. Do this on every evaluation, including
    // the ones that fall back to the default: an experiment analysis needs to
    // know a user was exposed to the control path too.
    tracker.TrackImpression(&Impression{
        FlagKey:   flagKey,
        Variation: result.Variation,
        Reason:    result.Reason,
        UserID:    userCtx.UserID,
        Timestamp: time.Now(),
    })

    // Comma-ok, not a bare assertion. Value is `any` and can legitimately be
    // nil (flag not found) or a non-bool (someone changed the flag's type in
    // the UI). Neither should panic a request handler.
    if v, ok := result.Value.(bool); ok {
        return v
    }
    return defaultValue
}
```

> `return result.Value.(bool)` was the same class of bug one more time. `Value` is `any`. It is nil whenever the flag is missing, and it is a `string` or `float64` the moment someone edits a boolean flag into a multivariate one in the admin UI, which is a normal thing for a product manager to do on a Tuesday. A bare assertion turns that edit into a panic in every handler that reads the flag. Note the ordering too: the impression is tracked *before* the value is coerced, so the analytics pipeline still records exposures even when the value is unusable.

### Staff Lens: Flag Mistakes Have Outsize Impact

A broken flag can affect every user, and a broken rollout can cause outages. Review flag changes as carefully as code changes. Canary flag changes, and monitor after enabling.

---
