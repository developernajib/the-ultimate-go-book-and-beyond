## Exercises

### Exercise 1: Implement a Power-of-10 Compliant Worker Pool

Build a worker pool that follows all 10 NASA rules:
- No recursion in any function.
- All loops have explicit upper bounds.
- All memory is pre-allocated at construction.
- No function exceeds 60 lines.
- Every function has at least 2 assertions.
- No package-level mutable state.
- Every error return is checked.
- No reflection or code generation.
- No nested pointers.
- Passes `go vet`, `staticcheck`, and `golangci-lint` with zero warnings.

```go
package nasa

import (
    "context"
    "time"
)

// Task represents an executable unit of work.
type Task func(ctx context.Context) error

// NASAWorkerPool starter template:
type NASAWorkerPool struct {
    // Your implementation here.
    // Hint: Use a fixed-size array of worker slots, a bounded task queue,
    // and pre-allocated result buffers.
}

func NewNASAWorkerPool(workers int, queueSize int) (*NASAWorkerPool, error) {
    // Pre-allocate everything here. No allocations after this point.
    return nil, nil
}

func (p *NASAWorkerPool) Submit(ctx context.Context, task Task) error {
    // Bounded wait for queue slot. Bounded execution time.
    return nil
}

func (p *NASAWorkerPool) Shutdown(timeout time.Duration) error {
    // Graceful shutdown with bounded wait.
    return nil
}
```

### Exercise 2: Root Cause Analysis Database

Build an error tracking system inspired by the Space Shuttle error database:
- Every error must have a root cause, process failure, and corrective action.
- Track defects per KLOC over time.
- Generate a quality report.
- All operations are bounded (fixed maximum errors, bounded queries).

### Exercise 3: Priority Inversion Detector

Write a Go program that:
1. Creates a scenario with 3 goroutines (high, medium, low priority simulated with
   channels) sharing a mutex.
2. Detects when the medium-priority goroutine prevents the high-priority goroutine from
   running.
3. Implements the fix using a timed mutex with a channel-based ownership pattern.
4. Includes tests that demonstrate the bug and verify the fix.

### Exercise 4: Bounded Telemetry Pipeline

Build a telemetry processing pipeline where:
- All buffers are pre-allocated (no `append` growth in the hot path).
- All reads and writes are bounded by size and time.
- All goroutines are bounded in count and lifetime.
- The pipeline can process 10,000 telemetry frames per second.
- No frame is ever dropped silently - rejected frames are counted.
- The system degrades gracefully under overload (backpressure, not OOM).

### Exercise 5: Formal State Machine Verification

Implement a state machine for a simplified spacecraft (PreLaunch, Ascent, Orbit, Descent,
Landed, Aborted) with:
- A formal specification of valid transitions.
- Pre-conditions and post-conditions on every transition.
- MC/DC test coverage - every condition independently affects the outcome.
- Property-based testing: generate random transition sequences and verify that only valid
  sequences are accepted.
- A test that exhaustively enumerates all possible 2-step transition paths and verifies
  correctness.

### Exercise 6: NASA-Inspired HTTP Service

Build an HTTP service that implements:
- Pre-allocated buffer pool for request/response bodies.
- Bounded goroutine pool for request processing.
- Rate limiting with a token bucket.
- Request size limits enforced before reading the full body.
- Timeouts on every operation (read, process, write).
- Graceful shutdown with drain period.
- Health check endpoint that reports pool utilization and rejection rates.
- Zero `log.Fatal` or `os.Exit` calls - all errors are handled and returned.

---
