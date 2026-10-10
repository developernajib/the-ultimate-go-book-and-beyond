## Key Takeaways

- **Arena allocators** offer the best performance when objects share a lifetime. They compile down to a single pointer increment and free everything in O(1).
- **Pool allocators** eliminate fragmentation for fixed-size objects and provide O(1) alloc/dealloc with individual object lifetime management.
- **Buddy allocators** handle variable-size allocations with bounded fragmentation and efficient coalescing, at the cost of up to 50% internal waste.
- **PMR (C++17)** solves the type-infection problem of classic allocators. Use `monotonic_buffer_resource` for arenas and `unsynchronized_pool_resource` for pools.
- **jemalloc, tcmalloc, and mimalloc** are drop-in `malloc` replacements that can improve performance 10--30% with zero code changes. Benchmark with your workload to choose.
- **NUMA awareness** matters on multi-socket servers. First-touch policy, thread pinning, and per-node allocation can double throughput.
- **Huge pages** (2MB/1GB) reduce TLB misses dramatically for large working sets. Use `mmap` with `MAP_HUGETLB` or `madvise(MADV_HUGEPAGE)`.
- **Go's allocator** is tcmalloc-inspired with per-P caches, size classes, and GC integration. It is good enough that custom allocators are not supported, though `sync.Pool` and experimental arenas exist for specific use cases.
- **Profile before optimizing.** Most applications are not allocation-bound. Custom allocators add complexity and bugs. Only invest when the profiler justifies it.

---

| [◀ Chapter 139: Performance Engineering](../chapter-139-performance-engineering/00-introduction.md) | [Chapter 140: Custom Memory Allocators](00-introduction.md) | [Chapter 141: Design Patterns in Modern C++](../chapter-141-design-patterns-cpp/00-introduction.md) ▶ |

