## Latency Numbers Every Programmer Should Know

These numbers are approximate for modern hardware (circa 2024-2025) and should be internalized:

```
L1 cache reference:                   1 ns        (4 cycles)
Branch mispredict:                    3-5 ns      (12-20 cycles)
L2 cache reference:                   4 ns        (12-15 cycles)
Mutex lock/unlock (uncontended):      15-25 ns
L3 cache reference:                   12-20 ns    (40-60 cycles)
Main memory reference:                50-100 ns   (150-300 cycles)
System call overhead:                 100-200 ns
Context switch:                       1-10 us     (microseconds)
SSD random read (NVMe):               10-20 us
SSD sequential read 1 MB (NVMe):      50-100 us
Mutex lock/unlock (contended):        1-100 us
TCP round-trip same datacenter:       500 us
SSD random read (SATA):               100-200 us
HDD seek:                             2-10 ms     (milliseconds)
TCP round-trip cross-continent:       50-150 ms
```

Key ratios to remember:

- **L1 to main memory: 50-100x.** A cache miss costs as much as 50-100 L1 hits. This is why data layout matters more than algorithm complexity for many workloads.
- **Main memory to SSD: 100-200x.** An SSD access costs as much as 100-200 memory accesses. This is why memory-mapped files are not "free."
- **SSD to network: 25-300x.** A cross-datacenter round trip costs as much as 25-300 SSD reads.

```cpp
// Practical implication: linked list vs vector lookup
// For N=1000, a linked list traversal might cause ~1000 cache misses
// at 50-100ns each = 50-100 microseconds
// A vector scan over 1000 ints (4KB) fits in L1 cache
// at ~1ns per access = ~1 microsecond
// The vector is 50-100x faster despite O(N) vs O(N)

#include <list>
#include <vector>
#include <benchmark/benchmark.h>

static void BM_VectorFind(benchmark::State& state) {
    std::vector<int> v(state.range(0));
    std::iota(v.begin(), v.end(), 0);
    int target = state.range(0) - 1;  // worst case: last element

    for (auto _ : state) {
        auto it = std::find(v.begin(), v.end(), target);
        benchmark::DoNotOptimize(it);
    }
}
BENCHMARK(BM_VectorFind)->Range(64, 1 << 16);

static void BM_ListFind(benchmark::State& state) {
    std::list<int> l;
    for (int i = 0; i < state.range(0); ++i) l.push_back(i);
    int target = state.range(0) - 1;

    for (auto _ : state) {
        auto it = std::find(l.begin(), l.end(), target);
        benchmark::DoNotOptimize(it);
    }
}
BENCHMARK(BM_ListFind)->Range(64, 1 << 16);
```

For sizes that exceed L1 cache (about 8K ints = 32KB), vector outperforms list by 10-50x despite identical algorithmic complexity.

---
