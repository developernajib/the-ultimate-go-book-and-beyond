## 90G.5 Discord's Go-to-Rust Migration: When the Garbage Collector Becomes the Enemy

### The Incident

In February 2020, Discord publicly documented their migration of the Read States service from Go to Rust. This
service tracks which channels and messages every user has read - a deceptively simple requirement that operates at
enormous scale: billions of Read States, millions of concurrent users per cache server, and hundreds of thousands
of updates per second.

The Go implementation worked correctly. It was not producing wrong results or crashing. The problem was the
garbage collector. Discord's Read States service maintained a massive LRU (Least Recently Used) cache in memory.
Go's garbage collector, which at the time ran every 2 minutes (forced by `GOGC`), had to scan the entire heap
including this massive cache. Each GC cycle caused latency spikes of 10-40 milliseconds.

**The GC Problem Visualized:**

```
┌──────────────────────────────────────────────────────────────────────┐
│              Go Read States Service - Latency Over Time              │
│                                                                      │
│  Latency                                                             │
│  (ms)                                                                │
│  40 │          ┌┐              ┌┐              ┌┐                    │
│     │          ││              ││              ││     ← GC spikes    │
│  30 │         ┌┘│             ┌┘│             ┌┘│       every 2min   │
│     │         │ │             │ │             │ │                    │
│  20 │        ┌┘ │            ┌┘ │            ┌┘ │                    │
│     │        │  │            │  │            │  │                    │
│  10 │       ┌┘  └┐          ┌┘  └┐          ┌┘  └┐                   │
│     │       │    │          │    │          │    │                   │
│   1 │───────┘    └──────────┘    └──────────┘    └────── baseline    │
│     │                                                                │
│     └───────┬──────────┬──────────┬──────────┬──────────             │
│         0:00        2:00        4:00        6:00  (minutes)          │
│                                                                      │
│  Problem: GC must scan entire heap including LRU cache               │
│  Cache: millions of entries = millions of pointers to scan           │
│  GC cannot be tuned away - it MUST scan live objects                 │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│              Rust Read States Service - Latency Over Time            │
│                                                                      │
│  Latency                                                             │
│  (ms)                                                                │
│  40 │                                                                │
│     │                                                                │
│  30 │                                                                │
│     │                                                                │
│  20 │                                                                │
│     │                                                                │
│  10 │                                                                │
│     │                                                                │
│   1 │                           (nothing here)                       │
│     │                                                                │
│  µs │───────────────────────────────────────────────── flat line     │
│     │                                                                │
│     └───────┬──────────┬──────────┬──────────┬──────────             │
│         0:00        2:00        4:00        6:00  (minutes)          │
│                                                                      │
│  Result: No GC = no spikes. Average response: microseconds.          │
│  Cache raised to 8M entries without penalty.                         │
│  BTreeMap for cache locality instead of HashMap.                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Why Go's GC Was the Problem

Go's garbage collector is a concurrent, tri-color mark-and-sweep collector. It is excellent for most workloads.
But it has a fundamental characteristic that becomes a liability for specific use cases: it must scan every
pointer on the heap to determine what is alive.

When your service has a massive in-memory cache with millions of entries, each GC cycle must traverse millions of
pointers. This takes time proportional to the number of live objects, not the amount of memory used. You could
have 100GB of cache entries, but if those entries contain pointers (which Go slices, maps, strings, and interfaces
all do), the GC must visit every one.

```go
package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"time"
)

// DemonstrateGCPressure shows why large pointer-heavy caches cause GC problems.
func DemonstrateGCPressure() {
	// Simulate Discord's Read State cache at smaller scale
	type ReadState struct {
		UserID      uint64
		ChannelID   uint64
		LastReadMsg uint64
		MentionCount int
		Flags       uint32
	}

	// Build a large cache - each entry has pointers (map keys, values)
	cache := make(map[uint64]*ReadState, 5_000_000)
	for i := uint64(0); i < 5_000_000; i++ {
		cache[i] = &ReadState{
			UserID:      i,
			ChannelID:   i % 100_000,
			LastReadMsg: i * 17,
		}
	}

	// Force GC and measure
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	fmt.Printf("Heap objects: %d\n", stats.HeapObjects)
	fmt.Printf("Heap alloc: %d MB\n", stats.HeapAlloc/1024/1024)

	start := time.Now()
	runtime.GC()
	gcDuration := time.Since(start)
	fmt.Printf("GC duration with 5M cached entries: %v\n", gcDuration)
	// On a typical machine: 10-50ms - exactly Discord's problem

	_ = cache // keep alive
}

// MitigationOption1_ReducePointers reduces GC pressure by using value types
// instead of pointer types in the cache.
func MitigationOption1_ReducePointers() {
	type ReadState struct {
		UserID      uint64
		ChannelID   uint64
		LastReadMsg uint64
		MentionCount int32
		Flags       uint32
	}

	// Value type map: entries are stored inline, fewer pointer scans
	// Still has overhead from map bucket pointers, but much less
	cache := make(map[uint64]ReadState, 5_000_000)
	for i := uint64(0); i < 5_000_000; i++ {
		cache[i] = ReadState{
			UserID:      i,
			ChannelID:   i % 100_000,
			LastReadMsg: i * 17,
		}
	}

	start := time.Now()
	runtime.GC()
	gcDuration := time.Since(start)
	fmt.Printf("GC duration with value-type cache: %v\n", gcDuration)
	// Measurably less than pointer-type cache

	_ = cache
}

// MitigationOption2_OffHeap moves data off the GC-managed heap entirely.
// This uses a technique where data is stored in a large byte slice,
// which the GC sees as a single allocation (1 pointer to scan).
func MitigationOption2_OffHeap() {
	type ReadState struct {
		UserID      uint64
		ChannelID   uint64
		LastReadMsg uint64
		MentionCount int32
		Flags       uint32
	}

	const entrySize = 8 + 8 + 8 + 4 + 4 // 32 bytes per entry
	const numEntries = 5_000_000

	// Single allocation - GC sees ONE pointer, not 5 million
	arena := make([]byte, entrySize*numEntries)

	// Index maps user ID to offset in the arena
	index := make(map[uint64]int, numEntries)

	_ = arena
	_ = index

	// The arena is opaque to GC - it scans only the []byte header (1 pointer)
	// The index still has 5M entries, but there are no pointers to ReadState objects
	// because the actual data lives in the byte slice

	start := time.Now()
	runtime.GC()
	gcDuration := time.Since(start)
	fmt.Printf("GC duration with off-heap arena: %v\n", gcDuration)
}

// MitigationOption3_GOMEMLIMIT uses the modern GOMEMLIMIT approach
// (available since Go 1.19) to control GC behavior.
func MitigationOption3_GOMEMLIMIT() {
	// Set GOGC to a very high value or off, and use GOMEMLIMIT instead
	// This tells the GC: "don't run until you approach this memory limit"

	// In production, set via environment:
	// GOMEMLIMIT=32GiB
	// GOGC=off

	// Programmatically:
	debug.SetGCPercent(-1) // disable GOGC-triggered collections
	debug.SetMemoryLimit(32 * 1024 * 1024 * 1024) // 32 GiB

	// The GC will now only run when memory usage approaches 32 GiB
	// This dramatically reduces GC frequency for cache-heavy services

	// WARNING: If your service legitimately uses near-limit memory,
	// GC will run very frequently near the limit (GC thrashing).
	// Set the limit well above your steady-state usage.
}
```

### When Go Is NOT the Right Choice

Discord's migration teaches an important lesson: Go is not the right tool for every job, and senior Go engineers
must know when to recommend a different language.

**Go's GC is a problem when:**
- Your service maintains millions of pointer-heavy objects in memory
- You have strict latency SLOs (p99 < 1ms) on the hot path
- The hot path intersects with GC pauses
- Your cache size cannot be reduced for business reasons

**Go's GC is fine when:**
- Your hot path completes in microseconds and GC pauses are milliseconds (still fast enough)
- Your heap is relatively small (< 1 million live objects)
- Your p99 latency SLO is in the tens of milliseconds
- You can use GOMEMLIMIT to reduce GC frequency
- You can move data off-heap (byte slices, mmap, external cache like Redis)

**Before migrating away from Go, try:**

1. **GOMEMLIMIT + GOGC=off** - the modern approach (Go 1.19+)
2. **Off-heap storage** - store data in `[]byte` arenas that GC sees as single allocations
3. **External cache** - move the hot cache to Redis/Memcached
4. **Value types** - use structs instead of pointers in maps
5. **sync.Pool** - for transient allocations on the hot path
6. **Reduce allocation rate** - preallocate, reuse buffers

### Junior → FAANG: GC Tuning as an Interview Topic

The GOMEMLIMIT + GOGC=off pattern is Go 1.19+ and is the modern answer to "how do you handle GC pressure in a latency-sensitive Go service." Know that GOGC controls the trigger ratio (heap growth relative to live set) and GOMEMLIMIT provides a hard ceiling. The six mitigations in this section (GOMEMLIMIT, off-heap, external cache, value types, sync.Pool, reduced allocation rate) are the ordered checklist an interviewer expects you to describe before recommending a language change.

### Senior @ FAANG: Language Selection as an ADR

At L6, the decision to migrate from Go to Rust (or any language change) is an ADR requiring quantified justification. The ADR for Discord's migration would document: the measured GC pause duration (2+ second spikes), the measured p99 latency SLO miss rate, the mitigations attempted and their measured improvement, the estimated engineering cost of the migration, and the expected latency improvement after migration. Without this documentation, the decision looks like a preference rather than an engineering judgment. Bar-raiser interviewers ask "why did you choose this language for this service?" and expect a data-backed answer.

The most important lesson at staff level is not the GC technical details but the framework for when to abandon Go. The six-item mitigation checklist is a required process gate before any language migration decision. If you can document that you tried all six and the performance requirement still cannot be met, the language migration is justified. If you skipped any of them, you have not made the case.

---
