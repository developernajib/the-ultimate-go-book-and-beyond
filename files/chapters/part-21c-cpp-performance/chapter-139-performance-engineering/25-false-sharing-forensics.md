## False Sharing Forensics

False sharing is the most expensive bug nobody sees in code review. Two threads write to different variables that happen to share a 64-byte cache line. Every write invalidates the line in the other core's L1, forcing a coherence transfer that costs 40 to 200 ns. Throughput drops by an order of magnitude and the code looks correct.

### The Anatomy

MESI/MOESI coherence: only one core can hold a line in `Modified` state. A write requires getting the line in `M`. Other cores' copies (in `S` or `E`) are invalidated.

If two cores keep writing to the same line in turn, the line bounces:

```
T0 writes -> line M on core 0,  invalidates core 1
T1 writes -> line M on core 1,  invalidates core 0
T0 writes -> back to core 0
...
```

Each transfer crosses the on-die mesh / fabric. Within a socket: 40 to 60 ns. Cross-socket: 100 to 200 ns.

### Detecting with perf c2c

`perf c2c` (cache-to-cache) is the dedicated tool. It samples HITM (hit-modified) events: loads that hit a line owned dirty by another core.

```bash
sudo perf c2c record -F 99 -- ./binary
sudo perf c2c report -NN -g --call-graph -c pid,iaddr
```

Output:

```
Shared Cache Line Distribution Pareto:
  ----------------------------------------
  Cacheline   Total recs  Total HITM  Pct
  ffff8a..40       12873        9842  76.4%   <-- offender
  ----------------------------------------
  Offset  Symbol               Source            HITM
  0x00    Stats::reqs          stats.cc:42       42%
  0x08    Stats::errors        stats.cc:43       28%
  0x10    Stats::bytes         stats.cc:44       18%
  ...
```

Three counters in the same struct, three threads writing to them, line bounces. Fix: pad each to its own line.

`perf c2c` requires Intel PEBS (and recent kernels) or AMD IBS. For ARM/POWER, equivalent tools vary, on Apple Silicon, Instruments' counters can show similar info.

### Fix Patterns

#### alignas + padding

```cpp
struct alignas(64) PaddedCounter {
    std::atomic<uint64_t> v{0};
    char pad[64 - sizeof(std::atomic<uint64_t>)];
};
struct Stats {
    PaddedCounter reqs, errors, bytes;
};
```

Or using the standard hint:

```cpp
struct alignas(std::hardware_destructive_interference_size) PadCounter {
    std::atomic<uint64_t> v{0};
};
```

GCC warns that `hardware_destructive_interference_size` is non-portable across ABI versions (`-Winterference-size`). For library headers, define your own constant and document it.

#### Per-thread storage

If the counter is incremented by a fixed thread, just keep one counter per thread. No padding, no contention.

```cpp
class CounterArray {
    static constexpr size_t N = 256; // max threads
    struct alignas(64) Slot { std::atomic<uint64_t> v{0}; };
    std::array<Slot, N> slots_;
public:
    void incr(size_t tid) noexcept { slots_[tid].v.fetch_add(1, std::memory_order_relaxed); }
    uint64_t total() const noexcept {
        uint64_t s = 0;
        for (auto& sl : slots_) s += sl.v.load(std::memory_order_relaxed);
        return s;
    }
};
```

#### Move cold fields away

Sometimes the false sharing is between a hot atomic and a cold flag in the same line.

```cpp
struct Worker {
    std::atomic<uint64_t> hot;          // written every request
    bool shutdown_requested;            // written once at shutdown
    int debug_level;                    // changed rarely
};
```

The cold writes are rare, but every cache miss on `shutdown_requested` reads the same line, evicting `hot` from someone's L1.

Fix: separate.

```cpp
struct Worker {
    alignas(64) std::atomic<uint64_t> hot;
    alignas(64) struct {
        bool shutdown_requested;
        int debug_level;
    } cold;
};
```

### A Concrete Benchmark

```cpp
struct Unpadded {
    std::atomic<uint64_t> a{0};
    std::atomic<uint64_t> b{0};
};
struct Padded {
    alignas(64) std::atomic<uint64_t> a{0};
    alignas(64) std::atomic<uint64_t> b{0};
};

template <class S>
double bench(S& s, size_t iters) {
    auto start = std::chrono::steady_clock::now();
    std::thread ta([&]{ for (size_t i=0;i<iters;++i) s.a.fetch_add(1, std::memory_order_relaxed); });
    std::thread tb([&]{ for (size_t i=0;i<iters;++i) s.b.fetch_add(1, std::memory_order_relaxed); });
    ta.join(); tb.join();
    auto end = std::chrono::steady_clock::now();
    return std::chrono::duration<double>(end - start).count();
}

int main() {
    constexpr size_t N = 100'000'000;
    Unpadded u; Padded p;
    std::cout << "unpadded: " << bench(u, N) << " s\n";
    std::cout << "padded:   " << bench(p, N) << " s\n";
}
```

Sapphire Rapids, 2 threads on different physical cores:

```
unpadded: 1.42 s
padded:   0.18 s
```

8x difference, identical algorithm. With perf:

```bash
$ perf stat -e mem_load_l3_hit_retired.xsnp_hitm ./bench
unpadded: 6,142,038 mem_load_l3_hit_retired.xsnp_hitm
padded:        2,041 mem_load_l3_hit_retired.xsnp_hitm
```

The HITM count is the smoking gun.

### Less Obvious Cases

#### `std::atomic<bool>` in a vector

```cpp
std::vector<std::atomic<bool>> flags(1024);  // 1 byte each
```

64 atomic bools per cache line. Threads writing distinct indices share lines. Solutions:

- Wrap in a struct with alignas(64) (memory cost: 64x bloat)
- Use a bitmap with atomic ops on full uint64_t words (one word, eight threads, but per-bit)
- Lock-free SPSC queue per thread instead of shared flags

#### shared_ptr ref counts

```cpp
std::shared_ptr<Big> p1 = make_shared<Big>();
std::shared_ptr<Big> p2 = p1;   // each thread copies
// Many threads incrementing/decrementing the control block ref count -> contention
```

The control block is the line that bounces. Avoid `shared_ptr` on hot paths shared across threads. Use intrusive_ptr with per-thread ref count batching, or pass by raw pointer / reference with a separate ownership scheme.

#### Adjacent std::vector pushes

```cpp
std::vector<std::vector<int>> per_thread(N);
// thread i pushes to per_thread[i]
```

`std::vector` headers are often 24 bytes, 2.5 per line. Two adjacent vectors can share a line for their sizes/capacities/pointers, even though the data is on the heap. Pad the wrappers.

#### Heap allocator metadata

Some allocators put metadata (free list links) inline at the start of every block. Two adjacent allocations may have metadata that shares a line, getting touched on free. tcmalloc and jemalloc avoid this with separate metadata regions.

### Dynamic Detection

Beyond `perf c2c`, eBPF can sample HITM with custom scripts. Intel's PT (Processor Trace) can pinpoint per-instruction. ASAN/TSAN do not detect false sharing (it is not a correctness bug).

Static detection: harder. `clang-tidy` and various lint tools can flag unaligned shared atomics, but they cannot model thread access patterns.

### When NOT to Pad

- Cold data (rare writes): padding wastes memory
- Per-thread struct (unique to that thread): no contention to begin with
- Read-only after init: never written, no invalidation
- Embedded in a larger struct already aligned for other reasons

Padding is not free. Each padded counter is 64 (or 128 on Apple) bytes. A million padded counters costs 64 MB. Use only on contention points.

### Junior to FAANG callout

Run `perf c2c` against every multi-threaded service you write. The first time you do this on a real service you will find at least one offender. Padding is cheap to fix, expensive to leave.

### Senior at FAANG callout

Code review for false sharing means thinking about which fields are written by which threads at what frequency. If you cannot answer that for every field of a hot struct, the design is unfinished. Standard libraries' `std::shared_ptr`, `std::atomic` ref-counts, and `std::vector` with concurrent push_back are footguns at scale.

### Quick checklist

- Hot atomics: padded to a cache line
- Per-thread structs: aligned, sized to a multiple of cache line
- shared_ptr on hot paths: replaced
- `std::vector<std::atomic<bool>>`: replaced with bitmap or per-thread
- `perf c2c` in CI for any binary above some line count
- Padding constant: pin to 64 (or 128 if Apple is a target), do not rely on `hardware_destructive_interference_size` across ABI versions
