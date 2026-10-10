## 5. NUMA Topology Discovery

You cannot make NUMA-aware decisions without knowing the topology. The first move on any new box is to enumerate nodes, distances, and CPU-to-node mappings. The Linux kernel exposes all of this through sysfs and through libnuma. Cross-platform code uses hwloc.

### The Command Line First

```bash
numactl --hardware
```

Output on a dual-socket EPYC 9654 (Genoa):

```
available: 2 nodes (0-1)
node 0 cpus: 0 1 2 ... 95 192 193 ... 287
node 0 size: 515740 MB
node 0 free: 510123 MB
node 1 cpus: 96 97 98 ... 191 288 289 ... 383
node 1 size: 515871 MB
node 1 free: 511004 MB
node distances:
node   0   1
  0:  10  32
  1:  32  10
```

Read this carefully. CPUs 0 to 95 are physical cores on socket 0, and 192 to 287 are their SMT siblings (also socket 0). The distance matrix uses 10 for "same node" and 32 for "remote socket". These are not nanoseconds. They are relative weights the kernel uses for scheduling. A common rule of thumb: divide by 10 to get an approximate latency multiplier. Distance 32 implies remote access is roughly 3.2x slower than local.

```bash
lscpu
```

Look for the `NUMA node(s)` line and the per-node CPU list. Also note `Socket(s)`, `Core(s) per socket`, and `Thread(s) per core`. On AMD with NPS=4, you can see 8 NUMA nodes on a 2-socket system, because each socket exposes 4 chiplet groups as separate NUMA nodes.

```bash
ls /sys/devices/system/node/
# node0 node1 ...

cat /sys/devices/system/node/node0/cpulist
# 0-95,192-287

cat /sys/devices/system/node/node0/meminfo
# Node 0 MemTotal: ...
# Node 0 MemFree: ...

cat /sys/devices/system/node/node0/distance
# 10 32
```

### libnuma in C++

libnuma is the standard Linux C API for NUMA. Add `-lnuma` at link time.

```cpp
#include <numa.h>
#include <numaif.h>
#include <cstdio>

int main() {
    if (numa_available() < 0) {
        std::fprintf(stderr, "NUMA not available on this kernel\n");
        return 1;
    }
    int max_node = numa_max_node();
    int num_configured = numa_num_configured_nodes();
    std::printf("max_node=%d configured=%d\n", max_node, num_configured);

    for (int i = 0; i <= max_node; ++i) {
        long size = numa_node_size64(i, nullptr);
        std::printf("node %d size=%ld bytes\n", i, size);
        for (int j = 0; j <= max_node; ++j) {
            std::printf("  distance(%d,%d)=%d\n", i, j, numa_distance(i, j));
        }
    }

    // Which CPUs are on node 0?
    struct bitmask* cpus = numa_allocate_cpumask();
    numa_node_to_cpus(0, cpus);
    std::printf("node 0 cpus:");
    for (size_t c = 0; c < cpus->size; ++c) {
        if (numa_bitmask_isbitset(cpus, c)) std::printf(" %zu", c);
    }
    std::printf("\n");
    numa_free_cpumask(cpus);
    return 0;
}
```

Key libnuma calls:

- `numa_available()`: returns -1 if NUMA is not supported by the kernel or hardware.
- `numa_max_node()`: highest valid node index. Iterate `0..max_node`. Some indices may not be configured (sparse).
- `numa_num_configured_nodes()`: count of actually present nodes.
- `numa_distance(a, b)`: relative distance between two nodes.
- `numa_node_to_cpus(node, mask)`: fill a bitmask with CPUs belonging to a node.
- `numa_node_of_cpu(cpu)`: inverse mapping.

### hwloc for Cross-Platform

libnuma is Linux-only. hwloc (Hardware Locality, from Open MPI) works on Linux, FreeBSD, Solaris, AIX, macOS, and Windows. It builds a hierarchical tree of the topology: machine -> NUMA nodes -> packages -> caches -> cores -> hardware threads.

```cpp
#include <hwloc.h>
#include <cstdio>

int main() {
    hwloc_topology_t topo;
    hwloc_topology_init(&topo);
    hwloc_topology_load(topo);

    int depth = hwloc_topology_get_depth(topo);
    std::printf("topology depth=%d\n", depth);

    int n_numa = hwloc_get_nbobjs_by_type(topo, HWLOC_OBJ_NUMANODE);
    std::printf("numa nodes=%d\n", n_numa);

    for (int i = 0; i < n_numa; ++i) {
        hwloc_obj_t obj = hwloc_get_obj_by_type(topo, HWLOC_OBJ_NUMANODE, i);
        std::printf("node %d: local_memory=%llu\n",
            i, (unsigned long long)obj->attr->numanode.local_memory);
    }

    hwloc_topology_destroy(topo);
    return 0;
}
```

Compile with `-lhwloc`. hwloc is what tools like Open MPI, Slurm, and Charm++ use to make portable affinity decisions.

### Building a Distance Matrix

```cpp
#include <numa.h>
#include <vector>
#include <cstdio>

std::vector<std::vector<int>> build_distance_matrix() {
    int n = numa_num_configured_nodes();
    std::vector<std::vector<int>> m(n, std::vector<int>(n));
    for (int i = 0; i < n; ++i)
        for (int j = 0; j < n; ++j)
            m[i][j] = numa_distance(i, j);
    return m;
}
```

Use this matrix to drive scheduling. If your worker thread is on node 2 and you need to allocate a buffer that will be accessed by another worker, allocate on the node with the smallest distance from node 2 that has free memory.

### Distance Numbers in Practice

ACPI SLIT (System Locality Information Table) is the source of these numbers. Vendors fill it based on their hardware design. Typical values:

- 10: same node.
- 11 to 12: same socket, different chiplet (AMD NPS modes, Intel sub-NUMA clustering).
- 20 to 22: 1-hop remote socket.
- 30 to 40: 2-hop remote socket (in 4-socket and 8-socket configs).
- 50+: very far (across blade in some HPC systems).

The actual latency penalty does not always match the distance number linearly. Always validate with a microbenchmark on the target hardware.

### Measuring Real NUMA Latency

```bash
# Intel Memory Latency Checker:
./mlc --latency_matrix
./mlc --bandwidth_matrix
```

This produces a real measured latency and bandwidth matrix between every pair of nodes. The output is what you should base tuning on, not the SLIT values.

### Junior to FAANG

A junior writes code that assumes one NUMA domain. A FAANG engineer enumerates nodes at startup, builds a distance matrix, and stores it for the scheduler to consult.

### Senior at FAANG

Staff engineers know that the SLIT values are advisory and the real latency matrix can disagree, especially on complex topologies (4-socket, NPS=4, CXL-attached memory). Production tuning starts with `mlc` measurements on the actual hardware SKU, not specs. They also keep a database of these measurements per server generation and reuse it for capacity planning.

---
