## Cache Hierarchy Optimization

DRAM latency on a modern Xeon is around 80 ns. L3 hit is around 12 ns. L1 is 4 cycles (about 1 ns at 4 GHz). The 80x gap is what makes data layout the highest-use optimization in C++.

### Sizes by Microarchitecture (per core unless noted)

| uarch | L1d | L1i | L2 | LLC (shared) | Line size |
|-------|-----|-----|-----|--------------|-----------|
| Skylake-SP | 32 KB | 32 KB | 1 MB | 1.375 MB/core | 64 B |
| Cascade Lake | 32 KB | 32 KB | 1 MB | 1.375 MB/core | 64 B |
| Icelake-SP | 48 KB | 32 KB | 1.25 MB | 1.5 MB/core | 64 B |
| Sapphire Rapids | 48 KB | 32 KB | 2 MB | 1.875 MB/core | 64 B |
| Emerald Rapids | 48 KB | 32 KB | 2 MB | 5 MB/core | 64 B |
| Granite Rapids | 48 KB | 64 KB | 2 MB | varies | 64 B |
| Zen 3 | 32 KB | 32 KB | 512 KB | 32 MB/CCX | 64 B |
| Zen 4 | 32 KB | 32 KB | 1 MB | 32 MB/CCD | 64 B |
| Zen 5 | 48 KB | 32 KB | 1 MB | 32 MB/CCD | 64 B |
| Apple M3 P-core | 64 KB | 192 KB | 16 MB shared | n/a | 128 B |

Apple Silicon's 128-byte cache lines bite anyone porting code with `alignas(64)`. Use `std::hardware_destructive_interference_size` (often 64 on Intel, 128 on Apple, 256 on some POWER).

### Measuring Cache Misses

```bash
perf stat -e \
  L1-dcache-loads,L1-dcache-load-misses,\
l2_rqsts.demand_data_rd_hit,l2_rqsts.demand_data_rd_miss,\
LLC-loads,LLC-load-misses,\
mem_load_retired.l1_hit,mem_load_retired.l1_miss,\
mem_load_retired.l2_hit,mem_load_retired.l3_hit,mem_load_retired.l3_miss \
  ./binary
```

L1 miss rate over 5% on a hot loop is a smell. Over 20% means you have a layout problem. LLC miss rate over 5% means DRAM-bound, fix data structures or prefetch.

### perf c2c: Coherence Misses

`perf c2c` (cache-to-cache) records HITM (hit-modified) events. These fire when a load hits a line that another core owns dirty, forcing a cross-core transfer (40 to 200 ns penalty depending on socket layout).

```bash
perf c2c record -F 99 -- ./binary
perf c2c report -NN -g --call-graph -c pid,iaddr
```

Output shows offending cache lines, the threads sharing them, and the source lines reading and writing. False sharing is the bug `c2c` was built to find.

### False Sharing Anatomy

```cpp
struct Counters {
    std::atomic<uint64_t> a; // thread 0 writes
    std::atomic<uint64_t> b; // thread 1 writes
}; // both fit in one 64-byte line: every store invalidates the other core
```

Fix:

```cpp
struct alignas(std::hardware_destructive_interference_size) PaddedCounter {
    std::atomic<uint64_t> v;
};
struct Counters { PaddedCounter a, b; };
```

Benchmark, two threads, each incrementing 10M times on Sapphire Rapids:

```
Unpadded:   1.42 s, 2.4M HITM events
Padded:     0.18 s, ~0 HITM events
```

8x speedup, no other change.

### hardware_destructive_interference_size Caveat

C++17 added `std::hardware_destructive_interference_size`. GCC and Clang report 64 on x86. The catch: this is an ABI-stable value. If a struct member is aligned to it in a header, every TU including that header must agree. Some compilers warn (`-Winterference-size`). Workaround for libraries: define your own.

```cpp
inline constexpr size_t kCacheLineSize = 64;  // pin it explicitly
struct alignas(kCacheLineSize) PaddedAtomic { std::atomic<uint64_t> v; };
```

### Constructive Interference

The flip side: data accessed together should share a line. `std::hardware_constructive_interference_size` is the same number on x86 (64). Pack hot fields together, push cold fields to a separate struct, and use parallel arrays if a struct is bigger than a line.

### Struct-of-Arrays vs Array-of-Structs

```cpp
// AoS: cache-unfriendly when scanning one field
struct Particle { float x, y, z, vx, vy, vz, mass; uint32_t id; };
std::vector<Particle> ps;

// SoA: scanning x is one contiguous stream
struct Particles {
    std::vector<float> x, y, z, vx, vy, vz, mass;
    std::vector<uint32_t> id;
};
```

For a 1M particle physics integrator updating x += vx (Skylake-X):

```
AoS:   3.8 ms, L1d miss 28%, IPC 0.9
SoA:   0.6 ms, L1d miss 1%, IPC 3.1, AVX-512 vectorized
```

The AoS version touched 32 bytes per particle, used 6 of 64 bytes per line, and could not vectorize cleanly. SoA used full lines, hardware prefetcher engaged, AVX-512 packed 16 floats per op.

### Hybrid: Hot/Cold Splitting

```cpp
// 64-byte line on hot path
struct alignas(64) ConnHot {
    int fd;
    uint64_t bytes_in;
    uint64_t bytes_out;
    State state;
    Conn* next;        // intrusive list
    char pad[24];
};
struct ConnCold {
    std::string remote_addr;
    std::string user_agent;
    Time connect_at;
    // ...
};
struct Conn { ConnHot hot; ConnCold cold; };
// Better: parallel containers, indices match
```

The poll loop reads `ConnHot` only. Logging code reads `ConnCold`. Keeps the hot working set inside L2.

### Cache-Conscious Hash Maps

`std::unordered_map` is famously cache-hostile (node-based, separate chaining, pointer hops). `absl::flat_hash_map`, `boost::unordered_flat_map`, `ankerl::unordered_dense` use open addressing with metadata bytes packed first.

`absl::flat_hash_map` SwissTable layout:

```
[ ctrl bytes 16x1B ][ slot 0 ][ slot 1 ]...[ slot 15 ]
```

A SIMD compare on the 16-byte control block finds candidate slots in one instruction. Average lookup: 1.1 cache lines touched. `unordered_map` averages 3 to 4. Result: 3 to 5x faster lookups on hot paths.

### Set-Associativity and Conflict Misses

L1d on Skylake is 8-way, 32 KB. There are 64 sets. Two addresses that differ by exactly 4 KB land in the same set. Stride a hot loop by 4 KB across 9+ pointers and L1 thrashes despite a tiny working set.

This bites strided allocations. Aligning everything to 4 KB (page boundaries) is a foot-gun. Add small offsets to spread sets:

```cpp
for (int i = 0; i < N; ++i) {
    buffers[i] = (char*)aligned_alloc(64, BUF_SIZE + i * 64);
    // tiny per-buffer offset breaks the conflict pattern
}
```

### Real Benchmark Deltas

Three real changes from a search-infra service we tuned:

1. Posting list scanner switched from std::vector<Posting> with 24-byte struct to SoA u32 docids + u8 freqs. Inner loop 2.1x faster.
2. RPC connection table split into `ConnHot` (32 B) and `ConnCold` heap. Poll loop 1.6x faster, no algorithmic change.
3. Per-thread metrics counter padded to 64 B. p99 tail latency on the noisy node dropped from 14 ms to 6 ms (false sharing on two unrelated counters).

### Junior to FAANG callout

Profile first. Adding `alignas(64)` everywhere bloats memory by 4-16x and pushes you out of L2. Pad only true contention points, identified by `perf c2c`.

### Senior at FAANG callout

The cache hierarchy is the substrate of the entire program. You should be able to draw your service's hottest data structure on a whiteboard with byte offsets and tell a reviewer which fields share a line, why, and which line is hot at every level. If you cannot, your hot path has bugs you have not found yet.

### Tools

- `pcm-memory` (Intel Performance Counter Monitor) for live bandwidth and miss-rate per channel
- `pmu-tools/cpubench.sh` for cache-latency curves on the host
- `lstopo --of png > topo.png` for visual topology
- `cachegrind` for repeatable cache-miss simulation (slow but deterministic)
