## Section 2: Memory Allocator Internals

### 2.1 TCMalloc-Based Allocator

Go's allocator is based on TCMalloc (Thread-Caching Malloc) with three tiers:

```
┌───────────────────────────────────────────────────────────────────┐
│                   Go Memory Allocator Hierarchy                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Request: allocate 32 bytes                                       │
│                     │                                             │
│                     ▼                                             │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  mcache (per-P cache, no locking needed)             │         │
│  │  - 67 size classes: 8B, 16B, 24B, 32B, 48B … 32KB    │         │
│  │  - Each size class has a free list of spans          │         │
│  │  - 32-byte class → take from free list → O(1)        │         │
│  └──────────────────────┬───────────────────────────────┘         │
│                         │ mcache exhausted                        │
│                         ▼                                         │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  mcentral (per-size-class, one mutex)                │         │
│  │  - Refills mcache with a span of objects             │         │
│  │  - Two per size class: scan and noscan spans         │         │
│  └──────────────────────┬───────────────────────────────┘         │
│                         │ mcentral exhausted                      │
│                         ▼                                         │
│  ┌──────────────────────────────────────────────────────┐         │
│  │  mheap (global, one mutex)                           │         │
│  │  - 8KB pages, managed as spans                       │         │
│  │  - Page allocator: pageAlloc radix tree (Go 1.14+)   │         │
│  │    replaced the old treap. O(1) page find on         │         │
│  │    the common path, scales better under contention.  │         │
│  │  - Requests memory from OS via mmap                  │         │
│  │  - Objects > 32KB allocated directly from mheap      │         │
│  └──────────────────────────────────────────────────────┘         │
│                                                                   │
│  Key insight: the mcache fast path takes no lock at all.          │
│  A P owns its mcache, so the common small alloc needs no          │
│  atomics. Locks appear only on refill (mcentral/mheap).           │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 Size Classes and Fragmentation

Go's memory allocator assigns every small object to one of 67 size classes, rounding the allocation up to the class boundary. That gives slab-like reuse without per-object metadata, and it means the memory you are charged for is the class size, not the size of your struct.

That rounding is where the waste hides. A 33-byte object does not get a 33-byte slot, and it cannot be "padded down" to the 32-byte class, since the class must be at least as large as the object. It lands in the next class up, which is 48 bytes, so 15 bytes per object are lost to internal fragmentation. Shrinking that struct by one byte, to 32, moves it into the 32-byte class and cuts its real footprint by a third. That is the whole game with size classes: the win comes from crossing a boundary downward, not from shaving bytes in general. Trimming a 40-byte struct to 36 bytes changes nothing at all, because both land in the 48-byte class.

The analysis below uses `unsafe.Sizeof` and the size class table to show how struct layout choices affect what the allocator actually charges you.

```go
package allocator

import (
	"unsafe"
)

// SizeClass returns the Go allocator size class for n bytes.
// Knowing this helps design structs that fit within one size class.
func SizeClass(n uintptr) uintptr {
	// Go has 67 size classes, from 8 bytes up to 32768. The exact table
	// lives in runtime/sizeclasses.go, which is generated, so treat this
	// copy as a snapshot and not as the source of truth.
	//
	// Note the sequence is not a smooth progression. It jumps 768 -> 896
	// -> 1024, with no 832 and no 960 class. The gaps are deliberate: each
	// class is chosen so objects divide into 8KB pages with bounded waste.
	// Guessing the table from memory is how people end up reasoning about
	// classes that do not exist. Verify it instead. The bucket bounds of
	// the /gc/heap/allocs-by-size:bytes histogram in runtime/metrics are
	// exactly these classes, so you can print the live table from any
	// program rather than trusting a listing in a book.
	//
	// Allocating n bytes uses the next larger size class.
	sizeClasses := []uintptr{
		8, 16, 24, 32, 48, 64, 80, 96, 112, 128,
		144, 160, 176, 192, 208, 224, 240, 256, 288, 320,
		352, 384, 416, 448, 480, 512, 576, 640, 704, 768,
		896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688,
		3072, 3200, 3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912,
		8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384, 18432,
		19072, 20480, 21760, 24576, 27264, 28672, 32768,
	}
	for _, sc := range sizeClasses {
		if sc >= n {
			return sc
		}
	}
	return n // Large object
}

// StructSizeOptimizer analyzes struct layout.
// Field ordering matters: misaligned fields cause padding waste.
// Go aligns fields to their natural alignment (int64 → 8 bytes, etc.)

// BadLayout wastes 7 bytes due to padding.
type BadLayout struct {
	a bool    // 1 byte + 7 bytes padding (to align int64)
	b int64   // 8 bytes
	c bool    // 1 byte + 7 bytes padding (to align int64)
	d int64   // 8 bytes
	// Total: 32 bytes, 14 bytes wasted
}

// GoodLayout uses field ordering to minimize padding.
type GoodLayout struct {
	b int64 // 8 bytes (8-byte aligned)
	d int64 // 8 bytes
	a bool  // 1 byte
	c bool  // 1 byte + 6 bytes padding (struct alignment)
	// Total: 24 bytes, 6 bytes wasted (saves 8 bytes vs BadLayout)
}

// FieldAlignmentAnalysis demonstrates alignment rules.
func FieldAlignmentAnalysis() {
	type example struct {
		a uint8  // 1 byte
		_ [3]byte // explicit padding
		b uint32 // 4 bytes
		c uint64 // 8 bytes
	}

	// Use unsafe.Offsetof to verify layout.
	_ = unsafe.Offsetof(example{}.a) // 0
	_ = unsafe.Offsetof(example{}.b) // 4
	_ = unsafe.Offsetof(example{}.c) // 8
	_ = unsafe.Sizeof(example{})     // 16
}

// CacheLineAwareness demonstrates cache-line-aligned structs.
// For structs accessed by multiple goroutines, pad to 64 bytes
// to prevent false sharing.
const CacheLineSize = 64

type CacheAlignedCounter struct {
	value uint64
	_     [CacheLineSize - 8]byte // Pad to 64 bytes
}

// PointerDensity measures the fraction of a struct that is pointers.
// High pointer density = more GC scan work per object.
// Minimize pointers in frequently-allocated structs.

// HighPointerDensity: GC must scan every field.
type HighPointerDensity struct {
	Name    *string   // pointer
	Email   *string   // pointer
	Tags    []*string // pointer + slice header
	Address *Address  // pointer
	Profile *Profile  // pointer
}

// LowPointerDensity: GC only scans slice headers, not inline fields.
type LowPointerDensity struct {
	Name    [64]byte  // inline, no pointer
	Email   [128]byte // inline, no pointer
	Tags    []string  // slice header, GC scans the backing array
	AddressCity    [32]byte // inline
	AddressCountry [16]byte // inline
}

// Address and Profile are placeholder types.
type Address struct{ City, Country string }
type Profile struct{ Bio string }
```

### 2.3 Stack Allocation and Growth

Go goroutines start with a 2 KB stack that grows on demand by copying, up to a 1 GB cap on 64-bit platforms. Frequent growth on a hot path costs real work, because each growth allocates a new stack, copies every live frame, and adjusts the pointers that referred into the old one. Values that escape analysis proves do not outlive the frame stay on the stack and cost the GC nothing at all.

The reliable way to see escape decisions is the compiler, not a `GODEBUG` setting. Run `go build -gcflags=-m` (or `-gcflags='-m -m'` for the reasoning chain) and the compiler prints each decision, "moved to heap" or "escapes to heap", per variable. The usual triggers are returning a pointer to a local, storing a value into an interface, capturing a variable in a closure that outlives the frame, and passing to a function the compiler cannot see into. Escape analysis is a compile-time decision, so `-gcflags=-m` is the ground truth, and `allocs/op` in a benchmark is the confirmation.

There is no `GODEBUG` knob that traces stack growth events. If you need to see growth in production, a runtime trace shows goroutine execution and the `/gc/scan/stack:bytes` metric shows total scannable stack, and profiling `runtime.morestack` in a CPU profile is the practical signal that a hot path is repeatedly growing its stack.

```go
package stacks

import (
	"runtime"
	"runtime/debug"
)

// Go goroutine stacks start at 2KB (Go 1.4+) and grow by copying.
// Stack growth is automatic but has cost:
// 1. Allocate new stack (2× current size)
// 2. Copy all stack frames
// 3. Update all pointers to stack-allocated objects
// This is O(stack size) work and can cause latency spikes.

// StackGrowthDemo illustrates when stack growth occurs.
// Deep recursion forces repeated doubling: 2KB → 4KB → 8KB → …
func StackGrowthDemo(depth int) {
	if depth <= 0 {
		return
	}
	// Each frame uses roughly 64 bytes for locals plus the return address.
	// By depth 100 that is about 6400 bytes of stack, which forces two
	// doublings past the 2KB start (2KB → 4KB → 8KB).
	var buf [64]byte
	_ = buf
	StackGrowthDemo(depth - 1)
}

// StackSizeMonitor tracks per-goroutine stack information.
type StackSizeMonitor struct{}

// CurrentGoroutineStack returns the current goroutine's stack trace.
// Use for debugging, not in hot paths.
func (m *StackSizeMonitor) CurrentGoroutineStack(maxDepth int) []runtime.Frame {
	pcs := make([]uintptr, maxDepth)
	n := runtime.Callers(2, pcs)
	frames := runtime.CallersFrames(pcs[:n])

	var result []runtime.Frame
	for {
		frame, more := frames.Next()
		result = append(result, frame)
		if !more {
			break
		}
	}
	return result
}

// AllGoroutineStacks returns a snapshot of all goroutine stacks.
// Use for detecting goroutine leaks in production.
func AllGoroutineStacks() []byte {
	buf := make([]byte, 1<<20) // 1MB buffer
	n := runtime.Stack(buf, true)
	return buf[:n]
}

// StackTuning provides guidance on stack configuration.
//
// GODEBUG=asyncpreemptoff=1 disables async preemption (Go 1.14+).
// Con: a goroutine in a tight loop with no function calls can no longer
// be preempted, so it can delay the start of a GC cycle until it yields.
// That is a much worse failure than the one it avoids. Effectively the
// only reason to set it is debugging, since signal-based preemption
// interferes with some debuggers and can confuse cgo code that is not
// prepared for EINTR. Do not set it as a performance tuning measure.
//
// debug.SetMaxStack(n): Sets maximum goroutine stack size.
// Default: 1GB on 64-bit, 250MB on 32-bit. Reduce to turn runaway
// recursion into a fast, legible crash instead of an OOM.
func StackTuning() {
	// Limit stack to 64MB to catch infinite recursion.
	debug.SetMaxStack(64 * 1024 * 1024)

	// Print GC-related debug output to stderr.
	// GODEBUG=gctrace=1 is set via environment variable, not code.
}

// PreallocateStack demonstrates manual stack preallocation.
// For goroutines that will need large stacks, allocate up front.
func LaunchLargeStackGoroutine(work func()) {
	go func() {
		// Trigger stack growth by calling a recursive function once.
		// This grows the stack from 2KB to the needed size up front.
		prewarmStack(8) // 8 levels × ~1KB each = ~8KB initial stack
		work()
	}()
}

// prewarmStack grows the goroutine stack by recursing n times.
// Each frame uses ~128 bytes.
//
//go:noinline
func prewarmStack(n int) {
	var buf [128]byte
	_ = buf
	if n > 0 {
		prewarmStack(n - 1)
	}
}
```

### 2.4 The Swiss Tables map (Go 1.24+)

Go 1.24 replaced the built-in map implementation with a Swiss Tables design adapted from Google's Abseil C++ library. The mechanism is worth knowing because it is routinely described wrongly. Each group of slots has a small control word holding one byte of metadata per slot, and a lookup tests all slots in the group at once against the hash's top bits. The trick is that Go does this with **SWAR**, SIMD Within A Register, ordinary arithmetic and bitwise operations on a single 64-bit word, rather than with vector SIMD instructions. That is what keeps the implementation portable across every architecture Go targets, and it is why you will not find AVX or NEON in the map fast path. If an interviewer asks how Swiss Tables get their speed and you answer "SIMD," that is the wrong answer for Go.

What changed for you as an operator is less clear-cut than the release-note headline suggests, and this is one of the places to be suspicious of round numbers. Lookups on large maps generally got faster, because a group probe replaces a chain of bucket comparisons. Memory did not uniformly improve. The direction depends on your map size distribution, and services with enormous numbers of very small maps behaved differently from those with a few large ones. Datadog published a detailed investigation of the RSS impact of this change across a large Go fleet, and it is the most useful public data point available, precisely because it shows the effect is workload-dependent rather than a single percentage.

The practical guidance needs no numbers. Iteration order and pointer stability are unchanged at the API level, so no code change is required, and code that reached into map internals through `unsafe` is the only thing that breaks. Because the baseline moved in both directions depending on the workload, re-run your own memory benchmarks after upgrading rather than budgeting for someone else's reported percentage.

### 2.5 Go 1.27: Size-Specialized Allocation Fast Paths

Go 1.27 introduces size-specialized allocation routines: dedicated fast paths for the most common small size classes, cutting small-object allocation cost by up to 30 percent, at a cost of roughly 60 KB of binary size. Nothing about the size-class model, the `mcache`/`mcentral`/`mheap` hierarchy, or the tuning advice in this section changes. The fast path through them just got shorter. The practical follow-up after upgrading: re-run the allocation benchmarks for services where `runtime.mallocgc` is prominent in profiles, and re-evaluate `sync.Pool` usage for medium-sized short-lived objects, because two consecutive releases (Green Tea marking in 1.26, allocation fast paths in 1.27) have both lowered the cost the pool was avoiding.

### 2.6 Junior → FAANG: the struct-alignment drill

Take any struct in your codebase with 5 or more fields. Use `unsafe.Sizeof`, `unsafe.Alignof`, and `unsafe.Offsetof` to print its current layout. Then reorder fields largest to smallest (int64 first, then int32, then int16, then int8, then bool) and reprint. If the size shrank, you just saved that many bytes per allocation times the number of instances. At 1M allocations per second, saving 8 bytes per allocation is 8 MB per second of GC pressure you just removed. Tools exist: `fieldalignment ./...` (the `golang.org/x/tools` analyzer, run as a standalone command), `github.com/dkorunic/betteralign`, or `go run honnef.co/go/tools/cmd/structlayout@latest`. This is a mechanical win that often goes unclaimed because the tools are one-shot. Make it part of your review checklist for new types, and you will ship a measurable RSS reduction every quarter without doing any heroic engineering.

### 2.8 Demystifying Memory: Heap, Runtime Overhead, RSS, and GOMEMLIMIT

When analyzing memory consumption, engineers frequently equate heap allocation with total process footprint. In production containers, this misconception leads to mysterious OOMKills (`ExitCode 137`). To reason accurately about memory, map the runtime's memory topology:

```
Total Process Memory (RSS + VSS)
│
├── Go-Managed Memory
│   │
│   ├── Go Heap (HeapSys)
│   │   ├── HeapInuse
│   │   │   ├── HeapAlloc        ← Actual allocated live Go objects
│   │   │   └── Unused space     ← Fragmentation within active spans
│   │   │
│   │   └── HeapIdle             ← Spans currently holding no objects
│   │       ├── HeapReleased     ← Scavenged memory returned to OS via MADV_DONTNEED
│   │       └── Unreleased Idle  ← Cached spans retained for rapid re-allocation
│   │
│   ├── Goroutine Stacks (StackInuse)  ← Dynamically sized 2KB+ execution stacks
│   ├── GC Work Buffers (GCSys)        ← Mark work queues, pacer tables
│   └── Metadata (MSpanSys, MCacheSys) ← Size-class accounting structures
│
└── Non-Go Memory
    ├── Cgo / Native Memory Allocations
    ├── OS Kernel Thread Stacks
    ├── Shared Libraries & Binary Text Segments
    └── mmap File-Backed Pages (e.g. databases, metrics engines)
```

#### Why Process RSS Exceeds HeapAlloc

1. **Span Internal Fragmentation**: `HeapInuse` includes size-class rounding overhead (e.g. allocating 33 bytes in a 48-byte class slot leaves 15 bytes in-span unallocated).
2. **Scavenger Retention**: After a garbage collection sweep, freed spans enter `HeapIdle`. The runtime scavenger background thread gradually returns unneeded idle pages to the OS via `madvise(MADV_DONTNEED)`. Until scavenged, these pages remain in process RSS.
3. **Stack and Runtime Overhead**: In services with 50,000+ goroutines, `StackInuse` and `GCSys` can exceed total `HeapAlloc`.

#### Tuning GOMEMLIMIT in Containerized Production

Prior to Go 1.19, the only tuning knob was `GOGC` (triggering GC when heap doubles). In a 2 GiB Kubernetes pod with high throughput, a burst in traffic could double the heap from 1.2 GiB to 2.4 GiB, triggering an instant kernel OOMKill before GC could intervene.

`GOMEMLIMIT` establishes a soft memory limit for the entire Go runtime (heap + stacks + runtime structures):
- **Heuristic**: Set `GOMEMLIMIT` to **80% - 85%** of your container's cgroup memory limit (e.g., `GOMEMLIMIT=1700MiB` for a 2 GiB pod).
- **Mechanism**: The GC pacer automatically becomes more aggressive as memory approaches the limit, initiating smaller, more frequent cycles and invoking the page scavenger to prevent pod termination.

> [!NOTE]
> For a detailed architectural breakdown of Go runtime memory taxonomy, span scavengers, and production RSS profiling, see Ashish Kumar's analysis in [*Understanding Memory in Go: Heap, Runtime Memory, RSS, and GOMEMLIMIT*](https://medium.com/search?q=understanding+memory+in+go+heap+runtime+memory+rss+and+gomemlimit).

### 2.7 Senior @ FAANG: when to care about the allocator and when not to

Almost no service is bottlenecked on the allocator itself. The `mcache` fast path is a bump allocation out of a per-P free list with no lock and no atomic, and it is not what is costing you. Resist the urge to attach a nanosecond figure to it, including one from this book. Allocation cost is easy to mis-measure and the number moves with the CPU, the size class, whether the span needs a refill, and whether the compiler removed the allocation entirely. If you want to know, measure your own workload, and trust `allocs/op` and `B/op` from `-benchmem` far more than any `ns/op` you collect on a busy machine.

What services are actually bottlenecked on is the downstream cost of allocations, which comes in three flavors. GC scan work is proportional to pointer density. Cache misses are proportional to object count and pointer chasing. RSS is proportional to span retention. The staff-engineer skill is diagnosing which of the three is hurting you, because each has a different fix. If GC CPU is high, cut allocation rate or pointer density. If cache misses dominate, flatten hot structs and remove indirection. If RSS stays high while `/gc/heap/live:bytes` is low, you are looking at retained spans and scavenging behavior rather than at a leak.

One outdated lever deserves retiring here, because it still circulates. `GODEBUG=madvdontneed=1` was meaningful advice in the Go 1.12 to 1.15 era, when the runtime used `MADV_FREE` on Linux and RSS therefore looked alarmingly high until the kernel felt memory pressure. Go 1.16 changed the default back to `MADV_DONTNEED`, so on any modern Go that setting is already the behavior you get and toggling it accomplishes nothing. The real levers for returning memory are `GOMEMLIMIT`, which makes the scavenger work harder as you approach it, and `debug.FreeOSMemory()` for a deliberate one-shot return. Knowing which diagnosis you are on is what separates a senior engineer who tunes by reflex from a staff engineer who tunes by evidence.

---
