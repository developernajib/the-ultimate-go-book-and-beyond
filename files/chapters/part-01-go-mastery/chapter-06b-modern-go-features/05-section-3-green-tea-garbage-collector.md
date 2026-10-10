## Section 3: Green Tea Garbage Collector

The Green Tea collector was introduced as an opt-in experiment in Go 1.25 (August 2025) via `GOEXPERIMENT=greenteagc`, and promoted to the default collector in Go 1.26 (February 2026). It does not replace Go's tri-color concurrent mark-and-sweep algorithm. It restructures the marking phase for better cache locality and SIMD parallelism. The language contract, escape-analysis rules, and write-barrier semantics are unchanged.

### 3.1 What Green Tea Actually Does

The original Go collector scanned live objects one at a time. Most of the mark-phase CPU cost was memory stalls: the mark worker would load a pointer, follow it, load the next object, and repeat, with each step potentially missing the cache. Green Tea changes the unit of mark work from the individual object to the span, the aligned block of memory that holds small objects of a single size class. Instead of scanning each small object the moment it is discovered, the collector accumulates marks on the object's span and later scans all of a span's marked objects in one pass over contiguous memory. On amd64 CPUs with AVX-512, the hottest scan kernels are vectorized.

```
Legacy mark phase:
  load ptr -> chase -> mark -> load next ptr -> chase -> mark -> ...
  (cache misses dominate)

Green Tea mark phase:
  accumulate marks per span -> scan all marked objects in the span in
  one contiguous pass (vectorized on AVX-512 hardware)
```

The payoff is smaller steady-state GC CPU (the Go team reports 10 to 40 percent reductions in GC overhead on allocation-heavy workloads) and slightly shorter p99 pauses because the mark phase finishes faster. Large objects continue to use the traditional per-object mark.

### 3.2 GC Tuning for Production

The two primary GC tuning knobs are `GOGC` (controls heap growth ratio) and `GOMEMLIMIT` (sets a hard memory ceiling). Setting `GOMEMLIMIT` is recommended for containerized deployments to prevent OOM kills.

```go
package gc

import (
	"runtime"
	"runtime/debug"
	"time"
)

// GC tuning parameters
type GCConfig struct {
	// GOGC: percentage increase in heap size that triggers GC
	// Default: 100 (GC when heap doubles)
	// Lower = more frequent GC, less memory
	// Higher = less frequent GC, more memory
	GOGC int

	// GOMEMLIMIT: soft memory limit (Go 1.19+)
	// Prevents OOM by triggering more aggressive GC
	MemLimitBytes int64

	// Green Tea is the default on Go 1.26+. On 1.25 it was opt-in via
	// GOEXPERIMENT=greenteagc. There is no runtime flag to toggle it:
	// the choice is made at build time.
}

// SetGCPolicy applies GC configuration
func SetGCPolicy(cfg GCConfig) {
	// Set GOGC
	debug.SetGCPercent(cfg.GOGC)

	// Set memory limit (crucial for containers)
	if cfg.MemLimitBytes > 0 {
		debug.SetMemoryLimit(cfg.MemLimitBytes)
	}
}

// Production GC configurations

// HighThroughput: for batch processing where latency doesn't matter
func HighThroughputGC() GCConfig {
	return GCConfig{
		GOGC:          200, // GC less frequently
		MemLimitBytes: 2 * 1024 * 1024 * 1024, // 2GB limit
	}
}

// LowLatency: for real-time services (HTTP, gRPC)
func LowLatencyGC() GCConfig {
	return GCConfig{
		GOGC:          50, // GC more frequently but smaller pauses
		MemLimitBytes: 512 * 1024 * 1024, // 512MB limit
	}
}

// MemoryConstrained: for containers with small limits
func MemoryConstrainedGC(containerLimitBytes int64) GCConfig {
	return GCConfig{
		GOGC:          100,
		MemLimitBytes: containerLimitBytes * 90 / 100, // 90% of container limit
	}
}

// GCStats monitors GC behavior
type GCStats struct {
	ticker *time.Ticker
	done   chan struct{}
}

func NewGCStats() *GCStats {
	return &GCStats{
		ticker: time.NewTicker(30 * time.Second),
		done:   make(chan struct{}),
	}
}

func (g *GCStats) Monitor(logFn func(map[string]any)) {
	go func() {
		var stats runtime.MemStats
		for {
			select {
			case <-g.ticker.C:
				runtime.ReadMemStats(&stats)
				logFn(map[string]any{
					"heap_alloc_mb":    stats.HeapAlloc / 1024 / 1024,
					"heap_sys_mb":      stats.HeapSys / 1024 / 1024,
					"heap_idle_mb":     stats.HeapIdle / 1024 / 1024,
					"heap_inuse_mb":    stats.HeapInuse / 1024 / 1024,
					"gc_count":         stats.NumGC,
					"gc_pause_ns_max":  gcPauseMax(&stats),
					"gc_cpu_fraction":  stats.GCCPUFraction,
					"next_gc_mb":       stats.NextGC / 1024 / 1024,
					"total_alloc_mb":   float64(stats.TotalAlloc) / 1024 / 1024,
				})
			case <-g.done:
				return
			}
		}
	}()
}

func gcPauseMax(stats *runtime.MemStats) uint64 {
	// PauseNs is a circular buffer of the 256 most recent GC pause durations
	pauses := stats.PauseNs[:]
	max := uint64(0)
	for _, p := range pauses {
		if p > max {
			max = p
		}
	}
	return max
}

func (g *GCStats) Stop() {
	g.ticker.Stop()
	close(g.done)
}

// Allocation optimization: reduce GC pressure
type ObjectPool[T any] struct {
	pool chan *T
	new  func() *T
}

func NewObjectPool[T any](size int, newFn func() *T) *ObjectPool[T] {
	p := &ObjectPool[T]{
		pool: make(chan *T, size),
		new:  newFn,
	}
	// Pre-populate
	for i := 0; i < size/2; i++ {
		p.pool <- newFn()
	}
	return p
}

func (p *ObjectPool[T]) Get() *T {
	select {
	case obj := <-p.pool:
		return obj
	default:
		return p.new()
	}
}

func (p *ObjectPool[T]) Put(obj *T) {
	select {
	case p.pool <- obj:
	default:
		// Pool full, let GC collect
	}
}

// Stack allocation hints: avoid heap escapes
func noEscape() {
	// These stay on stack
	var buf [1024]byte    // Fixed-size arrays: stack allocated
	_ = buf

	type Point struct{ X, Y float64 }
	p := Point{1.0, 2.0}  // Small structs without pointers: stack allocated
	_ = p

	// Avoid these patterns that cause heap allocation:
	// x := new(int)      // explicitly on heap
	// s := make([]int, n) where n is large
	// closures capturing variables
}
```

### Adoption Story

Green Tea is the default in 1.26, opt-in via `GOEXPERIMENT=greenteagc` in 1.25. The expected payoff is 10 to 40 percent reduction in GC CPU on allocation-heavy services with no source change.

The adoption sequence:

1. **Upgrade to 1.26 in non-production environments first.** Run the test suite. Verify behavior parity. Run benchmarks. The GC change is transparent to your code, but a regression in something else (a standard library change, a tooling change) may surface during the upgrade.
2. **Roll to a small canary in production.** Capture before-and-after metrics: GC CPU percentage, allocation rate, p99 latency, RSS. Validate the gain is real for your workload.
3. **Roll to the fleet.** The savings compound across services. Track them at the org level so the value is visible in the next platform review.

### Code-Review Lens (Senior Track)

Two patterns a staff reviewer flags after the Green Tea upgrade:

1. **Manual `runtime.GC()` calls.** Almost always wrong. The new GC's pacer is calibrated for automatic operation. Manual calls disrupt the pacer and produce worse latency, not better.
2. **Workarounds for pre-1.26 GC behavior.** If the team had "force-allocate large arenas to reduce GC pressure" or "manually trigger GC at known-quiet times" hacks, evaluate whether they are still necessary. Often they are not.

### Migration Lens

The relevant comparison is Java's GC choices. JVM tuning is a multi-knob exercise (G1, ZGC, Shenandoah, generation sizes, pause goals). Go's GC has historically had two knobs (`GOGC`, then `GOMEMLIMIT` in 1.19) and one algorithm. Green Tea continues that tradition: the algorithm changed, the knobs did not. The trade is less control for less complexity. For the vast majority of services, Go's "set GOMEMLIMIT and forget" model is the right shape. For services with extreme requirements, the lack of GC tuning is a real limitation. The workaround is to write code that allocates less, not to tune the GC.

---
