## Learning Objectives

By the end of this chapter, you will be able to:

1. **Map the cache hierarchy of a real CPU.** Given a model number (Sapphire Rapids Xeon 8480+, EPYC 9654, Apple M4 Pro, Ampere AmpereOne A192-32X), state the L1d, L1i, L2, and LLC sizes per core and per socket, identify whether the LLC is inclusive, non-inclusive, or victim, and describe the on-die interconnect (ring, mesh, Infinity Fabric, custom).

2. **Reason about cache coherence protocols at the protocol level.** Walk through a MESI state transition for a two-core read-write sequence, contrast MESI with MOESI (AMD) and MESIF (Intel), and explain why a directory-based protocol scales better than pure snooping past 8 sockets.

3. **Detect and eliminate false sharing in production C++ code.** Use `perf c2c` to find contended cache lines, apply `alignas(std::hardware_destructive_interference_size)` correctly, and quantify the speedup with a microbenchmark.

4. **Discover and interpret NUMA topology programmatically.** Parse `/sys/devices/system/node`, call `numa_num_configured_nodes()` and `numa_distance()`, build a distance matrix, and use hwloc to write topology code that runs on Linux, FreeBSD, and macOS.

5. **Choose and apply NUMA memory policies correctly.** Pick between first-touch, `MPOL_BIND`, `MPOL_INTERLEAVE`, and `MPOL_PREFERRED` based on workload class (OLTP, OLAP, streaming, ML inference), and implement the choice using `set_mempolicy`, `numa_alloc_onnode`, or a custom `std::pmr::memory_resource`.

6. **Pin threads correctly for HFT and database workloads.** Combine `isolcpus`, `sched_setaffinity`, and IRQ affinity to dedicate a core to a single thread, verify the pinning with `taskset` and `/proc/self/status`, and explain the cost of cross-socket migration.

7. **Tune huge pages and the TLB.** Choose between 4K, 2M, and 1G pages based on working set size, allocate huge pages on a specific NUMA node, measure dTLB misses with `perf stat`, and decide between THP, hugetlbfs, and explicit `MAP_HUGETLB`.

8. **Apply hardware and software prefetching.** Identify when the L1 streaming prefetcher will help and when it will not, place `__builtin_prefetch` correctly with the right distance, and recognize cache-oblivious algorithms that work without any explicit prefetching.

9. **Use streaming stores to bypass the cache.** Recognize write-only patterns (logging buffers, video frames, network DMA), apply `_mm256_stream_si256` or equivalent, and avoid the trap of using non-temporal stores for data that will be re-read.

10. **Read coherence-related performance counters.** Run `perf stat -e LLC-load-misses,LLC-store-misses,offcore_response.*`, interpret Intel uncore counters for mesh hop traffic, and use AMD IBS to localize coherence stalls to specific instructions.

---
