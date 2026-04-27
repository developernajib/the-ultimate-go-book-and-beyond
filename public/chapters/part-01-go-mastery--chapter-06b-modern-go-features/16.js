export default `## Section 11: Go 1.25, testing/synctest and Container-Aware GOMAXPROCS

*(json/v2 is covered separately in Section 5, it shipped inside the stdlib in Go 1.26 but is still gated by \`GOEXPERIMENT=jsonv2\` and not yet stable.)*

### 11.1 testing/synctest, Virtualized Time for Concurrent Tests

Go 1.25 introduced \`testing/synctest\`, which solves the hardest problem in concurrent testing: determinism. Tests that rely on \`time.Sleep\`, timers, or "wait for goroutine" loops are slow, flaky, and non-deterministic. \`testing/synctest\` provides a *bubble* where time is virtual.

\`\`\`go
package main

import (
	"context"
	"testing"
	"testing/synctest"
	"time"
)

// RateLimiter allows N operations per second
type RateLimiter struct {
	tokens  int
	maxRate int
	ticker  *time.Ticker
}

func NewRateLimiter(ratePerSec int) *RateLimiter {
	rl := &RateLimiter{
		tokens:  ratePerSec,
		maxRate: ratePerSec,
	}
	rl.ticker = time.NewTicker(time.Second)
	go func() {
		for range rl.ticker.C {
			rl.tokens = rl.maxRate // refill every second
		}
	}()
	return rl
}

// TestRateLimiterRefill tests that tokens refill after 1 second
// WITHOUT sleeping 1 real second - time is virtualized
func TestRateLimiterRefill(t *testing.T) {
	synctest.Run(func() {
		rl := NewRateLimiter(10)

		// Drain all tokens
		for range 10 {
			rl.tokens--
		}
		if rl.tokens != 0 {
			t.Fatal("expected 0 tokens")
		}

		// Advance virtual time by 1 second - instant in real time
		time.Sleep(time.Second)
		synctest.Wait() // wait for all goroutines in the bubble to settle

		if rl.tokens != 10 {
			t.Fatalf("expected 10 tokens after refill, got %d", rl.tokens)
		}
	})
}
\`\`\`

**Key behaviors of \`synctest.Run\`:**
- All \`time\` package functions inside use a fake clock
- \`synctest.Wait()\` blocks until all goroutines in the bubble are blocked
- Virtual time advances when all goroutines are blocked (waiting for timers)
- Goroutines created inside the bubble inherit the fake clock

### 11.2 Container-Aware GOMAXPROCS

Before Go 1.25, \`GOMAXPROCS\` defaulted to the machine's CPU count, but in Kubernetes, your pod might have a CPU limit of 0.5 on a 64-core node. This caused goroutine scheduling overhead far exceeding actual CPU budget.

\`\`\`go
// Before Go 1.25: GOMAXPROCS = 64 (machine CPUs), but container cgroup limit = 2
// After Go 1.25: GOMAXPROCS automatically = 2 (cgroup CPU bandwidth limit)

// You can still override explicitly:
import "runtime"

func init() {
    // Query the effective GOMAXPROCS (now container-aware)
    procs := runtime.GOMAXPROCS(0) // 0 = query without setting
    log.Printf("effective GOMAXPROCS: %d", procs)

    // Force explicit value if needed (e.g., benchmarking):
    // runtime.GOMAXPROCS(4)
}
\`\`\`

**Why this matters:** Before this fix, Go services in Kubernetes with CPU limits of 0.5 would spin up 64 OS threads, causing massive context-switching overhead. The container-aware default eliminates this entire class of performance bug.

### Adoption Story

\`testing/synctest\` (stable in 1.25) is the testing feature with the highest leverage for concurrent services. It provides a fake clock and deterministic goroutine scheduling that lets you write tests for time-dependent concurrent code without \`time.Sleep\` races. The adoption cost is learning the API. The payoff is that flaky concurrent tests become a solvable problem rather than a fact of life.

Container-aware \`GOMAXPROCS\` is transparent. Upgrade to 1.25, and the service automatically respects cgroup CPU limits. The pre-1.25 hacks (manually setting \`GOMAXPROCS\` from the cgroup files, using \`uber-go/automaxprocs\`) become unnecessary. Drop the dependency.

\`sync.WaitGroup.Go\` is a small ergonomic addition that saves the \`wg.Add(1)\` + \`defer wg.Done()\` boilerplate. Adopt it in new code. Migrate old code opportunistically.

### Code-Review Lens (Senior Track)

Three patterns to flag in tests after 1.25:

1. **\`time.Sleep\` in a concurrent test.** Replace with \`synctest.Run\` and the fake clock. The test becomes deterministic.
2. **\`uber-go/automaxprocs\` still imported on a 1.25+ service.** Drop it. The standard library does the job now.
3. **\`wg.Add(1); go func() { defer wg.Done(); ... }()\` in new code.** Replace with \`wg.Go(func() { ... })\`. One less place for the add/done mismatch bug.

---
`;
