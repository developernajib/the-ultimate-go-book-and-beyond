## Section 1: Tri-Color Mark-and-Sweep GC

### 1.1 The Algorithm

Go's GC uses **tri-color concurrent mark-and-sweep**:

- **White**: not yet visited, a candidate for collection
- **Grey**: reachable from roots but children not yet scanned
- **Black**: fully scanned, will not be collected

**Invariant**: A black object must never point directly to a white object (strong tri-color invariant). If it does, the white object would be incorrectly collected.

**Write Barrier**: Maintained during concurrent marking. When a goroutine stores a pointer, the write barrier ensures the referenced object is shaded gray. Go uses a **hybrid write barrier** (since Go 1.8) that combines a Dijkstra insertion barrier with a Yuasa deletion barrier. This is what makes concurrent GC safe while goroutines continue running and also eliminates the need for a STW stack rescan at mark termination.

> **Senior track**: Green Tea (Go 1.26 default) does not change any of this. It restructures how mark work is found and batched, scanning span by span rather than object by object, which improves locality during marking. The tri-color invariant and the hybrid write barrier are identical, and allocation speed is untouched. See the Green Tea file at the end of the chapter.

```go
package gc_internals

import (
	"runtime"
	"time"
	"unsafe"
)

// GCPhase represents the current GC phase.
type GCPhase int

const (
	GCOff         GCPhase = 0 // No GC running
	GCMarkSetup   GCPhase = 1 // STW: enable write barriers, root scan setup
	GCMark        GCPhase = 2 // Concurrent: mark reachable objects
	GCMarkTerm    GCPhase = 3 // STW: finalize marking
	// Sweep happens concurrently after mark termination.
)

// GCStats captures a snapshot of GC state.
type GCStats struct {
	NumGC         uint32
	PauseTotalNs  uint64
	PauseNs       [256]uint64 // Circular buffer of recent pause times.
	LastGCTime    time.Time
	NextGCBytes   uint64 // Heap size that will trigger next GC.
	HeapAlloc     uint64 // Currently allocated heap bytes.
	HeapSys       uint64 // Total heap memory obtained from OS.
	HeapInuse     uint64 // Heap bytes in non-idle spans.
	HeapIdle      uint64 // Heap bytes in idle spans.
	HeapReleased  uint64 // Heap bytes returned to OS.
	HeapObjects   uint64 // Number of allocated objects.
	StackInuse    uint64 // Bytes used by goroutine stacks.
	MSpanInuse    uint64 // Bytes used by mspan structures.
	MCacheInuse   uint64 // Bytes used by mcache structures.
	GCSys         uint64 // Bytes used by GC metadata.
	AllocRate     float64 // Bytes allocated per second.
}

// CollectGCStats gathers comprehensive GC statistics.
func CollectGCStats() GCStats {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	stats := GCStats{
		NumGC:        ms.NumGC,
		PauseTotalNs: ms.PauseTotalNs,
		PauseNs:      ms.PauseNs,
		LastGCTime:   time.Unix(0, int64(ms.LastGC)),
		NextGCBytes:  ms.NextGC,
		HeapAlloc:    ms.HeapAlloc,
		HeapSys:      ms.HeapSys,
		HeapInuse:    ms.HeapInuse,
		HeapIdle:     ms.HeapIdle,
		HeapReleased: ms.HeapReleased,
		HeapObjects:  ms.HeapObjects,
		StackInuse:   ms.StackInuse,
		MSpanInuse:   ms.MSpanInuse,
		MCacheInuse:  ms.MCacheInuse,
		GCSys:        ms.GCSys,
	}

	return stats
}

// RecentGCPauses returns the last N pause durations in descending order.
func RecentGCPauses(n int) []time.Duration {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	pauses := make([]time.Duration, 0, n)
	// PauseNs is a circular buffer. The most recent entry sits at
	// index (NumGC+255)%256.
	for i := 0; i < n && i < 256; i++ {
		idx := (int(ms.NumGC) + 255 - i) % 256
		pause := time.Duration(ms.PauseNs[idx])
		if pause == 0 {
			break
		}
		pauses = append(pauses, pause)
	}
	return pauses
}

// ForceGCAndMeasure triggers a GC cycle and measures its duration.
// Only use for diagnostics, never in production hot paths.
func ForceGCAndMeasure() time.Duration {
	before := CollectGCStats()
	runtime.GC()
	after := CollectGCStats()

	if after.NumGC > before.NumGC {
		idx := (int(after.NumGC) + 255) % 256
		return time.Duration(after.PauseNs[idx])
	}
	return 0
}

// WriteBarrierCost demonstrates why write barriers matter.
// With the write barrier enabled (during concurrent mark),
// every pointer store has additional overhead.
//
// Pseudo-code of what happens on "p.field = val":
//
//	if writeBarrier.enabled {
//	    // Shade the old and new referents into the barrier buffer.
//	    gcWriteBarrier(ptr, val)
//	}
//	p.field = val
//
// The cost shape, not a fixed number: when the GC is off, the check is a
// predictable load-and-branch that costs close to nothing. When marking is
// on, the store also buffers pointers for the GC to drain. Do not trust any
// specific nanosecond figure you read for this, including one in a book.
// It depends on the CPU, the barrier buffer state, and what fraction of the
// cycle is actually spent marking. Measure your own workload with a heap
// profile plus GODEBUG=gctrace=1 and compare GC CPU across designs.
//
// The actionable rule is structural and does not need a benchmark: fields of
// non-pointer type never go through the barrier at all. A []Point of structs
// does zero barrier work on write, while a []*Point does barrier work on
// every element store. Pointer-sparse layouts cut both barrier work and
// mark scan work at the source.

// avoid import errors
var _ = unsafe.Pointer(nil)
```

### 1.2 GC Tuning Parameters

`GOGC` controls the ratio between live heap at the last GC cycle and the heap size that triggers the next one, defaulting to 100 percent growth. Lowering it to 50 roughly doubles GC frequency and cuts the heap headroom, trading memory for GC CPU. `GOMEMLIMIT` (introduced in Go 1.19) is a **soft** memory limit: when the total runtime-managed footprint approaches it, the runtime runs GC more aggressively to stay under it. It is not a hard cap. If live memory genuinely exceeds the limit, the process keeps allocating rather than crashing, and the pacer burns CPU trying to keep up.

Two operational facts about `GOMEMLIMIT` deserve more attention than they usually get.

**It is not container-aware.** `GOMAXPROCS` has read the cgroup CPU quota since Go 1.25, and people reasonably assume its memory counterpart does the same. It does not. As of 1.27.1, `GOMEMLIMIT` defaults to `math.MaxInt64`, meaning effectively off, no matter what the cgroup memory limit says. There is an open proposal to change this. Until it lands, you set the limit yourself from the cgroup value, typically at 80 to 90 percent of it, leaving the cgroup limit above as the real OOM ceiling.

**The death spiral.** The failure mode to understand before you deploy it: if the live heap grows to near `GOMEMLIMIT`, the pacer cannot reach its goal no matter how often it runs, so it runs continuously, and the service spends most of its CPU on GC while making almost no progress. It never OOMs, it just stops doing useful work, which is arguably worse because a crash at least restarts and pages someone. The Go GC guide is explicit that this is the reason `GOMEMLIMIT` should not be treated as a substitute for capacity planning. This is also why the common advice to set `GOGC=off` alongside `GOMEMLIMIT` is only safe when you control the live heap and have real headroom under the limit. With `GOGC` left on, the ratio-based trigger still fires normally well below the limit, and the limit acts only as the backstop it was designed to be. Leaving `GOGC` on is the right default for most services.

The code below shows how to express these trade-offs as named policies.

```go
package gc_tuning

import (
	"runtime/debug"
)

// GCPolicy represents a GC tuning strategy.
type GCPolicy int

const (
	// PolicyDefault: GOGC=100, the baseline. GC triggers when the heap has
	// grown 100% above the live set measured at the end of the last cycle.
	PolicyDefault GCPolicy = iota

	// PolicySmallFootprint: GC more often, keep the heap small.
	// Buys RSS, costs GC CPU. Note it does not buy shorter STW pauses,
	// which are already sub-millisecond. What it can reduce is the mark
	// assist latency charged to allocating goroutines, because each cycle
	// has less to mark.
	PolicySmallFootprint

	// PolicyHighThroughput: GC less often, higher memory usage.
	// Buys GC CPU (fewer cycles, fewer assists), costs RSS.
	// Use for batch processing and short-lived services.
	PolicyHighThroughput

	// PolicyMemoryConstrained: hold a footprint ceiling on a small machine.
	// GOMEMLIMIT is the backstop. GOGC stays on deliberately, see the
	// death spiral discussion above.
	PolicyMemoryConstrained
)

// ApplyPolicy configures GC based on the deployment scenario.
func ApplyPolicy(policy GCPolicy, totalRAMBytes int64) {
	switch policy {
	case PolicySmallFootprint:
		// Less heap headroom means less to mark per cycle and less
		// assist work charged to allocating goroutines.
		// Tradeoff: GC runs more often, so total GC CPU goes up.
		debug.SetGCPercent(50) // GC when heap grows 50% above live size.
		// Limit to 40% of RAM to leave headroom.
		debug.SetMemoryLimit(totalRAMBytes * 40 / 100)

	case PolicyHighThroughput:
		// More headroom means fewer cycles and less total GC CPU.
		// Tradeoff is RSS, not pause length. STW pauses do not grow
		// with the heap, the concurrent mark phase does.
		debug.SetGCPercent(400) // GC when heap grows 4x above live size.
		debug.SetMemoryLimit(totalRAMBytes * 85 / 100)

	case PolicyMemoryConstrained:
		// GOMEMLIMIT is the ceiling. GOGC stays at 100 on purpose so the
		// ratio trigger keeps firing below the limit instead of letting
		// the limit become the only trigger, which is how services
		// death-spiral.
		debug.SetGCPercent(100)
		debug.SetMemoryLimit(totalRAMBytes * 70 / 100)

	default: // PolicyDefault
		debug.SetGCPercent(100)
		// Keep default GOMEMLIMIT (no override).
	}
}

// There is deliberately no GCPauseTarget function here.
//
// A "set GOGC from a target pause duration" helper is a tempting API and it
// appears in a lot of blog posts, but it encodes a false model of the Go GC,
// so it is worth spelling out why it is absent.
//
// Go's collector is concurrent. It stops the world twice per cycle, at sweep
// termination and at mark termination, and both are bounded work that does
// not scale with the size of your heap. Since the hybrid write barrier landed
// in Go 1.8 there is no stop-the-world stack rescan, which was the last part
// of the pause that grew with the program. Raising GOGC from 100 to 400 makes
// the concurrent mark phase longer in wall-clock terms, and it does not make
// your STW pauses four times longer.
//
// So GOGC is not a pause dial. GOGC is the dial between heap footprint and
// GC CPU. If your p99 moves when you change GOGC, the mechanism is almost
// never pause duration. It is mark assist, the GC charging mark work to the
// goroutine that is allocating, which shows up as latency inside the request
// that happened to be allocating at the wrong moment.
//
// That distinction changes the fix. If the assists are what hurt, more heap
// headroom (higher GOGC) gives the background workers more time to finish
// marking before the mutators catch up, so raising GOGC can improve p99 while
// costing memory. Allocating less improves it without costing memory. Reach
// for the second one first.
//
// The right way to hold a latency target is to measure, not to map a duration
// onto a percentage:
//
//	GODEBUG=gctrace=1 for the shape of each cycle.
//	/gc/pauses:seconds from runtime/metrics for the real STW distribution.
//	/cpu/classes/gc/total:cpu-seconds for what GC actually costs you.
//	A CPU profile to find the allocation sites feeding the assists.

// DisableGC disables the garbage collector.
// ONLY use for performance testing or very short-lived processes.
// In production, always use GOMEMLIMIT instead.
func DisableGC() {
	debug.SetGCPercent(-1) // Disables GC entirely.
	// WARNING: Memory will grow unbounded. OOM will kill the process.
}

// MemoryLimitStrategy recommends a GOMEMLIMIT based on machine configuration.
type MemoryLimitStrategy struct {
	TotalRAM        int64
	OtherProcessRAM int64 // RAM used by OS, sidecar containers, etc.
	HeadroomPct     int   // % to leave as headroom for stack/mheap overhead.
}

func (s MemoryLimitStrategy) Recommend() int64 {
	available := s.TotalRAM - s.OtherProcessRAM
	limit := available * int64(100-s.HeadroomPct) / 100
	return limit
}

// Example configurations:
//
// Kubernetes pod (2GB limit):
//   TotalRAM=2GB, OtherProcessRAM=200MB (sidecar+OS), HeadroomPct=15
//   → Limit = (2GB - 200MB) × 0.85 = 1.53GB
//
// Bare metal (64GB):
//   TotalRAM=64GB, OtherProcessRAM=4GB, HeadroomPct=10
//   → Limit = (64GB - 4GB) × 0.90 = 54GB
```

### 1.3 Finalizers and WeakReferences

Finalizers in Go allow cleanup of resources (C memory, file descriptors, OS handles) when the GC collects an object, but their use is fraught. They delay collection by one GC cycle, execute in an arbitrary goroutine, and cannot be guaranteed to run before process exit. Go 1.24 introduced **weak pointers** via the `weak` standard-library package: `weak.Make[T](ptr *T) weak.Pointer[T]` creates a weak reference, and `wp.Value()` returns the strong pointer if the target is still alive or `nil` if it has been collected. Weak pointers are the correct primitive for caches and interning tables, they do not prevent GC of the target and do not suffer from the finalizer-delay pathology. Go 1.24 also added `runtime.AddCleanup`, a replacement for `runtime.SetFinalizer` that does not resurrect the object and can be registered multiple times per object. The examples below show a correct cleanup pattern for C resources and a weak-pointer intern cache.

```go
package gc_finalizer

import (
	"runtime"
	"sync"
	"time"
)

// FileResource demonstrates the classic SetFinalizer safety-net pattern.
// It is shown because you will meet it in existing code and in interviews.
// In new code on Go 1.24 or later, use runtime.AddCleanup instead, see the
// end of this file. Finalizers run when the GC finds an object unreachable,
// and are NOT guaranteed to run on process exit.
type FileResource struct {
	path   string
	handle uintptr // OS file descriptor
	closed bool
	mu     sync.Mutex
}

// NewFileResource creates a resource with a GC finalizer as a safety net.
// The finalizer closes the resource if Close() was never called.
// IMPORTANT: a finalizer is a last resort. Always call Close() explicitly.
func NewFileResource(path string) (*FileResource, error) {
	// Open file (simplified, real code uses os.Open).
	f := &FileResource{path: path, handle: 1}

	// Register the finalizer, which runs once f becomes unreachable.
	// WARNING: the finalizer keeps the object from being freed in the
	// cycle that detects it, adding at least one extra cycle of delay.
	runtime.SetFinalizer(f, func(r *FileResource) {
		r.mu.Lock()
		defer r.mu.Unlock()
		if !r.closed {
			// Log warning: resource leaked.
			r.closeInternal()
		}
	})
	return f, nil
}

// Close explicitly closes the resource and removes the finalizer.
func (f *FileResource) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.closeInternal()
	// Clearing the finalizer lets the object be collected in the first
	// cycle that finds it unreachable, with no extra delay.
	runtime.SetFinalizer(f, nil)
}

func (f *FileResource) closeInternal() {
	// syscall.Close(int(f.handle)) in real code.
	f.closed = true
}

// FinalizerPitfalls documents common finalizer mistakes.
// This is documentation only, not executable.
func FinalizerPitfalls() {
	/*
	   PITFALL 1: Finalizers do not run on "the GC goroutine". The runtime
	   runs them sequentially on one dedicated goroutine (runfinq). Two
	   consequences follow. A panic there crashes the program with no
	   recovery possible, and one slow or blocking finalizer stalls every
	   other pending finalizer in the process, because they share that
	   single goroutine.

	   PITFALL 2: Finalizer order is not guaranteed. If A points to B,
	   A's finalizer may run before or after B's finalizer.

	   PITFALL 3: An object with a finalizer needs at least two GC cycles
	   to be reclaimed. The first cycle finds it unreachable and queues the
	   finalizer, and only a later cycle can free the memory. Anything the
	   object still points to stays alive that whole time.

	   PITFALL 4: Finalizers are not called if the program exits via
	   os.Exit(), or on normal return from main. Use defer plus explicit
	   cleanup for correctness.

	   PITFALL 5: A reference cycle whose members have finalizers is not
	   guaranteed to be collected at all, because the runtime has no
	   correct order in which to run them.

	   BEST PRACTICE: Since Go 1.24, prefer runtime.AddCleanup. It fixes
	   the resurrection problem, allows multiple registrations, and does
	   not have the cycle pathology of PITFALL 5. Either way, cleanup on
	   GC is a backstop that reports a bug, not a resource management
	   strategy. Explicit Close, called from a defer, is the strategy.
	*/
}

// WeakCache uses Go 1.24+ weak.Pointer. Entries do not keep values alive,
// so the GC can reclaim cached values the moment the application drops its
// last strong reference. Dead entries are removed lazily on Load.
//
// This is the idiomatic pattern since Go 1.24. Do NOT reimplement weakness
// with SetFinalizer, it delays collection and is race-prone.
//
// import "weak"
//
// type WeakCache[K comparable, V any] struct {
//     mu      sync.Mutex
//     entries map[K]weak.Pointer[V]
// }
//
// func NewWeakCache[K comparable, V any]() *WeakCache[K, V] {
//     return &WeakCache[K, V]{entries: make(map[K]weak.Pointer[V])}
// }
//
// func (c *WeakCache[K, V]) Store(key K, val *V) {
//     c.mu.Lock()
//     defer c.mu.Unlock()
//     c.entries[key] = weak.Make(val)
// }
//
// func (c *WeakCache[K, V]) Load(key K) (*V, bool) {
//     c.mu.Lock()
//     defer c.mu.Unlock()
//     wp, ok := c.entries[key]
//     if !ok {
//         return nil, false
//     }
//     v := wp.Value()
//     if v == nil {
//         // Target was collected. Evict the stale entry.
//         delete(c.entries, key)
//         return nil, false
//     }
//     return v, true
// }
//
// For resource cleanup prefer runtime.AddCleanup over SetFinalizer:
//
//   func NewResource() *Resource {
//       r := &Resource{handle: openNative()}
//       runtime.AddCleanup(r, func(h uintptr) { closeNative(h) }, r.handle)
//       return r
//   }
//
// AddCleanup does not resurrect the object, supports multiple registrations,
// and the cleanup callback receives a value captured at registration time,
// so it cannot accidentally keep the object alive through a pointer capture.

// GCBenchmark measures GC pause time as a fraction of wall-clock time,
// plus the allocation rate that drives it.
//
// Read GCPausePct for what it is. It is STW pause time over wall time, not
// GC CPU. On a concurrent collector that number is usually tiny even when
// GC is eating a quarter of your cores, so it is the wrong number to tune
// against on its own. For real GC CPU cost, read
// /cpu/classes/gc/total:cpu-seconds from runtime/metrics, and note that
// ReadMemStats itself briefly stops the world, so do not call it on a hot
// path or in a tight polling loop.
type GCBenchmark struct {
	startStats runtime.MemStats
	startTime  time.Time
}

func (b *GCBenchmark) Start() {
	runtime.ReadMemStats(&b.startStats)
	b.startTime = time.Now()
}

func (b *GCBenchmark) Stop() GCReport {
	var endStats runtime.MemStats
	runtime.ReadMemStats(&endStats)
	elapsed := time.Since(b.startTime)

	gcCycles := endStats.NumGC - b.startStats.NumGC
	gcPauseTotal := time.Duration(endStats.PauseTotalNs - b.startStats.PauseTotalNs)
	allocBytes := endStats.TotalAlloc - b.startStats.TotalAlloc

	return GCReport{
		GCCycles:     gcCycles,
		GCPauseTotal: gcPauseTotal,
		GCPausePct:   float64(gcPauseTotal) / float64(elapsed) * 100,
		AllocBytes:   allocBytes,
		AllocRate:    float64(allocBytes) / elapsed.Seconds(),
		Elapsed:      elapsed,
	}
}

type GCReport struct {
	GCCycles     uint32
	GCPauseTotal time.Duration
	GCPausePct   float64 // % of wall time spent in GC pause
	AllocBytes   uint64
	AllocRate    float64 // bytes/second
	Elapsed      time.Duration
}
```

### 1.4 Reading a `gctrace=1` line from first principles

Set `GODEBUG=gctrace=1` and every GC cycle prints one line to stderr. Learn the format and you can triage 80 percent of GC incidents from the log alone. A typical line:

```
gc 42 @15.634s 2%: 0.018+4.1+0.008 ms clock, 0.14+2.3/3.9/0.27+0.064 ms cpu, 112->115->58 MB, 116 MB goal, 0 MB stacks, 0 MB globals, 8 P
```

Field by field. `gc 42` is the cycle number. `@15.634s` is elapsed since program start. `2%` is the cumulative fraction of CPU time spent in GC since start (watch this number, above 10 percent is a smell and above 25 percent is a fire). `0.018+4.1+0.008 ms clock` is the wall-clock duration of STW sweep termination, concurrent mark and scan, and STW mark termination. `0.14+2.3/3.9/0.27+0.064 ms cpu` is the same phases in CPU time, with the mark middle broken into assist, dedicated background, and idle. `112->115->58 MB` is the heap size at the start of marking, the heap size at the end of marking, and the **live** heap after marking. That last number is the one the next goal is computed from, and it is not "after sweep," sweeping only returns memory that marking already proved dead. `116 MB goal` is the target heap size for the next cycle, driven by `GOGC` and `GOMEMLIMIT`. `0 MB stacks` and `0 MB globals` are the scannable root sizes, and `8 P` is `GOMAXPROCS`.

Read the line as a relationship, not as isolated fields. The goal is roughly the live heap times (1 + GOGC/100), so `58 MB` live against a `116 MB goal` is exactly what GOGC=100 should produce, and seeing the goal drift far below that ratio tells you `GOMEMLIMIT` has taken over as the trigger. The gap between the second and third numbers, 115 down to 58 MB, is how much of the heap was garbage, which is your allocation churn.

Two numbers matter most in incidents. First, the two STW values in the clock column, here 0.018 ms and 0.008 ms. These are tens of microseconds and should stay there. If either is above 1 ms on a serving path that needs sub-ms p99, something is genuinely wrong and `GOGC` will not fix it, so look for enormous goroutine stacks, huge global root sets, or a pathological number of goroutines to scan. Second, the assist value in the CPU column, `2.3` in the `2.3/3.9/0.27` group. Assist time is GC work billed to your request goroutines, so it is the part of GC that lands directly in your latency percentiles. Rising assist time means the mutators are outrunning the background markers, which is an allocation-rate problem. Most "my service is GC-bound" claims turn out to be "my service allocates faster than its heap headroom absorbs," and the durable fix is at the allocation source rather than at the knobs.

### 1.5 Junior → FAANG: the write-barrier intuition interviewers probe

When an interviewer asks "what is a write barrier," a junior answer is "a hook that runs during concurrent GC." A senior answer is "it is the mechanism that makes concurrent marking correct without stopping the mutator. When a goroutine writes a pointer during marking, the barrier records the pointer so the collector cannot lose track of a still-reachable object. Go has used a hybrid barrier since 1.8 that shades both the old referent (the Yuasa, or deletion, half) and the new one (the Dijkstra, or insertion, half). The reason it takes both halves is worth knowing, because it is the follow-up question: the hybrid barrier is what let Go delete the stop-the-world stack rescan at mark termination, which is why Go's pauses stopped scaling with the number of goroutines. The cost is a check on every pointer store while marking is active, and it is why pointer-sparse layouts are cheaper: fields of non-pointer type never touch the barrier, so a `[]Point` of structs does no barrier work on write while a `[]*Point` does barrier work on every element store. The same property makes the struct slice cheaper to mark, since the collector can skip it using the type's pointer bitmap."

Notice what that answer does not contain: a nanosecond figure for the barrier. You will find blog posts quoting one, and quoting it back is a trap, because the honest answer is that the cost depends on the CPU, on whether marking is even active, and on barrier buffer pressure. Saying "I would measure it with `gctrace` and a CPU profile rather than trust a number from a blog post" is a stronger answer than any figure, and it is the answer a good interviewer is fishing for.

Practice that answer. Then be able to draw the three colors on paper, explain how an object transitions white-to-gray-to-black, and name one specific operation (write barrier, mark assist) that keeps the invariant during mutator execution. That is the level of fluency that passes a FAANG senior interview.

### 1.6 Senior @ FAANG: writing a GC-tuning ADR

Every `GOGC` or `GOMEMLIMIT` change that lands in production should have an ADR. The template: (1) context including the baseline `gctrace` summary, p99, allocation rate, and heap working set. (2) problem statement naming the specific metric you are trying to move (p99, cost, RSS, CPU). (3) options considered: do nothing, change `GOGC`, change `GOMEMLIMIT`, refactor allocation sources, combine approaches. (4) chosen approach with expected effect and supporting benchmark. (5) monitoring plan naming the exact Prometheus queries that confirm the improvement and the exact queries that detect regression. (6) rollback criteria, expressed as "if X exceeds Y for Z minutes, revert to previous config." (7) expiration: "revisit in two quarters or after Go version upgrade, whichever comes first." The ADR is not paperwork. It is the document the on-call engineer opens at 2 AM when GC pauses change shape unexpectedly, and it is the document that tells the next staff engineer whether your tuning is still load-bearing a year later.

---
