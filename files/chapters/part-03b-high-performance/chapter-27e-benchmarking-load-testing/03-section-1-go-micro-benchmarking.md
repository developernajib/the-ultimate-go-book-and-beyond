## Section 1: Go Micro-Benchmarking

### 1.1 Benchmark Fundamentals

Go's `testing.B` framework measures function throughput and allocations, but correct usage requires understanding how the framework manages the timer, how to prevent the compiler from optimizing away the computation under test, and how to reset the timer after expensive setup. A benchmark that forgets `b.ReportAllocs()` or leaves an `err` check inside the loop body measures error handling overhead alongside the target operation. The examples below cover the canonical benchmark template, timer management, and the sink-variable pattern that prevents dead code elimination.

> **Senior track**: Since Go 1.24, prefer `for b.Loop() { ... }` over the classic `for i := 0; i < b.N; i++`. The compiler recognizes `b.Loop()` and keeps the parameters and results of calls in the loop body alive, so a function called directly between the loop's braces is not optimized away even when nobody looks at what it returns. It also eliminates the `b.N` ramp-up: the benchmark function body runs exactly once, and the first call to `b.Loop()` resets the timer, so setup above the loop is excluded without an explicit `b.ResetTimer()`. This closes a long-standing footgun where benchmarks silently measured nothing because the compiler proved the work was unused. Know the limit, though: `b.Loop()` protects *calls*. It does not protect inline arithmetic, and it will not stop the compiler from hoisting a loop-invariant expression out of the loop entirely. The `b.N` form is still valid but now considered legacy. Read the official announcement: `go.dev/blog/testing-b-loop`.

**Interpreting the output.** Each benchmark line looks like:

```
BenchmarkUserHandler-16    523412    2291 ns/op    432 B/op    8 allocs/op
```

- `-16`: GOMAXPROCS for the run.
- `523412`: iterations executed to reach the time budget (`-benchtime`, default 1s).
- `ns/op`: wall-clock nanoseconds per iteration. This is the headline number.
- `B/op`: average bytes allocated on the heap per iteration. Requires `b.ReportAllocs()` or `-benchmem`.
- `allocs/op`: average number of distinct heap allocations per iteration. Often the better optimization target than `B/op` because each allocation has fixed overhead (mcache lookup, write barrier, eventual GC scan).

A single run of these numbers is never enough to draw a conclusion. Always run `-count=10` or more and compare with `benchstat`.

```go
package bench_test

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
)

// Run with: go test -bench=. -benchmem -count=10 -benchtime=5s

var globalSink int

// BROKEN. `_ = x + y` throws the result away and x and y never change, so the
// compiler folds the addition to a constant and drops it. This times an empty
// loop. b.Loop() stops the compiler from eliminating *calls* in the loop body,
// it cannot manufacture work out of arithmetic with no observable effect.
func BenchmarkAdd_broken(b *testing.B) {
	x, y := 100, 200
	for b.Loop() {
		_ = x + y
	}
}

// STILL BROKEN, and this is the subtle one. The sink defeats dead-code
// elimination, but x and y are loop-invariant, so the compiler hoists x+y out
// of the loop and computes it exactly once. What is left inside the loop is a
// single store to a global.
func BenchmarkAdd_stillBroken(b *testing.B) {
	x, y := rand.IntN(1000), rand.IntN(1000)
	for b.Loop() {
		globalSink = x + y
	}
}

// The honest lesson: on the reference machine (Intel i7-10510U, Go 1.27.1,
// linux/amd64) all three shapes of this benchmark, including one that mutates
// x every iteration, land at ~1.2 ns/op. That is not the cost of an addition.
// It is b.Loop's own counter overhead, and it is the floor below which this
// harness cannot see. A single ALU op is not measurable with testing.B. If you
// want a number for something this small, benchmark a realistic batch of it and
// divide, and expect the result to be dominated by memory access, not the add.

// BenchmarkAllocVsPool demonstrates reporting allocation metrics.
// Measured on the reference machine above:
//
//	alloc-each        30.44 ns/op     0 B/op   0 allocs/op
//	pool-bytes        69.10 ns/op    24 B/op   1 allocs/op
//	pool-ptr          24.91 ns/op     0 B/op   0 allocs/op
//
// Both of the first two results are traps worth sitting with.
//
// alloc-each reports ZERO allocations. `buf` never leaves the loop, so escape
// analysis keeps the 1 KiB on the stack: `go test -gcflags=-m` prints
// "make([]byte, 1024) does not escape". A benchmark written to demonstrate
// allocation cost demonstrates nothing at all.
//
// pool-bytes is the classic sync.Pool footgun. Put takes an `any`, and a []byte
// is not pointer-shaped, so boxing the slice header into the interface heap
// allocates 24 bytes on every Put. The pool is slower AND allocates more than
// the code it was supposed to optimize. Pool pointers, not slices: pool-ptr
// stores *[]byte, which is pointer-shaped, boxes for free, and hits 0 allocs.
func BenchmarkAllocVsPool(b *testing.B) {
	b.Run("alloc-each", func(b *testing.B) {
		b.ReportAllocs() // Reports allocs/op and bytes/op.
		for b.Loop() {
			buf := make([]byte, 1024)
			globalByteSink = buf // Force the escape the trap above hides.
		}
	})

	// WRONG: Put([]byte) boxes a non-pointer-shaped value. 24 B/op, 1 alloc/op.
	poolBytes := sync.Pool{New: func() any { return make([]byte, 1024) }}
	b.Run("pool-bytes", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			buf := poolBytes.Get().([]byte)
			poolBytes.Put(buf)
		}
	})

	// RIGHT: pool the pointer. 0 B/op, 0 allocs/op.
	poolPtr := sync.Pool{New: func() any { buf := make([]byte, 1024); return &buf }}
	b.Run("pool-ptr", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			buf := poolPtr.Get().(*[]byte)
			poolPtr.Put(buf)
		}
	})
}

var globalByteSink []byte

// Parallel benchmark: measures throughput under concurrent load.
// Run with: go test -bench=. -cpu=1,2,4,8 (tests with different GOMAXPROCS)
//
// The obvious version of this benchmark writes `_ = counter + 1` inside the
// loop and reports ~0.25 ns/op, which is roughly a quarter of one clock cycle
// and therefore impossible. It measures an empty loop: nothing observes the
// result, so the increment never happens. Any sub-nanosecond benchmark result
// is a bug report about your benchmark, not a performance win.
func BenchmarkParallel(b *testing.B) {
	var counter atomic.Int64
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			counter.Add(1) // A real, observable, contended increment.
		}
	})
}

// BenchmarkExpensiveWork benchmarks an expensive operation.
// Note: no b.ResetTimer() needed. The first call to b.Loop() resets the timer
// itself, so anything above the loop is already excluded from the measurement.
func BenchmarkExpensiveWork(b *testing.B) {
	for b.Loop() {
		doExpensiveWork()
	}
}

func doExpensiveWork() {
	sum := 0
	for i := 0; i < 1000; i++ {
		sum += i
	}
	globalSink = sum
}

// Table-driven benchmarks for multiple inputs.
func BenchmarkSort(b *testing.B) {
	sizes := []int{10, 100, 1000, 10000, 100000}
	for _, size := range sizes {
		b.Run(fmt.Sprintf("n=%d", size), func(b *testing.B) {
			data := generateRandomSlice(size)
			for b.Loop() {
				dataCopy := make([]int, len(data))
				copy(dataCopy, data)
				slices.Sort(dataCopy)
			}
		})
	}
}

func generateRandomSlice(n int) []int {
	s := make([]int, n)
	for i := range s {
		s[i] = rand.IntN(1000000)
	}
	return s
}
```

### 1.2 Avoiding Benchmarking Pitfalls

The most common pitfalls are compiler optimization of constant inputs (eliminated entirely), loop body side effects that change the allocation profile after the first iteration, and including setup work in the measured section. `testing.B.Loop` (introduced in Go 1.24) replaces the manual `for i := 0; i < b.N; i++` loop and blocks the compiler from inlining the loop body or proving its result unused, which is the single most common cause of misleading benchmark numbers on inlineable functions. Each anti-pattern below includes a corrected version that produces accurate results.

> **Senior track**: If you must support pre-1.24 toolchains, the traditional defense is a package-level sink (`var sink T`) plus `//go:noinline` on the benchmarked function. This is brittle: the compiler can still constant-fold inputs, and `//go:noinline` changes the function's call overhead, skewing nanosecond-scale measurements. Once you drop compatibility with pre-1.24, delete the `//go:noinline` pragmas. Keep a sink wherever the thing under test is an expression rather than a call, because that is the one case `b.Loop()` does not cover. Dead-code elimination was never a compiler bug to be worked around, it is the compiler doing its job on code you failed to give a purpose.

```go
package pitfalls_test

import (
	"fmt"
	"math/rand/v2"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

var globalSink int

// PITFALL 1: Loop variable capture in closures.
// Before Go 1.22 a `for _, tc := range cases` variable was shared across all
// iterations, so a goroutine or closure that captured it saw whichever value
// the loop had reached by the time it ran, not the one it was launched with.
// Benchmarks that spawned per-case goroutines therefore measured the same case
// N times. Since Go 1.22 loop variables are per-iteration, and the `tc := tc`
// shadowing line every Go codebase used to carry is now dead weight. Delete it.

// PITFALL 2: Benchmark startup cost included in timing.
// With `for b.Loop()` the timer resets on the first iteration, so setup above
// the loop is already excluded. Under the legacy `for i := 0; i < b.N; i++`
// form you must call b.ResetTimer() yourself.
func BenchmarkWithSetup(b *testing.B) {
	// Expensive setup (e.g., create 10K entries in map).
	m := make(map[string]int)
	for i := 0; i < 10000; i++ {
		m[fmt.Sprintf("key%d", i)] = i
	}

	for b.Loop() {
		globalSink = m["key5000"] // Sink: a bare `_ = m[k]` can be elided.
	}
}

// PITFALL 3: GC pressure inflating benchmark results.
// A benchmark that allocates may trigger GC mid-run, and the collection cost
// lands on whichever iteration was unlucky. That is noise, not signal.
//
// The wrong reflex is to turn the GC off with debug.SetGCPercent(-1). It makes
// the number prettier and less true: if the code under test allocates, GC cost
// IS part of its cost, and hiding it just defers the bill to production. Do
// this instead: start from a clean heap so the run is reproducible, then report
// allocations so the GC pressure is visible as a number rather than as jitter.
func BenchmarkGCNoise(b *testing.B) {
	b.ReportAllocs()
	runtime.GC() // Clean heap before timing, for run-to-run reproducibility.

	for b.Loop() {
		// ... allocation-heavy work ...
	}
}

// PITFALL 4: CPU frequency scaling causing non-reproducible results.
// Fix: Disable turbo boost before benchmarking.
// echo 0 > /sys/devices/system/cpu/cpufreq/boost
// echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

// PITFALL 5: Testing only the fast path (cache hits).
func BenchmarkCacheLookup_realistic(b *testing.B) {
	cache := make(map[int]string)
	// Pre-populate with some entries.
	for i := 0; i < 1000; i++ {
		cache[i] = fmt.Sprintf("value%d", i)
	}

	// Mix of hits (80%) and misses (20%) - realistic production ratio.
	hitKeys := make([]int, 800)
	for i := range hitKeys {
		hitKeys[i] = rand.IntN(1000) // Will hit cache
	}
	missKeys := make([]int, 200)
	for i := range missKeys {
		missKeys[i] = 1000 + rand.IntN(10000) // Won't be in cache
	}
	allKeys := append(hitKeys, missKeys...)
	rand.Shuffle(len(allKeys), func(i, j int) { allKeys[i], allKeys[j] = allKeys[j], allKeys[i] })

	i := 0
	for b.Loop() {
		key := allKeys[i%len(allKeys)]
		globalStrSink = cache[key] // Sink, or the lookup can be elided.
		i++
	}
}

var globalStrSink string

// PITFALL 6: Benchmarking a hot path with cold CPU state.
// Warm the caches and branch-predictor tables before the timed region.
//
// Keep this in proportion. Warmup matters when the benchmark is short and the
// working set is large. It is close to irrelevant once the timed region runs
// for a second, because a few hundred cold iterations amortize to nothing
// against hundreds of millions of warm ones. The real defense against cold-start
// skew is -benchtime and -count plus benchstat, not a warmup loop you eyeballed.
func BenchmarkWithWarmup(b *testing.B) {
	fn := computeExpensive

	// Warmup: fill CPU caches, branch predictor tables.
	for i := 0; i < 1000; i++ {
		globalSink = fn(i)
	}

	i := 0
	for b.Loop() {
		globalSink = fn(i)
		i++
	}
}

func computeExpensive(n int) int {
	sum := 0
	for i := 0; i < n%100+10; i++ {
		sum += i * i
	}
	return sum
}

// PITFALL 7: what a contended counter benchmark actually measures.
//
// This looks like it answers "is atomic faster than mutex". It does not. Every
// goroutine here hammers one cache line, so what dominates both arms is
// coherence traffic bouncing that line between cores, not the cost of the
// synchronization primitive. Change the contention level or put real work in
// the critical section and the ranking can move.
//
// Measured, -cpu=4 pinned to 4 cores (Intel i7-10510U, Go 1.27.1), -count=6:
//
//	atomic    16.4 .. 40.0 ns/op
//	mutex     86.5 .. 93.8 ns/op
//
// Read those ranges, not their midpoints. Atomic is clearly ahead here, and the
// direction is what to take away, not a ratio. Note that the atomic arm spans
// 2.4x WITHIN a single -count=6 series on a box that had other work on it. Had
// this chapter reported one run, it could have honestly printed "16 ns" or
// "40 ns" and been off by 2.4x either way. This is exactly why a single run is
// not evidence, and why anyone quoting "atomic is Nx faster than mutex" as a
// context-free constant has not looked at their own error bars.
func BenchmarkAtomicVsMutex(b *testing.B) {
	b.Run("atomic", func(b *testing.B) {
		var counter atomic.Int64
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				counter.Add(1)
			}
		})
	})

	b.Run("mutex", func(b *testing.B) {
		var mu sync.Mutex
		var counter int64
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				mu.Lock()
				counter++
				mu.Unlock()
			}
		})
	})
}
```

### 1.3 Statistical Analysis with benchstat

A single benchmark run produces one data point that may be distorted by CPU scheduling jitter, background GC cycles, or thermal throttling. Running with `-count=10` produces 10 samples per benchmark, and `benchstat` applies a Mann-Whitney U-test (modern versions, replacing the earlier Welch's t-test) to determine whether an observed improvement is real or noise, reporting the 95% confidence interval alongside the percentage change. The workflow below runs a before/after benchmark suite, feeds both result files to `benchstat`, and shows how to interpret the `p` value and confidence interval.

> **Senior track**: A statistically significant change is not the same as a meaningful change. With enough samples, `benchstat` will flag a 0.5% improvement as `p=0.000`, but at that magnitude you are almost always seeing a measurement artifact, microcode update, kernel version bump, or a compiler regalloc reshuffle that has nothing to do with your code. A healthy rule: ignore deltas under roughly 3x the `± %` your benchmark reports. If `± %` is 1%, do not celebrate anything below 3%. Note what `± %` actually is, because it is widely misread as a standard deviation: it is the half-width of the confidence interval around the median, at the level set by `-confidence` (0.95 by default). Medians, not means, are the default for a reason. Benchmark distributions have long right tails from scheduler hiccups, and one descheduled iteration can drag a mean somewhere no sample ever was.

```go
package benchstat_guide

// benchstat usage guide (documentation, not executable code).
//
// 1. Collect multiple samples:
//    go test -bench=BenchmarkSort -count=10 -benchmem > old.txt
//    # Make your optimization change
//    go test -bench=BenchmarkSort -count=10 -benchmem > new.txt
//
// 2. Compare:
//    benchstat old.txt new.txt
//
// 3. Interpret output. Current benchstat (golang.org/x/perf) prints one table
//    per unit, not the single `old time/op | new time/op | delta` line that
//    older tutorials still show:
//
//           │   old.txt   │              new.txt               │
//           │   sec/op    │   sec/op     vs base               │
//    Sort-8   12.40µ ± 2%   8.10µ ± 1%   -34.68% (p=0.000 n=10)
//
// Fields:
//   - sec/op: median seconds per operation, NOT the mean. Benchmark
//     distributions have long right tails from scheduler hiccups, and the
//     median is robust to them.
//   - ± %: half the 95% confidence interval of the median, as a percentage.
//     Read it as "how much this number wobbles". Under ~3% is healthy.
//   - vs base: percent change against the first file. Negative = faster.
//   - p=0.000: p-value from the Mann-Whitney U-test.
//   - n=10: samples surviving in each group.
//   - "~" in the vs base column: no change detected at p < 0.05.
//
// 4. Tips:
//   - Run on an idle machine. Close the browser, pause the sync client.
//   - -count=10 minimum, -count=20 for better statistical power.
//   - ± above 5% means the environment is noisy. Fix that BEFORE believing any
//     delta, because no amount of statistics rescues a bad measurement.
//   - Always read allocs/op alongside sec/op. Faster today with more garbage
//     produced is a bill that arrives later, in someone else's GC pause.
```

**A worked example of why `p < 0.05` is not a truth oracle.** The output below is real, taken on the reference machine (Intel i7-10510U, Go 1.27.1, linux/amd64) while other work was running on it. Both files come from benchmarking *the exact same code, with no change whatsoever between them*, pinned with `taskset -c 0-3`, at `-count=6`:

```
       │   old.txt    │               new.txt                │
       │    sec/op    │    sec/op     vs base                │
Sort-4   1.038µ ± 88%   2.259µ ± 16%  +117.69% (p=0.004 n=6)

       │  old.txt   │            new.txt            │
       │    B/op    │    B/op     vs base           │
Sort-4   896.0 ± 0%   896.0 ± 0%  ~ (p=1.000 n=6) ¹
¹ all samples are equal
```

Identical code "regressed by 117 percent" at `p=0.004`. A CI gate reading only the p-value would have blocked that deploy and sent an engineer hunting for a bug that does not exist. The tell is sitting in the same line: `± 88%`. The confidence interval is so wide that the median is meaningless, and the test is faithfully reporting that two piles of noise differ from each other. Statistical significance answers "did these samples come from different distributions". It never answers "did my code get slower".

Now read the second table. `B/op` is `896.0 ± 0%` on both sides, "all samples are equal", from the same loaded machine in the same run. That contrast is the most useful thing in this section: **allocation counts are deterministic and survive a noisy box, wall-clock time does not.** When you cannot get a quiet machine, and often you cannot, anchor the claim to `allocs/op` and `B/op` and treat `sec/op` as a hypothesis awaiting a quiet room.

So: read `± %` before you read the delta. If variance is high you have not measured anything yet, and no p-value will rescue it.

**On latency assertions inside `testing.B`.** A tempting pattern is a benchmark that calls `time.Now()` around each iteration and fails when one exceeds a threshold. Do not ship it. `time.Now()` costs tens of nanoseconds, so it swamps anything sub-microsecond you are trying to measure. Worse, a single-iteration outlier is exactly what a loaded CI runner produces at random, so the check flakes constantly and gets disabled within a month. Per-iteration timing is what a profiler and a load test are for. Gate CI on `benchstat` comparing a stored baseline against the current run, which is the workflow in section 1.4 and the CI integration in section 4.

### 1.4 Junior → FAANG: the benchstat ritual

Every benchmark claim should look like this workflow, no exceptions:

```bash
go test -bench=. -count=10 -benchmem -run='^$' ./... > old.txt
# make your change
go test -bench=. -count=10 -benchmem -run='^$' ./... > new.txt
benchstat old.txt new.txt
```

If `benchstat` reports "~" (no significant change), your optimization did nothing measurable. Revert it, or investigate further. If it reports a change with `p < 0.05` **and** a `± %` under 3 percent on both sides, you have a real result. If `± %` is above 5 percent, your environment is noisy, and the p-value is worthless until you fix that: as the worked example above shows, a noisy box will hand you `p=0.004` on code you did not touch. This three-line workflow is the single most valuable habit in this chapter. Engineers who run it every time ship fewer regressions and make fewer wrong claims. Engineers who skip it ship optimization stories that turn out to be noise.

### 1.5 Senior @ FAANG: the benchmark code review bar

When reviewing a PR that touches a `testing.B`, apply six checks. First, does the benchmark use `b.Loop()` (Go 1.24+) or at minimum a sink variable plus `b.ReportAllocs()`? Second, is the setup outside the timed region, or is `b.ResetTimer()` called? Third, is the workload size realistic (not one element, not a billion)? Fourth, is there a comment explaining what the benchmark measures and why (which production code path does it correspond to)? Fifth, does the PR description include `benchstat` output showing the before/after, or just asserted numbers? Sixth, are allocations reported (`b.ReportAllocs()` and `B/op`, `allocs/op` visible)? A benchmark that fails any of these checks produces numbers you cannot trust, and a team that lets unchecked benchmarks land accumulates a test suite that lies. The bar is not perfection on first PR. The bar is catching the six categories reliably on every review, so the team converges on reliable benchmarks over time.

---
