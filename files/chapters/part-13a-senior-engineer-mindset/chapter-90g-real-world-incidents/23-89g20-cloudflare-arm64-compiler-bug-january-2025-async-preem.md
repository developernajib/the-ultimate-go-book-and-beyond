## 90G.20 Cloudflare arm64 Compiler Bug (January 2025) - Async Preemption Strikes

*A rare but persistent crash in an arm64 edge fleet, traced down to a Go compiler bug in async preemption:
the runtime's mechanism for interrupting long-running goroutines at arbitrary points.*

### The Incident

In early 2025, Cloudflare engineers investigating intermittent crashes on their arm64 (AArch64) edge servers
traced them to a subtle compiler bug in Go's async preemption mechanism. The bug affected only arm64 architecture
and manifested as rare, non-deterministic crashes that were extremely difficult to reproduce.

**Async preemption** is a Go runtime feature introduced in Go 1.14 that allows the scheduler to preempt
goroutines at (almost) any point in their execution, not just at function calls or channel operations. This is
essential for preventing long-running computation loops from starving other goroutines. On arm64, async
preemption works by sending a signal (SIGURG) to the thread running the goroutine, and the signal handler
adjusts the program counter to redirect execution to the scheduler.

The bug was in the compiler's **liveness analysis** for arm64. When the runtime preempted a goroutine at
certain instruction sequences, the garbage collector's stack scanner could misidentify registers as containing
live pointers when they actually contained stale data or non-pointer values. This caused the GC to either:

1. Follow invalid pointers, causing segmentation faults
2. Keep objects alive that should have been collected, causing memory leaks
3. Corrupt memory by writing GC marks to non-heap addresses

The fix required changes to the Go compiler's register liveness maps for arm64 preemption points.

### Architecture Diagram: How Async Preemption Can Corrupt GC State

The diagram below illustrates the race between async preemption and register liveness. When a goroutine is preempted between two instructions, the GC's stack scanner uses liveness maps to determine which registers hold live pointers. If the liveness map is stale or incorrect for the preemption point, the GC misinterprets register contents and corrupts memory.

```
┌─────────────────────────────────────────────────────────────────────┐
│              ARM64 ASYNC PREEMPTION BUG                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Normal goroutine execution:                                        │
│  ┌────────────────────────────────────────┐                         │
│  │  func compute() {                      │                         │
│  │      x := getObject()  // R1 = *Object │                         │
│  │      y := transform(x) // R1 reused    │                         │
│  │      // At this point R1 contains      │                         │
│  │      // an integer, NOT a pointer      │                         │
│  │      <-- SIGURG arrives here -->       │  <- PREEMPTION POINT    │
│  │      // Compiler liveness map says     │                         │
│  │      // R1 is still a live pointer     │  <- BUG!                │
│  │      result := finalize(y)             │                         │
│  │  }                                     │                         │
│  └────────────────────────────────────────┘                         │
│                                                                     │
│  What happens at preemption:                                        │
│  ┌──────────────────────────┐    ┌──────────────────────┐           │
│  │  Signal Handler (SIGURG) │    │  GC Stack Scanner     │          │
│  │                          │     │                        │        │
│  │  1. Save all registers   │--->│  1. Read liveness map │          │
│  │  2. Record PC location   │    │  2. Map says R1 = ptr │          │
│  │  3. Invoke GC scanner    │    │  3. R1 = 0xDEADBEEF  │           │
│  │                          │     │     (integer, not ptr)│         │
│  │                          │     │  4. Follow "pointer"  │         │
│  │                          │     │  5. SEGFAULT / CORRUPT│         │
│  └──────────────────────────┘    └──────────────────────┘           │
│                                                                     │
│  The bug: compiler's liveness map for arm64 was WRONG at certain    │
│  preemption points. It claimed registers held live pointers when    │
│  they held stale integers or reused values.                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Async Preemption Safety Testing

Because the Cloudflare bug was non-deterministic, reproducing it required manufacturing the exact conditions that maximized collision probability: registers transitioning from pointer values to integers immediately before a SIGURG arrives, with the GC scanner running concurrently. The stress test below achieves this by deliberately interleaving pointer-heavy tree construction with tight integer arithmetic loops (the same register-reuse pattern that exposed the liveness map error) and pairing it with an aggressive GC trigger firing every 50 ms. Any resulting panic indicates the compiler emitted an incorrect preemption map at that preemption point.

```go
package preempttest

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// PreemptionStressTest exercises async preemption to detect compiler bugs.
// It runs tight computation loops with pointer-heavy operations and forces
// frequent GC cycles to maximize the chance of hitting bad preemption points.
type PreemptionStressTest struct {
	workers     int
	duration    time.Duration
	gcFrequency time.Duration
	crashes     atomic.Int64
	iterations  atomic.Int64
	logger      *slog.Logger
}

// NewPreemptionStressTest creates a stress test configured for maximum preemption.
func NewPreemptionStressTest(workers int, duration time.Duration, logger *slog.Logger) *PreemptionStressTest {
	return &PreemptionStressTest{
		workers:     workers,
		duration:    duration,
		gcFrequency: 50 * time.Millisecond, // aggressive GC to trigger scanning
		logger:      logger,
	}
}

// Run executes the stress test. Any panics from GC corruption are caught and counted.
func (pst *PreemptionStressTest) Run(ctx context.Context) TestResult {
	ctx, cancel := context.WithTimeout(ctx, pst.duration)
	defer cancel()

	// Force aggressive GC to maximize preemption-during-GC scenarios.
	debug.SetGCPercent(10)
	defer debug.SetGCPercent(100)

	var wg sync.WaitGroup

	// Start computation workers that mix pointer and non-pointer register usage.
	for i := 0; i < pst.workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					pst.crashes.Add(1)
					pst.logger.Error("worker crashed - possible preemption bug",
						"worker", workerID,
						"panic", fmt.Sprintf("%v", r),
					)
				}
			}()
			pst.computeLoop(ctx, workerID)
		}(i)
	}

	// Start aggressive GC trigger in parallel.
	wg.Add(1)
	go func() {
		defer wg.Done()
		pst.gcTriggerLoop(ctx)
	}()

	wg.Wait()

	return TestResult{
		Iterations: pst.iterations.Load(),
		Crashes:    pst.crashes.Load(),
		Workers:    pst.workers,
		Duration:   pst.duration,
		Arch:       runtime.GOARCH,
		GoVersion:  runtime.Version(),
	}
}

// computeLoop performs operations that create the conditions for the arm64 bug:
// registers that transition from holding pointers to holding non-pointer values.
func (pst *PreemptionStressTest) computeLoop(ctx context.Context, workerID int) {
	type Node struct {
		Value int
		Left  *Node
		Right *Node
		Data  [64]byte // padding to create GC pressure
	}

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Phase 1: Create pointer-heavy data structures.
		// Registers will hold heap pointers.
		root := &Node{Value: 1}
		current := root
		for j := 0; j < 100; j++ {
			current.Left = &Node{Value: j * 2}
			current.Right = &Node{Value: j*2 + 1}
			current = current.Left
		}

		// Phase 2: Transition to integer-heavy computation.
		// The same registers now hold integers, but the liveness map
		// may still claim they hold pointers.
		sum := 0
		for j := 0; j < 1000; j++ {
			sum += j * j // tight loop - preemption likely here
			sum ^= (sum >> 3)
			sum += workerID
		}

		// Phase 3: Use pointer again to prevent dead code elimination.
		root.Value = sum
		_ = root

		pst.iterations.Add(1)
	}
}

// gcTriggerLoop forces frequent GC cycles to maximize the window for preemption.
func (pst *PreemptionStressTest) gcTriggerLoop(ctx context.Context) {
	ticker := time.NewTicker(pst.gcFrequency)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runtime.GC()
		}
	}
}

// TestResult summarizes the stress test outcome.
type TestResult struct {
	Iterations int64
	Crashes    int64
	Workers    int
	Duration   time.Duration
	Arch       string
	GoVersion  string
}

// String formats the result for display.
func (tr TestResult) String() string {
	status := "PASS"
	if tr.Crashes > 0 {
		status = "FAIL - POSSIBLE COMPILER BUG"
	}
	return fmt.Sprintf(
		"Preemption Stress Test: %s\n"+
			"  Architecture: %s\n"+
			"  Go Version:   %s\n"+
			"  Workers:      %d\n"+
			"  Duration:     %s\n"+
			"  Iterations:   %d\n"+
			"  Crashes:      %d\n",
		status, tr.Arch, tr.GoVersion, tr.Workers, tr.Duration, tr.Iterations, tr.Crashes,
	)
}

// RuntimePreemptionMetrics collects preemption-related runtime metrics.
type RuntimePreemptionMetrics struct {
	mu      sync.Mutex
	samples []metrics.Sample
}

// NewRuntimePreemptionMetrics creates a collector for preemption metrics.
func NewRuntimePreemptionMetrics() *RuntimePreemptionMetrics {
	return &RuntimePreemptionMetrics{
		samples: []metrics.Sample{
			{Name: "/gc/cycles/total:gc-cycles"},
			{Name: "/sched/goroutines:goroutines"},
			{Name: "/gc/heap/allocs:bytes"},
			{Name: "/gc/heap/frees:bytes"},
		},
	}
}

// Collect reads current runtime metrics.
func (rpm *RuntimePreemptionMetrics) Collect() map[string]uint64 {
	rpm.mu.Lock()
	defer rpm.mu.Unlock()

	metrics.Read(rpm.samples)
	result := make(map[string]uint64)
	for _, s := range rpm.samples {
		switch s.Value.Kind() {
		case metrics.KindUint64:
			result[s.Name] = s.Value.Uint64()
		}
	}
	return result
}

// AsyncPreemptionToggle demonstrates how to disable async preemption as a
// workaround for compiler bugs (GODEBUG=asyncpreemptoff=1).
func AsyncPreemptionToggle() string {
	// In production, set via environment variable:
	// GODEBUG=asyncpreemptoff=1 ./your-binary
	//
	// This disables async preemption, which means:
	// 1. Goroutines can only be preempted at function calls and channel ops
	// 2. Tight loops without function calls will not be preempted
	// 3. This is a WORKAROUND, not a fix - it reduces scheduler fairness
	//
	// The pointer size on this architecture:
	ptrSize := unsafe.Sizeof(uintptr(0))
	return fmt.Sprintf(
		"Architecture: %s, Pointer size: %d bytes, Go version: %s\n"+
			"To disable async preemption: GODEBUG=asyncpreemptoff=1\n"+
			"WARNING: This reduces scheduler fairness and is only a workaround.",
		runtime.GOARCH, ptrSize, runtime.Version(),
	)
}
```

### Key Lessons for Go Engineers

1. **Compiler bugs exist and affect production** - even mature compilers have bugs, especially on newer
   architectures (arm64) and with newer features (async preemption). Cross-architecture testing is essential.
2. **Async preemption is a powerful but complex feature** - it requires the compiler to maintain accurate
   liveness maps at every possible preemption point, which is a difficult correctness property to guarantee.
3. **Non-deterministic bugs require stress testing** - the Cloudflare bug was rare and non-reproducible with
   normal testing. Only aggressive stress testing with forced GC and high concurrency could trigger it.
4. **Know your escape hatches** - `GODEBUG=asyncpreemptoff=1` can disable async preemption as a temporary
   workaround while waiting for a compiler fix. Know the runtime knobs available in Go.

### Exercises

1. Run the `PreemptionStressTest` on both amd64 and arm64 architectures with different Go versions to
   compare crash rates and validate that newer Go versions have fixed known preemption issues.
2. Build a **cross-architecture CI pipeline** that runs the full test suite on amd64, arm64, and RISC-V
   to catch architecture-specific bugs before they reach production.
3. Implement a **runtime health monitor** that tracks GC pause times, goroutine preemption rates, and
   panic recovery counts, alerting when any metric deviates from its baseline.

---

### Junior → FAANG: Compiler Bugs and Cross-Architecture Testing as Interview Topics

The Cloudflare arm64 incident introduces a category of bug that most engineers never encounter: compiler correctness failures. The Go async preemption bug produced incorrect liveness maps on arm64, causing the GC to collect live objects. The symptom was non-deterministic crashes with no reproducible stack trace. For FAANG interviews, this incident answers "how would you debug a non-deterministic crash that disappears under the debugger?" The answer has two parts. First, increase the crash probability through stress testing: force frequent GC cycles, maximize goroutine concurrency, and run for hours rather than seconds. Second, narrow the search space by bisecting along known variables: Go version (newer vs. older), architecture (amd64 vs. arm64), and GODEBUG settings (asyncpreemptoff=1 vs. default). If disabling async preemption eliminates the crash, you have isolated the bug class even if you cannot yet reproduce it deterministically. Know the `GODEBUG` knobs available in the Go runtime: `asyncpreemptoff`, `gccheckmark`, `schedtrace`, and `gctrace` are the most relevant for diagnosing runtime-level instability.

### Senior @ FAANG: Architecture-Specific Regression Testing as a Platform Standard

At L6, the Cloudflare incident is an argument for multi-architecture CI as a platform requirement, not as an optional quality investment. When arm64 servers (AWS Graviton, Apple Silicon build agents) became cost-effective production platforms, many organizations moved workloads to arm64 without updating their CI infrastructure to include arm64 execution environments. The result is that arm64-specific bugs reach production undetected because the CI pipeline only validated amd64 binaries.

The staff-level response is to define multi-architecture testing as a production readiness gate. Every service that runs on arm64 in production must have its test suite executed on arm64 in CI. The gate is not optional and is not satisfied by "we ran the amd64 tests and they passed." This requires platform investment: arm64 CI runners provisioned and integrated into the pipeline, with the same test coverage and stress test suites as the amd64 baseline.

Beyond the infrastructure investment, the incident reveals a gap in Go's compiler regression testing coverage for new features on non-primary architectures. When async preemption was introduced, it was primarily validated on amd64. The arm64 liveness map bug was not caught because arm64 stress testing was not part of the feature's acceptance criteria. At staff level, when you introduce a new platform capability (new architecture tier, new runtime feature enabled by default), you explicitly define the acceptance criteria that must pass on all supported architectures before the capability is considered production-ready. This is a governance contribution, not a code contribution: it shapes how the platform engineering team validates future changes.

