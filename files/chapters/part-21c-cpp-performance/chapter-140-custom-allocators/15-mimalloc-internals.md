## Mimalloc Internals

Mimalloc is Microsoft Research's allocator (Daan Leijen, 2019). It is the youngest of the production-grade trio, the smallest in code size (~11KLOC vs jemalloc's 50KLOC+), and in many benchmarks the fastest. It is the default allocator inside Microsoft's Azure C++ services and a strong choice for new projects. Version 2.x was the long-stable line, with 3.x released in early 2025 and maturing since.

### Free List Sharding: The Core Idea

The headline trick in mimalloc is "free list sharding." Older allocators keep one free list per size class per thread. Mimalloc keeps one free list per page (where a page is ~64KiB of one size class). When a page is full, you move on. When a page is freed, you reclaim it as a unit.

This sounds small. The consequences are large.

- Locality: allocations from the same page tend to be close in memory. A hot loop allocating and freeing repeatedly stays inside one page, which stays in L1.
- Bounded latency: scanning a page's free list is bounded by the page size. There is no pathological "walk a 1M-element free list" case.
- Cheap reclaim: reclaiming a fully-free page is moving a pointer. No coalescing.

```cpp
// Conceptual layout. Real mimalloc is more compact.
struct mi_page_t {
    mi_block_t* free;          // local free list
    mi_block_t* local_free;    // freed by owning thread, not yet recycled
    std::atomic<mi_block_t*> thread_free;  // freed by foreign threads
    uint16_t used;
    uint16_t capacity;
    uint8_t  block_size_bin;
    // ...
};
```

Three free lists per page. `free` is the fast path. `local_free` accumulates frees by the owning thread within an "epoch" so the fast path stays branch-free. `thread_free` is a CAS-based MPSC list for cross-thread frees.

### Pages and Segments

A page is one size class. A segment is 4MiB of contiguous memory containing many pages of varying size classes. Segments are the unit of `mmap`. Pages are the unit of size class assignment. Blocks are the unit of allocation.

```
segment (4 MiB)
    [ page 64KiB | page 64KiB | page 64KiB | ... | page 512KiB ]
                                                    ^ medium page
```

Small allocations (<= 8KiB) come from small pages. Medium (<= 512KiB) from medium pages. Large (<= 2MiB) from full segments. Huge (> 2MiB) from dedicated `mmap` calls.

### Bounded Worst-Case Latency

Mimalloc explicitly bounds the worst-case allocation latency. The free list is a linked list of fixed length per page. The page chooser is a constant-bounded scan. Claiming a new page is a single atomic on the heap's page queue. There is no path that walks an unbounded structure.

This matters for soft real-time C++ (game engines, audio, low-latency trading). Jemalloc's purge can stall on `madvise`. TCMalloc's central cache spinlock can spike under contention. Mimalloc's hot path has a fixed instruction count.

### Secure Mode

Compile with `-DMI_SECURE=4` and mimalloc enables a stack of hardening features.

- Guard pages between segments. Bracketed with `PROT_NONE` so a linear overflow segfaults rather than corrupting the next allocation.
- Encoded free list pointers. Each `next` pointer in a free list is XOR'd with two per-page secrets. A leaked free list does not leak heap addresses, and overwriting a free list pointer with attacker-controlled data produces an unmapped target.
- Randomized allocation. Within a page, the next free block is chosen randomly, not LIFO. Defeats type-confusion exploits that rely on predictable reuse.
- Double-free detection. The encoded free list naturally detects most double frees because the second free's encoded `next` does not match.

`MI_SECURE=4` costs ~5-10% throughput. For services that touch untrusted data this is the right trade. For internal batch jobs it is overhead.

### Thread-Local Heaps

Each thread has its own heap. Heaps own page queues. Allocations are thread-local and lock-free on the fast path. Cross-thread frees use the `thread_free` MPSC list per page.

You can also create explicit named heaps and free an entire heap at once.

```cpp
#include <mimalloc.h>

mi_heap_t* h = mi_heap_new();
void* p1 = mi_heap_malloc(h, 64);
void* p2 = mi_heap_malloc(h, 1024);
// ... use ...
mi_heap_destroy(h);  // frees p1, p2, and everything else allocated in h
```

This is a region allocator built into the general allocator. Useful for request-scoped lifetimes (web request handler, query processor, frame in a game engine). Faster than `delete`-ing individual objects because freeing skips per-object work.

### Comparison vs Jemalloc and TCMalloc

| Workload | Mimalloc | Jemalloc | TCMalloc (modern) |
|--------------------------------|----------|----------|-------------------|
| Single-threaded malloc/free | best | good | good |
| Many small allocs, low contention | best | good | best |
| High-contention multi-thread | good | best | best |
| RSS / memory tightness | good | best | good |
| Tail latency (p99.9) | best | good | good |
| Code size (footprint) | best | poor | poor |
| Ease of building | best | good | poor (Bazel only) |
| Hugepage awareness | yes | yes | best (TEMERAIRE) |
| Profiling tools maturity | good | best | best |

Pick mimalloc for new code, soft real-time, embedded, or when binary size matters. Pick jemalloc when RSS is the dominant constraint or when extent hooks are needed (NUMA-pinned arenas, shared-memory backing). Pick tcmalloc on Linux at hyperscale where TEMERAIRE-style hugepage management pays off.

### Override at Link or Runtime

```bash
# Link override (preferred, lower startup cost):
g++ -O2 main.cc -lmimalloc

# Runtime override:
LD_PRELOAD=/usr/lib/libmimalloc.so ./binary

# Stats on exit:
MIMALLOC_VERBOSE=1 MIMALLOC_SHOW_STATS=1 ./binary
```

### Tuning Knobs Worth Knowing

- `MIMALLOC_PAGE_RESET=1`: reset (decommit) free pages aggressively, lower RSS at the cost of some throughput.
- `MIMALLOC_LARGE_OS_PAGES=1`: try to back segments with hugepages.
- `MIMALLOC_RESERVE_HUGE_OS_PAGES=N`: pre-reserve N gigabytes of hugepages at startup. Critical for trading systems that cannot afford a runtime hugepage promotion.
- `MIMALLOC_PURGE_DELAY=10`: ms before a freed page is purged.

### Junior to FAANG

A junior engineer benchmarks mimalloc against the system allocator on a single-threaded microbench, sees a 2x win, and ships. A FAANG-grade engineer benchmarks all three production allocators on the actual production workload (read mix, alloc size distribution, thread topology, cross-thread free pattern), measures p99.9 latency and RSS together, and picks the one that wins on the metric that matters for the service. They also know mimalloc's `mi_heap_destroy` is the fastest "free a million objects" call in C++ and use it for request-scoped heaps.
