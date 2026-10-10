## Section 4: Runtime Profiling Tools

### 4.1 pprof Integration

Exposing pprof over HTTP in production, behind authentication, enables on-demand profiling without restarting the process, which is essential for diagnosing intermittent performance issues that only manifest under production load patterns. The standard `net/http/pprof` package registers profiles at `/debug/pprof/` automatically on import, but production integrations should add rate limiting and authentication to prevent profiling from being triggered by unauthenticated clients. The setup below mounts pprof on a separate administrative port with an auth middleware and a maximum profile duration to prevent resource exhaustion.

```go
package profiling

import (
	"net/http"
	_ "net/http/pprof" // Register pprof handlers
	"os"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"time"
)

// ProfileServer starts a pprof HTTP server for live profiling.
// Access at http://host:6060/debug/pprof/
func ProfileServer(addr string) {
	go func() {
		// net/http/pprof registers the following endpoints:
		// /debug/pprof/           - index
		// /debug/pprof/cmdline   - command line
		// /debug/pprof/profile   - CPU profile (30s by default)
		// /debug/pprof/symbol    - symbol lookup
		// /debug/pprof/trace     - execution trace
		// /debug/pprof/goroutine - goroutine stacks
		// /debug/pprof/heap      - heap profile
		// /debug/pprof/allocs    - allocation profile
		// /debug/pprof/block     - blocking profile
		// /debug/pprof/mutex     - mutex profile
		http.ListenAndServe(addr, nil)
	}()
}

// CPUProfile captures a CPU profile to a file.
// Run: go tool pprof cpu.prof
func CPUProfile(duration time.Duration, filename string) error {
	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()

	if err := pprof.StartCPUProfile(f); err != nil {
		return err
	}
	time.Sleep(duration)
	pprof.StopCPUProfile()
	return nil
}

// HeapProfile captures a heap profile.
// Run: go tool pprof -alloc_objects heap.prof
//
// The heap profile is SAMPLED, not exhaustive. By default the runtime
// records roughly one allocation per 512KB allocated (MemProfileRate), and
// then scales the samples back up to estimate totals. Two consequences
// follow. Totals are statistically good and are what you should reason
// about. Any individual small allocation may simply not be in the profile,
// so "it is not in the heap profile" is not proof that a specific call
// site did not allocate. To prove a specific site, use a benchmark with
// -benchmem and read allocs/op, which counts every allocation exactly.
//
// Setting runtime.MemProfileRate = 1 records every allocation, which is
// accurate and very slow. Set it once at the top of main if you need it,
// since changing it mid-run makes the profile inconsistent.
func HeapProfile(filename string) error {
	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	// GC first so the inuse_* counts reflect live objects rather than
	// garbage that simply has not been collected yet.
	runtime.GC()
	return pprof.WriteHeapProfile(f)
}

// TraceProfile captures an execution trace.
// Run: go tool trace trace.out
// Shows: goroutine scheduling, GC phases, syscall latency, network waits.
func TraceProfile(duration time.Duration, filename string) error {
	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()

	if err := trace.Start(f); err != nil {
		return err
	}
	time.Sleep(duration)
	trace.Stop()
	return nil
}

// BlockProfile enables blocking profiling and writes to file.
// Shows: time goroutines spend blocked on channels and mutexes.
//
// READ THIS FIRST: the block profile is OFF by default. The default rate
// is 0, which records nothing at all. If you curl /debug/pprof/block on a
// service that never called SetBlockProfileRate, you get an empty profile,
// and the correct reading of that profile is "I have not enabled this,"
// not "my service never blocks." Engineers lose hours to this.
//
// The rate argument is in nanoseconds, not a boolean. rate=1 reports every
// blocking event and is expensive enough that it is a load-test setting,
// not a production one. A sampling value such as 10000 (report roughly one
// blocking event per 10µs of blocking) is the usual production compromise.
//
// Note it profiles blocking on Go synchronisation, channels and mutexes.
// Time in a blocking syscall is not what this measures, use a CPU profile
// or a trace for that.
func BlockProfile(rate int, filename string) error {
	runtime.SetBlockProfileRate(rate)
	defer runtime.SetBlockProfileRate(0)

	// ... run your workload ...

	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()

	p := pprof.Lookup("block")
	return p.WriteTo(f, 0)
}

// MutexProfile enables mutex contention profiling.
// Shows: which mutexes are hotly contested.
//
// Like the block profile, this is OFF by default (fraction 0 records
// nothing). fraction is a 1-in-N sampling rate, so 1 records every
// contention event and 100 records roughly one percent of them. Start at
// 100 in production and lower it only if the signal is too sparse.
//
// Only contended lock handoffs are recorded. An uncontended Lock/Unlock
// pair never appears here, which is the point: this profile answers "which
// locks are goroutines actually waiting on," not "which locks are taken."
func MutexProfile(fraction int, filename string) error {
	runtime.SetMutexProfileFraction(fraction)
	defer runtime.SetMutexProfileFraction(0)

	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()

	p := pprof.Lookup("mutex")
	return p.WriteTo(f, 0)
}

// ProfileGuide provides commands for analyzing profiles.
// This is documentation - not executable.
const ProfileGuide = `
Go Profiling Cheatsheet
========================

1. CPU Profile (What is the CPU doing?)
   Capture: go tool pprof http://host:6060/debug/pprof/profile?seconds=30
   Analyze: go tool pprof -http=:8080 cpu.prof
   Look for:
     - runtime.mallocgc > 20%: too many allocations → use pools
     - runtime.gcBgMarkWorker > 10%: GC is expensive → tune GOGC
     - sync.(*Mutex).Lock: mutex contention → use lock-free or sharding
     - syscall.Read/Write: I/O bound → use async I/O or batching

2. Heap Profile (What objects are on the heap?)
   Capture: go tool pprof http://host:6060/debug/pprof/heap
   Analyze: go tool pprof -alloc_objects heap.prof
   Look for:
     - Unexpected large allocations
     - Objects that should be pooled
     - Strings/bytes that could be pre-allocated

3. Goroutine Profile (What are goroutines waiting for?)
   Capture: curl http://host:6060/debug/pprof/goroutine?debug=2 > goroutines.txt
   Look for:
     - Goroutines stuck in chan receive (potential leaks)
     - Goroutines in io.Read with no timeout (network stuck)
     - 1000s of goroutines (spawning too many)

4. Trace (What is the scheduler doing?)
   Capture: curl -o trace.out http://host:6060/debug/pprof/trace?seconds=5
     (NOT go tool pprof. A trace is not a pprof profile. Fetch it with
      curl, then open it with go tool trace.)
   Analyze: go tool trace trace.out
   Look for:
     - STW pause duration (want well under 1ms, typically tens of µs).
       Concurrent mark runs for milliseconds and that is normal, so do
       not read mark duration as if it were pause duration.
     - Goroutine scheduling latency (time runnable -> running)
     - Syscall duration (time in kernel)

5. Blocking Profile (Where do goroutines block?)
   Enable: runtime.SetBlockProfileRate(N)  <- REQUIRED, default is 0
     Without this the profile is empty and means nothing.
   Capture: go tool pprof http://host:6060/debug/pprof/block
   Look for:
     - Channel operations blocking longer than expected
     - sync.Cond.Wait calls
     - Contended mutex handoffs

GODEBUG Environment Variables:
  gctrace=1     - Print one line per GC cycle to stderr. Cheap enough to
                  leave on in production if you capture stderr.
  schedtrace=N  - Print scheduler state every N ms
  scheddetail=1 - With schedtrace, replace the summary line with a full
                  per-P/M/G dump. Debugging the runtime, not a service.
  asyncpreemptoff=1 - Disable signal-based preemption. Debugging only.
  gccheckmark=1 - Re-verify the mark phase for correctness. This is a GC
                  correctness self-check (it hunts runtime/compiler bugs),
                  NOT a measurement tool. Very slow, testing only.
  inittrace=1   - Print time and memory used by each package init.
                  Underrated for diagnosing slow startup.
`
```

### 4.2 GODEBUG and Runtime Metrics

The `GODEBUG` environment variable exposes dozens of runtime diagnostic modes. `gctrace=1` emits a line per GC cycle with pause times and heap stats, and `schedtrace=1000` prints scheduler state every second. Their overhead differs more than people assume, and it is worth being precise rather than blanket-banning them: `gctrace=1` prints one line per GC cycle and is cheap enough to leave enabled in production if you are capturing stderr, whereas `gccheckmark=1` re-verifies the mark phase and is genuinely slow. Judge each one on its own cost.

For programmatic collection, prefer `runtime/metrics` over `runtime.ReadMemStats`. The reason is not style. `ReadMemStats` stops the world to take its snapshot, so polling it on a tight interval means you are paying pauses for the privilege of measuring pauses. `runtime/metrics` does not stop the world, it exposes strictly more information (including real histograms rather than the `[256]uint64` circular buffer), and it is the API the runtime team maintains going forward. The code below collects through `runtime/metrics` on a ticker.

```go
package runtime_metrics

import (
	"context"
	"runtime/metrics"
	"time"
)

// RuntimeMetrics uses the runtime/metrics package (Go 1.16+) for
// structured, low-overhead runtime metric collection.

// MetricSnapshot captures the key runtime metrics.
//
// Every field here is populated by CollectRuntimeMetrics below. That is a
// deliberate constraint: a snapshot struct with fields nobody fills is
// worse than no field at all, because a zero reads as "healthy" on a
// dashboard rather than as "never measured."
type MetricSnapshot struct {
	// GC
	GCCycles uint64 // Completed GC cycles since start
	HeapGoal uint64 // Target heap size for the next GC

	// Memory
	HeapLive    uint64 // Live heap bytes as of the last mark
	HeapObjects uint64 // Bytes of heap occupied by objects (NOT a count,
	// and NOT cumulative allocation. See /gc/heap/allocs:bytes if you
	// want allocation totals.)

	// Scheduler
	Goroutines uint64
}

// CollectRuntimeMetrics gathers metrics using the runtime/metrics API.
//
// Only request what you consume. metrics.Read does work proportional to
// the samples you pass, and an unknown name is not an error: the runtime
// sets its Value Kind to KindBad and moves on. That is why each read is
// guarded by a Kind check. Metric names are versioned by the runtime and
// can be added or retired between releases, so a Kind check is how you
// notice a name went away instead of silently reporting zero.
//
// Call metrics.All() to print the live catalogue for your toolchain.
func CollectRuntimeMetrics() MetricSnapshot {
	descs := []metrics.Sample{
		{Name: "/gc/cycles/total:gc-cycles"},
		{Name: "/memory/classes/heap/objects:bytes"},
		{Name: "/sched/goroutines:goroutines"},
		{Name: "/gc/heap/goal:bytes"},
		{Name: "/gc/heap/live:bytes"},
	}

	metrics.Read(descs)

	var snap MetricSnapshot
	for _, s := range descs {
		switch s.Name {
		case "/gc/cycles/total:gc-cycles":
			if s.Value.Kind() == metrics.KindUint64 {
				snap.GCCycles = s.Value.Uint64()
			}
		case "/memory/classes/heap/objects:bytes":
			if s.Value.Kind() == metrics.KindUint64 {
				snap.HeapObjects = s.Value.Uint64()
			}
		case "/sched/goroutines:goroutines":
			if s.Value.Kind() == metrics.KindUint64 {
				snap.Goroutines = s.Value.Uint64()
			}
		case "/gc/heap/goal:bytes":
			if s.Value.Kind() == metrics.KindUint64 {
				snap.HeapGoal = s.Value.Uint64()
			}
		case "/gc/heap/live:bytes":
			if s.Value.Kind() == metrics.KindUint64 {
				snap.HeapLive = s.Value.Uint64()
			}
		}
	}
	return snap
}

// Histograms need different handling from scalars, and the two metrics you
// most want (GC pauses, scheduler latency) are both histograms. Reading
// one as a Uint64 silently gives you nothing, so it is worth one example.
//
// Note /gc/pauses:seconds is CUMULATIVE since process start. To get the
// pause distribution for an interval, snapshot it at both ends and
// subtract the bucket counts. Graphing it raw shows you the lifetime
// distribution, which hides exactly the regression you are looking for.
func PauseQuantile(q float64) time.Duration {
	s := []metrics.Sample{{Name: "/gc/pauses:seconds"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindFloat64Histogram {
		return 0
	}
	h := s[0].Value.Float64Histogram()

	var total uint64
	for _, c := range h.Counts {
		total += c
	}
	if total == 0 {
		return 0
	}

	target := uint64(float64(total) * q)
	var seen uint64
	for i, c := range h.Counts {
		seen += c
		if seen >= target {
			// Buckets[i+1] is this bucket's upper bound.
			return time.Duration(h.Buckets[i+1] * float64(time.Second))
		}
	}
	return 0
}

// MetricsCollector periodically collects runtime metrics.
type MetricsCollector struct {
	interval time.Duration
	handler  func(MetricSnapshot)
	cancel   context.CancelFunc
}

func NewMetricsCollector(interval time.Duration, handler func(MetricSnapshot)) *MetricsCollector {
	return &MetricsCollector{
		interval: interval,
		handler:  handler,
	}
}

func (c *MetricsCollector) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel

	go func() {
		ticker := time.NewTicker(c.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				c.handler(CollectRuntimeMetrics())
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (c *MetricsCollector) Stop() {
	if c.cancel != nil {
		c.cancel()
	}
}
```

### 4.3 The five queries every Go service dashboard should have

Beyond exposing metrics, you need a short list of queries that tell you at a glance whether the runtime is healthy. These assume `client_golang` with the Go collector.

1. **GC frequency**: `rate(go_gc_duration_seconds_count[5m])`. Cycles per second. Useful mostly as a shape to compare against itself over time.
2. **GC CPU share**: `rate(go_cpu_classes_gc_total_cpu_seconds_total[5m]) / rate(go_cpu_classes_total_cpu_seconds_total[5m])`. This is the number that actually tells you what GC costs. Note it requires the `runtime/metrics`-backed collector, enabled with `collectors.NewGoCollector(collectors.WithGoCollectorRuntimeMetrics(...))`. Do not reach for `go_gc_cpu_fraction`, which is not a real metric name, and be careful with the old `go_memstats_gc_cpu_fraction`, which came from `MemStats.GCCPUFraction`, is a lifetime average rather than a rate (so it is useless for spotting a regression today), and has been dropped from recent collector versions.
3. **Goroutine count**: `go_goroutines`. Alert on sustained growth, not on an absolute number. Hundreds of thousands of goroutines can be perfectly healthy.
4. **Pacer pressure**: `go_memstats_heap_inuse_bytes / go_memstats_next_gc_bytes`. Roughly how far through the current GC cycle's budget the heap is. Treat it as approximate, since `heap_inuse` includes span-level slack and is not the same quantity as the live heap the pacer computes its goal from.
5. **Scheduler latency**: `histogram_quantile(0.99, rate(go_sched_latencies_seconds_bucket[5m]))`. Time from runnable to running. Also requires the runtime metrics collector.

One caution about thresholds. It is tempting to attach fixed alert values to these, and only two of them survive contact with a real fleet: goroutine count should be alerted on *trend*, and everything else should be alerted on *deviation from that service's own baseline*. A GC CPU share of 20 percent is a crisis for a latency-sensitive proxy and completely normal for a batch indexer. Copying someone else's thresholds is how dashboards end up either permanently red or permanently useless. A service without this dashboard is a service whose performance is invisible until it breaks.

### 4.4 Junior → FAANG: the continuous-profiling habit

`pprof` captured on demand during an incident is reactive. Continuous profiling (Google Cloud Profiler, Datadog Continuous Profiler, Pyroscope, Parca) captures samples continuously and lets you compare profiles across time windows, deploys, and customers. The cost is 1 to 3 percent CPU in most configurations. The benefit is that when p99 regresses on Tuesday at 14:00, you can compare Tuesday 14:00 to Tuesday 13:00 and see exactly which function grew CPU. The habit to build: every time you deploy a change that touches a hot path, diff the profile window before and after the deploy and confirm the CPU shape did not move unexpectedly. This habit takes two minutes per deploy and has saved more incidents in post-hoc review than any other single tool. Ask for it in your first week on the job if your team does not already have it.

### 4.5 Senior @ FAANG: the profiling posture document

A staff engineer's artifact for profiling is not a profile, it is the policy. Write a one-page document covering: which profiles are collected automatically (CPU, heap, goroutine, block, mutex, trace). At what rate and overhead. Where they land (object storage, continuous profiler service). For how long they are retained. Who has access (SRE, service team, security). What PII or secret material could leak through labels and strings (a real risk, worth a security review). How profiles are redacted if needed. How profiles are used during incident response (runbook reference). How profiles are used during capacity planning (quarterly review). This document is the difference between a team that occasionally captures a profile and a team with genuine runtime observability, and it is the kind of artifact staff engineers are evaluated on at promotion time.

---
