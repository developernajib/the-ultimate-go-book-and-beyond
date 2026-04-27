export default `## Section 7: Goroutine Leak Detection

Goroutine leaks are among the most insidious bugs in Go programs. A leaked goroutine consumes memory, holds references that prevent garbage collection, and can exhaust file descriptors or connections. Unlike memory leaks in C, goroutine leaks produce no compiler warning and often go unnoticed until a service degrades under load.

### 7.1 Modern Goroutine Leak Detection

Go 1.26 adds a goroutine leak profile to \`net/http/pprof\` that identifies goroutines blocked longer than a configurable threshold, making detection and diagnosis significantly easier in production.

\`\`\`go
package leakdetect

import (
	"context"
	"fmt"
	"runtime"
    "slices"
	"strings"
	"sync"
	"time"
)

// GoroutineSnapshot captures current goroutine state
type GoroutineSnapshot struct {
	Count  int
	Stacks []string
}

func CaptureGoroutines() GoroutineSnapshot {
	buf := make([]byte, 1<<20) // 1MB buffer
	n := runtime.Stack(buf, true)
	stacks := strings.Split(string(buf[:n]), "\\n\\n")

	return GoroutineSnapshot{
		Count:  runtime.NumGoroutine(),
		Stacks: stacks,
	}
}

// LeakDetector tracks goroutine lifecycle
type LeakDetector struct {
	mu       sync.Mutex
	baseline GoroutineSnapshot
	threshold int
}

func NewLeakDetector(threshold int) *LeakDetector {
	ld := &LeakDetector{threshold: threshold}
	ld.baseline = CaptureGoroutines()
	return ld
}

// Check detects goroutine leaks since baseline
func (ld *LeakDetector) Check() (leaked bool, diff int, newStacks []string) {
	current := CaptureGoroutines()
	diff = current.Count - ld.baseline.Count

	if diff <= ld.threshold {
		return false, diff, nil
	}

	// Find new goroutines by comparing stacks
	baselineSet := make(map[string]bool)
	for _, s := range ld.baseline.Stacks {
		// Normalize: remove goroutine IDs (they change)
		normalized := normalizeStack(s)
		baselineSet[normalized] = true
	}

	for _, s := range current.Stacks {
		normalized := normalizeStack(s)
		if !baselineSet[normalized] {
			newStacks = append(newStacks, s)
		}
	}

	return true, diff, newStacks
}

func normalizeStack(stack string) string {
	lines := strings.Split(stack, "\\n")
	if len(lines) == 0 {
		return stack
	}
	// Remove first line (goroutine ID) and normalize goroutine IDs
	if len(lines) > 0 && strings.HasPrefix(lines[0], "goroutine ") {
		lines = lines[1:]
	}
	return strings.Join(lines, "\\n")
}

// Common goroutine leak patterns and fixes

// LEAK: goroutine blocked on channel send with no receiver
func LeakExample1() {
	ch := make(chan int) // unbuffered
	go func() {
		ch <- 1 // blocks forever if no receiver
	}()
	// forgot to receive from ch
}

// FIX: use context for cancellation
func FixedExample1(ctx context.Context) <-chan int {
	ch := make(chan int, 1) // buffered OR
	go func() {
		select {
		case ch <- 1:
		case <-ctx.Done(): // cancel if no receiver
		}
	}()
	return ch
}

// LEAK: ticker not stopped
func LeakExample2() {
	ticker := time.NewTicker(time.Second)
	go func() {
		for range ticker.C { // goroutine lives forever
			// do work
		}
	}()
	// forgot ticker.Stop()
}

// FIX: always use context or explicit stop
func FixedExample2(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// do work
			case <-ctx.Done():
				return
			}
		}
	}()
}

// LEAK: goroutine waiting on WaitGroup that never completes
func LeakExample3() {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		// wg.Done() never called if function panics
		panic("oops")
	}()
	wg.Wait() // blocks forever
}

// FIX: defer wg.Done()
func FixedExample3() {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done() // always called
		// do work
	}()
	wg.Wait()
}

// GoroutineTracker tracks goroutine spawning with stack traces
type GoroutineTracker struct {
	mu      sync.Mutex
	active  map[string]time.Time
}

func NewGoroutineTracker() *GoroutineTracker {
	return &GoroutineTracker{
		active: make(map[string]time.Time),
	}
}

func (gt *GoroutineTracker) Go(name string, fn func()) {
	gt.mu.Lock()
	gt.active[name] = time.Now()
	gt.mu.Unlock()

	go func() {
		defer func() {
			gt.mu.Lock()
			delete(gt.active, name)
			gt.mu.Unlock()
		}()
		fn()
	}()
}

func (gt *GoroutineTracker) ActiveGoroutines() map[string]time.Duration {
	gt.mu.Lock()
	defer gt.mu.Unlock()

	result := make(map[string]time.Duration, len(gt.active))
	now := time.Now()
	for name, start := range gt.active {
		result[name] = now.Sub(start)
	}
	return result
}

func (gt *GoroutineTracker) LongRunning(threshold time.Duration) []string {
	active := gt.ActiveGoroutines()
	var names []string
	for name, dur := range active {
		if dur > threshold {
			names = append(names, fmt.Sprintf("%s (running %v)", name, dur))
		}
	}
	slices.Sort(names)
	return names
}

// Using goleak for testing (go.uber.org/goleak)
// func TestNoGoroutineLeak(t *testing.T) {
//     defer goleak.VerifyNone(t)
//     // ... test code
// }
\`\`\`

### Adoption Story

Goroutine leak detection is the most under-adopted discipline in Go. Every long-running service has at least one subtle leak, and they compound over the service's lifetime. The adoption sequence:

1. **Wire \`goleak.VerifyNone(t)\` into every test.** The \`go.uber.org/goleak\` library verifies at the end of each test that no new goroutines remain. The cost is near-zero. The bugs it catches are catastrophic.
2. **Monitor goroutine count in production.** \`runtime.NumGoroutine()\` is a one-line metric to export to Prometheus. A steady rise means a leak.
3. **Capture periodic goroutine profiles.** Via \`/debug/pprof/goroutine\`. When the count rises, the profile shows which goroutines are stuck and where. Compare against a known-healthy baseline.

### Code-Review Lens (Senior Track)

Three patterns to flag in PRs that spawn goroutines:

1. **A \`go func()\` without a cancellation path.** Any goroutine that reads from a channel or calls a blocking function without a \`ctx.Done()\` check is a leak candidate. Require explicit shutdown discipline.
2. **A goroutine that outlives its intended scope.** A handler spawning a goroutine that runs beyond the request lifetime is almost always a bug. Pass the request's context so cancellation propagates.
3. **A missing \`goleak.VerifyNone(t)\` in new tests.** Wire the discipline at the package level (\`TestMain\` in every package) so that every test runs the check.

### Migration Lens

Thread-leak detection in Java (thread dumps at heap dumps, via VisualVM or JFR) is the closest analogue. Go's advantage is that the profile tooling is built in and goroutines are cheap enough that a few leaked ones do not crash the process, but they still hold the resources they were waiting on (locks, file descriptors, network connections), and those do accumulate.

---
`;
