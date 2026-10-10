## 10. Cross-Socket Pitfalls

The most common production NUMA bug is a thread doing work on socket 0 with memory on socket 1, neither of which knows about the other. The latency penalty is real, the bandwidth penalty is real, and the bug is invisible from the source code. You only see it when you look at the hardware.

### Pitfall 1: The Setup Thread

A service starts up. A single initialization thread allocates and populates the buffer pool, the index structures, and the connection pools. All of those allocations first-touch on the init thread's NUMA node. Then worker threads spin up, get pinned to other nodes, and run the steady-state workload. Every read is remote.

```cpp
// BAD
void init() {
    buffer_pool_ = new char[BUFFER_POOL_BYTES];
    memset(buffer_pool_, 0, BUFFER_POOL_BYTES);   // all on init's node
    // Build the indexes ...
}
void start_workers() {
    for (int n = 0; n < numa_nodes; ++n) {
        spawn_pinned_thread(n, [this]{ worker_loop(); });
    }
}
```

The fix is parallel first-touch by node:

```cpp
// GOOD
void init_per_node(int node) {
    pin_to_node(node);
    char* slice = numa_alloc_onnode(BUFFER_POOL_BYTES / num_nodes, node);
    memset(slice, 0, BUFFER_POOL_BYTES / num_nodes);
    register_slice(node, slice);
}
void init() {
    std::vector<std::thread> ts;
    for (int n = 0; n < num_nodes; ++n) {
        ts.emplace_back([this, n]{ init_per_node(n); });
    }
    for (auto& t : ts) t.join();
}
```

### Pitfall 2: Migrating Threads

A thread is created without affinity. The kernel scheduler runs it on socket 0 first. The thread allocates and first-touches a buffer (now on socket 0). Later, the load balancer migrates the thread to socket 1. The thread is now reading remote on every load, plus the migration itself caused TLB shootdowns and L1/L2 cache cold-start.

The cost of a single thread migration across sockets:

- Cold L1: 32 KB to refill. At 5-cycle hits and 30-cycle remote hits during fill, around 5 to 20 microseconds.
- Cold L2: 1 to 4 MB. Several hundred microseconds.
- Cold TLB: 1500-entry TLB to refill. Each miss is a page walk. Tens of microseconds total if the access pattern is dense.
- All subsequent accesses to data still on socket 0: remote, +100 to 200 ns each.

For latency-critical services, this is unacceptable. Pin every thread.

### Pitfall 3: Thread-Local Data

`thread_local` variables are stored in TLS, which is allocated when the thread is created. If thread creation happens on a node different from where the thread will eventually run, TLS is remote.

```cpp
// thread_local std::vector<int> per_thread_buf - // If the thread is created on node 0 but pinned to node 1, the vector's
// metadata is on node 0, and its first allocation may be too.
```

Fix: pin the thread before the first access to any thread_local. With `std::thread`, you can pin in the function the thread runs:

```cpp
std::thread t([n]{
    pin_to_node(n);
    // First touch of thread_locals happens after pinning.
    worker_loop();
});
```

### Pitfall 4: Cross-Socket Atomics

A single hot atomic counter touched by threads on multiple sockets is a coherence storm. The line ping-pongs across UPI/xGMI. Throughput is limited not by CPU speed but by the link's invalidation bandwidth.

A single contended cache line across sockets can sustain roughly 1 to 5 million RMW operations per second total, regardless of how many cores are pounding on it. Compare to a per-core slot at 1 to 3 billion ops per second per core uncontended. The gap is 1000x.

Fix: partition (per-core, per-node), aggregate periodically. See chapter 9.

### Pitfall 5: Memory Allocator Slabs

`malloc` from `glibc`, `tcmalloc`, and `jemalloc` are NUMA-naive by default. They keep per-thread caches, which is good for cache locality on the calling thread, but the underlying slabs may live on the wrong node.

```bash
# tcmalloc has limited NUMA support. jemalloc 5+ has narrow NUMA awareness.
# To check what your allocator is doing:
MALLOC_CONF=stats_print:true ./your_program   # jemalloc
```

For the highest performance services, use a custom NUMA-aware allocator (chapter 9 example) or run one allocator per node and route allocations explicitly.

### Pitfall 6: NIC Interrupts

The network card sits on a specific PCIe slot, which is connected to a specific socket's IO hub. NIC interrupts (RX queues) deliver packets to that socket. If the application thread that handles the connection runs on the other socket, every packet crosses UPI.

```bash
# Find your NIC's NUMA node:
cat /sys/class/net/eth0/device/numa_node

# Pin RX/TX queue interrupts to that node's CPUs:
# (See /proc/interrupts for IRQs, /proc/irq/N/smp_affinity)
```

Cloudflare, Netflix, and CDN operators have written extensively about pinning IRQ affinity to match NIC NUMA placement. This single change can cut p99 latency by 30 percent on cross-socket-misaligned setups.

### Measuring Cross-Socket Traffic

Intel uncore counters expose UPI traffic:

```bash
# UPI link utilization:
perf stat -e uncore_upi/event=0x2,umask=0x0f/ ./prog

# Cross-socket cache misses (LLC miss served by remote socket):
perf stat -e mem_load_l3_miss_retired.remote_hitm,\
mem_load_l3_miss_retired.remote_dram \
  ./prog
```

On AMD, similar counters exist for xGMI and the IO die.

A useful microbenchmark: measure local DRAM latency with `mlc --idle_latency` and compare to remote:

```
Memory node access latencies (ns):
       0   1
0:    85  142
1:   140   84
```

Remote at 140 ns vs local at 85 ns: 65 percent overhead per remote DRAM access. Multiplied across millions of accesses per second, this is the difference between meeting an SLO and missing it.

### A War Story (Composite)

A logging service ran fine in dev. In production on a 4-socket Skylake-SP server, p99 latency spiked. Profiling showed the JSON serialization function as the hot spot, but the function was simple. The CPU was pegged. `perf c2c` revealed a hot HITM line in a single-instance `std::atomic<bool> shutdown_flag`. Twenty-eight worker threads on four sockets all read this flag in their inner loop. The line was constantly being kicked between sockets. Replacing with a `thread_local` cached read updated periodically dropped p99 by 80 percent.

The bug was not in the serializer. It was in a one-line atomic read. False sharing at the worst level: shared, contended, on a hot path.

### Junior to FAANG

A junior treats NUMA as an opaque kernel concern. A FAANG engineer pins threads, allocates per-node, watches remote DRAM and UPI counters, and reproduces production behavior in a controlled microbenchmark.

### Senior at FAANG

Staff engineers design service topology around the hardware: which socket terminates which connections, which socket holds which shard, which socket runs which background work. The application code stays simple, because the placement does the heavy lifting.

---
