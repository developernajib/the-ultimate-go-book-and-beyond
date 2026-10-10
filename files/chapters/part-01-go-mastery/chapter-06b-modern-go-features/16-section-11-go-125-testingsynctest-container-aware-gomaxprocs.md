## Section 11: Go 1.25, testing/synctest and Container-Aware GOMAXPROCS

*(json/v2 is covered separately in Section 5. It shipped inside the stdlib in Go 1.25, was gated by `GOEXPERIMENT=jsonv2` through Go 1.26, and reached general availability in Go 1.27.)*

### 11.1 testing/synctest, Virtualized Time for Concurrent Tests

Go 1.25 stabilized `testing/synctest` (experimental behind `GOEXPERIMENT=synctest` in 1.24), which solves the hardest problem in concurrent testing: determinism. Tests that rely on `time.Sleep`, timers, or "wait for goroutine" loops are slow, flaky, and non-deterministic. `testing/synctest` provides a *bubble* where time is virtual.

```go
package main

import (
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// RateLimiter allows N operations per second
type RateLimiter struct {
	mu      sync.Mutex
	tokens  int
	maxRate int
	ticker  *time.Ticker
	done    chan struct{}
}

func NewRateLimiter(ratePerSec int) *RateLimiter {
	rl := &RateLimiter{
		tokens:  ratePerSec,
		maxRate: ratePerSec,
		done:    make(chan struct{}),
	}
	rl.ticker = time.NewTicker(time.Second)
	go func() {
		for {
			select {
			case <-rl.ticker.C:
				rl.mu.Lock()
				rl.tokens = rl.maxRate // refill every second
				rl.mu.Unlock()
			case <-rl.done:
				return
			}
		}
	}()
	return rl
}

// Allow consumes a token if one is available.
func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if rl.tokens == 0 {
		return false
	}
	rl.tokens--
	return true
}

// Tokens reports the current token count.
func (rl *RateLimiter) Tokens() int {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	return rl.tokens
}

// Stop shuts down the refill goroutine.
func (rl *RateLimiter) Stop() {
	rl.ticker.Stop()
	close(rl.done)
}

// TestRateLimiterRefill tests that tokens refill after 1 second
// WITHOUT sleeping 1 real second: time is virtualized
func TestRateLimiterRefill(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		rl := NewRateLimiter(10)
		defer rl.Stop() // the bubble requires all goroutines to exit

		// Drain all tokens
		for range 10 {
			if !rl.Allow() {
				t.Fatal("expected a token to be available")
			}
		}
		if rl.Tokens() != 0 {
			t.Fatal("expected 0 tokens")
		}

		// Advance virtual time by 1 second, instant in real time
		time.Sleep(time.Second)
		synctest.Wait() // wait for all goroutines in the bubble to settle

		if got := rl.Tokens(); got != 10 {
			t.Fatalf("expected 10 tokens after refill, got %d", got)
		}
	})
}
```

**Key behaviors of `synctest.Test`:**

(The experimental `synctest.Run` from Go 1.24 is deprecated. Use `synctest.Test`, which passes a bubble-aware `*testing.T`.)
- All `time` package functions inside use a fake clock
- `synctest.Wait()` blocks until all goroutines in the bubble are blocked
- Virtual time advances when all goroutines are blocked (waiting for timers)
- Goroutines created inside the bubble inherit the fake clock

### 11.2 Container-Aware GOMAXPROCS

Before Go 1.25, `GOMAXPROCS` defaulted to the machine's CPU count, but in Kubernetes, your pod might have a CPU limit of 0.5 on a 64-core node. This caused goroutine scheduling overhead far exceeding actual CPU budget.

```go
// Before Go 1.25: GOMAXPROCS = 64 (machine CPUs), but container cgroup limit = 2
// After Go 1.25: GOMAXPROCS automatically = 2 (cgroup CPU bandwidth limit)

// You can still override explicitly:
import (
	"log"
	"runtime"
)

func init() {
    // Query the effective GOMAXPROCS (now container-aware)
    procs := runtime.GOMAXPROCS(0) // 0 = query without setting
    log.Printf("effective GOMAXPROCS: %d", procs)

    // Force explicit value if needed (e.g., benchmarking):
    // runtime.GOMAXPROCS(4)
}
```

**Why this matters:** Before this fix, Go services in Kubernetes with CPU limits of 0.5 would spin up 64 OS threads, causing massive context-switching overhead. The container-aware default eliminates this entire class of performance bug.

### Adoption Story

`testing/synctest` (stable in 1.25) is the testing feature with the highest-value for concurrent services. It provides a fake clock and deterministic goroutine scheduling that lets you write tests for time-dependent concurrent code without `time.Sleep` races. The adoption cost is learning the API. The payoff is that flaky concurrent tests become a solvable problem rather than a fact of life.

Container-aware `GOMAXPROCS` is transparent. Upgrade to 1.25, and the service automatically respects cgroup CPU limits. The pre-1.25 hacks (manually setting `GOMAXPROCS` from the cgroup files, using `uber-go/automaxprocs`) become unnecessary. Drop the dependency.

`sync.WaitGroup.Go` is a small ergonomic addition that saves the `wg.Add(1)` + `defer wg.Done()` boilerplate. Adopt it in new code. Migrate old code opportunistically.

### Code-Review Lens (Senior Track)

Three patterns to flag in tests after 1.25:

1. **`time.Sleep` in a concurrent test.** Replace with `synctest.Test` and the fake clock. The test becomes deterministic.
2. **`uber-go/automaxprocs` still imported on a 1.25+ service.** Drop it. The standard library does the job now.
3. **Manual WaitGroup boilerplate (`wg.Add(1)` paired with `defer wg.Done()`) in new code.** Replace with `wg.Go(func() { ... })`. One less place for the add/done mismatch bug.

---
