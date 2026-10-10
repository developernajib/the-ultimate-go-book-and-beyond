## 23. Summary

NUMA, cache coherence, and hardware-aware C++ are not optimization. They are correctness for any system where the SLO is in microseconds or where 96 cores must work together at full throughput. The chapter covered, in order, the hierarchy from cache lines up to socket fabrics, the Linux interfaces that expose them, and the C++ patterns that respect them.

### The Compressed Mental Model

A modern server is a graph of memory regions, not a uniform pool. Each region has a latency, a bandwidth, and a coherence neighborhood. Code that respects the graph performs near peak. Code that ignores it does not, regardless of how clever the algorithm is.

### The Compressed Toolchain

| Tool | Purpose |
|---|---|
| `numactl --hardware`, `lscpu`, `lstopo` | Topology discovery |
| libnuma, hwloc | Programmatic topology API |
| `sched_setaffinity`, `taskset`, `chrt` | Thread placement |
| `numa_alloc_onnode`, `mbind`, `set_mempolicy` | Memory placement |
| `move_pages` | Migration and inspection |
| `perf c2c`, `perf stat -e mem_load_l3_*` | Coherence and NUMA diagnostics |
| Intel MLC, lat_mem_rd, STREAM | Latency and bandwidth measurement |
| `__builtin_prefetch`, `_mm256_stream_si256` | Software cache control |
| Hugepages (THP, hugetlbfs, MAP_HUGETLB) | TLB control |
| `isolcpus`, `nohz_full`, `rcu_nocbs` | Kernel preparation for dedicated cores |

### The Compressed Pattern

For any latency-critical or throughput-critical service:

1. Discover topology at startup. Build a node-distance map.
2. Pin threads to specific CPUs. One thread per physical core, no oversubscription.
3. Allocate memory on the node where it will be accessed. Use `numa_alloc_onnode` or a NUMA-aware `std::pmr::memory_resource`.
4. Partition data so each shard is owned by one core or one node. Avoid sharing writable state across nodes.
5. For shared read-only state, replicate per node or use RCU.
6. For metrics and counters, use per-core slots aggregated lazily.
7. Use hugepages for working sets larger than ~10 MB. Choose 2 MB or 1 GB by working set size.
8. Pin NIC and NVMe IRQs to the local node. Run application workers on the same node.
9. Disable AutoNUMA for pinned workloads.
10. Validate placement with `/proc/PID/numa_maps` in tests and in production health checks.
11. Monitor remote DRAM ratio, UPI/xGMI use, and cross-socket HITM events. Alert on regressions.

This list is the difference between a service that scales linearly across cores and sockets and a service that plateaus.

### The Compressed Future

Hardware is moving toward more memory regions per machine, not fewer. Chiplet boundaries inside a socket. CXL.mem expansion across multiple tiers. CXL 3.0 fabric memory across hosts. CPU-GPU unified memory. Code that hardcodes "two NUMA nodes" or assumes uniform memory will require rewrite. Code that abstracts placement behind a memory resource and queries the topology at startup will adapt.

### The One Sentence

Treat memory placement as part of the data structure design, not as a deployment concern, and the rest follows.

---

| [◀ Chapter 154: ML Inference Engines in C++](../chapter-154-ml-inference-engines/00-introduction.md) | [Chapter 155: NUMA, Cache Coherence, and Hardware-Aware C++](00-introduction.md) | [Chapter 156: Query Optimizers and Execution Engines in C++](../chapter-156-query-optimizers/00-introduction.md) ▶ |
