## Exercises

1. **Token Bucket Rate Limiter from Scratch**: Implement a thread-safe token bucket rate limiter in pure Go (no Redis, no external libraries) using a `sync.Mutex`-protected struct with `tokens float64`, `lastRefill time.Time`, and configurable `capacity` and `refillRate`. Expose it as an HTTP middleware. Write a test that fires 20 requests in quick succession against a limit of 10 req/s and asserts exactly 10 succeed with `200` and 10 receive `429`.

2. **Sliding Window Counter with Redis**: Implement a sliding window rate limiter using a Redis sorted set (`ZADD` / `ZREMRANGEBYSCORE` / `ZCARD`) inside a Lua script for atomicity. The key should be scoped to `rate:{identifier}:{window_seconds}`. Write an integration test against a real Redis instance (use `testcontainers-go`) that asserts the window slides correctly and does not reset abruptly at a fixed boundary.

3. **Tiered Rate Limits per Plan**: Build a middleware that reads the authenticated user's plan tier (`free`, `pro`, `enterprise`) from the JWT claims and applies different rate limits per tier (e.g., free: 60 req/min, pro: 600 req/min, enterprise: 6000 req/min). Also apply a separate stricter limit on a `POST /search` endpoint regardless of tier. Write table-driven tests for all three tiers asserting the correct `RateLimit-Policy` header value, including that the policy is named after the tier.

4. **Standard Rate Limit Headers**: Ensure every HTTP response includes `RateLimit-Policy` (`"name";q=<quota>;w=<window-seconds>`) and `RateLimit` (`"name";r=<remaining>;t=<seconds-until-reset>`) per the IETF draft, plus `Retry-After` on `429` responses only. Note that `t` is **seconds remaining, not a Unix timestamp**, and that the draft withdrew the older `RateLimit-Limit` / `-Remaining` / `-Reset` trio. Write a test that issues requests until a `429`, reads `Retry-After`, waits that long (mock time with a clock interface), and asserts the next request succeeds. Add a second test asserting `Retry-After` is never 0 and never expires before the window does: round up, not down.

5. **Adaptive Rate Limiting Based on System Load**: Implement a middleware that reads current CPU usage via `gopsutil` (or a mockable `LoadReader` interface) and halves the effective rate limit when CPU exceeds 80%. The threshold and reduction factor must be configurable. Write a unit test using the mock interface that simulates high load and asserts the effective limit is reduced, and normal load restores it.

6. **Circuit Breaker for Redis Fallback**: Wrap the Redis rate limiter in a circuit breaker (implement one manually or use `sony/gobreaker`). When Redis is unavailable, fail open (allow the request) and log a warning. After 5 consecutive Redis failures, open the circuit and skip Redis entirely for 10 seconds before re-attempting. Write a test that injects a failing Redis client, fires 10 requests, and asserts all 10 receive `200` (fail-open behavior) and the warning is logged exactly once per open transition.

7. **Abuse Detection and IP Reputation**: Implement an abuse-detection middleware that tracks, per IP, the number of distinct API keys used within a 1-hour sliding window using a Redis HyperLogLog. If a single IP uses more than 10 distinct keys, add it to a Redis blocklist with a 1-hour TTL and return `429` for all subsequent requests. Write a test that simulates an IP rotating through 11 keys and asserts the 11th request is blocked while a different IP with 5 keys is not.

### Junior → FAANG: Turning Exercise Lists into Interview Wins

Exercises like these exist on FAANG take-homes and live coding screens. The difference between a candidate who passes and one who does not is rarely raw algorithm knowledge. It is the ability to make good design decisions under time pressure and communicate them clearly.

**How to approach these exercises under interview time pressure:**

Start with the interface before the implementation. Write `type RateLimiter interface { Allow(ctx context.Context, key string) (bool, error) }` before writing a single struct. This keeps your design open to substitution (memory vs Redis, real clock vs mock clock) and signals to the interviewer that you think in abstractions.

**Which exercises to prioritize if you only have limited prep time:**

Exercise 1 (token bucket from scratch) is the highest-signal exercise. It tests floating-point arithmetic, mutex usage, lazy evaluation, and HTTP middleware chaining. If you can implement it correctly in 20 minutes with tests, you can pass most FAANG rate limiting screens.

Exercise 4 (standard headers) is the easiest to get wrong in a subtle way. Practice writing the current shape from memory: `RateLimit-Policy: "default";q=100;w=60` and `RateLimit: "default";r=50;t=30`, plus `Retry-After` on the 429. Interviewers who know this area will probe two things. First, whether you reach for the withdrawn `RateLimit-Limit` / `-Remaining` / `-Reset` trio, which dates you to a superseded draft revision. Second, whether you know `t` is a duration rather than a timestamp. If you can also say that the fields are structured-field items and that the draft calls them informative hints rather than guarantees, you are ahead of most interviewers on the topic.

**The clock interface habit (applies to exercises 1, 4, 5):**

Any exercise that involves time requires a mockable clock. Define:

```go
type Clock interface {
    Now() time.Time
}
type RealClock struct{}
func (RealClock) Now() time.Time { return time.Now() }
```

Inject it into your struct. In tests, inject a `FakeClock` you control. This single habit eliminates `time.Sleep` from test files and makes your tests run in milliseconds instead of seconds.

**Entry-point answer for exercise 6 (circuit breaker):**

The key insight is that the circuit breaker state (closed, open, half-open) must be shared across requests in the same process but not necessarily across processes. A single `sync.Mutex`-protected state machine per service instance is sufficient. You do not need distributed circuit breaker state. Each replica independently trips its own circuit, and if Redis is down, all replicas will trip independently within a few requests. That is fine and actually desirable (each replica independently falls back to local limiting).

### Senior @ FAANG: Raising the Bar on Each Exercise

A senior candidate is not evaluated on whether the solution works. They are evaluated on whether the solution is production-ready, observable, and designed for change. Here is what "raising the bar" means for each exercise category.

**Exercises 1-2 (core algorithm exercises): add observability by default.**

A production rate limiter without metrics is a liability. In every exercise solution, add at minimum: a counter for allowed requests, a counter for rejected requests, and a histogram for the time spent in the `Allow()` call. Use a constructor injection pattern: `NewTokenBucket(..., metrics MetricsSink)` where `MetricsSink` is an interface with `Inc(name string)` and `Observe(name string, value float64)`. In production this binds to Prometheus. In tests it binds to a no-op sink. This pattern is a L5 signal in any FAANG interview.

**Exercise 3 (tiered limits): add runtime configurability.**

The exercise asks for three fixed tiers. A senior candidate asks: "how do I change a tier's limit without a deploy?" The answer: store limits in a config struct that is loaded from an environment variable or a config service, and wrap it in an `atomic.Pointer[TierConfig]` so the middleware reads the latest value on every request with no lock contention. A reload mechanism (SIGHUP handler, polling goroutine) updates the atomic pointer. This is the difference between a feature and a platform capability.

**Exercise 5 (adaptive limiting): add hysteresis to prevent oscillation.**

The naive implementation raises limits when load is low and lowers them when load is high. Without hysteresis, the limiter oscillates: it admits more load, load increases, it reduces limits, load drops, it admits more load, repeat. The fix is AIMD: when the health score improves, increase the effective rate by a small additive amount (plus 5%). When the health score worsens, decrease by a large multiplicative amount (times 0.5). This is how TCP congestion control avoids oscillation and it is the right analogy here.

**Exercise 6 (circuit breaker fallback): consider partial degradation.**

Fail open is not binary. When Redis is down, you have three options: allow all (fail open), reject all (fail closed), or apply a conservative local limit (graceful degradation). The right choice depends on the endpoint. For a payments API, graceful degradation (local limit at 10% of normal rate) is better than either extreme. Expose this as a `FallbackPolicy` enum with `AllowAll`, `DenyAll`, and `LocalLimit(rate float64)` variants. Teams register their endpoint's policy when they configure the middleware.

**Exercise 7 (HyperLogLog abuse detection): think about the false positive trade-off for blocklisting.**

HyperLogLog has a 0.81% standard error. At a threshold of 10 distinct keys, you may block a legitimate IP that used only 9 keys (false positive) or fail to block one that used 11 keys (false negative). False positives for blocklisting have a real user impact: a legitimate user behind a shared corporate NAT (many colleagues using the same egress IP) could be blocked. The senior answer: use HyperLogLog for the detection signal, but require a secondary confirmation before blocklisting. For example, if HLL reports more than 10 keys AND the request rate from this IP in the last minute is more than 2x baseline, then blocklist. Single-signal blocklisting is too aggressive for shared IPs.

**The exercise that would make this list complete:**

A quota reconciliation exercise: given that a user has used 8,000 of their 10,000 monthly quota, and the product team wants to run a promotion that doubles the monthly quota retroactively, implement the quota reset without a Redis scan across all user keys. The correct approach: store a `quota_version` field alongside `monthly_used`. When the version changes (promotion applied), the middleware detects the mismatch and resets usage to zero atomically in Lua. This avoids a batch job, avoids a Redis scan, and is consistent across all replicas. It is the kind of problem that appears in FAANG L5/L6 design reviews and is rarely covered in books.
