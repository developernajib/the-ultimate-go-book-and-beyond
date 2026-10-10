## False Sharing and Cache Line Alignment

### What Is False Sharing?

Modern CPUs transfer data between cores in **cache lines**, typically 64 bytes. When two threads write to different variables that happen to reside on the same cache line, the hardware coherency protocol (MESI/MOESI) bounces that cache line back and forth between cores. This is called **false sharing** and can devastate performance.

```
Cache line (64 bytes):
┌─────────────────────────────────────────────────────┐
│  counter_a (8 bytes)  │  counter_b (8 bytes)  │ ... │
└─────────────────────────────────────────────────────┘
         ↑                        ↑
      Thread 1                 Thread 2
      writes here              writes here
      
Both threads invalidate each other's cache line on every write!
```

### Detecting and Fixing False Sharing

Two atomic counters in `BadCounters` share a 64-byte cache line. When thread A increments `counter_a` and thread B increments `counter_b` simultaneously, both CPU cores invalidate each other's cache line on every write, serializing what should be independent operations. Aligning each counter to `hardware_destructive_interference_size` (typically 64 bytes) ensures they occupy separate cache lines and eliminate the false sharing penalty.
```cpp
#include <atomic>
#include <thread>
#include <chrono>
#include <iostream>
#include <new> // For hardware_destructive_interference_size

// BAD: counters on the same cache line - false sharing
struct BadCounters {
    std::atomic<int64_t> counter_a{0};
    std::atomic<int64_t> counter_b{0};
};

// GOOD: each counter on its own cache line
struct GoodCounters {
    // C++17: std::hardware_destructive_interference_size
    // This is the minimum offset between two objects to avoid false sharing.
    // Typically 64 bytes on x86. Some compilers don't define it, so provide
    // a fallback.
#ifdef __cpp_lib_hardware_interference_size
    static constexpr size_t cache_line = std::hardware_destructive_interference_size;
#else
    static constexpr size_t cache_line = 64;
#endif

    alignas(cache_line) std::atomic<int64_t> counter_a{0};
    alignas(cache_line) std::atomic<int64_t> counter_b{0};
};

template <typename Counters>
void benchmark(const char* label) {
    Counters counters;
    const int iterations = 50'000'000;

    auto start = std::chrono::high_resolution_clock::now();

    std::thread t1([&] {
        for (int i = 0; i < iterations; ++i) {
            counters.counter_a.fetch_add(1, std::memory_order_relaxed);
        }
    });

    std::thread t2([&] {
        for (int i = 0; i < iterations; ++i) {
            counters.counter_b.fetch_add(1, std::memory_order_relaxed);
        }
    });

    t1.join();
    t2.join();

    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    std::cout << label << ": " << ms.count() << " ms\n";
}

int main() {
    benchmark<BadCounters>("False sharing (bad) ");
    benchmark<GoodCounters>("Aligned (good)     ");
    return 0;
}

// Typical output on x86-64:
// False sharing (bad) : 850 ms
// Aligned (good)      : 250 ms
// That's a 3-4x difference from a simple alignment change!
```

### hardware_destructive_interference_size vs hardware_constructive_interference_size

C++17 defines two constants in `<new>`:

- **`hardware_destructive_interference_size`**: Minimum offset to **avoid** false sharing. Use `alignas` with this to separate independent atomics.
- **`hardware_constructive_interference_size`**: Maximum size that **benefits** from being on the same cache line. Use this to keep related data together for spatial locality.

```cpp
// Keep together: data accessed together should share a cache line
struct alignas(std::hardware_constructive_interference_size) HotData {
    int key;
    int value;
    // Fits in one cache line - accessed together, cached together
};

// Keep apart: independent data on separate cache lines
struct ThreadLocal {
    alignas(std::hardware_destructive_interference_size) std::atomic<int> my_counter{0};
};
```

### Junior → FAANG: False Sharing as a Silent Performance Killer

False sharing is one of the most common performance bugs in multi-threaded C++ code, and it is invisible to Valgrind, TSan, and ASan because it is not a correctness bug. Two threads write to different variables that happen to share a cache line. The variables are logically independent, but the hardware sees them as the same unit of memory, so every write by one thread invalidates the cache line for the other, causing cache-miss thrashing.

The symptom: a multi-threaded program that is slower than its single-threaded equivalent even when the threads do no shared work. The diagnosis: `perf c2c` on Linux (cache-to-cache transfer analysis) or VTune's cache-coherence analysis on Windows. Both show which cache lines are being bounced between cores.

The fix pattern: pad or align hot variables to `alignas(std::hardware_destructive_interference_size)` (C++17). This constant is typically 64 bytes on x86 and ARM. Put the padding in the struct definition adjacent to the hot variable.

First-job interview tip: know that `std::hardware_destructive_interference_size` and `std::hardware_constructive_interference_size` exist in C++17. Being able to name these constants and explain the difference between destructive interference (false sharing, avoid it) and constructive interference (true sharing, pack hot fields together) signals systems depth.

### Senior @ FAANG: False Sharing as a Design Smell and a Governance Target

At L5+, false sharing is not just a bug to fix, it is a signal about data layout decisions made during design. If a struct has per-thread counters that are laid out sequentially, the design was not cache-aware from the start. The fix is not just padding. It is understanding why the struct was designed without cache-awareness and updating the data layout guidelines.

The mature approach at scale: use a sharded counter pattern for high-frequency per-thread statistics. Each thread writes to its own cache-line-aligned counter slot. Reads aggregate across all shards. This is the pattern used by tcmalloc's per-CPU caches and Linux kernel per-CPU variables. It scales linearly with core count.

ADR for cache-aware data layout: when designing any struct that will be accessed concurrently from multiple threads, require a layout review that explicitly identifies: (1) which fields are written by which threads, (2) which fields are read-only after initialization, (3) whether hot writer fields need cache-line isolation from hot reader fields (false sharing vs. constructive sharing). This review should be part of the design doc template for any concurrent data structure.

Platform concern: `hardware_destructive_interference_size` is 64 bytes on x86-64 and ARM Cortex-A. On some server ARM chips and POWER9, cache lines are 128 bytes. A codebase that hard-codes 64 bytes as the alignment has a latent false-sharing bug on 128-byte cache line platforms. Use the C++17 constant, not a magic number.

Bar-raiser signal: be able to explain the difference between true sharing (two threads legitimately share a cache line because they access related data together, e.g., a read-mostly config struct) and false sharing (two threads access logically independent data that happens to share a line). True sharing is sometimes intentional and beneficial. False sharing is always a performance bug.

---
