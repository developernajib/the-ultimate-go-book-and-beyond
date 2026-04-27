export default `## 7.3 Memory Layout and Allocator

### Process Memory Segments

A Go process uses distinct memory segments: the text segment for code, a data segment for globals, and a heap managed by the Go allocator. Understanding these segments helps interpret memory profiling output.

\`\`\`
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Process Memory Layout                            │
├──────────────────────────────────────────────────────────────────────────────┤
│  High Address                                                                 │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                          Kernel Space                                   │  │
│  │                    (not accessible from user code)                      │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                             Stack                                       │  │
│  │            (grows downward, goroutine stacks allocated here)           │  │
│  │                               ↓                                         │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                         │  │
│  │                          Unused Space                                   │  │
│  │                                                                         │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                               ↑                                         │  │
│  │                             Heap                                        │  │
│  │           (Go's memory allocator manages this region)                  │  │
│  │         (grows upward, objects allocated by runtime)                   │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                             BSS                                         │  │
│  │                (uninitialized global variables)                        │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                            Data                                         │  │
│  │                 (initialized global variables)                         │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                            Text                                         │  │
│  │                    (compiled program code)                             │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  Low Address (0x0)                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Go's Memory Allocator (TCMalloc Variant)

Go uses a variant of TCMalloc (Thread-Caching Malloc) optimized for concurrent allocation:

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Go Memory Allocator Architecture                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                            mheap (Global Heap)                          │ │
│  │  • Single instance per process                                         │ │
│  │  • Manages memory arenas (64MB chunks on 64-bit)                       │ │
│  │  • Handles allocations > 32KB                                          │ │
│  │  • Protected by lock (contention point for large allocs)               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│         ┌──────────────────────────┼──────────────────────────┐             │
│         │                          │                          │             │
│         ▼                          ▼                          ▼             │
│  ┌────────────────┐       ┌────────────────┐       ┌────────────────┐      │
│  │mcentral(size 8)│       │mcentral(size16)│       │mcentral(sizeN) │      │
│  │                │       │                │       │                │      │
│  │ Central free   │       │ Central free   │       │ Central free   │      │
│  │ list for 8B    │       │ list for 16B   │       │ list for NB    │      │
│  │ objects        │       │ objects        │       │ objects        │      │
│  │                │       │                │       │                │      │
│  │ One lock per   │       │ One lock per   │       │ One lock per   │      │
│  │ size class     │       │ size class     │       │ size class     │      │
│  └───────┬────────┘       └───────┬────────┘       └───────┬────────┘      │
│          │                        │                        │                │
│     ┌────┴────┐              ┌────┴────┐              ┌────┴────┐          │
│     ▼         ▼              ▼         ▼              ▼         ▼          │
│ ┌───────┐ ┌───────┐     ┌───────┐ ┌───────┐     ┌───────┐ ┌───────┐       │
│ │mcache │ │mcache │     │mcache │ │mcache │     │mcache │ │mcache │       │
│ │ (P0)  │ │ (P1)  │     │ (P0)  │ │ (P1)  │     │ (P0)  │ │ (P1)  │       │
│ │       │ │       │     │       │ │       │     │       │ │       │       │
│ │NO LOCK│ │NO LOCK│     │NO LOCK│ │NO LOCK│     │NO LOCK│ │NO LOCK│       │
│ └───────┘ └───────┘     └───────┘ └───────┘     └───────┘ └───────┘       │
│                                                                              │
│  mcache: Per-P cache, no locks needed for allocation                        │
│  mcentral: Central free list, one lock per size class                       │
│  mheap: Global heap, manages arenas and large allocations                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Size Classes

Rather than allocating the exact number of bytes requested, Go rounds each allocation up to one of 67 predefined size classes (from 8 bytes to 32KB). This rounding simplifies free-list management and reduces fragmentation at the cost of slight internal waste. The following program shows how requested sizes map to actual capacities.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "unsafe"
)

func main() {
    // Demonstrate size class rounding
    sizes := []int{1, 8, 9, 16, 17, 32, 48, 64, 80, 96, 112, 128, 256, 512, 1024}

    for _, size := range sizes {
        // Allocate object of specified size
        data := make([]byte, size)

        // Get actual allocated size using runtime internals
        // Note: This is for demonstration; don't rely on this in production
        var m runtime.MemStats
        runtime.ReadMemStats(&m)

        fmt.Printf("Requested: %4d bytes, Allocated: %4d bytes (ptr: %p)\\n",
            size, cap(data), unsafe.Pointer(&data[0]))
    }
}

// Common size classes:
// 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256,
// 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024, 1152, 1280,
// 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864, 5376, 6144, 6528,
// 6784, 6912, 8192, 9472, 9728, 10240, 10880, 12288, 13568, 14336, 16384, 18432, 19072,
// 20480, 21760, 24576, 27264, 28672, 32768
\`\`\`

### Tiny Allocations

The allocator has a special path for objects smaller than 16 bytes that contain no pointers. Instead of giving each tiny object its own 8-byte minimum block, it packs multiple tiny objects into a single 16-byte block. This dramatically reduces per-object overhead for small scalar types like \`int8\`, \`bool\`, and small strings. The program below measures the actual heap impact of 1000 tiny allocations.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "unsafe"
)

func main() {
    runtime.GC()
    var m1, m2 runtime.MemStats
    runtime.ReadMemStats(&m1)

    // Allocate 1000 tiny objects
    ptrs := make([]*int8, 1000)
    for i := range ptrs {
        ptrs[i] = new(int8) // 1 byte each
    }

    runtime.ReadMemStats(&m2)

    // Without tiny allocator: 1000 allocations * (8 bytes min + overhead) = ~16KB
    // With tiny allocator: packed into fewer blocks
    fmt.Printf("Heap increase: %d bytes for 1000 int8s\\n", m2.HeapAlloc-m1.HeapAlloc)
    fmt.Printf("Expected without tiny: %d bytes\\n", 1000*16)

    // Show that addresses are close together
    fmt.Printf("Address diff between [0] and [1]: %d bytes\\n",
        uintptr(unsafe.Pointer(ptrs[1]))-uintptr(unsafe.Pointer(ptrs[0])))

    _ = ptrs // Keep alive
}
\`\`\`

### Large Object Allocation

Objects larger than 32KB do not fit into any size class. These allocations go directly to \`mheap\`, which carves out spans of the required size from its arena pool. Because \`mheap\` access requires a global lock, frequent large allocations become a contention point under high concurrency.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
)

func main() {
    // Small allocation (uses mcache -> mcentral)
    small := make([]byte, 1024) // 1KB

    // Large allocation (direct from mheap)
    large := make([]byte, 64*1024) // 64KB

    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    fmt.Printf("HeapAlloc: %d KB\\n", m.HeapAlloc/1024)
    fmt.Printf("HeapObjects: %d\\n", m.HeapObjects)
    fmt.Printf("HeapSys: %d KB\\n", m.HeapSys/1024)
    fmt.Printf("HeapInuse: %d KB\\n", m.HeapInuse/1024)

    _, _ = small, large
}
\`\`\`

**Uber's Optimization**: Uber discovered that their high-throughput services were experiencing lock contention on mheap for large allocations. They reduced large allocations by using buffer pools and pre-allocated arenas.

### The Size-Class Mental Model

Go's allocator uses size classes (roughly 70 distinct sizes from 8 bytes to 32 KB). Each size class has its own free list per P. Allocations within a size class are O(1) lock-free from the per-P cache. The senior-track implications:

1. **Allocations that straddle size-class boundaries waste memory.** A 513-byte allocation gets rounded up to the next size class (typically 576 bytes). For high-count allocations, the overhead compounds.
2. **Pool-backed allocations bypass the size class.** \`sync.Pool\` returns the exact same backing buffer repeatedly, which avoids the allocator entirely.
3. **Large allocations (>32 KB) go direct to the heap.** These acquire a global lock on \`mheap\`. Under contention (many goroutines allocating large buffers simultaneously), this can become a bottleneck.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **Arena-style manual memory management.** Proposals to add manual arenas to a Go service are usually a sign that the team has not exhausted the cheaper options (\`sync.Pool\`, pre-allocation, reducing allocation rate). Arenas are the last resort.
2. **Allocations sized just over a size-class boundary.** \`make([]byte, 65)\` allocates 80 bytes (or the nearest size class). \`make([]byte, 64)\` allocates 64. For high-count buffers, the difference compounds.

---
`;
