## Exercises with Complete Solutions

### Exercise 1: Implement a Retry Policy with Exponential Backoff and Jitter

Implement a `RetryPolicy[T]` generic that wraps any function call with configurable max attempts, exponential backoff (2^n * base), and full jitter to prevent thundering herd. It should integrate with `context` cancellation and emit structured `slog` log entries on each retry. Write a test that verifies it stops retrying after context cancellation.

```go
package exercises

import (
	"context"
	"time"
)

// Starter skeleton:
type RetryConfig struct {
    MaxAttempts int
    BaseDelay   time.Duration
    MaxDelay    time.Duration
    Multiplier  float64
}

func Retry[T any](ctx context.Context, cfg RetryConfig, fn func(ctx context.Context) (T, error)) (T, error) {
    // TODO: implement with jitter
    var zero T
    return zero, nil
}
```

### Exercise 2: Build a Chaos Scheduler

Implement a `ChaosScheduler` that accepts a cron-like schedule and automatically runs registered chaos experiments. Requirements:
- Thread-safe experiment registry
- Maximum one experiment at a time (global lock)
- Dry-run mode that logs what would happen
- Graceful shutdown (finish current experiment, then stop)
- Structured log output for each experiment run with pass/fail

### Exercise 3: Write a DR Test for a Database Failover

Using the `DRPipeline` from Section 9, write a complete DR test for the following scenario: "Primary PostgreSQL in us-east-1 becomes unavailable. Standby in us-west-2 must be promoted within 15 minutes with no more than 5 minutes of data loss."

Steps to implement:
1. Measure current replication lag (must be < 5 min)
2. Simulate primary failure (stop the primary container)
3. Verify health check detects failure within 30 seconds
4. Trigger standby promotion
5. Verify new primary accepts writes
6. Verify DNS has been updated
7. Measure actual RTO and RPO
8. Emit a pass/fail result with metrics

### Exercise 4: Postmortem Action Item Tracker

Build a simple HTTP API using `net/http` (standard library only) that:
- Accepts `POST /postmortems` with a JSON body matching the `Postmortem` struct
- Validates the postmortem using `Generator.Validate`
- Stores it in memory
- Accepts `GET /postmortems/{id}/action-items?overdue=true` to list overdue action items
- Returns structured JSON errors
- Uses `log/slog` for access logging with request ID

### Exercise 5: Implement Adaptive Circuit Breaker

Extend the `CircuitBreaker` from Section 5 to use a sliding window of the last N requests (not just consecutive failures). The circuit should open when the error rate within the window exceeds a configurable percentage threshold. This is more resistant to bursts of errors that happen to be non-consecutive.

```go
package exercises

type SlidingWindowCircuitBreaker[T any] struct {
    cfg    SlidingWindowConfig
    window []bool // true=success, false=failure
    head   int
    // ...
}

type SlidingWindowConfig struct {
    WindowSize     int
    ErrorThreshold float64 // 0.0-1.0
    MinRequests    int     // don't open until at least this many requests
    // ...
}
```

---

### Junior -> FAANG: Exercise Prioritization for Interview Preparation

Exercise 1 (retry policy with jitter) is the highest-priority exercise for interview preparation. Exponential backoff with full jitter appears in FAANG coding interviews more frequently than any other reliability pattern. The full jitter formula is `sleep = random(0, min(cap, base * 2^attempt))`. Without jitter, all clients retry simultaneously after a shared failure, causing a thundering herd that overwhelms the recovering service. With jitter, retries are spread out over the backoff window.

Exercise 5 (sliding window circuit breaker) is the second priority. The sliding window model is more production-realistic than the consecutive-failure model, because real traffic has bursty error patterns that are not consecutive. Implementing it correctly requires understanding ring buffers and careful index management.

Exercise 3 (DR test for database failover) is the hardest exercise and the most valuable for demonstrating operational maturity. Work through it even if you cannot complete it fully. The process of thinking through each step (measure lag, simulate failure, verify detection, trigger promotion, verify writes, measure RTO/RPO) is the learning objective, not just the code.

### Senior @ FAANG: Using These Exercises as Staff-Level Assessment Criteria

**Exercise 1 assessment at L6.** An L5 solution implements the retry loop correctly with jitter. An L6 solution adds: structured log entries at each retry with the attempt number, delay, and error, a context cancellation check between retries (not just at the sleep), and a `RetryableError` type that allows callers to mark specific errors as non-retryable (skip retrying on authentication errors, which will not resolve with retries).

**Exercise 2 assessment at L6.** An L5 solution serializes experiment execution correctly and logs results. An L6 solution adds: dry-run mode that emits the experiment plan without executing it (useful for verifying cron schedules without injecting faults), a maximum experiment duration guard (kill experiments that run longer than configured), and a result store that persists experiment outcomes for trend analysis.

**Exercise 3 assessment at L6.** This exercise tests operational thinking, not just coding. An L5 solution completes the mechanical steps. An L6 solution adds: pre-condition checks (verify the test environment is not already degraded before starting), post-condition verification that goes beyond "primary accepts writes" to include "replication to the new standby has resumed within 60 seconds of promotion," and a detailed timing log that records the duration of each step (useful for identifying which step is the RTO bottleneck).

**Exercise 4 assessment at L6.** An L5 solution implements the HTTP API correctly. An L6 solution adds: pagination on the list endpoint (postmortems accumulate over years, returning all is not scalable), sorting by overdue severity (most overdue first), and an `action_item_completion_rate` computed field in the postmortem response (count of completed items divided by total items, labeling the postmortem as fully addressed, partially addressed, or not addressed). This computed field demonstrates that the implementation thinks about the postmortem as a living document with lifecycle, not just a static record.

**Exercise 5 assessment at L6.** The sliding window circuit breaker is a data structures exercise. An L5 solution uses a slice with a head pointer. An L6 solution discusses the trade-off between accuracy and lock granularity: a coarse lock on the entire window for every request is correct but creates contention under high throughput. A concurrent sliding window uses atomic operations for the head pointer and lock-free slot writes, requiring careful ordering guarantees. The L6 interview follow-up is: "How does your implementation behave under concurrent traffic of 10,000 RPS?"
