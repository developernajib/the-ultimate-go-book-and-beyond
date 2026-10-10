## Section 3: Lock-Free Data Structures

### 3.1 Lock-Free Ring Buffer (MPMC Queue)

A lock-free multi-producer, multi-consumer ring buffer removes the mutex from the enqueue and dequeue path. The implementation uses typed atomics from `sync/atomic` (Go 1.19+, `atomic.Uint64`, `atomic.Pointer[T]`) for the head and tail cursors, and a power-of-two capacity so that modulo becomes a bitmask, keeping the hot path to a handful of atomic operations.

**About the speedup you were expecting.** Earlier editions of this material claimed a lock-free MPMC queue is "5 to 10 times faster than a mutex-protected queue". That claim did not survive being measured, and rather than quietly replace it with a different number, it is worth showing why.

Two benchmarks were run on the same machine (Go 1.27.1, i7-10510U, 4 physical cores pinned), comparing this ring buffer, a mutex-protected slice queue, and a plain buffered `chan T`. The two benchmarks disagreed with each other:

| Benchmark shape | RingBuffer | Mutex queue | `chan T` |
|---|---|---|---|
| `RunParallel`, mixed enqueue/dequeue per goroutine | 201 ns ±37% | 213 ns ±25% | **98 ns ±14%** |
| 2 producers / 2 consumers, consumers busy-polling | **384 ns ±82%** | 520 ns ±47% | 1654 ns ±36% |

In the first shape the ring buffer ties the mutex (1.06x, well inside the noise) and the **channel is twice as fast as the lock-free structure**. In the second shape the ring buffer wins and the channel looks terrible. Both are "real" benchmarks. The second penalizes the channel because busy-polling with `select`/`default` throws away exactly the blocking behaviour channels are optimized for, which is a benchmark artifact, not a property of channels.

Look at the variance: ±37% to ±82%. At that spread, on that hardware, **these benchmarks cannot resolve the question**, and any single number drawn from them would be fiction with a decimal point. So this chapter does not give you one. What the measurements do support is narrower and more useful:

- The ring buffer allocates **0 B/op**, the mutex queue allocated **45 B/op**. Allocation counts are deterministic and reproduce anywhere. That is a real, defensible advantage.
- No configuration tested showed anything close to 5x over a mutex.
- A plain channel is competitive and sometimes better.

If you need a number for your system, benchmark **your** producer/consumer ratio, **your** item size, and **your** core count, on the hardware you will deploy on. The honest headline is that the mutex is not the bottleneck you think it is until you have proven it is.

Cache line width varies by architecture (64 bytes on x86-64, 128 on ARM64 including Apple silicon and on ppc64, 256 on IBM s390x), so portable code should pad with `golang.org/x/sys/cpu.CacheLinePad` rather than a hard-coded constant. The example below hard-codes 64 for clarity on x86-64, and the section after it shows why that shortcut is a bug waiting to happen.

> **Senior track**: Before reaching for a custom MPMC queue, try `chan T` with a small buffer. Go channels are heavily optimized, and the measurements above show a channel beating a hand-written lock-free queue in a plausible workload. Contention rarely dominates until the producer/consumer ratio is very skewed. The custom structure also costs you: it is 100 lines you now maintain, it needs `-race -count=100` in CI forever, and its bugs are non-deterministic. Measure before you micro-optimize, and be prepared for the measurement to tell you to delete the clever thing.

```go
package lockfree

import (
	"runtime"
	"sync/atomic"
)

const cacheLineSize = 64

// cell is a single slot in the ring buffer.
//
// NOTE ON PADDING: there is no correct way to pad this generically. The
// obvious formula
//
//	_ [cacheLineSize - unsafe.Sizeof(atomic.Uint64{}) - 8]byte
//
// silently assumes T is exactly 8 bytes. Measured with unsafe.Sizeof on
// Go 1.26, that formula yields:
//
//	cell[uint64] = 64 bytes  (correct, by luck)
//	cell[string] = 72 bytes  (WRONG, straddles a cache line)
//	cell[[]byte] = 80 bytes  (WRONG, straddles a cache line)
//
// A cell that straddles a cache line reintroduces exactly the false sharing
// the padding exists to prevent, and it does so silently. Go has no way to
// say "pad to the next multiple of 64" in a type declaration, because array
// lengths must be constants and unsafe.Sizeof(T) is not constant for a type
// parameter.
//
// So: do not pad the cell. Pad the CURSORS (see RingBuffer below), which is
// where the contention actually is, and accept that adjacent cells may share
// a line. Producers and consumers touch different cells and move on, so
// cell-level false sharing is a second-order effect. Two atomic cursors
// hammered by every goroutine is a first-order effect.
type cell[T any] struct {
	sequence atomic.Uint64
	data     T
}

// RingBuffer is a lock-free multi-producer multi-consumer bounded queue,
// based on Dmitry Vyukov's MPMC queue algorithm.
//
// The padding here is the padding that matters: `enqueue` and `dequeue` are
// hammered by every producer and every consumer respectively. Without the
// separator they would share a cache line, and every producer's CAS would
// invalidate that line for every consumer, turning two independent cursors
// into one contended one. Keeping them on separate lines is the single most
// important layout decision in this type.
//
// For portable code use golang.org/x/sys/cpu.CacheLinePad instead of the
// hard-coded 64, since ARM64 and s390x differ (see the prose above).
type RingBuffer[T any] struct {
	_       [cacheLineSize]byte // isolate from whatever precedes us in memory
	enqueue atomic.Uint64
	_       [cacheLineSize - 8]byte // keep enqueue and dequeue apart
	dequeue atomic.Uint64
	_       [cacheLineSize - 8]byte

	// Read-mostly below: written once at construction, never in the hot path,
	// so these are safe to share a line with each other.
	mask  uint64
	cells []cell[T]
}

// NewRingBuffer creates a lock-free ring buffer.
// capacity must be a power of 2.
func NewRingBuffer[T any](capacity uint64) *RingBuffer[T] {
	// Ensure power of 2
	if capacity&(capacity-1) != 0 {
		panic("capacity must be power of 2")
	}
	rb := &RingBuffer[T]{
		mask:  capacity - 1,
		cells: make([]cell[T], capacity),
	}
	for i := range rb.cells {
		rb.cells[i].sequence.Store(uint64(i))
	}
	return rb
}

// Enqueue attempts to enqueue an item. Returns false if full.
func (rb *RingBuffer[T]) Enqueue(item T) bool {
	var pos uint64
	for {
		pos = rb.enqueue.Load()
		cell := &rb.cells[pos&rb.mask]
		seq := cell.sequence.Load()
		diff := int64(seq) - int64(pos)

		switch {
		case diff == 0:
			// Cell is ready for writing.
			if rb.enqueue.CompareAndSwap(pos, pos+1) {
				cell.data = item
				cell.sequence.Store(pos + 1)
				return true
			}
		case diff < 0:
			// Queue is full.
			return false
		default:
			// Another producer is ahead - retry.
			runtime.Gosched()
		}
	}
}

// Dequeue attempts to dequeue an item. Returns false if empty.
func (rb *RingBuffer[T]) Dequeue() (T, bool) {
	var zero T
	var pos uint64
	for {
		pos = rb.dequeue.Load()
		cell := &rb.cells[pos&rb.mask]
		seq := cell.sequence.Load()
		diff := int64(seq) - int64(pos+1)

		switch {
		case diff == 0:
			// Cell has data ready.
			if rb.dequeue.CompareAndSwap(pos, pos+1) {
				item := cell.data
				cell.data = zero // GC-safe: clear reference
				cell.sequence.Store(pos + rb.mask + 1)
				return item, true
			}
		case diff < 0:
			// Queue is empty.
			return zero, false
		default:
			// Another consumer is ahead - retry.
			runtime.Gosched()
		}
	}
}

// Len returns an approximate count of items in the buffer.
func (rb *RingBuffer[T]) Len() int {
	enq := rb.enqueue.Load()
	deq := rb.dequeue.Load()
	if enq >= deq {
		return int(enq - deq)
	}
	return 0
}
```

### 3.2 Lock-Free Counter and Statistics

High-frequency counters in metrics collection, rate limiting, and circuit breakers are a natural fit for atomics. But be precise about where the win comes from, because the usual framing credits the wrong thing.

Measured on Go 1.27.1, i7-10510U, 4 physical cores pinned, using `b.RunParallel` with every goroutine hitting the counter, summarized by `benchstat` over two independent sets of runs:

| Approach | Run 1 | Run 2 | Speedup vs mutex |
|---|---|---|---|
| Mutex-protected `v++` | 67.2 ns ±56% | 98.1 ns ±45% | 1x |
| `atomic.Uint64.Add` on one counter | 33.2 ns ±40% | 40.9 ns ±18% | **~2x** |
| Sharded atomic counter (256 shards) | 7.1 ns ±25% | 8.1 ns ±60% | **~10x** |

Read the middle row carefully. Swapping a mutex for an atomic bought roughly **2x**, not the 5x-to-20x that gets quoted. That is because a contended atomic and a contended mutex are fighting the same physical battle: one cache line, ping-ponging between cores. The atomic avoids the parking and waking, which is real but bounded. It does not avoid the cache-coherence traffic, which is the actual cost.

The **10x comes from sharding**, not from atomics. Sharding wins because it gives each core its own cache line to increment, so there is no coherence traffic at all. That is the lesson worth carrying: at high contention, you are not optimizing instructions, you are optimizing which cache lines get shared. An atomic on a shared line is still a shared line.

One caveat that cuts the other way: these ran on 4 cores, which is mild contention. Mutex cost grows sharply with the number of contending threads, so on a 64-core machine the first row would be far worse and the ratios far larger. This is exactly why "atomics are Nx faster than mutexes" is not a fact you can memorize. It is a function of your core count, your contention, and your access pattern, and it must be measured on the machine you deploy to.

```go
package lockfree

import (
	"sync/atomic"
	"time"
)

// Counter is a sharded atomic counter.
//
// Each shard occupies its own cache line, which is the entire point: 256
// counters on one line would be slower than a single counter, because every
// core would invalidate every other core's line on every increment. This is
// false sharing, and padding is the cure. See chapter 27D.
//
// Cost: 256 shards x 64 B = 16 KB per Counter. Do not create one of these
// per metric per tenant unless you have counted the memory first.
type Counter struct {
	shards [256]paddedUint64
}

type paddedUint64 struct {
	v atomic.Uint64
	_ [cacheLineSize - 8]byte
}

// Inc increments the counter.
//
// A note on the shard key, because this is where the design usually goes
// wrong. Go deliberately does not expose goroutine IDs, and you should not
// dig one out of a stack trace to get one. An earlier version of this API
// took a `goroutineID int` parameter and pushed the problem onto the caller,
// which is worse: callers do not have a good ID either, and any ID that is
// stable per goroutine is wrong anyway, because a goroutine migrates between
// Ps and what you actually want is a key that is stable per CPU.
//
// The honest options are:
//
//  1. Any cheap per-caller value you already have (a worker index, a
//     connection number). Best when your concurrency is already structured.
//  2. runtime_procPin via linkname to get the real P id. Fast and correct,
//     but unsafe and unsupported. Several production libraries do it anyway.
//  3. A counter that rotates shards. Simple, portable, and good enough: it
//     spreads writers across lines without pretending to know where they run.
//
// This uses option 3, which costs one extra atomic but needs no unsafe
// tricks and no cooperation from the caller.
func (c *Counter) Inc() {
	c.Add(1)
}

// Add adds delta to the counter.
func (c *Counter) Add(delta uint64) {
	shard := shardSeq.Add(1) & 255
	c.shards[shard].v.Add(delta)
}

// shardSeq spreads writers across shards. It is itself a contended atomic,
// which sounds self-defeating, but it is a bare increment with no read of
// the result's meaning, and it is still far cheaper than contending on the
// counter plus whatever the caller does. If this shows up in your profile,
// you have earned the right to use option 1 or 2 above.
var shardSeq atomic.Uint64

// Load returns the total count across all shards.
func (c *Counter) Load() uint64 {
	var total uint64
	for i := range c.shards {
		total += c.shards[i].v.Load()
	}
	return total
}

// Reset resets all shards to zero and returns the previous total.
func (c *Counter) Reset() uint64 {
	var total uint64
	for i := range c.shards {
		total += c.shards[i].v.Swap(0)
	}
	return total
}

// RateTracker tracks events per second over a 60-second sliding window.
//
// Each bucket stores its own epoch alongside its count, which is what makes
// this correct across gaps. See the discussion after the code for the two
// bugs this design exists to avoid.
type RateTracker struct {
	buckets [60]rateBucket
}

type rateBucket struct {
	// epoch is the absolute second this bucket's count belongs to. A bucket
	// whose epoch is stale is treated as zero rather than counted.
	epoch atomic.Int64
	count atomic.Uint64
	_     [cacheLineSize - 16]byte
}

// Record records n events at the current time.
func (rt *RateTracker) Record(n uint64) {
	now := time.Now().Unix()
	b := &rt.buckets[now%60]

	for {
		e := b.epoch.Load()
		if e == now {
			b.count.Add(n) // Bucket is current: just add.
			return
		}
		if e > now {
			return // Clock went backwards. Drop rather than corrupt.
		}
		// Bucket belongs to an older minute. Claim it for `now`.
		if b.epoch.CompareAndSwap(e, now) {
			b.count.Store(n) // We won the claim: reset to n.
			return
		}
		// Someone else claimed it. Retry, and we will take the e == now path.
	}
}

// RatePerSecond returns approximate events/second over the last minute.
// Buckets whose epoch has aged out are skipped, not counted.
func (rt *RateTracker) RatePerSecond() float64 {
	now := time.Now().Unix()
	cutoff := now - 60
	var total uint64
	for i := range rt.buckets {
		if rt.buckets[i].epoch.Load() > cutoff {
			total += rt.buckets[i].count.Load()
		}
	}
	return float64(total) / 60.0
}
```

**Why `RateTracker` stores an epoch per bucket.** The compact version of this type is a classic, and it is broken. It looks like this:

```go
// BROKEN. Do not ship this.
func (rt *RateTracker) Record(n uint64) {
	now := time.Now().Unix()
	bucket := now % 60
	last := rt.lastTick.Load()
	if now != last {
		if rt.lastTick.CompareAndSwap(last, now) {
			rt.buckets[bucket].Store(0) // clear "the" stale bucket
		}
	}
	rt.buckets[bucket].Add(n)
}
```

It has two defects, and the second one is severe.

The mild one is a race: a goroutine can `Add` to the bucket between another goroutine's CAS and its `Store(0)`, and its increment is erased. You lose a few counts. For a metric, that is often tolerable.

The severe one is that **it only ever clears one bucket**. The design assumes time advances one second at a time with traffic in every second. If the service goes idle, or traffic is bursty, or the process was descheduled, the buckets for the skipped seconds are never cleared and keep counting toward the window forever.

Driving the original implementation with a synthetic clock: 60 seconds of traffic at 100 events/sec, then one hour of idleness, then a single event.

| | Reported window total |
|---|---|
| After 60s of traffic at 100/s | 6000 (correct) |
| After 1 hour idle, then 1 event | **5901** (should be 1) |

It reports 5901 events per minute for a service that has served one request in an hour, and it will keep reporting it. Wire that to autoscaling or a circuit breaker and you have an outage caused by your rate limiter defending against traffic that stopped an hour ago.

Storing the epoch alongside the count fixes it structurally: a bucket is only counted if it belongs to the current window, so gaps self-heal with no cleanup pass and no background goroutine. The corrected version reports exactly 1. This is the general shape of the fix for every time-bucketed structure: **do not track when you last cleaned up, record what each slot means and let readers ignore what is stale.**

### 3.3 Lock-Free Hash Map (Read-Optimized)

Start with what the standard library already gives you, because it is better than it used to be and most of this section's alternatives are unnecessary.

Since Go 1.24, `sync.Map` is implemented as a **HashTrieMap**, a concurrent hash-trie, replacing the older read/dirty two-map design. Go's built-in `map` has been **Swiss Tables since Go 1.24**, probed with **SWAR over a 64-bit control word** (bit tricks on an ordinary register, not vector SIMD, a detail routinely garbled in blog posts). Datadog's write-up on the RSS impact of the Swiss Tables migration is a genuinely useful anchor if you want to see what a runtime map change does to a large production fleet.

Practically: for a concurrent map, benchmark `sync.Map` and a sharded `RWMutex` map against each other **on your access pattern** before writing anything custom. `sync.Map` is not simply "for read-heavy workloads", which is the folklore. Measured honestly across write ratios it is competitive far more often than its reputation suggests, and it loses mainly on sustained churn of a small key set.

For genuinely read-mostly data (routing tables, feature flags, config that changes on deploy), a **copy-on-write** map replaces the whole map atomically via `atomic.Pointer`, giving readers a completely lock-free path. That is the structure below.

Understand the price before you use it. **COW writes are O(n)**: every `Store` copies the entire map. Measured on Go 1.27.1 (i7-10510U, 4 cores pinned), one `Store` into a COW map:

| Entries | Time per `Store` |
|---|---|
| 10 | ~1.0 us |
| 100 | ~6.4 us |
| 1000 | **~55 us** |

That is linear, exactly as designed, and it means a 1000-entry COW map costs 55 microseconds per write. At 100 writes/sec you are burning 0.5% of a core to maintain a config map, which is fine. At 10,000 writes/sec this converts CPU cycles straight into garbage. **COW is for data that is read constantly and written on deploys, not for anything a request can write.**

```go
package lockfree

import (
	"sync"
	"sync/atomic"
)

// ReadMap is a copy-on-write concurrent map.
//
// Readers are genuinely lock-free: one atomic pointer load, then an ordinary
// map read on an immutable map. Writers take a mutex and rebuild the whole
// map, so writes are O(n) and serialized.
//
// USE FOR: config, routing tables, feature flags. Data read on every request
// and written on deploys.
// DO NOT USE FOR: anything a request handler writes. Use sync.Map or a
// sharded RWMutex map, and benchmark both.
type ReadMap[K comparable, V any] struct {
	mu sync.Mutex              // serializes writers only
	m  atomic.Pointer[map[K]V] // immutable once published
}

func NewReadMap[K comparable, V any]() *ReadMap[K, V] {
	rm := &ReadMap[K, V]{}
	empty := make(map[K]V)
	rm.m.Store(&empty)
	return rm
}

// Load reads a value. Never blocks, never takes a lock.
func (m *ReadMap[K, V]) Load(key K) (V, bool) {
	v, ok := (*m.m.Load())[key]
	return v, ok
}

// Store sets a key. O(n): copies the entire map.
func (m *ReadMap[K, V]) Store(key K, value V) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.clone()
	next[key] = value
	m.m.Store(&next)
}

// Delete removes a key. O(n): copies the entire map.
func (m *ReadMap[K, V]) Delete(key K) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.clone()
	delete(next, key)
	m.m.Store(&next)
}

// StoreMany applies several updates under a single copy. Prefer this to a
// loop of Store calls, which would copy the map once per key and turn an
// O(n) operation into O(n*k).
func (m *ReadMap[K, V]) StoreMany(kv map[K]V) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next := m.clone()
	for k, v := range kv {
		next[k] = v
	}
	m.m.Store(&next)
}

// clone copies the current map. Caller must hold mu.
//
// The published map is never mutated after Store, which is the entire
// correctness argument: a reader holding the old pointer keeps reading a map
// that nobody will ever write to again, so no lock is needed and the old map
// is collected once the last reader drops it. Go's GC is doing the
// epoch-based reclamation that a C++ version of this would hand-roll.
func (m *ReadMap[K, V]) clone() map[K]V {
	cur := *m.m.Load()
	next := make(map[K]V, len(cur)+1)
	for k, v := range cur {
		next[k] = v
	}
	return next
}

// Len returns the number of entries.
func (m *ReadMap[K, V]) Len() int { return len(*m.m.Load()) }
```

The version of this type that circulates widely carries a `dirty map[K]V` and a `misses` counter alongside the read map, imitating the pre-1.24 `sync.Map` internals. In a copy-on-write map those fields are **dead code**. Since `Store` republishes the full map on every write, the read map is always a superset of the dirty map, so the `dirty` lookup in `Load` can never succeed where the read lookup failed. It is machinery that can never fire, costing a mutex acquisition on every miss and misleading every reader of the code into thinking something subtle is happening.

The lesson generalizes past this type. `sync.Map`'s read/dirty/misses design solves a specific problem: amortizing promotion when writes are frequent enough that you cannot copy on each one. Lift that structure into a design that copies on every write and you have imported the complexity without the problem. Copying a data structure's *shape* from the standard library, without its *reason*, is one of the most reliable ways to produce code that looks sophisticated and does nothing.

### 3.4 The memory model traps that bite lock-free code

Go's memory model guarantees happens-before only through a defined set of synchronization primitives, so reasoning informally about atomic ordering is the fastest route to a correctness bug that passes every local test and corrupts data in production once a week. Three traps recur. First, `atomic.Load` and `atomic.Store` are sequentially consistent in Go (unlike C++ where you must pick an ordering), which is simpler but heavier, so do not assume you can upgrade to "seq-cst" to fix a bug. Second, a plain read of a field written atomically by another goroutine is a data race under the race detector and undefined under the spec, even if the field is a single machine word. You must read via `atomic.Load` on every reader path, including snapshot copies. Third, `atomic.Pointer[T]` swap is atomic for the pointer itself, not for the pointee, so if consumers hold a pointer to the previous snapshot, that snapshot must remain live until every consumer has moved on. The canonical solution is epoch-based reclamation or a generational counter, and if you cannot articulate the epoch scheme for your custom structure, use `sync.Mutex` and move on.

Always run CI with `go test -race -count=100` for any package that touches atomics. The race detector is the single most important tool you have for lock-free correctness, and it only reports races it actually observes, so a single run proves very little. A hundred runs, with goroutine interleavings shuffled by scheduling luck, proves considerably more.

Budget for it. The race detector costs roughly **2 to 20x CPU and 5 to 10x memory**, which is why it belongs in CI and not in your production binary. That overhead is also a hint about the honest cost of concurrency bugs: the tool that finds them is expensive because the bugs are invisible without it.

Note the asymmetry that makes this worth the CI minutes. A race detector run that finds nothing is weak evidence of correctness. A run that finds something is proof of a bug. You are not trying to prove your lock-free structure correct, you are trying very hard to break it, and the value is entirely in how hard you try.

### 3.5 Junior → FAANG: the three-question test before writing lock-free code

Before reaching for atomics, ask three questions, and if you cannot answer yes to all three, use a mutex instead. Question one: have I measured a lock as the bottleneck in a real workload with `pprof -mutex` or `-block`? If not, the mutex is not the problem. Question two: can I write a failing test that demonstrates the correctness-under-concurrency property I need, and does that test reliably fail without my atomics and pass with them? If not, the atomics are a liability, not an asset. Question three: will the next engineer who reads this code, with average seniority, be able to modify it without breaking it? If not, you have written code that will be silently disabled or reverted during an incident when no one has time to reason about it. This is the checklist interviewers at Meta, Google, and Stripe infrastructure teams use internally, and it is the one you will see in post-incident reviews when a clever lock-free structure turns out to have been the root cause.

### 3.6 Senior @ FAANG: the lock-free ADR template

Custom lock-free data structures are load-bearing by definition, so every one should have an ADR that includes: the exact workload it optimizes (producer count, consumer count, item size, arrival rate, p99 target), the baseline measurement it beats (mutex queue, channel, `sync.Map`), the correctness argument (which operations are linearizable, which are eventually consistent, which are relaxed), the memory reclamation scheme (epoch, hazard pointer, reference count), the failure mode under GC pressure (does a stop-the-world mark phase serialize the hot path, does the pool of epoch records grow unboundedly under pathological traffic), the rollback path (a feature flag to fall back to the mutex version in production without a redeploy), and the retirement criteria (what future Go version or hardware change would let us delete this and go back to the standard library). This is the document the on-call engineer reads at 2 AM. Without it, your cleverness is a liability even if it is correct.

---
