## 6. NUMA Memory Policies

Allocation does not pick a node by default. Linux uses first-touch: physical pages are assigned to the node of the CPU that first writes to them. This is usually what you want, but only if you control which thread writes first. If a single setup thread initializes memory before workers start, all the memory ends up on whatever node the setup thread ran on, and your workers are remote no matter what you do.

### The Default: First Touch

```cpp
char* buf = new char[1 << 30];   // 1 GB
// At this point no physical pages are allocated yet. The kernel returned
// virtual address space backed by anonymous mappings. Pages will be
// allocated on the first write.
buf[0] = 0;
// That single write triggered a page fault, the kernel allocated a 4K
// page from the local NUMA node of the current CPU, and zeroed it.
```

If a setup thread on node 0 then runs `memset(buf, 0, 1<<30)`, all 256K pages land on node 0. Workers running on node 1 then read remote for every load.

The fix is parallel first-touch:

```cpp
#include <thread>
#include <vector>
const size_t N = 1ULL << 30;
char* buf = new char[N];

int num_threads = std::thread::hardware_concurrency();
std::vector<std::thread> ts;
for (int t = 0; t < num_threads; ++t) {
    ts.emplace_back([&, t]{
        size_t chunk = N / num_threads;
        size_t start = t * chunk;
        size_t end = (t == num_threads - 1) ? N : start + chunk;
        for (size_t i = start; i < end; i += 4096) buf[i] = 0;
    });
}
for (auto& th : ts) th.join();
```

Now each thread first-touches its own slice on its own node, assuming threads are pinned (next chapter).

### set_mempolicy and mbind

The kernel exposes two syscalls:

- `set_mempolicy`: changes the policy for the calling thread. All future allocations from this thread use the policy.
- `mbind`: applies a policy to a specific virtual address range.

Policies (from `<numaif.h>`):

- `MPOL_DEFAULT`: revert to the system default (first-touch).
- `MPOL_BIND`: allocations must come from the specified node mask. Out of memory if not available.
- `MPOL_PREFERRED`: try the preferred node, fall back to others if full.
- `MPOL_INTERLEAVE`: round-robin pages across the node mask. Maximizes aggregate bandwidth.
- `MPOL_LOCAL` (newer kernels): allocate on the node where the fault happens (default behavior, but explicit).
- `MPOL_PREFERRED_MANY` (kernel 5.15+): like preferred but accepts a mask of preferred nodes.

```cpp
#include <numaif.h>
#include <numa.h>
#include <sys/mman.h>

void* alloc_on_node(size_t bytes, int node) {
    void* p = mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) return nullptr;
    unsigned long mask = 1UL << node;
    if (mbind(p, bytes, MPOL_BIND, &mask, 64, MPOL_MF_STRICT) != 0) {
        munmap(p, bytes);
        return nullptr;
    }
    return p;
}
```

`MPOL_MF_STRICT` makes the call fail if any pages are already on the wrong node. Without it, the kernel migrates as a best effort.

### libnuma Convenience Wrappers

```cpp
#include <numa.h>

// Allocate bytes on a specific node, fail if not available:
void* p = numa_alloc_onnode(bytes, node);
// Allocate interleaved across all nodes:
void* p = numa_alloc_interleaved(bytes);
// Allocate on the local node:
void* p = numa_alloc_local(bytes);
// Allocate from a custom node mask:
struct bitmask* mask = numa_allocate_nodemask();
numa_bitmask_setbit(mask, 0);
numa_bitmask_setbit(mask, 2);
void* p = numa_alloc_interleaved_subset(bytes, mask);

numa_free(p, bytes);
```

These wrap `mmap` + `mbind` and add zeroing.

### Choosing the Right Policy

| Workload | Policy | Reason |
|---|---|---|
| OLTP point lookups | First-touch + thread pinning | Each shard owns its data on one node. |
| OLAP scans | `MPOL_INTERLEAVE` | Maximize aggregate DRAM bandwidth across nodes. |
| ML inference (per-request) | First-touch on the request thread's node | Request data is local to the worker. |
| In-memory cache (read-mostly) | `MPOL_INTERLEAVE` | Reads are roughly even across nodes, bandwidth matters more than locality. |
| Logging / append-only | First-touch on writer's node | Writer node owns the buffer, consumers pull from a different ring. |
| Hugepage backed working set | `MPOL_BIND` to a specific node | You manage placement explicitly. |

### std::pmr Allocators That Respect NUMA

C++17's `std::pmr` lets you compose allocators. A NUMA-aware `memory_resource`:

```cpp
#include <memory_resource>
#include <numa.h>
#include <stdexcept>

class numa_memory_resource : public std::pmr::memory_resource {
public:
    explicit numa_memory_resource(int node) : node_(node) {}
protected:
    void* do_allocate(size_t bytes, size_t align) override {
        // numa_alloc_onnode returns page-aligned. For larger alignments
        // you need to over-allocate. Simplified version:
        void* p = numa_alloc_onnode(bytes, node_);
        if (!p) throw std::bad_alloc();
        return p;
    }
    void do_deallocate(void* p, size_t bytes, size_t /*align*/) override {
        numa_free(p, bytes);
    }
    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override {
        auto* o = dynamic_cast<const numa_memory_resource*>(&other);
        return o && o->node_ == node_;
    }
private:
    int node_;
};

// Usage:
numa_memory_resource node0_mr(0);
std::pmr::vector<int> v(&node0_mr);
v.reserve(1'000'000);    // backing storage on node 0
```

For HFT-grade systems you usually want a slab allocator on top, because per-allocation `numa_alloc_onnode` is a syscall and is slow. Allocate large arenas with libnuma and sub-allocate from them with a per-thread bump or pool allocator.

### Verifying Placement

```bash
# At runtime, for a process:
cat /proc/$PID/numa_maps | head
# Each line shows a virtual mapping with N0=count N1=count meaning pages on node 0 and node 1.

# Programmatically with move_pages (query mode):
```

```cpp
#include <numaif.h>
#include <vector>

int page_node(void* addr) {
    void* pages[1] = {addr};
    int status[1] = {-1};
    if (move_pages(0, 1, pages, nullptr, status, 0) != 0) return -1;
    return status[0];   // node id, or negative for error
}
```

This is the way to verify in tests that a buffer is on the expected node.

### Junior to FAANG

A junior calls `numa_alloc_onnode` once and hopes. A FAANG engineer verifies with `move_pages` or `/proc/PID/numa_maps`, and writes a unit test that fails if the placement is wrong.

### Senior at FAANG

Staff engineers think about what happens when the desired node is out of memory. `MPOL_BIND` returns failure, which can crash a service. `MPOL_PREFERRED` silently falls back to remote, which can degrade latency. The right policy depends on whether the SLO is "always fast" (use `MPOL_BIND` with capacity planning) or "available even when degraded" (use `MPOL_PREFERRED` with monitoring).

---
