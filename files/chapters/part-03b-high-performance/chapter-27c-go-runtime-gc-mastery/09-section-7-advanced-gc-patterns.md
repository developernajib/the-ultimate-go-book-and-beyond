## Section 7: Advanced GC Patterns

### 7.1 Incremental GC with Pacing

Go's GC paces its work so that concurrent marking finishes just as the heap reaches the goal, spreading collection across the mutator's execution instead of doing it all at one threshold. Two things about the pacer are commonly misstated and both matter.

First, `GOGC` is **not** a CPU fraction target. It is a heap growth ratio: at `GOGC=100`, the next cycle triggers when the heap has grown 100 percent past the live set from the last cycle. The pacer does hold an internal GC CPU goal (25 percent, of which mark assists are the overflow valve), but that is a fixed design constant of the algorithm and not a dial you are setting when you write `GOGC=50`.

Second, the pacer is a **proportional controller**, not a planner. It measures the error between where the heap actually is and where it should be at this point in the cycle, and it adjusts the assist ratio in proportion to that error. It is closed-loop feedback, in the same family as a thermostat. It does not compute a schedule ahead of time, and descriptions of it as dynamic programming or online optimization are simply wrong. Understanding it as a controller tells you the useful thing: it reacts to your allocation rate, so a sudden allocation spike produces error, and error is paid for in mark assists charged to your own goroutines.

Reducing `GOGC` therefore trades memory for GC CPU. It does not shorten pauses, which are already sub-millisecond and do not scale with the heap.

That framing also explains the code that follows. What is useful is **observing** the pacer's inputs. What is not useful is trying to outsmart it, and the next section shows a tempting example of exactly that, and why it is wrong.

```go
package gc_advanced

import (
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
)

// ANTI-PATTERN, shown so you can recognise and reject it in review.
//
// It is tempting to write a "GCPacer" that watches your allocation rate and
// calls runtime.GC() when it looks too high. Every part of that idea is
// wrong, and it is worth being specific about why, because the code looks
// reasonable:
//
//	func (p *GCPacer) RecordAllocation(n uint64) {
//	    p.windowAllocs.Add(n)
//	    elapsed := time.Since(p.windowStart).Seconds()  // RACE
//	    if elapsed < 1.0 { return }
//	    if rate(p) > target*1.5 { go runtime.GC() }     // fights the pacer
//	    p.windowAllocs.Store(0)                         // RACE
//	    p.windowStart = time.Now()                      // RACE
//	}
//
//  1. It is racy. windowStart is a plain time.Time read and written from
//     every calling goroutine at once. Atomic counters next to a non-atomic
//     field is a very common way to half-synchronise a struct. Under -race
//     this fails immediately.
//  2. It fights the pacer. Forcing a cycle because allocation is "too fast"
//     does not reduce allocation, it adds a full mark phase on top of the
//     one the pacer already scheduled, so GC CPU goes UP.
//  3. Its premise is inverted. A high allocation rate with a small live set
//     is cheap, because marking cost tracks the LIVE heap, not the garbage.
//     Reacting to allocation rate alone punishes exactly the workloads the
//     GC handles best.
//  4. RecordAllocation must be called on every allocation to be accurate,
//     which is both impossible to enforce and slower than what it saves.
//
// If allocation rate genuinely is your problem, allocate less. That is the
// entire fix. What follows is the useful half: measuring, without steering.

// AllocRateMonitor observes allocation rate. It is deliberately read-only:
// it never calls runtime.GC() and never touches GOGC.
//
// /gc/heap/allocs:bytes is a cumulative counter of all bytes ever allocated,
// so a rate is just the delta between two samples over the elapsed time.
// This costs one metrics.Read and stops the world exactly zero times.
type AllocRateMonitor struct {
	mu         sync.Mutex // Guards ALL fields below. See anti-pattern above.
	lastBytes  uint64
	lastSample time.Time
	rate       float64 // bytes/second at the last Sample
}

func readAllocBytes() uint64 {
	s := []metrics.Sample{{Name: "/gc/heap/allocs:bytes"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return s[0].Value.Uint64()
}

func NewAllocRateMonitor() *AllocRateMonitor {
	return &AllocRateMonitor{
		lastBytes:  readAllocBytes(),
		lastSample: time.Now(),
	}
}

// Sample updates and returns the allocation rate in bytes/second.
// Call it on a ticker, not on a hot path.
func (m *AllocRateMonitor) Sample() float64 {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	cur := readAllocBytes()
	elapsed := now.Sub(m.lastSample).Seconds()
	if elapsed <= 0 {
		return m.rate
	}
	m.rate = float64(cur-m.lastBytes) / elapsed
	m.lastBytes, m.lastSample = cur, now
	return m.rate
}

// SmallObjectPool provides a typed pool for small, frequently-allocated
// objects, for hot paths where new(T) would generate GC pressure.
//
// The instrumentation here is the interesting part. The obvious way to
// count pool hits does not work:
//
//	obj := p.pool.Get().(*T)
//	if obj != nil { hits++ } else { misses++ }   // misses is ALWAYS 0
//
// When sync.Pool has a New function, Get never returns nil. It returns a
// freshly constructed object instead, so the nil branch is dead code and
// the pool reports a 100% hit rate even when every single Get allocated.
// A metric that reads perfect no matter what is worse than no metric.
//
// The only place that knows a miss happened is New itself, because New is
// called precisely when the pool had nothing to hand back. Count there.
type SmallObjectPool[T any] struct {
	pool sync.Pool
	gets atomic.Uint64
	news atomic.Uint64 // Incremented inside New: a real miss.
}

func NewSmallObjectPool[T any](init func() *T) *SmallObjectPool[T] {
	p := &SmallObjectPool[T]{}
	p.pool = sync.Pool{
		New: func() any {
			p.news.Add(1) // Reached only when the pool was empty.
			return init()
		},
	}
	return p
}

func (p *SmallObjectPool[T]) Get() *T {
	p.gets.Add(1)
	return p.pool.Get().(*T)
}

func (p *SmallObjectPool[T]) Put(obj *T) {
	p.pool.Put(obj)
}

// HitRate is the fraction of Gets served from the pool rather than New.
//
// Expect this to drop around GC cycles, and do not treat that as a bug.
// The GC clears pools, by design. sync.Pool is a free list for objects in
// flight, not a cache, and it will never hold anything across an idle
// period for you.
//
// The precise lifetime is worth knowing, because "cleared at GC" is the
// common shorthand and it is off by one. Since Go 1.13 each pool has a
// victim cache: at GC, the live items are moved to the victim slot rather
// than dropped, and the previous victim slot is discarded. So an object
// survives exactly one GC and is gone on the second. Measured on Go 1.27.1
// (linux/amd64): Put, then one runtime.GC(), then Get, and New is NOT
// called (the victim cache served it). Put, then two GCs, and New IS
// called. The victim cache exists to stop a pool from going completely
// cold on every single cycle, which is what made pre-1.13 pools spiky.
//
// A pool whose hit rate stays low is a pool whose objects do not live long
// enough to be reused. Delete it rather than tune it.
func (p *SmallObjectPool[T]) HitRate() float64 {
	gets := p.gets.Load()
	if gets == 0 {
		return 0
	}
	return float64(gets-p.news.Load()) / float64(gets)
}
```

### 7.2 Read-Copy-Update (RCU) for Config

Read-Copy-Update (RCU) is a synchronization pattern where readers access a shared data structure without any locking, and writers produce a new copy of the structure and atomically swap the pointer, allowing zero-cost reads at the price of higher write complexity. In Go, RCU is implemented with `atomic.Pointer` for the swap and a grace-period mechanism (usually a quiescence counter) to defer freeing old versions until all readers have finished with them. The config manager below uses RCU to provide zero-allocation, lock-free config reads to hot request paths while safely updating config from a background watcher goroutine.

```go
package rcu

import (
	"sync/atomic"
)

// RCUConfig implements Read-Copy-Update for configuration.
// Readers never block, they atomically load the current pointer.
// Writers copy, modify, then atomically swap the pointer.
// Old readers finish with the old config, new readers see the new one.

// Config is the application configuration.
type Config struct {
	MaxConnections int
	Timeout        int64 // nanoseconds
	Features       map[string]bool
	RateLimits     map[string]int
}

// RCUStore holds an atomically-updated pointer to Config.
type RCUStore struct {
	ptr atomic.Pointer[Config]
}

func NewRCUStore(initial *Config) *RCUStore {
	s := &RCUStore{}
	s.ptr.Store(initial)
	return s
}

// Load returns the current configuration.
// Lock-free and wait-free, safe to call from hot paths.
//
// The returned *Config must be treated as immutable. Nothing in the type
// system enforces that, and it is the one rule that makes this whole
// pattern work: a reader that mutates the config it loaded is racing every
// other reader holding the same pointer.
func (s *RCUStore) Load() *Config {
	return s.ptr.Load()
}

// Update creates a new Config based on the current one and atomically swaps.
// The update function receives a deep copy of the current config.
func (s *RCUStore) Update(fn func(*Config)) {
	for {
		old := s.ptr.Load()
		// Create a copy.
		newCfg := copyConfig(old)
		// Apply mutation.
		fn(newCfg)
		// Atomically swap. Retry if another writer won the race.
		if s.ptr.CompareAndSwap(old, newCfg) {
			return
		}
	}
}

func copyConfig(c *Config) *Config {
	newCfg := *c // Shallow copy of value fields.

	// Deep copy map fields.
	if c.Features != nil {
		newCfg.Features = make(map[string]bool, len(c.Features))
		for k, v := range c.Features {
			newCfg.Features[k] = v
		}
	}
	if c.RateLimits != nil {
		newCfg.RateLimits = make(map[string]int, len(c.RateLimits))
		for k, v := range c.RateLimits {
			newCfg.RateLimits[k] = v
		}
	}
	return &newCfg
}
```

### 7.3 `runtime.GC()` is almost never the answer

Code that calls `runtime.GC()` explicitly is a red flag in code review. The legitimate cases are rare: a long-lived program that knows it has just dropped a very large working set (for example, a batch job completing a phase and about to idle) and wants to give memory back to the OS promptly. An init routine that wants a clean baseline before benchmarking. A test harness that needs determinism. Everything else is cargo culting. The GC pacer already decides when to collect based on allocation rate and heap size, and manually forcing a cycle usually makes pause behavior worse, not better. If you see `runtime.GC()` in hot path code, the review question is "what problem were you trying to solve, and have you measured whether the forced GC actually solved it." In most cases the engineer was trying to fix a symptom of a different problem (unbounded cache growth, an allocation storm, a goroutine leak) and the forced GC is papering over it.

### 7.4 Junior → FAANG: RCU in one mental model

Read-copy-update is easier than it sounds. Picture a blackboard shared by many readers and one writer. Readers copy the blackboard instantly (a pointer load) and work from their copy. The writer takes the current blackboard, makes a new one with the changes, and atomically swaps the pointer to point at the new board. Readers who already copied the old board keep using it until they are done, then drop their reference. The old board is garbage collected automatically once no reader holds it. In Go, `atomic.Pointer[T]` is the pointer, `.Load()` is the reader's copy, and `.Store()` or `.CompareAndSwap()` is the swap. You will find the shape of this pattern in Kubernetes informers and in most feature-flag and config services.

The Go GC is what makes it cheap, and this is the part worth understanding rather than memorizing. In C or C++ the hard problem in RCU is not the swap, it is knowing when it is safe to free the old version, which is why those implementations need epochs, hazard pointers, or `synchronize_rcu`. In Go, a reader that loaded the old pointer is holding a reference, so the old config is reachable and simply will not be collected until that reader drops it. The grace period you would otherwise have to implement by hand is just reachability, and the GC already tracks it. That is a case where garbage collection buys back the CPU it costs you.

One caution on a claim you will see repeated: `sync.Map` is often described as being built from this pattern, with a read map and a dirty map and promotion between them. That description is out of date. As of Go 1.24 `sync.Map` is implemented as a **HashTrieMap**, a concurrent hash-trie, and the read/dirty/promotion machinery is gone. Do not reason about current `sync.Map` performance from articles describing the old design.

### 7.5 Senior @ FAANG: the pacer is not a knob

A common staff-level failure mode is to look at the Go GC pacer and treat it as a tuning surface. It is not. The pacer is an algorithm with documented inputs (`GOGC`, `GOMEMLIMIT`, allocation rate, live heap) and a documented goal (run a concurrent mark while keeping mutator assist share bounded). The levers you have are the inputs, not the pacer itself. If you find yourself reaching for `runtime/debug.SetGCPercent` on a ticker, or adding `runtime.GC()` calls to "help" the pacer, step back. The real question is which input is wrong, allocation rate (fix at the source), live heap (fix the data structure), `GOMEMLIMIT` (fix the cap), or `GOGC` (fix the target ratio). Mastering the GC at staff level means understanding which input to change and why, not fighting the pacer at runtime. Go's maintainers deliberately expose a minimal API here. Respect that, and the runtime will reward you.

---
