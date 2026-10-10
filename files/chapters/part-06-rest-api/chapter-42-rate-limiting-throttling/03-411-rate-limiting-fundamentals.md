## 42.1 Rate Limiting Fundamentals

### Rate Limiting vs Throttling

The two terms are often used interchangeably, but the distinction matters at the design level. **Rate limiting** rejects requests above a threshold. It is a hard boundary, and crossing it returns `429 Too Many Requests` (defined in RFC 6585). **Throttling** slows requests down rather than rejecting them (enqueue, delay, or return early while scheduling the work). Token bucket and sliding window algorithms are rate limiters. Leaky bucket is a throttler. In practice most production systems combine both: throttle near the limit (add latency), reject past the limit (return 429 with `Retry-After`, which RFC 9110 defines for exactly this case).

### Why Rate Limit?

Rate limiting serves five key goals: **protection from abuse** (DDoS, scrapers, credential stuffing), **fair usage** (equal access across users), **cost control** (limit expensive operations, protect downstream services), **quality of service** (stable response times, prevent cascade failures), and **business model enforcement** (API tier limits, usage billing).

### Rate Limiting Concepts

Every rate limiter needs a common contract so middleware, handlers, and tests can swap implementations without coupling to a specific algorithm. The `RateLimiter` interface below captures the minimal surface. `Allow` and `AllowN` return not just a boolean but also the remaining quota and the reset timestamp, which are exactly the values the standard `RateLimit` response header needs. `Config` centralizes the three knobs that all algorithms share: the steady-state `Rate`, the `Window` over which it is measured, and an optional `Burst` that absorbs short spikes without triggering rejections.

```go
// ... imports omitted for brevity (time, net/http)

// RateLimiter interface for all rate limiting implementations
type RateLimiter interface {
    // Allow checks if a request should be allowed
    Allow(key string) (allowed bool, remaining int, resetAt time.Time)

    // AllowN checks if n requests should be allowed
    AllowN(key string, n int) (allowed bool, remaining int, resetAt time.Time)

    // Limit returns the maximum number of requests allowed per window
    Limit() int
}

// Config holds rate limiter configuration
type Config struct {
    // Rate is the number of requests allowed per window
    Rate int

    // Window is the time window for the rate limit
    Window time.Duration

    // Burst allows temporary exceeding of rate
    Burst int

    // KeyFunc extracts the rate limit key from context
    KeyFunc func(r *http.Request) string
}

// DefaultConfig returns sensible defaults
func DefaultConfig() Config {
    return Config{
        Rate:   100,
        Window: time.Minute,
        Burst:  10,
        KeyFunc: func(r *http.Request) string {
            return r.RemoteAddr
        },
    }
}

// Result contains rate limit check result
type Result struct {
    Allowed   bool
    Remaining int
    ResetAt   time.Time
    RetryAt   time.Time
}
```

### The Canonical In-Process Limiter: `golang.org/x/time/rate`

Before hand-rolling a token bucket, reach for `golang.org/x/time/rate`. It is maintained by the Go team, race-tested, and covers the three call patterns you need. `Allow()` is the fast drop-on-exceed check. `Wait(ctx)` is the blocking variant that respects cancellation (use this in workers that pace themselves). `Reserve()` returns a delay you can inspect and optionally cancel before sleeping.

```go
import "golang.org/x/time/rate"

// 100 requests per second, burst of 20.
// rate.Limit is a float64: tokens per second.
lim := rate.NewLimiter(rate.Limit(100), 20)

// Non-blocking: good for HTTP middleware where you want 429 on exceed.
if !lim.Allow() {
    http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
    return
}

// Blocking: good for background workers paced against downstream APIs.
if err := lim.Wait(ctx); err != nil {
    return err // ctx canceled or deadline exceeded
}

// Reserve: inspect the delay before committing to it.
r := lim.Reserve()
if !r.OK() {
    return errors.New("cannot reserve, burst exceeded")
}
if d := r.Delay(); d > maxAcceptableDelay {
    r.Cancel() // return the token to the bucket
    return errBusy
}
time.Sleep(r.Delay())
```

> **Senior track**: `rate.Every(d)` converts a period into a `rate.Limit` (`rate.Every(10*time.Millisecond)` equals 100 req/sec). Use it when the period is the natural unit. Never construct a fresh `NewLimiter` per request in a hot path, because a limiter that is thrown away after one call always allows the call. Keep a map from key to `*rate.Limiter` and prune stale entries from a janitor goroutine, otherwise the map grows unbounded for per-IP limiting.

### Junior → FAANG: Building the Mental Model for Rate Limiting Contracts

The `RateLimiter` interface defined here is the correct starting point for any Go project because it decouples the algorithm from the HTTP layer. Junior engineers frequently skip the interface and hard-code a specific implementation directly in middleware. This creates a test problem: you cannot swap in a no-op limiter for unit tests, and you cannot benchmark algorithms against each other without rewriting the middleware.

Practice reading this interface as a contract. `Allow` returns remaining and resetAt, not just a boolean. Ask yourself why. The answer is that the HTTP middleware needs both values to set response headers. If the interface only returned a boolean, the middleware would need to call a second method to get the quota state, which is a race condition between two non-atomic calls. The interface design prevents the race by making one call return everything the middleware needs.

The distinction between rate limiting and throttling matters in interviews. Be ready to give a concrete example of each. Rate limiting: a login endpoint returns 429 after 5 attempts per minute, no queuing. Throttling: a background job processor accepts all tasks but queues the overflow and drains at a constant rate, so no task is rejected, only delayed. A follow-up question is: which would you use for a payment processing webhook? Throttling is safer there, because dropping a webhook means missing a payment event.

For `golang.org/x/time/rate`, memorize the three call patterns and when to use each: `Allow()` for HTTP middleware where you want immediate 429, `Wait(ctx)` for background workers that pace themselves against an external API, and `Reserve()` for cases where you need to inspect the delay before committing to it.

### Senior @ FAANG: Interface Governance and the Quota Contract Between Services

The `RateLimiter` interface is a good local contract. At platform scale, you need to think about the quota contract between services, which is a different and more complex problem.

**The interface as an extension point for instrumentation.** The interface as written returns `allowed`, `remaining`, and `resetAt`. A production implementation wraps this with a metrics-emitting decorator that increments counters on every call without modifying the algorithm implementations. This is the Open-Closed Principle applied directly: add behavior without modifying existing types. The decorator also adds structured logging with the key, the algorithm name, and the decision, which is the audit trail your security team requires.

**Quota ownership in a microservice graph.** When service A makes a downstream call to service B on behalf of a user, whose `RateLimiter` enforces the limit? If service B has its own limiter keyed by service A's identity, it protects itself from service A being a noisy neighbor. If service A has a limiter keyed by the end user's identity, it enforces the per-user quota across everything service A does on that user's behalf. You need both, because they protect against different failure modes. The former is service-to-service rate limiting (a network reliability concern). The latter is per-user quota enforcement (a business policy concern). Conflating them is a common architecture mistake.

**Janitor goroutine correctness under load.** The senior track note about pruning stale entries is correct but incomplete. The obvious implementation is one `map[string]*rate.Limiter` behind one `sync.RWMutex`, and a janitor that takes the write lock and walks every entry. With millions of per-IP entries that walk holds the write lock long enough to stall every in-flight request. The production pattern is a sharded map: 16 or 32 shards, each with its own mutex and its own key subset chosen by hashing the key. The janitor sweeps one shard at a time, so at any moment only 1/32 of the keyspace is blocked, and the sweep is interruptible between shards. Sharding is worth reaching for before `sync.Map`, whose read-mostly design is tuned for keys that are written once and read many times, not for the steady churn of limiter creation and eviction.

**The `Config` struct as a runtime-updateable policy.** The `Config` shown here is constructed once at startup. For enterprise products, limits must be changeable at runtime without restarting the service. This requires a configuration store with a watch mechanism (etcd, Consul, or a database with a polling goroutine), a way to propagate the new config to all in-flight limiter instances, and a decision about whether in-flight requests see the old or new limit. Atomic pointer swaps on the `Config` struct eliminate the need for a mutex on the hot path while still allowing safe updates. An L6 engineer designs this from the start rather than retrofitting it after the first customer asks for a limit increase.
