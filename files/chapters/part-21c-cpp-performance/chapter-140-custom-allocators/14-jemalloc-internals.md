## Jemalloc Internals

Jemalloc was Jason Evans' allocator for FreeBSD's libc, then Facebook adopted and extended it, and it became the de facto allocator for memory-pressure-sensitive C++ services. Redis, MariaDB, Rust (until 2018), Cassandra, and most of Meta's C++ stack run on jemalloc. The 5.x series is the current line. Facebook handed maintenance back to upstream in 2022. Development continues but at a slower pace than tcmalloc.

### Arenas

The unit of concurrency in jemalloc is the arena. An arena owns its own heap state. Threads are assigned to arenas via a hash of the thread id (round robin by default). The number of arenas defaults to `4 * ncpus`. Threads sharing an arena contend on its mutex, threads on different arenas do not.

```bash
# Override default arena count.
MALLOC_CONF="narenas:32"
```

For latency-sensitive workloads that issue many concurrent allocations, the default is usually correct. For memory-tight workloads, fewer arenas reduces RSS at the cost of contention. This is the classic jemalloc tuning knob.

### Thread Cache (tcache)

Each thread has a tcache that absorbs small allocations without touching the arena. The tcache holds free lists per size class, capped per class to keep memory bounded. Above the cap, surplus objects are flushed back to the arena.

```c
// Disable tcache for a single allocation:
void* p = mallocx(size, MALLOCX_TCACHE_NONE);
// Or globally via MALLOC_CONF="tcache:false".
```

Disabling tcache is useful only in pathological workloads (e.g. one thread allocates, another frees, every time). Most production code wants tcache on.

### Size Classes, Slabs, and Extents

Jemalloc divides allocations into three regimes.

- Small: 8 bytes to ~14KiB. Served from slabs (called "runs" in older docs). Each slab is a contiguous region of an extent, sliced into fixed-size objects.
- Large: ~16KiB to ~3.75MiB. Served as whole extents.
- Huge: above the large threshold. Served as multi-extent allocations.

Size classes use a base+log scheme: roughly four classes per power of two (e.g. 80, 96, 112, 128 bytes). Total ~232 size classes.

An extent is a contiguous region of virtual address space, page-aligned, tracked in per-arena rtrees and treaps. Extents are the unit of `mmap`/`munmap` and the unit of physical memory release.

### Extent Hooks: The Most Powerful Customization Surface

Jemalloc lets you replace the function jemalloc uses to acquire and release virtual memory. This is how Facebook ships jemalloc on top of `mmap`-backed shared memory, hugepage pools, or even RDMA-registered regions.

```c
extent_hooks_t hooks = {
    .alloc      = my_alloc,      // returns a region of virtual memory
    .dalloc     = my_dalloc,
    .destroy    = my_destroy,
    .commit     = my_commit,     // make memory accessible
    .decommit   = my_decommit,   // give memory back without unmapping
    .purge_lazy = my_purge_lazy, // MADV_FREE equivalent
    .purge_forced = my_purge_forced, // MADV_DONTNEED equivalent
    .split      = my_split,
    .merge      = my_merge,
};

unsigned arena_id;
size_t sz = sizeof(arena_id);
extent_hooks_t* hooks_ptr = &hooks;
mallctl("arenas.create", &arena_id, &sz, &hooks_ptr, sizeof(hooks_ptr));
```

Allocations into this arena now use your hooks. This is how you build a per-NUMA-node arena, a hugepage-only arena, or a shared-memory arena, without forking jemalloc.

### Purge Strategies: Decay vs Dirty

When an extent becomes free, jemalloc does not immediately give pages back to the kernel. Two timers govern when memory is "purged" (returned to the kernel via `madvise`).

- `dirty_decay_ms`: time before unused dirty pages are subjected to `MADV_FREE` (lazy purge).
- `muzzy_decay_ms`: time before muzzy pages (already lazily purged) are subjected to `MADV_DONTNEED` (forced purge).

A page goes dirty -> muzzy -> clean. `MADV_FREE` is cheap, the kernel can reuse the physical page but does not zero immediately. `MADV_DONTNEED` is more aggressive, it returns the physical page now and forces a zero-fill on next touch.

```bash
MALLOC_CONF="dirty_decay_ms:10000,muzzy_decay_ms:10000"
```

For RSS-sensitive workloads (containers with hard memory limits), shorten these. For latency-sensitive workloads where the cost of touching freshly-zeroed pages matters, lengthen them. Setting them to `0` purges immediately. Setting them to `-1` disables purging.

### Background Threads

Modern jemalloc can run purging on background threads instead of inline on the freeing thread. This is huge for tail latency.

```bash
MALLOC_CONF="background_thread:true"
```

Without background threads, a `free()` that triggers a purge can block for milliseconds while the kernel processes `madvise` over a large region. With background threads, the freeing thread returns immediately and a worker handles purging.

### Transparent Huge Pages

Jemalloc supports two strategies for hugepages.

- `metadata_thp:auto` enables hugepages for jemalloc's internal metadata (rtree nodes, etc).
- Per-arena `MADV_HUGEPAGE` hints, controlled via `arena.<i>.retain` and the `thp` option.

Facebook runs production jemalloc with `metadata_thp:always` and selectively `MADV_HUGEPAGE` on large extents. The combination meaningfully reduces dTLB misses on long-running services.

```bash
MALLOC_CONF="metadata_thp:always,thp:always"
```

Verify with `cat /proc/<pid>/smaps | grep -i huge`.

### Profiling

`malloc_stats_print` dumps a textual report. `jeprof` (jemalloc's pprof) reads heap profiles.

```cpp
#include <jemalloc/jemalloc.h>

// Print full stats:
malloc_stats_print(nullptr, nullptr, "");

// Enable sampled profiling at startup:
// MALLOC_CONF="prof:true,prof_active:true,lg_prof_sample:19"
// (sample every 2^19 = 512KB)

// Dump a profile:
bool active = true;
mallctl("prof.dump", nullptr, nullptr, &active, sizeof(active));
```

The dumped `.heap` file feeds into `jeprof --svg ./binary jeprof.*.heap > flamegraph.svg`.

### Facebook's Production Configuration (Approximate)

```
MALLOC_CONF="\
narenas:64,\
background_thread:true,\
metadata_thp:always,\
dirty_decay_ms:30000,\
muzzy_decay_ms:30000,\
prof:true,prof_active:true,lg_prof_sample:19"
```

Specifics drift across services. The pattern (background threads, hugepage metadata, sampled profiling on by default) is the part to copy.

### Junior to FAANG

A junior engineer runs `LD_PRELOAD=libjemalloc.so` and ships. A FAANG-grade engineer picks the arena count for their thread topology, tunes the decay timers to the container's memory pressure, runs background-thread purging, points the extent hooks at hugepage-backed memory, and reads `malloc_stats_print` output as a profiler. They also know that `mallctl("arena.<i>.purge", ...)` forces immediate purge of an arena, which is the right thing to call before a long idle period or a fork.
