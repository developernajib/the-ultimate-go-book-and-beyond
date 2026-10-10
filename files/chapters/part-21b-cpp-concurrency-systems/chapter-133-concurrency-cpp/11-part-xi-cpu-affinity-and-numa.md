## Part XI: CPU Affinity and NUMA-Aware Threading

On multi-socket servers at FAANG scale, raw core count is rarely the bottleneck. The real tax is cross-socket memory traffic. Pinning threads to cores and binding their heap to local NUMA nodes routinely cuts p99 latency by 20 to 40 percent on hot-path services. C++ has no portable affinity API, so senior engineers drop to POSIX `pthread_setaffinity_np` on Linux and `SetThreadAffinityMask` on Windows, guarded behind a thin abstraction.

### Pinning a worker pool to physical cores

```cpp
#include <pthread.h>
#include <sched.h>
#include <thread>
#include <vector>
#include <system_error>

class AffineWorker {
public:
    AffineWorker(int core_id, std::function<void()> task)
        : thread_([core_id, t = std::move(task)]() mutable {
              pin_to_core(core_id);
              t();
          }) {}

    ~AffineWorker() { if (thread_.joinable()) thread_.join(); }

private:
    static void pin_to_core(int core_id) {
        cpu_set_t set;
        CPU_ZERO(&set);
        CPU_SET(core_id, &set);
        int rc = pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
        if (rc != 0) {
            throw std::system_error(rc, std::generic_category(),
                                    "pthread_setaffinity_np failed");
        }
    }
    std::jthread thread_;
};
```

Use one `AffineWorker` per physical core, not per hyperthread. Hyperthread siblings contend for the same L1/L2, so pinning two latency-critical threads to the same physical core is an anti-pattern. Query `/sys/devices/system/cpu/cpu*/topology/thread_siblings_list` at startup to distinguish siblings.

### NUMA-local allocation

Affinity alone is not enough. If thread T runs on node 0 but malloc returns memory backed by node 1, every load crosses the interconnect. Use `libnuma` to bind memory policy before the first allocation.

```cpp
#include <numa.h>
#include <numaif.h>

void bind_thread_to_node(int node_id) {
    if (numa_available() < 0) return;
    bitmask* mask = numa_allocate_nodemask();
    numa_bitmask_setbit(mask, node_id);
    numa_bind(mask);                 // threads and future allocations
    numa_free_nodemask(mask);
}

// Per-node arena allocator for a sharded cache
template <typename T>
class NumaArena {
public:
    explicit NumaArena(int node) : node_(node) {
        buf_ = numa_alloc_onnode(kArenaBytes, node);
        if (!buf_) throw std::bad_alloc();
    }
    ~NumaArena() { numa_free(buf_, kArenaBytes); }

    T* allocate(std::size_t n) {
        auto off = offset_.fetch_add(n * sizeof(T), std::memory_order_relaxed);
        if (off + n * sizeof(T) > kArenaBytes) throw std::bad_alloc();
        return reinterpret_cast<T*>(static_cast<char*>(buf_) + off);
    }

private:
    static constexpr std::size_t kArenaBytes = 1ULL << 30;
    int node_;
    void* buf_;
    std::atomic<std::size_t> offset_{0};
};
```

Pair each `AffineWorker` with a `NumaArena` on the same node. Cross-node traffic drops to near zero on read-mostly workloads.

### Interrupt affinity and isolation

For sub-millisecond p99 targets, isolate cores from the kernel scheduler entirely. Boot with `isolcpus=8-15 nohz_full=8-15 rcu_nocbs=8-15`, and move IRQs off those cores by writing masks to `/proc/irq/*/smp_affinity`. Your pinned C++ workers then run without scheduler ticks and RCU callbacks interrupting them. Combine with `SCHED_FIFO` for latency-sensitive threads, and cap priority to avoid starving watchdogs.

### Go comparison

Go's scheduler deliberately hides affinity. `runtime.LockOSThread` pins a goroutine to an OS thread, but there is no standard API to pin that thread to a core. C++ gives you direct control, which is why latency-critical trading and ad-bidding systems use C++ with explicit affinity rather than Go. The trade-off is operational complexity, one misconfigured mask and throughput collapses.

### When to reach for affinity

Use affinity when you have measured cross-socket memory bandwidth saturation (`perf stat -e uncore_imc/cas_count_read/`) or when p99 tail latency exceeds your SLO despite adequate median latency. Do not pin by default, the Linux scheduler is excellent for most workloads, and incorrect pinning causes load imbalance.

### Junior → FAANG: NUMA as a Hardware Reality You Must Know About

Go engineers rarely think about NUMA because the Go runtime is not NUMA-aware by default and the GC adds enough non-determinism that NUMA effects are hard to isolate. In C++, NUMA awareness is the difference between a service that meets its p99 SLO and one that does not.

The minimum awareness level: know that modern servers have multiple CPU sockets, each with local memory. Accessing memory on the other socket (remote NUMA) takes 2x to 3x longer than local access. When a thread is migrated to a different socket by the OS scheduler, all its memory accesses become remote. CPU pinning prevents this migration.

### Senior @ FAANG: NUMA-Aware System Design and Measurement Protocol

At the staff level, NUMA optimization is a measurement-first discipline. The protocol: (1) measure baseline p99 latency and identify if NUMA is a suspect (use `numastat`, `perf stat -e numa-*`). (2) if cross-socket traffic is high, profile which data structures are accessed most frequently cross-socket. (3) design a NUMA-aware allocation strategy (bind each thread's allocator to its local NUMA node using `libnuma`). (4) pin threads to cores on a single NUMA node for the hot path. (5) measure the improvement.

A staff engineer who recommends NUMA optimization without this measurement protocol is guessing. The protocol ensures that the optimization effort targets the actual bottleneck.

**NUMA in Kubernetes and container environments.** Most FAANG services run in containers, where CPU pinning and NUMA binding require explicit configuration (`cpusets`, `cpumanager` policy in Kubernetes). A staff engineer who designs a NUMA-aware service documents the required Kubernetes configuration and validates it in the deployment environment. NUMA optimization designed for bare-metal may have no effect in a container with a permissive CPU topology.

