## 21. Exercises

Six hands-on labs. Each requires Linux with NUMA hardware (or a NUMA-emulating VM with `-numa node,cpus=0-3 -numa node,cpus=4-7` in QEMU). Allow 1 to 4 hours per exercise.

### Exercise 1: False Sharing Microbenchmark

Build a microbenchmark that demonstrates false sharing.

Tasks:

1. Write a program with two structs: `Shared` (two `std::atomic<uint64_t>` fields packed together) and `Padded` (two fields separated by `alignas(64)`).
2. Spawn two threads, each pinned to a different physical core. Have each thread perform 100 million `fetch_add` operations on its own field.
3. Time both versions with `std::chrono::steady_clock`. Report the speedup.
4. Run `perf c2c record` on the Shared version. Identify the HITM hot line and the source location.
5. Repeat across a) two cores on the same socket, b) two cores on different sockets. Document the cross-socket multiplier.

Deliverable: source code, measurement table, `perf c2c` output excerpt, written analysis.

### Exercise 2: NUMA-Aware Allocator

Build a NUMA-aware `std::pmr::memory_resource`.

Tasks:

1. Implement a class `numa_arena_resource` derived from `std::pmr::memory_resource`. Constructor takes a NUMA node and an arena size in bytes. Allocates the arena with `numa_alloc_onnode`. `do_allocate` bumps a pointer, `do_deallocate` is no-op (arena freed in destructor).
2. Use it to back a `std::pmr::vector<int>` of 1 million elements.
3. Write a test: spawn a thread pinned to a different node. Have it iterate the vector. Use `perf stat -e mem_load_l3_miss_retired.remote_dram` to confirm remote DRAM accesses.
4. Verify with `move_pages` (query mode) that the vector's storage is on the expected node.

Deliverable: source code, unit test, perf output showing the expected remote DRAM ratio.

### Exercise 3: Cross-Socket Bounce Benchmark

Measure cache-line bounce cost as a function of CPU pair.

Tasks:

1. Write a benchmark: a single `std::atomic<uint64_t>`, two threads pinned to specified CPUs, each doing N `fetch_add`s.
2. Run for every pair (CPU_a, CPU_b) where a < b. On a 96-core box, this is 4560 pairs. (Or sample if too many.)
3. Plot the latency matrix as a heatmap. Annotate which regions correspond to: same-core SMT, same-core (no SMT), same-CCD, same-socket, cross-socket.
4. Fit a model: latency = base + alpha * is_smt + beta * is_same_socket + gamma * is_cross_socket. Report the fit coefficients.

Deliverable: heatmap image, model fit, written interpretation.

### Exercise 4: Hugepage TLB Measurement

Quantify the TLB benefit of hugepages on a real workload.

Tasks:

1. Write a program that allocates a 4 GB array of `uint64_t` and walks it in a randomized order (Sattolo's algorithm to build a single cycle, then chase pointers).
2. Run with three configurations:
 - 4 KB pages (default).
 - 2 MB THP enabled (`madvise(MADV_HUGEPAGE)`).
 - 1 GB hugepages via `MAP_HUGETLB | MAP_HUGE_1GB` (reserve at boot).
3. Measure `dTLB-load-misses` and total walk cycles with `perf stat`.
4. Report the speedup of (3) vs (1) and (2). Compute the cycles per access for each.

Deliverable: source code, perf outputs, table of results, written conclusion.

### Exercise 5: Shard-Per-Core Microservice

Build a small in-memory key-value store using shard-per-core architecture.

Tasks:

1. Spawn one worker thread per physical core, each pinned. Each worker owns a `std::unordered_map<uint64_t, std::string>`.
2. Connections from clients (you can use TCP or even a simple in-process queue) hash on the key and route to the owning shard.
3. Communication between the I/O thread and shard workers happens through SPSC queues (one per (io_thread, shard) pair).
4. Benchmark with random GETs and SETs. Compare throughput against a single-locked-map baseline.
5. Run on a single-socket configuration and a dual-socket configuration. Report scaling.

Deliverable: source code, throughput numbers across configurations, written analysis of where the architecture wins and where it loses.

### Exercise 6: Production Pinning Audit

Audit a real or simulated production deployment.

Tasks:

1. Write a script that connects to a running process and reports:
 - Each thread's CPU affinity mask.
 - Each thread's NUMA memory policy (`get_mempolicy`).
 - The NUMA distribution of the process's anonymous mappings (parse `/proc/PID/numa_maps`).
 - The current CPU governor on each CPU.
 - The state of `numa_balancing`, THP, and hugepages.
2. Compare against an expected configuration (read from a YAML file).
3. Output a diff and a remediation script.
4. Run against a sample workload (e.g., redis-server or a custom test program). Find at least one misconfiguration and fix it.

Deliverable: the audit script, the YAML schema for expected config, an example output showing a found misconfiguration, the fix applied, and a re-audit confirming clean state.

### Bonus Exercise: CXL Emulation

If you have access to a CXL-capable machine, repeat Exercise 4 with CXL.mem as a third tier. If not, emulate by using a remote-socket node as a stand-in for a slow tier and reading the difference. Quantify the bandwidth/latency floor of the slow tier and predict the application impact.

---
