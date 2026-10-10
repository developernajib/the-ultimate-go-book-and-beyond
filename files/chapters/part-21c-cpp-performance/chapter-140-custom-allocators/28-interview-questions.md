## Interview Questions

### Conceptual

**Q1: What is the difference between internal and external fragmentation?**

Internal fragmentation is wasted space within an allocated block (allocating 33 bytes in a 64-byte slot wastes 31 bytes). External fragmentation is wasted space between allocated blocks, there is enough total free memory but no single contiguous region large enough for the request. Arena allocators have no external fragmentation. Buddy allocators have bounded external fragmentation but up to 50% internal fragmentation. Pool allocators have zero fragmentation for their designed size class.

**Q2: Why does Go not allow custom allocators?**

Go's garbage collector requires full knowledge of all live objects. It uses precise type bitmaps and write barriers to track pointers. A custom allocator that manages its own memory would bypass GC scanning, potentially creating dangling pointers to collected objects or preventing the GC from finding live objects. The `sync.Pool` and experimental `arena` package are Go's alternatives, both designed to cooperate with the GC.

**Q3: When would you choose jemalloc over tcmalloc?**

jemalloc excels at low fragmentation for long-running services with diverse allocation patterns (web servers, databases). tcmalloc excels at raw throughput with aggressive huge page utilization and integrates well with Google's profiling ecosystem (pprof). For most workloads outside Google's infrastructure, jemalloc is the safer default.

**Q4: What is the first-touch NUMA policy and why does it matter?**

Linux allocates physical pages on the NUMA node of the thread that first writes to them, not the thread that calls `mmap`/`malloc`. This means `memset` from one thread followed by use from another results in all remote memory accesses. The fix is to have each worker thread initialize its own partition of the data.

### Design Questions

**Q5: Design a memory allocator for a game engine that processes 60 frames per second.**

Use a two-level scheme. Level 1: a per-frame arena allocator (~4--16MB) that is reset every frame for temporary data (particle positions, visibility results, AI decisions). Level 2: a pool allocator for persistent game objects (entities, components) with fixed-size slots. The arena handles the high-frequency temporary allocations with zero fragmentation and O(1) reset. The pool handles object creation/destruction with O(1) allocation and no fragmentation. Neither needs locks if allocation is single-threaded per frame. For multithreaded work within a frame, give each worker thread its own sub-arena.

**Q6: You have a service processing 100K requests/sec. Each request allocates 50--200 small objects. How do you optimize allocation?**

Give each request a `monotonic_buffer_resource` (PMR arena) backed by a thread-local pre-allocated buffer. Size the buffer for the 99th percentile request (say 32KB). On the rare overflow, fall back to the default allocator. At request end, the arena is destroyed, freeing everything in O(1). This eliminates individual free calls and reduces allocator contention. Benchmark to confirm the buffer size handles most requests without fallback.

**Q7: Explain the trade-off between `std::pmr::monotonic_buffer_resource` and `std::pmr::unsynchronized_pool_resource`.**

`monotonic_buffer_resource` is a bump allocator: allocation is a pointer increment, deallocation is a no-op, and the entire resource is freed at destruction. It is the fastest option when all objects share a common lifetime. `unsynchronized_pool_resource` maintains size-bucketed pools: allocation and deallocation are both O(1), and individual objects can be returned to the pool for reuse. Choose monotonic when lifetimes are scoped (request, frame, phase). Choose the pool resource when objects are created and destroyed independently throughout the resource's lifetime.

### Coding Questions

**Q8: Implement a simple free-list allocator that coalesces adjacent free blocks.**

The candidate should implement: (a) a header structure containing block size and free/used flag, (b) allocation that walks the free list (first-fit or best-fit), (c) splitting when a free block is larger than needed, and (d) coalescing on `free()` by checking whether the previous and next blocks are also free. Key edge cases: alignment, minimum block size (must fit the free-list pointer), and boundary blocks at the start and end of the heap.

**Q9: Write a C++ allocator that detects double-free and use-after-free at runtime.**

On allocation, fill memory with a known pattern (e.g., `0xCD`). On deallocation, check that the memory does not already contain the freed pattern (`0xDD`), then fill with `0xDD`. Maintain a set of currently-allocated addresses. `free` checks membership and removes it, double-free means it is not in the set. This is the principle behind debug allocators in MSVC (`_CrtSetDbgFlag`) and tools like ASan.

---
