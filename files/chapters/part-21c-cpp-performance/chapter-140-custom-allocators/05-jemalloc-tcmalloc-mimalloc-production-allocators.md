## jemalloc, tcmalloc, mimalloc, Production Allocators

When you need better performance than the system `malloc` but do not want to write a custom allocator, drop-in replacements offer significant improvements.

### jemalloc (Facebook/Meta)

Originally written for FreeBSD, adopted by Facebook for its server workloads. Redis, Firefox, and many large-scale services use it.

**Key design:**
- Thread-local caches (tcache) eliminate most lock contention.
- Size classes organized into small (8B--14KB), large (16KB--4MB), and huge (>4MB).
- Arenas: multiple independent allocators that threads are assigned to round-robin.
- Extensive profiling and introspection (`malloc_stats_print`, heap profiling).

```cpp
// Link with -ljemalloc or use LD_PRELOAD=libjemalloc.so
// jemalloc replaces malloc/free transparently

// Programmatic control via mallctl API
#ifdef __has_include
#if __has_include(<jemalloc/jemalloc.h>)
#include <jemalloc/jemalloc.h>

void jemalloc_example() {
    // Allocate normally -- goes through jemalloc
    void* p = malloc(1024);
    free(p);

    // Query stats
    size_t allocated, active, mapped;
    size_t sz = sizeof(size_t);
    mallctl("stats.allocated", &allocated, &sz, nullptr, 0);
    mallctl("stats.active", &active, &sz, nullptr, 0);
    mallctl("stats.mapped", &mapped, &sz, nullptr, 0);

    printf("allocated: %zu, active: %zu, mapped: %zu\n",
           allocated, active, mapped);

    // Enable heap profiling
    bool active_profiling = true;
    mallctl("prof.active", nullptr, nullptr, &active_profiling,
            sizeof(active_profiling));
}
#endif
#endif
```

### tcmalloc (Google)

Google's thread-caching malloc, used across Google's infrastructure.

**Key design:**
- Per-thread cache for small allocations (no locks on the fast path).
- Central free list with a transfer cache for cross-thread deallocation.
- Page heap for large allocations using a buddy-like system.
- Aggressive use of huge pages to reduce TLB misses.

```cpp
// Link with -ltcmalloc or LD_PRELOAD=libtcmalloc.so

// tcmalloc provides heap profiling via environment variables:
//   HEAPPROFILE=/tmp/myprogram ./myprogram
//   pprof --text ./myprogram /tmp/myprogram.0001.heap

// Programmatic control
#ifdef __has_include
#if __has_include(<gperftools/malloc_extension.h>)
#include <gperftools/malloc_extension.h>

void tcmalloc_example() {
    void* p = malloc(1024);
    free(p);

    // Release free memory back to OS
    MallocExtension::instance()->ReleaseFreeMemory();

    // Get stats
    size_t value;
    MallocExtension::instance()->GetNumericProperty(
        "generic.current_allocated_bytes", &value
    );
    printf("Currently allocated: %zu bytes\n", value);
}
#endif
#endif
```

### mimalloc (Microsoft)

Microsoft's compact allocator, focused on being both fast and memory-efficient.

**Key design:**
- Free list sharding: each page has its own free list, improving locality.
- Eager page reset: returns physical memory to the OS quickly.
- Small codebase (~8K lines), easier to audit and port.
- Excellent performance on allocation-heavy workloads and on Windows.

```cpp
// Link with -lmimalloc or LD_PRELOAD=libmimalloc.so

#ifdef __has_include
#if __has_include(<mimalloc.h>)
#include <mimalloc.h>

void mimalloc_example() {
    // Drop-in replacement
    void* p = mi_malloc(1024);
    mi_free(p);

    // Aligned allocation
    void* aligned = mi_malloc_aligned(4096, 64);
    mi_free(aligned);

    // Heap-local allocation (isolated heap)
    mi_heap_t* heap = mi_heap_new();
    void* h = mi_heap_malloc(heap, 256);
    mi_heap_destroy(heap);  // Frees all allocations in this heap
}
#endif
#endif
```

### Choosing Between Them

| Criterion | jemalloc | tcmalloc | mimalloc |
|-----------|----------|----------|----------|
| Best for | Long-running servers | Google-style workloads | General purpose, Windows |
| Fragmentation | Low | Moderate | Very low |
| Thread scaling | Excellent | Excellent | Excellent |
| Huge page support | Good | Best (built-in) | Good |
| Profiling | Excellent (built-in) | Excellent (pprof) | Basic |
| Code size | Large | Large | Small |
| Memory overhead | Moderate | Moderate | Low |

**Practical guidance:** Try mimalloc first (easiest to integrate, good default). If you need extensive profiling, use jemalloc. If you are already in the Google ecosystem or need aggressive huge page support, use tcmalloc. Always benchmark with YOUR workload, synthetic benchmarks lie.

---
