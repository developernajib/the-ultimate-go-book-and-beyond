## 61.8 Testing Rate Limiters

Rate limiter testing must verify both the happy path (requests within limits are allowed) and the enforcement boundary (the exact request that exceeds the limit is rejected), as off-by-one errors in window calculations are a common source of bugs. Concurrent tests using `sync.WaitGroup` and multiple goroutines verify that the limiter is thread-safe under load, catching race conditions that only manifest when multiple goroutines update the token count simultaneously. Using `time.Sleep` sparingly and preferring fakeable clocks where the limiter implementation supports it makes tests faster and deterministic.

```go
// rate_limiter_test.go
package ratelimiter

import (
    "context"
    "sync"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestTokenBucket_Basic(t *testing.T) {
    bucket := NewTokenBucket(10, 1) // 10 capacity, 1 token/sec

    // Should allow first 10 requests
    for i := 0; i < 10; i++ {
        assert.True(t, bucket.Allow(1), "request %d should be allowed", i)
    }

    // 11th request should be denied
    assert.False(t, bucket.Allow(1), "request 11 should be denied")

    // Wait for refill
    time.Sleep(time.Second)

    // Should allow one more
    assert.True(t, bucket.Allow(1), "should allow after refill")
}

func TestSlidingWindow_Accuracy(t *testing.T) {
    ctx := context.Background()
    client := setupRedis(t)

    limiter := NewRedisSlidingWindow(client, "test", 10, time.Second)
    key := "test-user"

    // Allow 10 requests
    for i := 0; i < 10; i++ {
        allowed, _, err := limiter.Allow(ctx, key)
        require.NoError(t, err)
        assert.True(t, allowed, "request %d should be allowed", i)
    }

    // 11th should be denied
    allowed, result, err := limiter.Allow(ctx, key)
    require.NoError(t, err)
    assert.False(t, allowed)
    assert.Equal(t, int64(0), result.Remaining)

    // Wait for window to slide
    time.Sleep(time.Second)

    // Should allow again
    allowed, _, err = limiter.Allow(ctx, key)
    require.NoError(t, err)
    assert.True(t, allowed)
}

func TestRateLimiter_Concurrent(t *testing.T) {
    ctx := context.Background()
    client := setupRedis(t)

    limiter := NewRedisSlidingWindow(client, "concurrent", 100, time.Minute)
    key := "concurrent-test"

    var wg sync.WaitGroup
    allowed := make(chan bool, 200)

    // Fire 200 concurrent requests
    for i := 0; i < 200; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            ok, _, _ := limiter.Allow(ctx, key)
            allowed <- ok
        }()
    }

    wg.Wait()
    close(allowed)

    // Count allowed requests
    allowedCount := 0
    for ok := range allowed {
        if ok {
            allowedCount++
        }
    }

    // Should be close to limit (may have slight variance due to timing)
    assert.InDelta(t, 100, allowedCount, 5, "should allow approximately 100 requests")
}

func BenchmarkTokenBucket_Allow(b *testing.B) {
    bucket := NewTokenBucket(1000000, 1000000)

    b.ResetTimer()
    for b.Loop() {
        bucket.Allow(1)
    }
}

func BenchmarkSlidingWindow_Allow(b *testing.B) {
    ctx := context.Background()
    client := setupRedis(b)
    limiter := NewRedisSlidingWindow(client, "bench", 1000000, time.Minute)

    b.ResetTimer()
    for b.Loop() {
        limiter.Allow(ctx, "bench-key")
    }
}
```

---

### Junior → FAANG: Testing Rate Limiters Correctly

Rate limiter tests are deceptively tricky because they involve time, concurrency, and external state (Redis). Knowing the patterns that make these tests correct and fast is a practical skill.

**The off-by-one is the most common rate limiter bug.** Is the 100th request allowed or denied? Your limit is 100. After 100 allowed requests, the 101st should be denied. Write a test that explicitly checks the 100th (allowed) and 101st (denied) requests. This boundary test catches the most common implementation error: using `>` instead of `>=` in the limit check.

**Concurrent tests require goroutines, not just sequential calls.** `TestRateLimiter_Concurrent` fires 200 goroutines simultaneously. This tests that the Lua script's atomicity prevents two goroutines from both reading 99 and both incrementing to 100 (which would allow 2 extra requests). A sequential test that calls `Allow` 200 times in a loop tests the limit but not thread safety. Both tests are necessary.

**`time.Sleep` in tests is a code smell, not a pattern.** The tests in this section use `time.Sleep(time.Second)` to wait for window expiry. This makes the test slow (it takes at least 1 second) and fragile (if the CI machine is slow, the second might not be enough). The correct approach for production code is to make the rate limiter accept a clock interface rather than calling `time.Now()` directly, allowing tests to inject a fake clock that advances instantly. This is a refactoring investment that pays off in faster, more reliable tests.

**`assert.InDelta` for concurrent tests acknowledges timing variance.** The concurrent test allows 5 requests of variance (`assert.InDelta(t, 100, allowedCount, 5)`). This is necessary because goroutines do not execute in a perfectly deterministic order. Two goroutines might both reach the Redis Lua script within the same millisecond, and the exact count of allowed requests depends on which arrives first. Requiring exactly 100 would make the test flaky. A delta of 5 (5% of the limit) is a reasonable tolerance for a concurrent test.

---

### Senior @ FAANG: Test Architecture for Rate Limiting Infrastructure

At L6/L7, testing a rate limiter that is shared infrastructure means the tests must cover not just the algorithm's correctness but the operational properties that all consuming services depend on.

**Property-based testing for algorithm correctness.** The tests in this section are example-based: specific inputs produce specific outputs. Property-based testing (using a library like `gopter` or writing custom fuzz-style tests) generates random inputs and verifies that invariants hold. For a rate limiter, the invariants are: the number of allowed requests in any window-sized interval never exceeds the limit (by more than the allowed approximation error), and the `Remaining` field in the result is always non-negative. Running 10,000 random scenarios with randomized request timing catches edge cases that example-based tests miss.

**Load testing must run against the actual Redis topology.** The benchmarks in this section run against a single Redis instance. Production uses a Redis cluster with network latency. The p99 latency of a Lua script call to Redis in the same datacenter is approximately 1-2ms. Across datacenter boundaries, it is 5-50ms. The benchmark must be run against a Redis cluster that matches the production network topology to produce valid latency numbers. If the benchmark shows 0.1ms and production shows 5ms, the benchmark is not measuring what production does.

**Chaos testing the fallback activation.** The graceful degradation code activates the fallback after 3 Redis failures. Write a chaos test that: (1) starts the rate limiter with Redis running, (2) fires 1000 concurrent requests to verify normal operation, (3) stops the Redis container using `testcontainers`, (4) fires 1000 more concurrent requests and verifies that the fallback activates (all requests are allowed or limited by the fallback, none return errors), (5) restarts the Redis container, (6) verifies that the rate limiter recovers automatically within 10 seconds. This end-to-end chaos test verifies the fallback behavior under realistic failure conditions. It takes 30 seconds to run, which is acceptable for a nightly CI job. The test passes only when all three stages (normal operation, fallback, recovery) behave correctly.
