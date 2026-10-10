## NUMA-Aware Allocation

Non-Uniform Memory Access (NUMA) means different CPU sockets have different memory banks. Accessing "local" memory (attached to your socket) is 2--3x faster than "remote" memory (another socket's bank). On a dual-socket server, ignoring NUMA can cut throughput nearly in half.

### NUMA Topology

On a dual-socket server each CPU socket has its own memory bank. Inter-socket (remote) memory access crosses the QPI/UPI interconnect and costs 2-3× more latency than local access. The diagram below illustrates how cores map to their respective NUMA nodes so you can reason about where to pin threads and allocate memory to avoid cross-socket traffic.
```
Socket 0                    Socket 1
+--------+                  +--------+
| Core 0 |                  | Core 4 |
| Core 1 |  <-- QPI/UPI --> | Core 5 |
| Core 2 |                  | Core 6 |
| Core 3 |                  | Core 7 |
+--------+                  +--------+
    |                            |
  Local                       Local
  Memory                      Memory
  (Node 0)                    (Node 1)
```

### Linux NUMA API

The Linux `libnuma` API exposes `numa_alloc_onnode` to allocate memory on a specific NUMA node and `numa_run_on_node` to pin the calling thread's execution to that node's cores. Pairing thread affinity with co-located memory allocation ensures that all cache-line fills go through the local memory controller, which is the single most impactful NUMA optimization for latency-sensitive applications.
```cpp
#include <cstdio>
#include <cstdlib>

#ifdef __linux__
#include <numa.h>
#include <numaif.h>
#include <sched.h>

void numa_allocation_example() {
    if (numa_available() < 0) {
        printf("NUMA not available\n");
        return;
    }

    int num_nodes = numa_max_node() + 1;
    printf("NUMA nodes: %d\n", num_nodes);

    // Allocate on specific NUMA node
    size_t size = 64 * 1024 * 1024;  // 64 MB
    void* local_mem = numa_alloc_onnode(size, 0);   // Node 0
    void* remote_mem = numa_alloc_onnode(size, 1);  // Node 1
    void* interleaved = numa_alloc_interleaved(size); // Round-robin

    // Pin current thread to a specific node
    int current_node = numa_node_of_cpu(sched_getcpu());
    printf("Running on NUMA node: %d\n", current_node);

    // Bind memory policy for future allocations
    struct bitmask* nodemask = numa_allocate_nodemask();
    numa_bitmask_setbit(nodemask, 0);
    numa_bind(nodemask);  // All allocations go to node 0
    numa_free_nodemask(nodemask);

    // Move existing pages to a different node
    unsigned long node_mask = 1UL << 1;  // Target: node 1
    long result = mbind(local_mem, size, MPOL_BIND,
                        &node_mask, num_nodes + 1, MPOL_MF_MOVE);

    numa_free(local_mem, size);
    numa_free(remote_mem, size);
    numa_free(interleaved, size);
}

// NUMA-aware allocator wrapper
class NumaAllocator {
    int node_;

public:
    explicit NumaAllocator(int numa_node) : node_(numa_node) {}

    void* allocate(size_t size) {
        return numa_alloc_onnode(size, node_);
    }

    void deallocate(void* ptr, size_t size) {
        numa_free(ptr, size);
    }
};
#endif
```

### NUMA Best Practices

1. **First-touch policy**: Linux allocates pages on the NUMA node of the thread that first writes to them. Initialize data on the thread that will use it.
2. **Thread pinning**: Pin threads to specific cores so they consistently access local memory.
3. **Partition data by node**: Split large data structures so each partition lives on the node that processes it.
4. **Interleaving for shared data**: If data is accessed equally by all nodes, interleave across nodes for balanced bandwidth.

---
