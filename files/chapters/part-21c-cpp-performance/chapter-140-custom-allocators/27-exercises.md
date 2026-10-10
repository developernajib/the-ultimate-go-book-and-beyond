## Exercises

### Exercise 1: Thread-Safe Arena with Overflow

Extend the `ArenaAllocator` to:
- Support thread-safe allocation using `std::atomic` for the offset.
- Automatically allocate a new chunk when the current one fills (linked-list of chunks).
- Provide `reset()` that frees all chunks except the first.

### Exercise 2: Size-Class Pool Allocator

Build a pool allocator that handles multiple size classes (16B, 32B, 64B, 128B, 256B, 512B, 1KB). Incoming allocations should be routed to the smallest pool that fits. Compare its performance against `malloc` for a workload of mixed-size allocations.

### Exercise 3: Benchmark Huge Pages

Write a program that:
1. Allocates a 1GB array with regular 4KB pages.
2. Allocates a 1GB array with 2MB huge pages.
3. Performs a sequential scan and a random-access scan on each.
4. Measures and reports the throughput difference.

Run with `perf stat -e dTLB-load-misses` to observe the TLB miss difference.

### Exercise 4: PMR-Based JSON Parser

Write a simple JSON parser that:
- Uses `std::pmr::monotonic_buffer_resource` for all allocations.
- Parses into `std::pmr::vector` and `std::pmr::string`.
- Measures allocation count and total bytes compared to the same parser using the default allocator.

### Exercise 5: NUMA-Aware Matrix Multiply

On a multi-socket machine:
1. Allocate two large matrices, one on each NUMA node.
2. Pin worker threads to cores on each node.
3. Each thread multiplies its local partition.
4. Compare performance with and without NUMA awareness using `numactl --interleave=all`.

---
