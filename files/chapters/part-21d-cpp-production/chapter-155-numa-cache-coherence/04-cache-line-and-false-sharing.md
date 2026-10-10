## 4. Cache Lines and False Sharing

False sharing is the cheapest performance bug to introduce and the most expensive to find. Two unrelated variables sit in the same 64-byte cache line. Two cores update them. Neither core knows the other exists. The hardware ping-pongs the line between L1 caches, and a 4 GHz CPU runs at the speed of a coherence transaction.

### The Cache Line

Almost all x86 and recent ARM server CPUs use 64-byte cache lines. Apple M-series uses 128 bytes. The cache line is the unit of coherence. The hardware does not track 4-byte words. It tracks 64-byte (or 128-byte) lines. A write to byte 0 invalidates the entire line in every other cache that holds a copy.

```cpp
struct BadCounters {
    std::atomic<uint64_t> a;  // bytes 0-7
    std::atomic<uint64_t> b;  // bytes 8-15
    // a and b are in the same 64-byte line.
};
```

If thread T0 increments `a` at 100 million ops/sec on core 0, and T1 increments `b` at 100 million ops/sec on core 1, the actual throughput will be far lower than 200 million combined ops/sec. The line bounces between L1 of core 0 and L1 of core 1 on every write. On a same-socket pair, you might see 40 to 60 million combined ops/sec. On different sockets, single-digit millions.

### A Real Microbenchmark

```cpp
#include <atomic>
#include <thread>
#include <chrono>
#include <cstdio>
#include <new>

struct Shared {
    std::atomic<uint64_t> a{0};
    std::atomic<uint64_t> b{0};
};

struct Padded {
    alignas(64) std::atomic<uint64_t> a{0};
    alignas(64) std::atomic<uint64_t> b{0};
};

template <typename T>
double bench(T& s, int iters) {
    auto t0 = std::chrono::steady_clock::now();
    std::thread ta([&]{ for (int i = 0; i < iters; ++i) s.a.fetch_add(1, std::memory_order_relaxed); });
    std::thread tb([&]{ for (int i = 0; i < iters; ++i) s.b.fetch_add(1, std::memory_order_relaxed); });
    ta.join();
    tb.join();
    auto t1 = std::chrono::steady_clock::now();
    return std::chrono::duration<double>(t1 - t0).count();
}

int main() {
    constexpr int N = 50'000'000;
    Shared s;
    Padded p;
    std::printf("shared:  %.3f s\n", bench(s, N));
    std::printf("padded:  %.3f s\n", bench(p, N));
}
```

On a Zen 4 EPYC, a typical run shows the shared version taking 1.8 seconds and the padded version taking 0.25 seconds. A 7x improvement from 64 bytes of padding.

### std::hardware_destructive_interference_size

C++17 introduced two constants in `<new>`:

- `std::hardware_destructive_interference_size`: the minimum spacing to avoid false sharing.
- `std::hardware_constructive_interference_size`: the maximum spacing to take advantage of cache prefetching for related data.

```cpp
#include <new>
struct Padded {
    alignas(std::hardware_destructive_interference_size) std::atomic<uint64_t> a{0};
    alignas(std::hardware_destructive_interference_size) std::atomic<uint64_t> b{0};
};
```

Catch: this is a compile-time constant. On libstdc++ it is currently 64 even when targeting Apple Silicon (which uses 128). On libc++ it is 64 too. If you ship a single binary that runs on both x86 and ARM Apple, you might want to use `128` directly to be safe, or query at runtime and dynamically lay out your structures (which is exotic and rarely worth it).

GCC also warns about ABI stability of these constants. If you use them across translation units that may be compiled with different settings, you can get linker mismatches. The pragmatic move is to define your own constant:

```cpp
#if defined(__APPLE__) && defined(__arm64__)
inline constexpr size_t kCacheLine = 128;
#else
inline constexpr size_t kCacheLine = 64;
#endif
```

### Detecting False Sharing with perf c2c

```bash
sudo perf c2c record -F 99 ./your_program
sudo perf c2c report --stdio
```

The output shows "HITM" (hit modified) events grouped by cache line. A hot HITM line with high "remote HITM" count and multiple writer CPUs is a smoking gun for false sharing.

A typical report excerpt:

```
       =================================================
                  Trace Event Information
       =================================================
        Total records          : 1234567
        Locked Load/Store      : 89012
        Load LLC Misses        : 234567
        ...
       =================================================
            Shared Data Cache Line Table
       =================================================
  Index  Cacheline    Total  Tot  ... Symbol
   0     0x7f2a...    50000  ... [.] my_counter_struct+0x0
   1     0x7f2a...    32000  ... [.] another_struct+0x40
```

The address column tells you the exact line. The `addr2line` tool or the `Symbol` column tells you the source location.

### Padding Patterns

**Pattern 1: alignas on the contained type.**

```cpp
struct alignas(64) PerCoreCounter {
    std::atomic<uint64_t> value{0};
};
std::array<PerCoreCounter, 64> counters;
```

**Pattern 2: Separate the contended writer from the readers.**

```cpp
struct Hot {
    alignas(64) std::atomic<uint64_t> writer_only;
    char pad[64 - sizeof(std::atomic<uint64_t>)];
    alignas(64) std::atomic<uint64_t> reader_mostly;
};
```

**Pattern 3: Per-thread storage with thread_local.**

```cpp
thread_local uint64_t local_counter = 0;
// Aggregate periodically:
std::atomic<uint64_t> global_counter{0};
void flush() {
    global_counter.fetch_add(local_counter, std::memory_order_relaxed);
    local_counter = 0;
}
```

This eliminates contention entirely between flushes. The trade-off is that readers see slightly stale values.

### False Sharing You Cannot See in the Source

The most insidious cases come from the runtime, not your code:

- `std::vector<bool>` packs 8 elements per byte. Two threads writing to "different" indices may share a byte and a cache line.
- Heap allocations from the same arena may produce neighboring allocations on the same line. `tcmalloc` and `jemalloc` mostly avoid this through size-class slabs, but small objects (16, 24, 32 bytes) can still pack.
- Standard library containers like `std::deque` allocate fixed-size blocks that may span lines.

When you cannot reproduce false sharing from the source, run `perf c2c` and let the hardware tell you.

### Junior to FAANG

A junior pads everything with `alignas(64)`. A FAANG engineer pads only the variables that are written by multiple threads, leaves read-mostly fields packed for L1 efficiency, and measures the line layout with `pahole` to confirm.

### Senior at FAANG

Staff engineers design data structures so false sharing is impossible by construction, not avoided by padding. Per-core sharded counters, per-NUMA-node hash tables, and shard-per-core architectures (SeaStar) eliminate the question entirely. Padding is a fix for a design that already lost.

---
