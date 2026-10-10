## Section 3: CPU Profiling and Optimization

### 3.1 Hardware Performance Counters

Hardware performance counters, tracked by the CPU's performance monitoring unit, measure microarchitectural events like cache misses, branch mispredictions, IPC (instructions per cycle), and TLB misses that are invisible in wall-clock profiling. The practical way to read them for a Go program is to not write any Go at all: run the binary under `perf stat`. Reading them from inside the process means the `perf_event_open` syscall, either directly or through a wrapper like `github.com/hodgesds/perf-utils`, and it usually needs a relaxed `perf_event_paranoid` setting or `CAP_PERFMON`, which is often unavailable in a container. The reference below is the interpretation layer: the `perf stat` invocations worth memorizing, and the arithmetic that turns raw counts into a verdict of CPU-bound, memory-bound, or branch-bound.

```go
package perfcounters

// Go provides pprof for CPU profiling, but for hardware-level metrics
// (cache misses, branch mispredictions, IPC), use `perf` on Linux.

// perf stat commands for Go programs:
//
// Basic metrics:
// perf stat -e cycles,instructions,cache-misses,branch-misses ./myserver
//
// Detailed cache analysis:
// perf stat -e L1-dcache-loads,L1-dcache-load-misses,LLC-loads,LLC-load-misses ./myserver
//
// Interpret results:
// instructions/cycle (IPC): Higher is better.
//   - IPC < 1.0: memory-bound (frequent cache misses)
//   - IPC 1-2: CPU-bound, moderate
//   - IPC > 2: Well-optimized (instruction-level parallelism)
//
// cache-miss rate: cache-misses / cache-references × 100%
//   - L1 miss rate > 5%: cache-unfriendly access patterns
//   - LLC miss rate > 1%: working set exceeds L3 cache
//
// branch-miss rate: branch-misses / branches × 100%
//   - > 2%: consider sorting data or using lookup tables

// PerfMetrics holds counter values collected elsewhere: parsed from `perf stat`
// output, or read via perf_event_open(2). Populating it is the easy part and is
// deliberately out of scope here. Knowing what the ratios mean is the part that
// makes the numbers useful, so that is what this type encodes.
type PerfMetrics struct {
	Cycles          uint64
	Instructions    uint64
	CacheReferences uint64
	CacheMisses     uint64
	BranchMisses    uint64
	BranchPredicts  uint64
}

// IPC returns Instructions Per Cycle.
func (m PerfMetrics) IPC() float64 {
	if m.Cycles == 0 {
		return 0
	}
	return float64(m.Instructions) / float64(m.Cycles)
}

// CacheMissRate returns L3 cache miss rate (0.0 - 1.0).
func (m PerfMetrics) CacheMissRate() float64 {
	if m.CacheReferences == 0 {
		return 0
	}
	return float64(m.CacheMisses) / float64(m.CacheReferences)
}

// BranchMissRate returns branch misprediction rate (0.0 - 1.0).
func (m PerfMetrics) BranchMissRate() float64 {
	if m.BranchPredicts == 0 {
		return 0
	}
	return float64(m.BranchMisses) / float64(m.BranchPredicts)
}

// Diagnose returns performance diagnosis and recommendations.
func (m PerfMetrics) Diagnose() []string {
	var issues []string

	if m.IPC() < 1.0 {
		issues = append(issues, "Memory-bound: IPC < 1. Improve cache access patterns (sequential access, SoA, prefetching).")
	} else if m.IPC() < 2.0 {
		issues = append(issues, "Moderate IPC. Look for memory latency in critical loops.")
	}

	if m.CacheMissRate() > 0.05 {
		issues = append(issues,
			"High cache miss rate (>5%). Check for random memory access, large working sets, or pointer chasing.")
	}

	if m.BranchMissRate() > 0.02 {
		issues = append(issues,
			"High branch misprediction (>2%). Sort data before filtering, use lookup tables, or branchless techniques.")
	}

	if len(issues) == 0 {
		issues = append(issues, "CPU metrics look healthy.")
	}
	return issues
}
```

### 3.2 Inlining and Escape Analysis

Go's compiler inlines small functions automatically, eliminating call overhead and enabling further optimizations like constant folding across the call boundary. Functions that are too large, call `recover`, or are marked `//go:noinline` are excluded. Escape analysis determines whether a variable can be stack-allocated: variables that don't outlive the function, don't have their address passed to non-inlined functions, and don't implement interface methods typically stay on the stack. The tooling below uses `go build -gcflags='-m=2'` to show inlining decisions and escape analysis results, and demonstrates how to restructure code to keep hot-path allocations on the stack.

```go
package inlining

import (
	"fmt"
	"io"
)

// Go inlines small functions automatically.
// A function is NOT inlined if:
// 1. Its inline cost exceeds the budget (80 by default). Cost is not a node
//    count: the compiler assigns a weight per operation and sums them. PGO
//    raises the budget for call sites the profile marks as hot.
// 2. It contains a defer, a go statement, or a call to recover.
// 3. It is marked //go:noinline (in any package, including its own).
//
// Note what is NOT on that list: calling a non-inlinable function. Mid-stack
// inlining means a function that calls an un-inlinable callee is still itself
// inlinable, the call just adds to its cost. Verified on Go 1.27 with -m=2:
//
//   //go:noinline
//   func nope(a int) int { return a * 2 }
//   func callsNoinline(a int) int { return nope(a) + 1 }
//   // → "can inline callsNoinline with cost 63"

// Verify inlining decisions, including the cost the compiler computed:
// go build -gcflags="-m=2" ./... 2>&1 | grep "can inline"
// The inverse (why something did not inline) is on the same output:
// go build -gcflags="-m=2" ./... 2>&1 | grep "cannot inline"

// Trivially inlinable. -m=2 reports "can inline add with cost 4".
func add(a, b int) int {
	return a + b
}

// Heavier. The fmt calls dominate the cost, and each error path adds more.
// Splitting the validation out from the formatting lets the hot path (valid
// input, no error) inline while the cold error construction stays a real call.
func processItem(id int, name string, value float64) (result string, err error) {
	if id <= 0 {
		return "", fmt.Errorf("invalid id: %d", id)
	}
	if name == "" {
		return "", fmt.Errorf("empty name")
	}
	// ... more logic ...
	return fmt.Sprintf("%s:%f", name, value), nil
}

// go:nosplit prevents the compiler from inserting a stack growth check.
// It does NOT force inlining. It removes the stack-split prologue, which is a
// compare and a rarely-taken branch, so the saving is a couple of instructions
// and not something you will see outside a very tight leaf call. Getting it
// wrong overflows the goroutine's stack red zone, so the risk/reward is bad
// almost everywhere. The runtime uses it. Application code should not.
//
//go:nosplit
func fastAdd(a, b int64) int64 {
	return a + b
}

// Prevent inlining. Useful for:
// 1. Functions that must appear in stack traces for debugging
// 2. Benchmarks where you don't want the call to be optimized away
//
//go:noinline
func doWorkForBench(n int) int {
	return n * n
}

// EscapeAnalysis: understanding which variables escape to heap.
// Check with: go build -gcflags="-m" ./...
// Every annotation below is the compiler's actual output on Go 1.27/amd64,
// not a guess. Run the command and read what it says, always.

// No allocation at all. An int is returned by value in a register.
// There is nothing here to place on any heap, which is worth saying plainly:
// "does not escape" and "is allocated on the stack" are not the same claim.
func noEscape() int {
	x := 42
	return x
}

// Escapes. The compiler prints: "moved to heap: x".
// The caller holds a reference that outlives this frame, so x cannot live in a
// frame that is about to be popped.
func doesEscape() *int {
	x := 42
	return &x
}

// Escapes. The compiler prints: "val escapes to heap".
// Assigning an int into a map[string]any boxes it, and the box outlives the call.
func storesInMap(m map[string]any, key string, val int) {
	m[key] = val
}

// Does not escape. The compiler says nothing about val at all: it is an int
// copied into the map's storage, with no box to allocate.
func noEscapeMap(m map[string]int, key string, val int) {
	m[key] = val
}

// The compiler prints: "leaking param: data", which is a weaker statement than
// "escapes to heap". It means the callee may retain data, so escape analysis
// gives up on it here and pushes the decision to whoever built the backing
// array. If the caller allocated data locally and only ever passed it here,
// the caller's allocation is what gets moved to the heap. This is the usual
// reason a buffer you "obviously" stack-allocated shows up in a heap profile.
func callsInterface(w io.Writer, data []byte) {
	w.Write(data)
}

// Bounds check elimination: the compiler can sometimes prove an index is in
// range and drop the check. See which checks survive with:
// go build -gcflags="-d=ssa/check_bce/debug=1" ./...
// It prints one line per bounds check the compiler could NOT eliminate.
// Silence is the good outcome.

// Bounds-checked. n and len(s) are unrelated as far as the compiler knows,
// so it cannot prove i < len(s). Output: "Found IsInBounds" on the s[i] line.
func sumChecked(s []int, n int) int {
	sum := 0
	for i := 0; i < n; i++ {
		sum += s[i] // Bounds check on every iteration.
	}
	return sum
}

// Check-free. range derives the index from len(s) itself, so there is nothing
// to prove. check_bce prints nothing for this function.
func sumRange(s []int) int {
	sum := 0
	for _, v := range s {
		sum += v
	}
	return sum
}

// Check-free in the loop. Reslicing ties the length to n once, up front.
// check_bce reports a single "Found IsSliceInBounds" on the s[:n] line: the
// per-iteration check became one check outside the loop. That trade, N checks
// down to one, is the whole point, and it is why this pattern is worth knowing
// even though the loop body looks identical to sumRange.
func sumResliced(s []int, n int) int {
	if n > len(s) {
		panic("n out of bounds")
	}
	s = s[:n]
	sum := 0
	for _, v := range s {
		sum += v
	}
	return sum
}
```

### 3.2.1 Profile-Guided Optimization (PGO)

Profile-guided optimization, generally available since Go 1.21, feeds a representative production CPU profile back into the compiler so it can make better decisions on the paths that are actually hot. Be precise about what PGO does, because that scoping is what makes its numbers believable: it raises the inline budget for hot call sites and it devirtualizes hot interface calls. That is the whole mechanism. It does not change the allocator, it does not tune the GC, and it will not rescue a bad algorithm.

The honest range from the Go team's benchmark corpus and public deployments is **2 to 14 percent** CPU reduction:

- **Typical workloads**: low single digits. Call-heavy code with a dominant concrete type at an interface call site sits at the top of the range.
- **Uber**: single-digit-percent CPU reductions across top services from their fleet-wide rollout, which is worth a lot of cores at their scale.
- **Datadog**: up to 14 percent in production agents.

You will see material quoting 15 to 20 percent. That is cherry-picked from the friendliest possible hot-path case. Budget a few percent for planning and treat anything more as a bonus. A code path with no interface dispatch and no hot call sites should be expected to gain nothing, and that is not a misconfiguration.

The workflow is:

```bash
# 1. Collect a representative profile from production (30 seconds is enough).
curl -o default.pgo http://prod-host:6060/debug/pprof/profile?seconds=30

# 2. Place default.pgo in the main package directory, next to main.go.
#    The compiler picks it up automatically. No build flag needed.

# 3. Build with PGO enabled (default since Go 1.21 when default.pgo is present).
go build ./cmd/myserver

# 4. Verify PGO was actually applied. Easiest check: the build records the
#    profile it used, so ask the binary.
go version -m ./myserver | grep pgo
#    → build -pgo=/path/to/default.pgo

#    To see the decisions themselves, use the PGO debug flag. Note that these
#    messages are gated on pgodebug, NOT on -m=2, so grepping -m=2 output for
#    "PGO" prints nothing whether or not PGO ran. Use a clean cache, since a
#    cached package is not recompiled and therefore prints nothing either.
go clean -cache && go build -gcflags="-d=pgodebug=1" ./cmd/myserver 2>&1 | head
#    → hot-callsite-thres-from-CDF=48.83...
#    → hot-node enabled increased budget=2000 for func=main.total
#    That budget line is PGO working: the inline budget for a hot function goes
#    from the default 80 to 2000, which is why hot call chains suddenly flatten.

# 5. Benchmark before/after with benchstat.
```

> **Senior track**: PGO's biggest wins come from devirtualization. If your hot loop dispatches through an interface whose concrete type is dominant in production (say, `*jsonEncoder` 95 percent of the time), PGO turns the indirect call into a direct call plus a guard. That single change unlocks inlining and often 5 to 10 percent on its own. To maximize impact, ensure your collected profile covers real traffic shape. A profile taken under synthetic load rarely reflects the call distribution that matters.

### 3.3 CPU Flame Graph Analysis

CPU flame graphs visualize the call stack distribution of sampled profiling data, making it immediately apparent which call chains consume the most CPU and how they relate to the program's entry points. Reading one correctly turns on a single distinction. A frame's width is its *cumulative* time, meaning the samples taken anywhere inside it or its children. Its *self* time is the part of that width not covered by any child sitting on top of it. A wide frame with an equally wide child is not doing the work, it is only on the path to whatever is. So the optimization targets are the wide plateaus at the *top* of the stack, where width stops being handed down to a child, because that is where the CPU actually went. The workflow below collects a 30-second CPU profile with `pprof` and renders it with `go tool pprof -http=:8080`.

```go
package flamegraph

// Flame graph interpretation guide (documentation).
//
// A CPU flame graph (from pprof) shows:
// X-axis: proportion of CPU time (wider = more CPU). NOT time order.
// Y-axis: call stack depth (bottom = entry point, top = what was running).
// Color: in `go tool pprof -http`, the flame graph colors frames by package,
//        so runtime frames are easy to pick out. (Brendan Gregg's original
//        flamegraph.pl randomizes hue instead. Do not read meaning into it.)
//
// A worked example. The percentages are cumulative, so a parent's share
// includes everything stacked above it:
//
//  runtime.goexit
//  └── net/http.(*Server).Serve
//      └── net/http.(*conn).serve            ← 80% cumulative
//          ├── encoding/json.Marshal          ← 35% cumulative
//          │   └── encoding/json.(*encodeState).marshal
//          │       └── reflect.Value.Field
//          │           └── runtime.mallocgc   ← 15%, allocation under reflect
//          ├── my/app.(*Handler).ServeHTTP    ← 25% cumulative
//          │   └── my/app.queryDB
//          │       └── database/sql.(*DB).QueryContext
//          └── runtime.gcBgMarkWorker         ← 20%, GC mark workers

// What this graph is telling you, in priority order:
//
// 1. gcBgMarkWorker at 20% is the loudest signal, and it is a SYMPTOM, not a
//    target. You cannot optimize the mark worker. It is wide because something
//    is allocating. Note that mallocgc under json is 15%: the allocation and
//    the GC cost of that allocation are the same root cause counted twice, in
//    two different places on the graph. Fixing the allocation shrinks both.
//    This is the single most common flame graph misreading.
//
// 2. The json.Marshal → reflect → mallocgc chain is where to actually look.
//    Reflection-based marshaling allocates per field. Code-generated marshalers
//    (easyjson, or hand-written MarshalJSON) remove the reflect walk.
//    Do not expect a miracle: swapping JSON encoders is routinely measured at
//    well under 2x on realistic payloads, not the order of magnitude the
//    benchmarks in those projects' READMEs suggest. Measure YOUR payloads.
//
// 3. my/app.queryDB at 25% is mostly database/sql. If it is wide but its
//    children are just as wide all the way up, that is waiting, not burning.
//    A CPU profile only samples running goroutines, so time blocked on the DB
//    does not appear here at all. Reach for a block or mutex profile instead.

// ProfileResult represents a simplified flame graph entry.
type ProfileEntry struct {
	Function string
	File     string
	Line     int
	CPUPct   float64
	Children []*ProfileEntry
}

// TopHotspots returns the top N CPU consumers from a profile.
func TopHotspots(root *ProfileEntry, n int) []*ProfileEntry {
	var all []*ProfileEntry
	collectAll(root, &all)

	// Sort by CPUPct descending.
	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && all[j].CPUPct > all[j-1].CPUPct; j-- {
			all[j], all[j-1] = all[j-1], all[j]
		}
	}

	return all[:min(n, len(all))]
}

func collectAll(e *ProfileEntry, result *[]*ProfileEntry) {
	if e == nil {
		return
	}
	*result = append(*result, e)
	for _, child := range e.Children {
		collectAll(child, result)
	}
}
```

### 3.4 Distinguishing CPU-bound from memory-bound at a glance

The single most useful diagnostic question in performance work is: am I CPU-bound or memory-bound? They look identical in wall-clock profiling, but require opposite interventions. The quick answer comes from one `perf stat` command:

```bash
perf stat -e cycles,instructions,cache-references,cache-misses,L1-dcache-load-misses ./binary
```

Calculate IPC (instructions / cycles). If IPC is above 2.0, you are CPU-bound on real work, so optimize the algorithm or parallelize. If IPC is below 1.0, you are memory-bound, so look at cache miss rate and access patterns. If IPC is between 1.0 and 2.0, you are likely branch-bound or have mixed behavior, check branch-miss rate next. On modern Intel and AMD server parts, a well-optimized numeric loop should hit IPC 3 to 4. A cache-friendly business logic loop typically lands at 2 to 3. A pointer-chasing loop through a large hash map can sit below 0.5. The IPC number alone reveals more than any flame graph on memory-bound workloads.

### 3.5 Junior → FAANG: the `perf stat` drill worth repeating

Take any Go benchmark you have written. Build it into a standalone binary (`go test -c`) and run:

```bash
perf stat -e cycles,instructions,cache-misses,branch-misses ./bench.test -test.bench=. -test.benchtime=10s
```

Record the four numbers. Now change the code (flatten a struct, sort the input, add `sync.Pool`, whatever matches the chapter). Rerun. Record the delta. After five iterations on five different benchmarks, you will have a personal mental library of what each intervention buys on which workload. Interviewers for infrastructure roles at Google, Meta, AWS, Apple, and Netflix routinely ask "describe a time you optimized CPU performance." Having a library of five real benchmarks with before/after counter deltas is worth more than any book chapter.

### 3.6 Senior @ FAANG: the PGO rollout as a platform project

PGO is a team-level optimization, not a service-level one. The largest gains come from automating profile collection and rebuild across the fleet, not from manually collecting a profile for one service. The staff-engineer artifact is a platform rollout plan: (1) a shared tool that samples production profiles at a fixed cadence and stores them in object storage. (2) a CI pipeline that pulls the latest profile and rebuilds with PGO automatically. (3) a regression-detection gate that rejects builds where PGO unexpectedly loses performance (rare but does happen, particularly if the profile is stale or captured during a pathological load). (4) documentation that tells service owners how to opt in and what to expect. Services that opt in see 2 to 7 percent CPU reduction on average, which at fleet scale buys significant cores. Uber, Google, and Meta all run something like this internally. Outside those companies, the tooling is less mature, but the design is the same. Owning the rollout is a high-impact cross-cutting project that demonstrates exactly the kind of platform thinking staff engineers are evaluated on.

---
