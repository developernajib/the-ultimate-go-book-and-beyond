## Go's Memory Allocator Comparison

Go's runtime allocator is a sophisticated system inspired by tcmalloc. Understanding it illuminates why Go rarely needs custom allocators and why C++ sometimes does.

### Go's Allocator Design

Go's runtime divides memory allocation across three hierarchical tiers: per-P thread-local caches (`mcache`), per-size-class central span lists (`mcentral`), and a global page heap (`mheap`).
```
Go Runtime Allocator Architecture:
+------------------------------------------------+
|  Goroutine                                     |
|  +------------------------------------------+ |
|  | mcache (per-P, lock-free)                 | |
|  | Tiny allocator: <16B objects              | |
|  | Size-class caches: 16B to 32KB           | |
|  +------------------------------------------+ |
+------------------------------------------------+
           |
           v
+------------------------------------------------+
| mcentral (per-size-class, locked)              |
| Manages spans of same size class               |
+------------------------------------------------+
           |
           v
+------------------------------------------------+
| mheap (global, locked)                         |
| Page-level allocation, span management         |
| Backed by OS via mmap/sbrk                     |
+------------------------------------------------+
```

### Key Differences: Go vs C++ Allocators

Comparing Go's integrated runtime allocator against traditional C++ general-purpose allocators highlights differences in concurrency, fragmentation management, and OS reclamation:
```
Feature               Go Allocator              C++ (glibc malloc)
--------------------------------------------------------------------------
Thread-local cache    Yes (per-P mcache)        No (ptmalloc2 has arenas)
Size classes          67 classes, 8B-32KB       Bins, not fixed classes
Tiny objects (<16B)   Dedicated tiny allocator  No special handling
GC integration        Tight (bitmap marking)    N/A (no GC)
Huge page support     Automatic (MADV_HUGEPAGE) Manual
NUMA awareness        Limited (OS-dependent)    None (without libnuma)
Custom allocators     Not supported by language Full support
Memory return to OS   madvise(MADV_DONTNEED)   Rarely automatic
```

### Why Go Does Not Support Custom Allocators

Go's garbage collector needs to know about every allocation. It scans the heap using precise type information and write barriers. A custom allocator would bypass these mechanisms, breaking GC correctness.

The `sync.Pool` is Go's closest equivalent to a pool allocator:

```go
package main

import (
    "fmt"
    "sync"
)

type Buffer struct {
    data [4096]byte
}

var bufferPool = sync.Pool{
    New: func() interface{} {
        return &Buffer{}
    },
}

func processRequest() {
    // Get from pool (or allocate new)
    buf := bufferPool.Get().(*Buffer)

    // Use the buffer
    copy(buf.data[:], []byte("hello"))
    fmt.Println(string(buf.data[:5]))

    // Return to pool for reuse
    bufferPool.Put(buf)
}
```

The arena package (`arena.Arena`) was experimentally added in Go 1.20 behind a GOEXPERIMENT flag. It provides true arena allocation but remains experimental because integrating it with the GC is difficult.

```go
//go:build goexperiment.arenas

package main

import "arena"

type Node struct {
    Value int
    Left  *Node
    Right *Node
}

func buildTree(a *arena.Arena, depth int) *Node {
    if depth == 0 {
        return nil
    }
    // Allocate in the arena -- freed together when arena is freed
    node := arena.New[Node](a)
    node.Value = depth
    node.Left = buildTree(a, depth-1)
    node.Right = buildTree(a, depth-1)
    return node
}

func main() {
    a := arena.NewArena()
    defer a.Free() // Free all arena allocations at once

    root := buildTree(a, 20)
    _ = root
}
```

### When a Go Developer Misses Custom Allocators

- **Latency-sensitive hot paths**: GC pauses (even sub-millisecond) are unacceptable.
- **Millions of small objects**: GC scanning overhead dominates.
- **Object pools beyond sync.Pool**: sync.Pool can be cleared by GC at any time.
- **Memory-mapped I/O**: Go has no zero-copy mmap with allocator integration.

These are exactly the scenarios where C++ custom allocators shine and where choosing C++ over Go for a specific component makes engineering sense.

---
