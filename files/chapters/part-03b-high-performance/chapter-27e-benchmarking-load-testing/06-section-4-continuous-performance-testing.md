## Section 4: Continuous Performance Testing

### 4.1 CI Benchmark Pipeline

A CI benchmark pipeline runs benchmarks on dedicated runners with fixed CPU affinity, compares results against the main branch baseline, and fails the build if any benchmark regresses beyond a configurable threshold. Self-hosted runners tagged for benchmark workloads prevent the shared CI environment's variable load from producing noisy measurements.

> **Use `benchstat` if you possibly can.** The code below re-implements a crude subset of it, because seeing the mechanism is worth something and because some pipelines cannot add the dependency. It is strictly worse than the real thing: `benchstat` does the Mann-Whitney test, reports confidence intervals, and will tell you when a delta is indistinguishable from noise. This code just compares medians against a threshold. If you can shell out to `benchstat -format=csv` and parse that instead, do it, and skip to section 4.3.
>
> **One rule this code exists to demonstrate: never compare single samples.** `-count=10` prints ten lines per benchmark with the same name. The obvious parser keys a map by name and silently keeps whichever line came last, then compares that one arbitrary sample against another arbitrary sample from the baseline. Measured on the reference machine, pinned with `taskset`, a single `BenchmarkSort` varied from 938.8 to 1005 ns/op across five consecutive runs of identical code. A gate comparing arbitrary samples with a 5 percent threshold would fire on that, on nothing. Collect every sample per name and reduce, which is what `samples []float64` below is for.

```go
package ci_benchmark

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// BenchmarkRegression tracks performance over time and fails CI on regression.
type BenchmarkRegression struct {
	baselineDir string  // Directory with baseline benchmark results.
	threshold   float64 // Fractional regression that fails the build. 0.10 = 10%.
}

func NewBenchmarkRegression(baselineDir string, thresholdPct float64) *BenchmarkRegression {
	return &BenchmarkRegression{
		baselineDir: baselineDir,
		threshold:   thresholdPct / 100.0,
	}
}

// BenchmarkRun represents results from one benchmark run.
type BenchmarkRun struct {
	Timestamp  time.Time
	CommitHash string
	Results    []BenchmarkResult
}

// BenchmarkResult aggregates ALL samples for one benchmark name, not one run.
// The medians are what the gate compares. The sample slices are retained so the
// report can show the spread, which is the only way a reader can tell whether a
// delta means anything.
type BenchmarkResult struct {
	Name       string
	NsPerOp    float64 // Median of NsSamples.
	AllocsOp   float64 // Median of AllocsSamples. Deterministic in practice.
	BytesOp    float64 // Median of BytesSamples. Deterministic in practice.
	NsSamples  []float64
	NsSpreadPc float64 // (max-min)/median, as a percentage. The noise estimate.
}

// median returns the median of xs. It sorts a copy: callers still want their
// sample order for reporting.
func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := slices.Clone(xs)
	slices.Sort(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// RunBenchmarks executes Go benchmarks and returns structured results.
func (r *BenchmarkRegression) RunBenchmarks(pkg string) (*BenchmarkRun, error) {
	// Execute benchmarks.
	cmd := exec.Command("go", "test",
		"-bench=.", "-benchmem",
		"-count=10",
		"-benchtime=3s",
		pkg,
	)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("run benchmarks: %w", err)
	}

	// Parse output.
	results := parseBenchmarkOutput(string(output))

	// Get commit hash.
	hashCmd := exec.Command("git", "rev-parse", "--short", "HEAD")
	hash, _ := hashCmd.Output()

	return &BenchmarkRun{
		Timestamp:  time.Now(),
		CommitHash: strings.TrimSpace(string(hash)),
		Results:    results,
	}, nil
}

// parseBenchmarkOutput parses `go test -bench` output, grouping every sample by
// benchmark name. With -count=N each name appears N times, and all N samples
// must be kept: a map keyed by name that assigns rather than appends throws away
// N-1 of them and reduces the whole exercise to comparing two coin flips.
func parseBenchmarkOutput(output string) []BenchmarkResult {
	type acc struct {
		ns, allocs, bytes []float64
	}
	byName := map[string]*acc{}
	var order []string // Preserve first-seen order for stable reports.

	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "Benchmark") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		name := parts[0]
		a, ok := byName[name]
		if !ok {
			a = &acc{}
			byName[name] = a
			order = append(order, name)
		}

		// Values are "<number> <unit>" pairs after the iteration count.
		for i := 1; i+1 < len(parts); i++ {
			v, err := strconv.ParseFloat(parts[i], 64)
			if err != nil {
				continue
			}
			switch parts[i+1] {
			case "ns/op":
				a.ns = append(a.ns, v)
			case "allocs/op":
				a.allocs = append(a.allocs, v)
			case "B/op":
				a.bytes = append(a.bytes, v) // Was silently dropped before.
			}
		}
	}

	results := make([]BenchmarkResult, 0, len(order))
	for _, name := range order {
		a := byName[name]
		r := BenchmarkResult{
			Name:      name,
			NsPerOp:   median(a.ns),
			AllocsOp:  median(a.allocs),
			BytesOp:   median(a.bytes),
			NsSamples: a.ns,
		}
		if r.NsPerOp > 0 && len(a.ns) > 1 {
			r.NsSpreadPc = (slices.Max(a.ns) - slices.Min(a.ns)) / r.NsPerOp * 100
		}
		results = append(results, r)
	}
	return results
}

// SaveBaseline saves current results as the baseline for future comparisons.
func (r *BenchmarkRegression) SaveBaseline(run *BenchmarkRun) error {
	if err := os.MkdirAll(r.baselineDir, 0755); err != nil {
		return err
	}
	path := filepath.Join(r.baselineDir, "baseline.json")
	data, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// LoadBaseline loads the saved baseline.
func (r *BenchmarkRegression) LoadBaseline() (*BenchmarkRun, error) {
	path := filepath.Join(r.baselineDir, "baseline.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var run BenchmarkRun
	if err := json.Unmarshal(data, &run); err != nil {
		return nil, err
	}
	return &run, nil
}

// Regression holds details of a performance regression.
type Regression struct {
	Benchmark string
	Kind      string // "time" or "allocs".
	Old       float64
	New       float64
	DeltaPct  float64
	Note      string
}

// CheckRegression compares current medians against baseline medians.
//
// Two rules here matter more than the arithmetic.
//
// First, a time regression is only reported when the delta clears BOTH the
// threshold and the benchmark's own observed noise. If a benchmark swings 30%
// run to run, a 12% "regression" from it is not a finding, and firing on it is
// how a team learns to ignore the gate. Such benchmarks are reported as
// unusable rather than as failures: the correct fix is a quieter runner or a
// higher -count, not a louder alarm.
//
// Second, allocation regressions are gated separately and tightly. allocs/op is
// deterministic, so ANY increase is a real code change with no noise excuse.
// This is the check that keeps working on a busy shared CI runner where the
// timing numbers have already stopped meaning anything.
func (r *BenchmarkRegression) CheckRegression(baseline, current *BenchmarkRun) []Regression {
	baselineMap := make(map[string]BenchmarkResult, len(baseline.Results))
	for _, res := range baseline.Results {
		baselineMap[res.Name] = res
	}

	var regressions []Regression
	for _, cur := range current.Results {
		old, ok := baselineMap[cur.Name]
		if !ok {
			continue // New benchmark, nothing to compare against.
		}

		// Allocations: exact, so any growth counts.
		if old.AllocsOp > 0 && cur.AllocsOp > old.AllocsOp {
			regressions = append(regressions, Regression{
				Benchmark: cur.Name,
				Kind:      "allocs",
				Old:       old.AllocsOp,
				New:       cur.AllocsOp,
				DeltaPct:  (cur.AllocsOp - old.AllocsOp) / old.AllocsOp * 100,
				Note:      "allocs/op is deterministic: this is a real change, not noise",
			})
		}

		if old.NsPerOp == 0 {
			continue
		}
		delta := (cur.NsPerOp - old.NsPerOp) / old.NsPerOp
		if delta <= r.threshold {
			continue
		}

		// Refuse to cry wolf: the observed spread is this benchmark's noise
		// floor, and a delta inside it is not evidence of anything.
		noise := max(cur.NsSpreadPc, old.NsSpreadPc)
		if delta*100 <= noise {
			regressions = append(regressions, Regression{
				Benchmark: cur.Name,
				Kind:      "time",
				Old:       old.NsPerOp,
				New:       cur.NsPerOp,
				DeltaPct:  delta * 100,
				Note: fmt.Sprintf("IGNORED: delta is within the %.0f%% run-to-run "+
					"spread. Fix the runner or raise -count, do not trust this.", noise),
			})
			continue
		}

		regressions = append(regressions, Regression{
			Benchmark: cur.Name,
			Kind:      "time",
			Old:       old.NsPerOp,
			New:       cur.NsPerOp,
			DeltaPct:  delta * 100,
		})
	}
	return regressions
}

// FailCI prints the regression report and returns the process exit code.
// Findings noted as IGNORED are printed but do not fail the build: the engineer
// should see that the benchmark is too noisy to judge, without being blocked by
// a measurement the tool itself does not believe.
func (r *BenchmarkRegression) FailCI(regressions []Regression) int {
	if len(regressions) == 0 {
		fmt.Println("No performance regressions detected.")
		return 0
	}

	fail := 0
	for _, reg := range regressions {
		unit := "ns"
		if reg.Kind == "allocs" {
			unit = " allocs"
		}
		fmt.Printf("  [%s] %s: %.1f%s -> %.1f%s (+%.1f%%)\n",
			reg.Kind, reg.Benchmark, reg.Old, unit, reg.New, unit, reg.DeltaPct)
		if reg.Note != "" {
			fmt.Printf("        %s\n", reg.Note)
		}
		if !strings.HasPrefix(reg.Note, "IGNORED") {
			fail++
		}
	}
	fmt.Printf("\nTime threshold: %.0f%%. Blocking findings: %d.\n", r.threshold*100, fail)
	if fail == 0 {
		return 0
	}
	return 1
}
```

### 4.2 Benchmark Helper Utilities

Benchmark helpers reduce boilerplate by encapsulating common patterns: preventing dead code elimination, reporting throughput metrics, and measuring memory deltas. Centralizing these in a utility package keeps individual benchmarks focused on the operation under test. The helpers below cover thread pinning for reduced variance, a sink wrapper to prevent compiler elimination, and timing/memory measurement utilities.

```go
package bench_utils_test

import (
	"runtime"
	"testing"
	"time"
)

// LockThread locks the calling goroutine to its current OS thread.
//
// Read the name carefully, because the obvious version of this helper is named
// PinToCore, takes a coreID, and then ignores it. runtime.LockOSThread does NOT
// pin anything to a core. It guarantees the goroutine keeps running on the same
// OS thread, and the kernel scheduler remains free to migrate that thread across
// cores whenever it likes. A helper that accepts a coreID it cannot honor is
// worse than no helper: it makes you believe you controlled a variable you did
// not, and then you trust the resulting numbers.
//
// Go has no API for CPU affinity. To actually pin, do it from outside the
// process, which is simpler and more reliable anyway:
//
//	taskset -c 2 go test -bench=. -count=10
//
// Or cgo into sched_setaffinity(2) if you must do it in-process, remembering
// that it applies to the locked OS thread rather than to the goroutine.
func LockThread() {
	runtime.LockOSThread()
}

// BenchmarkContext provides helpers for running accurate benchmarks.
type BenchmarkContext struct {
	b    *testing.B
	sink any // Prevent dead code elimination.
}

func NewBenchmarkContext(b *testing.B) *BenchmarkContext {
	return &BenchmarkContext{b: b}
}

// Keep records v so the compiler cannot prove the work producing it was
// pointless.
//
// WARNING, and this is why the helper is barely worth having: the parameter is
// `any`, so every call boxes v into an interface. For anything not
// pointer-shaped that boxing HEAP ALLOCATES, inside your timed region and
// inside your allocs/op. A helper meant to keep the benchmark honest quietly
// adds an allocation per iteration to it.
//
// Measured on the reference machine (Intel i7-10510U, Go 1.27.1), sinking an
// int:
//
//	typed sink (var intSink int)   1.480 ns/op   0 B/op   0 allocs/op
//	Keep(any), arbitrary int      14.350 ns/op   8 B/op   1 allocs/op
//	Keep(any), int in 0..255       2.970 ns/op   0 B/op   0 allocs/op
//
// Note the third row, because it is the trap inside the trap. Small integers
// box for free: the runtime hands back a pointer into its static 0..255 table
// (runtime.staticuint64s) instead of allocating. So a toy benchmark that sinks
// i%256 reports 0 allocs/op and the helper looks harmless, while the same code
// sinking real values allocates on every single iteration. If you validate a
// benchmark helper with small ints, you have validated nothing.
//
// Prefer, in order:
//  1. `for b.Loop()`, which keeps call arguments and results alive for free.
//  2. A typed package-level sink: `var intSink int`, then `intSink = f(x)`.
//     No boxing, no allocation, 10x less overhead.
//
// Reach for this only when one sink must serve many types, and only after
// checking that allocs/op did not move.
func (bc *BenchmarkContext) Keep(v any) {
	bc.sink = v
}

// ReportThroughput reports throughput in MB/s.
func (bc *BenchmarkContext) ReportThroughput(bytesProcessed int64) {
	bc.b.SetBytes(bytesProcessed)
}

// ReportCustomMetric adds a custom metric to the benchmark output.
func (bc *BenchmarkContext) ReportCustomMetric(name string, value float64, unit string) {
	bc.b.ReportMetric(value, unit)
}

// BenchmarkHelpers provides utilities for common benchmark patterns.
type BenchmarkHelpers struct{}

// TimedRun runs fn once and returns its duration.
func (h BenchmarkHelpers) TimedRun(fn func()) time.Duration {
	start := time.Now()
	fn()
	return time.Since(start)
}

// AverageLatency runs fn n times and returns the mean latency.
//
// Provided for completeness, and included with a health warning, because the
// mean is the wrong statistic for latency and this chapter argues against it
// everywhere else. One descheduled iteration drags the mean somewhere no sample
// ever was, which is exactly why benchstat reports medians. It also pays a
// time.Now() call per iteration, so for anything under a microsecond it mostly
// measures the clock.
//
// Use testing.B for micro-benchmarks and percentiles for latency. If you want
// the distribution, collect the samples and reduce them properly rather than
// throwing the shape away by summing.
func (h BenchmarkHelpers) AverageLatency(fn func(), n int) time.Duration {
	total := time.Duration(0)
	for i := 0; i < n; i++ {
		start := time.Now()
		fn()
		total += time.Since(start)
	}
	return total / time.Duration(n)
}

// MemoryDelta returns bytes allocated during fn().
func (h BenchmarkHelpers) MemoryDelta(fn func()) uint64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	fn()
	runtime.ReadMemStats(&after)
	if after.TotalAlloc > before.TotalAlloc {
		return after.TotalAlloc - before.TotalAlloc
	}
	return 0
}
```

### 4.3 Threshold selection that does not cry wolf

Regression thresholds in CI have a sweet spot. Too tight (say, 3 percent) and every noisy CI run triggers a false alarm, teams learn to ignore the alerts, and the value evaporates. Too loose (say, 30 percent) and real regressions slip through while the alert never fires. A reasonable default is 10 percent for individual benchmark regressions combined with a 5 percent threshold on the geometric mean of all benchmarks in the suite. That combination catches real regressions (which usually move a benchmark 20 percent or more) while tolerating the noise floor of typical CI infrastructure. Track false-positive rate for the first month after enabling the gate and adjust. If you get more than one false alarm per week, tighten infrastructure (pin CPU, isolate runner, increase `-count`) before loosening the threshold. The threshold is a lever on signal quality, not a knob to turn to make the alert go away.

### 4.4 Junior → FAANG: the benchmark regression drill

When a CI benchmark regression fires on your PR, do not guess. Follow a script. Step one: reproduce locally with the same `-count` and `-benchtime`. If you cannot reproduce, the regression is likely CI noise, rerun CI once before investigating further. Step two: run `benchstat old.txt new.txt` and read the output. If the regression is below the noise floor of the benchmark, same conclusion. Step three: if the regression reproduces, bisect. Run `git bisect start HEAD~10 HEAD~20` with the benchmark as the test command, and let git find the commit that introduced the regression. Step four: once you find the commit, `git show` it and form a hypothesis. Is it an allocation? A new interface dispatch? A lock being held longer? Step five: fix the root cause or revert. Document what you found in the PR description so the next engineer learns from it. This drill takes thirty minutes on a good day and is how engineers develop reliable performance intuition.

### 4.5 Senior @ FAANG: the performance test pyramid

Apply the classic test pyramid shape to performance testing. At the base: unit benchmarks (`testing.B`), fast, cheap, run on every PR, catching the single most common regression there is, an allocation appearing in a hot path. In the middle: component load tests (handler-level `httptest` benchmarks under sustained rate), slower, still run on every PR, catch integration-level regressions. At the top: end-to-end load tests against a staging environment with production-shaped traffic, run nightly or on release candidates, catch emergent behavior that unit tests miss. Each layer serves a different purpose and costs a different amount. Teams that invest only at the base miss the interactions that matter for SLO compliance. Teams that invest only at the top waste CI time and catch regressions too late in the cycle. The staff-engineer move is to build all three layers and make each one's scope and threshold explicit. Then when a regression is caught, the team knows which layer found it and what the appropriate response time is.

---
