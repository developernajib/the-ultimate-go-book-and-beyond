## Memory Allocator Benchmarking

Allocator microbenchmarks lie. They lie about throughput because they do not match the real allocation pattern. They lie about latency because they sample averages, not tails. They lie about memory because they do not measure the post-fragmentation RSS that production sees after hours of running. To pick an allocator that wins in production you have to benchmark like production.

### What to Measure

Five metrics matter. All five.

1. Throughput: allocations per second under steady state. Easy to measure, often misleading on its own.
2. p50 / p99 / p99.9 / p99.99 allocation latency. Tail latency is where allocators differ most. A median 30 ns alloc with a p99.99 of 5 ms is unusable in low-latency systems.
3. RSS bloat ratio: peak RSS divided by live allocated bytes. A ratio of 1.5x is good. 3x is bad. 10x is broken.
4. Steady-state RSS after long runtime: many allocators have RSS that climbs and stabilizes, some never stabilize.
5. Cross-thread free penalty: the cost of freeing in a thread other than the allocating thread. This is where naive thread-local allocators fall apart.

Allocators that win on (1) often lose on (3) and (4). Decide what your service cares about before benchmarking.

### mimalloc-bench

mimalloc-bench is the reference benchmark suite for general-purpose allocators. It includes ~30 workloads from real applications (cfrac, espresso, larson, malloc-large, mleak, redis, rocksdb, sh6bench, xmalloc-test, alloc-test, sh8bench, mstress, rptest, glibc-bench, larsonN-sized, cscratch). Each workload is a different allocation pattern.

```bash
git clone https://github.com/daanx/mimalloc-bench.git
cd mimalloc-bench
./build-bench-env.sh all
./bench.sh -allocators=sys,je,tc,mi -benches=cfrac,larson,redis
```

The output is a per-allocator-per-benchmark table of time and RSS. Read the suite's README to understand what each workload stresses. `larson` is multi-threaded and stresses cross-thread free. `cfrac` is single-threaded compute heavy with small allocations. `redis` is a real workload that exposes long-tail behaviors.

### ali-bench (Alibaba's Allocator Benchmark)

ali-bench targets multi-threaded workloads with adversarial patterns. It tests producer-consumer (one thread allocates, another frees), N-producer-N-consumer, fragmentation patterns (alloc many small, free every other one), and mixed-size workloads. These stress paths that naive single-threaded benchmarks never hit.

The takeaway from ali-bench is usually that allocator choice depends on the producer-consumer ratio and whether free crosses threads frequently.

### Stress Patterns That Matter

If you cannot use an off-the-shelf suite, write the patterns yourself.

```cpp
// Pattern 1: many small allocations, all kept alive.
// Stresses size class fragmentation.
void stress_small_kept(size_t n) {
    std::vector<void*> ptrs;
    ptrs.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        ptrs.push_back(std::malloc(8 + (i % 64)));
    }
    for (void* p : ptrs) std::free(p);
}

// Pattern 2: half-and-half free.
// Stresses free-list fragmentation at the page/slab level.
void stress_fragmentation(size_t n) {
    std::vector<void*> ptrs(n);
    for (size_t i = 0; i < n; ++i) ptrs[i] = std::malloc(64);
    // Free every other one. Now memory is checkerboarded.
    for (size_t i = 0; i < n; i += 2) {
        std::free(ptrs[i]);
        ptrs[i] = nullptr;
    }
    // Allocate larger objects. Can the allocator coalesce?
    for (size_t i = 0; i < n / 4; ++i) std::malloc(256);
}

// Pattern 3: mixed sizes, geometric distribution.
// Mimics real application allocation distributions.
void stress_mixed(size_t n) {
    std::mt19937 rng(42);
    std::geometric_distribution<size_t> dist(0.05);
    std::vector<void*> ptrs;
    for (size_t i = 0; i < n; ++i) {
        size_t sz = std::min<size_t>(dist(rng) + 8, 4096);
        ptrs.push_back(std::malloc(sz));
        if (ptrs.size() > 1000 && (rng() & 1)) {
            size_t idx = rng() % ptrs.size();
            std::free(ptrs[idx]);
            ptrs[idx] = ptrs.back();
            ptrs.pop_back();
        }
    }
    for (void* p : ptrs) if (p) std::free(p);
}

// Pattern 4: producer-consumer.
// Stresses cross-thread free path.
void stress_xthread() {
    constexpr size_t N = 1'000'000;
    std::vector<void*> queue;
    std::mutex mu;
    std::condition_variable cv;
    bool done = false;

    std::thread producer([&] {
        for (size_t i = 0; i < N; ++i) {
            void* p = std::malloc(64);
            std::lock_guard g(mu);
            queue.push_back(p);
            cv.notify_one();
        }
        std::lock_guard g(mu);
        done = true;
        cv.notify_one();
    });

    std::thread consumer([&] {
        while (true) {
            std::unique_lock g(mu);
            cv.wait(g, [&] { return !queue.empty() || done; });
            if (queue.empty() && done) return;
            void* p = queue.back();
            queue.pop_back();
            g.unlock();
            std::free(p);
        }
    });

    producer.join();
    consumer.join();
}
```

Each pattern surfaces a different weakness. Glibc malloc fares worst on producer-consumer. Mimalloc handles fragmentation well. Jemalloc and tcmalloc handle mixed sizes well. Run all four against each candidate allocator, plot the results.

### Measuring RSS Bloat

Read `/proc/self/statm` periodically.

```cpp
size_t resident_kb() {
    std::ifstream f("/proc/self/statm");
    size_t size, resident;
    f >> size >> resident;
    return resident * (sysconf(_SC_PAGESIZE) / 1024);
}
```

Sample at 100ms intervals throughout the workload. Plot RSS vs time alongside allocated bytes (which you track explicitly). The ratio at peak and the ratio after the last `free` are the two numbers that matter. The post-free ratio shows whether the allocator returns memory to the kernel or holds it.

For containerized workloads, also read `/sys/fs/cgroup/memory.current` (cgroup v2). RSS-from-statm and cgroup memory differ slightly because of shared mappings.

### Measuring Tail Latency

Microbench latency with `rdtsc` or `clock_gettime(CLOCK_MONOTONIC)` per allocation.

```cpp
std::vector<uint64_t> latencies(N);
for (size_t i = 0; i < N; ++i) {
    auto start = std::chrono::steady_clock::now();
    void* p = std::malloc(64);
    auto end = std::chrono::steady_clock::now();
    latencies[i] = std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();
    std::free(p);
}
std::sort(latencies.begin(), latencies.end());
std::cout << "p50:    " << latencies[N / 2] << " ns\n"
          << "p99:    " << latencies[N * 99 / 100] << " ns\n"
          << "p99.9:  " << latencies[N * 999 / 1000] << " ns\n"
          << "p99.99: " << latencies[N * 9999 / 10000] << " ns\n"
          << "max:    " << latencies.back() << " ns\n";
```

Use HdrHistogram for a fixed-memory log-bucketed histogram if you cannot afford to keep all latencies in a vector.

`rdtsc` is faster than `clock_gettime` but you need to convert cycles to nanoseconds and pin the thread to a single core to avoid TSC sync issues across cores. For sub-100ns resolution, prefer `rdtsc` with the conversion factor measured at startup.

### Comparison Methodology

The procedure that produces decisions worth shipping.

1. Replay your production workload, not synthetic. Capture allocation traces with `LD_PRELOAD` shim or eBPF (`libtraceevent` + `kprobe`s). Replay the trace against each candidate allocator.
2. Same hardware as production. Same kernel. Same NUMA topology. Same hugepage configuration. Allocator behavior changes with all of these.
3. Same compiler flags. `-O2` vs `-O3` interacts with the inliner around malloc. LTO interacts with allocator hooks.
4. Multiple runs. At least 5. Report median and IQR, not mean and stddev. Allocator timing has heavy tails.
5. Long enough to reach steady state. RSS often climbs for 10-30 minutes before stabilizing. Throughput often dips around minute 5 as fragmentation appears.
6. Multiple workload phases. Cold start, warm steady state, mid-flight burst, idle, second burst. The second burst reveals whether the allocator gave memory back during idle.
7. Compare on the metric that matters for the service. There is no overall "best allocator." Pick a primary metric (latency p99.9, RSS, throughput) and a budget on the others.

### Common Mistakes

- Benchmarking with `for (i = 0; i < N; ++i) { p = malloc(64); free(p); }`. The compiler eliminates this. Even when it does not, the allocator hits its hot path and reports an unrealistically low number.
- Reporting average latency. Allocators have multimodal distributions. Average obscures the tail.
- Benchmarking single-threaded then claiming the result for multi-threaded code. Cross-thread free pattern dominates real workloads.
- Comparing allocators on different hardware. Run them all in the same job.
- Measuring throughput on a CPU-bound workload where allocation is 1% of the time. Allocator choice will not move the needle on the actual metric.

### Junior to FAANG

A junior engineer reads a blog post about mimalloc winning on a microbench and switches the production allocator. A FAANG-grade engineer captures a production allocation trace, replays it against each candidate on identical hardware, plots tail latency and RSS over a 30-minute steady state, and only switches when both improve on the metric the service cares about. They also know the answer is sometimes "the system allocator is fine" and that the most expensive thing about an allocator switch is the on-call learning curve, not the milliseconds saved.
