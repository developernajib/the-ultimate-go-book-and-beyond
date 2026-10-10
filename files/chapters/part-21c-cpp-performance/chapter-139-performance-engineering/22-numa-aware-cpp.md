## NUMA-Aware C++

A two-socket Xeon server is two NUMA nodes. A four-socket EPYC with subdivided CCXs may be eight nodes. Local DRAM access is ~85 ns. Remote (cross-socket UPI) is ~140 to 180 ns. Get NUMA wrong and your service runs at half speed for no visible reason.

### Topology Inspection

```bash
numactl --hardware
lscpu --extended
lstopo --of png > topo.png   # from hwloc
cat /sys/devices/system/node/node*/distance
```

Sample output (2-socket SPR):

```
node 0 cpus: 0-31,64-95
node 0 size: 257 GB
node 1 cpus: 32-63,96-127
node 1 size: 257 GB
distances:
       0   1
   0: 10  21
   1: 21  10
```

Distance 21 means roughly 2x the latency of local. AMD EPYC 4-NUMA modes can show 12, 32, 32, 32 (one near and three far). On Genoa with NPS=4, distances can be 10, 12, 32, 32 within a socket plus 32 to 44 cross-socket.

### libnuma Basics

```cpp
#include <numa.h>
#include <numaif.h>

if (numa_available() < 0) {
    // No NUMA support (or single node), fall back
}

int nodes = numa_num_configured_nodes();
int curr  = numa_node_of_cpu(sched_getcpu());

// Allocate on a specific node
void* p = numa_alloc_onnode(size, /*node=*/0);
// ...
numa_free(p, size);

// Run thread only on a set of CPUs from one node
struct bitmask* cpus = numa_allocate_cpumask();
numa_node_to_cpus(0, cpus);
numa_sched_setaffinity(0, cpus);
numa_free_cpumask(cpus);

// Set memory binding for subsequent allocations
numa_set_membind_node(0);
```

Link with `-lnuma`.

### First-Touch Policy

Linux's default is "first-touch": physical pages are allocated on the node where the first writing thread runs. Two consequences:

1. Allocation does not place pages. Touching does.
2. If your init thread runs on node 0 and warms up an arena, all pages live on node 0, even if 24 worker threads on node 1 use them later.

Wrong:

```cpp
auto buf = std::make_unique<float[]>(1'000'000'000);  // pages not yet faulted
std::memset(buf.get(), 0, ...);                       // node-0 main thread faults them all
// Now spawn workers across both nodes -> half are remote
```

Right (parallel first-touch):

```cpp
auto buf = std::make_unique<float[]>(N);
#pragma omp parallel for
for (size_t i = 0; i < N; ++i) buf[i] = 0.0f;
// Each thread's pages live on the thread's node
```

Or use `numa_alloc_interleaved` for read-mostly shared structures.

### RAII Wrappers

```cpp
class NumaMembind {
    bitmask* old_;
public:
    explicit NumaMembind(int node) {
        old_ = numa_get_membind();
        bitmask* m = numa_allocate_nodemask();
        numa_bitmask_setbit(m, node);
        numa_set_membind(m);
        numa_free_nodemask(m);
    }
    ~NumaMembind() {
        if (old_) {
            numa_set_membind(old_);
            numa_free_nodemask(old_);
        }
    }
    NumaMembind(const NumaMembind&) = delete;
    NumaMembind& operator=(const NumaMembind&) = delete;
};

// Allocate node-local arena
{
    NumaMembind bind(my_node);
    arena_.reset(new char[arena_size_]);
    std::fill_n(arena_.get(), arena_size_, 0); // first-touch on this node
}
```

Custom allocator:

```cpp
template <class T>
struct NumaAllocator {
    int node;
    using value_type = T;
    NumaAllocator(int n) : node(n) {}
    template <class U> NumaAllocator(const NumaAllocator<U>& o) : node(o.node) {}
    T* allocate(size_t n) {
        void* p = numa_alloc_onnode(n * sizeof(T), node);
        if (!p) throw std::bad_alloc{};
        return static_cast<T*>(p);
    }
    void deallocate(T* p, size_t n) noexcept {
        numa_free(p, n * sizeof(T));
    }
    bool operator==(const NumaAllocator& o) const noexcept { return node == o.node; }
    bool operator!=(const NumaAllocator& o) const noexcept { return node != o.node; }
};

// Use:
std::vector<float, NumaAllocator<float>> v(1'000'000, 0.0f, NumaAllocator<float>{0});
```

### Page Migration

`migrate_pages(pid, oldnodes, newnodes)` moves a process's pages. `move_pages(pid, count, pages, nodes, status, flags)` moves specific pages. For a load-balancer that re-pins a hot worker to a different socket, migrate the worker's working set first or expect a cold start.

```cpp
void migrate_buffer_to_node(void* base, size_t bytes, int node) {
    long page_size = sysconf(_SC_PAGESIZE);
    size_t npages = (bytes + page_size - 1) / page_size;
    std::vector<void*> pages(npages);
    std::vector<int>   nodes(npages, node);
    std::vector<int>   status(npages);
    for (size_t i = 0; i < npages; ++i)
        pages[i] = (char*)base + i * page_size;
    long r = move_pages(0, npages, pages.data(), nodes.data(),
                        status.data(), MPOL_MF_MOVE);
    if (r < 0) perror("move_pages");
}
```

Linux's automatic NUMA balancing (`/proc/sys/kernel/numa_balancing`) tries to do this for you, sampling page faults to detect misplacement. For predictable perf, turn it off in latency-sensitive services and place explicitly.

### Per-Node Worker Pools

```cpp
struct NodeWorker {
    int node;
    std::thread thr;
    moodycamel::ConcurrentQueue<Task> q;
    std::unique_ptr<Arena> arena;
};

void start_workers(std::vector<NodeWorker>& ws) {
    for (auto& w : ws) {
        w.thr = std::thread([&w]{
            // Pin thread to this node's CPUs
            cpu_set_t cs; CPU_ZERO(&cs);
            for (int c : cpus_of_node(w.node)) CPU_SET(c, &cs);
            pthread_setaffinity_np(pthread_self(), sizeof(cs), &cs);

            // Bind allocations to this node
            NumaMembind bind(w.node);
            w.arena = std::make_unique<Arena>(/*size=*/1ULL << 30);

            for (Task t; w.q.wait_dequeue(t); ) handle(t, *w.arena);
        });
    }
}
```

### OpenMP and MPI

OpenMP: `OMP_PROC_BIND=close OMP_PLACES=cores` keeps threads close on shared sockets. `OMP_PROC_BIND=spread OMP_PLACES=sockets` spreads across sockets for memory-bandwidth jobs.

MPI: one rank per NUMA node is the canonical layout for memory-bandwidth-bound HPC. `mpirun -np 2 --map-by socket --bind-to socket ./app`.

### Cross-Socket Coordination

Avoid locks on shared cache lines crossing sockets. The line bounces between L3s of different sockets, every acquire is 100+ ns. Patterns:

- Per-node counters, aggregated by a reader thread
- Per-node hash table shards, dispatcher routes by hash
- MCS / CLH locks (queue-based) reduce ping-pong on the lock word
- Read-copy-update (RCU) for read-mostly structures

### Real Service Example

A search shard serving 50 K QPS on a dual-socket SPR (256 GB RAM):

Naive deployment: one process, all threads pinned via the kernel scheduler:
- p50 latency: 1.8 ms
- p99 latency: 14 ms (threads bouncing across sockets)
- Memory BW: 60 GB/s aggregate

NUMA-aware: one process per socket, half the index loaded per process, threads pinned per socket, allocations bound:
- p50 latency: 1.1 ms
- p99 latency: 4 ms
- Memory BW: 130 GB/s aggregate (each socket near local peak)

Same hardware. 2x throughput, 3.5x p99 improvement.

### Inspection in Production

```bash
# Per-node memory usage of a process
numastat -p <pid>

# Live live numa migration counts
cat /proc/<pid>/numa_maps
cat /sys/devices/system/node/node*/numastat
```

`numa_hit` vs `numa_foreign` ratios on each node tell you placement quality. A healthy node has `numa_hit` >> `numa_miss`.

### Junior to FAANG callout

Pin threads. Pin allocations. First-touch in the worker thread, not the main thread. Enable NUMA awareness in your allocator (jemalloc has `oversize_threshold,muzzy_decay_ms`, tcmalloc has its own settings). If you do not know which socket your working set lives on, you do not know how fast your service runs.

### Senior at FAANG callout

For a multi-socket service the model is: every working set has a home node. Every thread that writes that working set runs on the home node. Cross-node traffic exists for replicated read-mostly state and for inter-shard messages, both quantified. When the architecture diagram on the wall does not show NUMA boundaries, the deployment will violate them.

### Caveats

- Containers: `numactl` works inside containers if the cgroup permits CPU pinning. Kubernetes' Topology Manager can enforce NUMA alignment with `policy: single-numa-node`.
- VMs: hypervisor must expose vNUMA matching pNUMA. Misaligned vNUMA is the most common cause of "perf is half what bare-metal shows".
- Hot-plug memory and CPU offline change topology mid-run. Re-query, do not cache for the lifetime of the process if the platform supports it.
