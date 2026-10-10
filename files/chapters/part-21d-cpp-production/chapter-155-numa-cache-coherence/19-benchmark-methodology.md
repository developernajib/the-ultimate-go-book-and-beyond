## 19. Benchmark Methodology

Performance claims that are not backed by reproducible benchmarks are noise. NUMA and coherence effects are especially prone to bad measurement: a microbenchmark that never crosses sockets cannot find the bug, a macrobenchmark contaminated by GC or networking can mask the effect.

### The Hierarchy of Benchmarks

1. **Microbenchmarks**: a few lines of code in a tight loop. Measure one effect (false sharing, cache miss cost, atomic contention).
2. **Component benchmarks**: a full data structure or subsystem. Measure realistic access patterns.
3. **Macrobenchmarks**: end-to-end workload (TPC-C, YCSB, custom).
4. **Production**: the real workload on real hardware.

Each level can lie. Microbenchmarks lie by being too clean. Macrobenchmarks lie by mixing many effects. Production lies by changing while you measure.

### Tools

#### Intel Memory Latency Checker (MLC)

Free download from Intel. Measures latency and bandwidth for every (CPU, memory) pair on the system.

```bash
sudo ./mlc --idle_latency
sudo ./mlc --bandwidth_matrix
sudo ./mlc --loaded_latency
sudo ./mlc --c2c_latency   # cache-to-cache transfer cost
```

`--idle_latency` gives the unloaded latency from each CPU to each memory node. This is the "specs" number you should base NUMA decisions on.

`--c2c_latency` measures the cost of cache-to-cache transfers between cores, including across sockets. Useful for understanding atomic contention costs.

#### STREAM (Bandwidth Benchmark)

The classic memory bandwidth benchmark. Four kernels: copy, scale, add, triad.

```c
// Pseudo-code - real STREAM is openmp-parallel.
for (i = 0; i < N; ++i) c[i] = a[i] + s * b[i];   // triad
```

Compile with OpenMP, run with `OMP_NUM_THREADS` and `OMP_PLACES` set:

```bash
OMP_NUM_THREADS=96 OMP_PLACES=cores OMP_PROC_BIND=close ./stream
```

Reports GB/s for each kernel. Triad is usually the most relevant. On a Sapphire Rapids 8480+ socket, peak is 200+ GB/s. On EPYC 9654, 350+ GB/s. Cross-socket only mode reveals UPI/xGMI limits.

#### lat_mem_rd (lmbench)

A pointer-chasing latency benchmark. Walks a randomized linked list of various sizes and measures average load latency.

```bash
lat_mem_rd 1024M 64
```

Output: latency by working set size. The curve has plateaus at L1, L2, L3, and DRAM sizes, revealing the hierarchy. NUMA effects show up as a steeper slope when crossing the LLC boundary.

#### AMD ucbench

AMD's equivalent to MLC for EPYC parts. Measures latency and bandwidth, with awareness of CCD and IOD topology.

#### perf bench

Built into `perf`:

```bash
perf bench mem memcpy -s 1MB --output-format=table
perf bench mem memset -s 1MB --output-format=table
perf bench numa mem -p 4 -t 8 -P 512 -C 0,8 -M 0,1 -s 20 -zZ0 -G 0
```

`perf bench numa` is specifically for NUMA workloads. Worth learning.

### Designing a NUMA Microbenchmark

```cpp
// Measure cross-socket cache line bounce cost.
#include <atomic>
#include <thread>
#include <chrono>
#include <numa.h>
#include <pthread.h>
#include <sched.h>
#include <cstdio>

void pin(int cpu) {
    cpu_set_t set; CPU_ZERO(&set); CPU_SET(cpu, &set);
    pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
}

struct alignas(64) Counter { std::atomic<uint64_t> v{0}; };

double bench_pair(int cpu_a, int cpu_b, Counter* c, uint64_t iters) {
    auto start = std::chrono::steady_clock::now();
    std::thread ta([&]{ pin(cpu_a); for (uint64_t i = 0; i < iters; ++i) c->v.fetch_add(1, std::memory_order_relaxed); });
    std::thread tb([&]{ pin(cpu_b); for (uint64_t i = 0; i < iters; ++i) c->v.fetch_add(1, std::memory_order_relaxed); });
    ta.join(); tb.join();
    auto end = std::chrono::steady_clock::now();
    return std::chrono::duration<double>(end - start).count();
}

int main() {
    Counter c;
    uint64_t iters = 10'000'000;
    // Same core (SMT siblings):
    std::printf("smt:        %.3f s\n", bench_pair(0, 1, &c, iters));
    // Same socket, different cores:
    std::printf("same-sock:  %.3f s\n", bench_pair(0, 4, &c, iters));
    // Cross-socket (e.g. CPU 0 and 96 on a 96-cores-per-socket box):
    std::printf("cross-sock: %.3f s\n", bench_pair(0, 96, &c, iters));
}
```

On a typical EPYC 9654 dual-socket: SMT pair ~0.4 s, same-socket different-core ~0.6 s, cross-socket ~3.5 s. The cross-socket cost is roughly 6x the same-core cost.

### Common Microbenchmark Mistakes

1. **Not pinning.** The OS migrates threads. Each run measures something different. Always pin.
2. **Tiny iteration counts.** Below ~100 ms total, timer noise dominates. Run for at least a few seconds.
3. **Compiler optimization removing the work.** Use `volatile` or print results to keep the work observable.
4. **Cache warmup.** First iteration includes cold-cache misses. Discard a warmup run.
5. **CPU frequency scaling.** Lock the CPU frequency before benchmarking:
   ```bash
   for c in $(seq 0 $(nproc)); do
       echo performance > /sys/devices/system/cpu/cpu$c/cpufreq/scaling_governor
   done
   ```
6. **Background noise.** `tuned-adm profile latency-performance` minimizes background interference.
7. **One run.** Run at least 5 times and report median or P95.

### Macro Benchmark Discipline

Same rules apply at the macro level, plus:

- **Warm up the entire system** for the same duration as the measurement, not just a few seconds.
- **Measure during steady state**, not during ramp.
- **Match production conditions**: same kernel, same NIC firmware, same THP setting, same `numa_balancing` setting.
- **Vary one thing at a time.** "Enabled NUMA pinning AND switched allocator" gives you a result you cannot attribute.
- **Test the regression direction too.** If you can speed it up by 30 percent, can you slow it down by the same 30 percent by reverting? If yes, the change is the cause. If no, something else moved.

### Reproducible Reporting

A good NUMA benchmark report includes:

```
Hardware: Intel Xeon 8480+, 2 sockets, 56 cores each, SMT off, 1 TB DDR5-4800
Kernel: 6.5.0-15-generic, NUMA balancing off
Compiler: GCC 13.2 -O3 -march=native
THP: madvise. Hugepages: 2 MB, 16 GB reserved per node.
CPU governor: performance. Frequency locked to 3.4 GHz base.
Pinning: thread N pinned to CPU N (one thread per physical core).
Memory: numa_alloc_onnode for per-thread buffers.
Iterations: 10 runs of 30 seconds each. Reported: median throughput.
```

Without this metadata, the numbers are not reproducible.

### Junior to FAANG

A junior posts a benchmark with no metadata and a 5-second run. A FAANG engineer pins, locks frequency, runs 10 iterations, reports median and IQR, includes the hardware spec, and explains the methodology.

### Senior at FAANG

Staff engineers know that a benchmark is only as good as its hypothesis. "Is the bottleneck cross-socket coherence?" is testable. "Is this fast?" is not. Frame the benchmark as a falsifiable claim, design the methodology to falsify it, and report the result either way.

---
