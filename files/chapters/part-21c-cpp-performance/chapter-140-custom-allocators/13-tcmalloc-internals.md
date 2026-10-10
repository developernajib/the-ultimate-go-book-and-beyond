## TCMalloc Internals

TCMalloc is Google's thread-caching allocator. The version most people think of (the gperftools fork from 2007) is essentially abandoned. The current TCMalloc lives at github.com/google/tcmalloc, is the default allocator inside Google's production fleet, and is rewritten around hugepages. Senior engineers should know which one they are linking against. The two share a name and almost nothing else.

### Three-Tier Cache Hierarchy

Every allocation walks at most three layers.

1. Per-thread cache (or per-CPU cache on modern Linux). Lock-free. Holds free lists segregated by size class.
2. Central cache. One per size class. Protected by a spinlock. Acts as a clearinghouse between threads.
3. Page heap. Manages multi-page spans. Protected by a global mutex. Calls into the kernel via `mmap`.

The thread cache absorbs ~99% of allocations on a warm path. If the local list for a size class is empty, the thread cache pulls a batch from the central cache. If the central cache is empty, it pulls a span from the page heap. If the page heap is empty, it asks the kernel for more virtual memory.

```cpp
// Simplified hot path (illustrative, not actual TCMalloc source).
void* ThreadCache::Allocate(size_t size) {
    const size_t cl = SizeMap::SizeClass(size);
    FreeList& list = list_[cl];
    if (list.empty()) [[unlikely]] {
        return FetchFromCentralCache(cl, SizeMap::ByteSize(cl));
    }
    return list.Pop();  // O(1), no atomics, no syscalls.
}
```

The free list pop is a load + store + a counter decrement. No CAS. No fences. That is why TCMalloc beats glibc on small allocations.

### Per-CPU Mode (the Modern Default)

Old TCMalloc used per-thread caches. The modern TCMalloc uses per-CPU caches via the `rseq` (restartable sequences) syscall on Linux. Why? A 1000-thread server with 1000 thread caches wastes memory. A 96-CPU machine with 96 CPU caches does not. Per-CPU also kills cache thrashing when threads migrate.

Per-CPU mode requires kernel support for `rseq`. The allocation sequence reads the current CPU id, indexes into a per-CPU slab, and pops a free entry. If the kernel preempts mid-sequence, `rseq` aborts the sequence and restarts. No locks. No atomics on the fast path.

### Size Classes

TCMalloc uses ~88 size classes. They are not powers of two. They are tuned to minimize internal fragmentation while keeping the table small. Sizes below 1KB are spaced by 8 or 16 bytes. Larger sizes round up more aggressively.

Allocations above ~256KB skip the thread cache entirely and go straight to the page heap as multi-page spans. The exact threshold is configurable via `tcmalloc::MallocExtension::SetMaxTotalThreadCacheBytes`.

### Spans and the Page Heap

A span is a run of contiguous pages owned by the page heap. A span is in one of three states.

- IN_USE: handed to the central cache, sliced into objects of one size class.
- ON_NORMAL_FREELIST: free, owned by the page heap, available to satisfy a page request.
- ON_RETURNED_FREELIST: free and decommitted (released to the kernel).

Span metadata lives in a radix tree (a 3-level page map on x86-64) keyed by the page address. Looking up which size class owns a pointer is O(1) after the indirections.

### Decommit Strategy

TCMalloc does not call `munmap`. It calls `madvise(MADV_DONTNEED)` on free spans. This tells the kernel the pages can be reclaimed but keeps the virtual address mapped. On the next touch the kernel zero-fills a fresh page. Why? `munmap` would invalidate the address, the next allocation would need a fresh `mmap` and update the page map. `MADV_DONTNEED` is cheaper and idempotent.

The release rate is governed by `TCMALLOC_RELEASE_RATE` (default ~1MB/s). Setting this too high wastes CPU on `madvise`. Too low and RSS grows during low-traffic periods.

```cpp
tcmalloc::MallocExtension::SetBackgroundReleaseRate(
    tcmalloc::MallocExtension::BytesPerSecond{16 << 20});  // 16 MB/s.
```

### TEMERAIRE: The Hugepage-Aware Page Heap

TEMERAIRE is the hugepage-aware page heap that ships in modern TCMalloc, described in the OSDI '21 paper "Beyond malloc efficiency to fleet efficiency." The motivation: at Google's scale, the cost of TLB misses inside production C++ binaries is enormous. Every hugepage covers 2MiB on x86-64. If allocator-managed memory is fragmented across many 4KiB pages, the kernel cannot promote them.

TEMERAIRE allocates from hugepage-aligned regions. The page heap tracks each hugepage's "filled-ness" and prefers to satisfy allocations from already-partial hugepages. Empty hugepages are released as a unit. The result: production code sees ~5-7% fewer TLB misses without any code change, and RSS goes down because release granularity matches the kernel's mapping granularity.

To enable on the modern build:

```bash
# Compile-time / runtime defaults differ across versions.
export TCMALLOC_HPAA=true
```

Inside Google this is on by default. In open source it is on by default in recent (2024-2025) builds.

### Comparison Matrix

| Feature | gperftools tcmalloc | Modern (google/tcmalloc) |
|--------------------------|---------------------|--------------------------|
| Per-thread cache | yes | available |
| Per-CPU cache (rseq) | no | default |
| Hugepage-aware page heap | no | yes (TEMERAIRE) |
| Bazel-only build | no | yes |
| Active development | minimal | yes |
| C++17 minimum | no | yes (C++17/20) |

If your build still links `-ltcmalloc` from gperftools, you are running a 2010-era allocator. Migrate.

### Profiling Hooks

TCMalloc ships with sampling-based heap profiling. Set `TCMALLOC_SAMPLE_PARAMETER=524288` (sample every ~512KB allocated) and dump the profile.

```cpp
#include "tcmalloc/malloc_extension.h"

const auto profile = tcmalloc::MallocExtension::SnapshotCurrent(
    tcmalloc::ProfileType::kHeap);
profile.Iterate([](const tcmalloc::Profile::Sample& s) {
    // s.stack[], s.allocated_size, s.requested_size, s.count
});
```

Sampling is ~zero overhead because it is amortized over the size of each sampled allocation. Always-on sampled profiling in production is the norm at FAANG scale, not the exception.

### Junior to FAANG

A junior engineer links `-ltcmalloc` and assumes "Google's allocator." A FAANG-grade engineer checks whether they got the gperftools fossil or the modern build, configures the release rate and the hugepage policy, samples production heap profiles continuously, and knows that the central-cache spinlock can become contended on workloads that fragment a single size class across 200 threads. They also know that `MallocExtension::ReleaseMemoryToSystem(0)` forces an immediate decommit, which is useful before forking or before idle periods.
