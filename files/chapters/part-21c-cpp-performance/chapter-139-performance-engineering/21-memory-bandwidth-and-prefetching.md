## Memory Bandwidth and Prefetching

A 32-core Sapphire Rapids socket with 8 DDR5-4800 channels has ~300 GB/s peak DRAM bandwidth. Few real workloads hit half of it. Bandwidth-bound code is the most common backend bottleneck after latency-bound code. Knowing your headroom is step one.

### Measuring Bandwidth

#### Stream Benchmark

The canonical microbenchmark. Build with -O3 and the compiler that matches your prod toolchain.

```bash
gcc -O3 -fopenmp -march=native -mcmodel=medium \
    -DSTREAM_ARRAY_SIZE=200000000 -DNTIMES=20 \
    stream.c -o stream
OMP_NUM_THREADS=32 OMP_PROC_BIND=close ./stream
```

Output (Sapphire Rapids 8480+, 8 channels DDR5-4800):

```
Function    Best Rate MB/s
Copy:        285,000
Scale:       284,000
Add:         275,000
Triad:       275,000
```

Triad is `a[i] = b[i] + s * c[i]`, the realistic mixed-stream case. 275 GB/s is near the theoretical 300 GB/s, leaving ~10% for refresh, ECC, and command overhead.

#### Intel MLC

Memory Latency Checker. Idle latency, loaded latency curve, per-channel breakdown.

```bash
sudo ./mlc --idle_latency
sudo ./mlc --loaded_latency
sudo ./mlc --bandwidth_matrix    # NUMA cross-socket BW
sudo ./mlc --c2c_latency         # cross-core latency
```

Loaded-latency curves show how latency rises as bandwidth saturates. The knee (where latency doubles) is the practical bandwidth ceiling for latency-sensitive workloads.

#### perf for live measurement

```bash
perf stat -a -e \
  uncore_imc_0/cas_count_read/,uncore_imc_0/cas_count_write/,\
uncore_imc_1/cas_count_read/,...  -- sleep 10
```

Each CAS is 64 bytes. Multiply count by 64 and divide by interval to get bytes/sec per channel. `pcm-memory` does this with a friendly UI.

### DRAM Channels and Interleaving

A modern Xeon socket has 6 to 12 memory controllers / channels. The kernel interleaves physical pages across channels at page granularity (4K) or sub-page (cache-line interleaving in some BIOS modes).

Rank interleaving: each channel has 1 to 4 ranks. Accessing rank N while rank M is busy hides activate/precharge latency.

NUMA misconfiguration kills bandwidth: a thread allocated on socket 0, running on socket 1, doubles every memory access (cross-socket UPI link is ~50 GB/s, slower than local DRAM).

```bash
numactl --hardware
# node 0 cpus: 0-31     node 0 size: 256 GB    node 0 free: 198 GB
# node 1 cpus: 32-63    node 1 size: 256 GB    node 1 free: 211 GB
# node distances:
#       0   1
#   0:  10  21
#   1:  21  10
```

### Software Prefetch

`__builtin_prefetch(addr, rw, locality)`:

- rw: 0 read, 1 write
- locality: 0 (no temporal), 1 (low), 2 (moderate), 3 (high, default)

```cpp
for (size_t i = 0; i < n; ++i) {
    __builtin_prefetch(&data[i + 16], 0, 1);
    process(data[i]);
}
```

Picking the prefetch distance:

```
distance ~= memory_latency_in_cycles / cycles_per_iteration
```

For 80 ns DRAM at 4 GHz with a 100-cycle iteration: prefetch ~3 iterations ahead. For 5-cycle iterations: prefetch ~64 ahead. Too close: data not in cache yet. Too far: prefetched line gets evicted before use.

Real example: pointer-chasing graph traversal:

```cpp
for (Node* n = head; n; n = n->next) {
    __builtin_prefetch(n->next, 0, 0);   // n->next->next not visible
    sum += n->value;
}
```

Pointer chase has a fundamental dependency you cannot break with prefetch. The prefetch above only helps when n->next was not yet loaded, which is the same line we are about to touch. To benefit, queue ahead:

```cpp
constexpr int LOOK = 8;
Node* future[LOOK] = {};
Node* cur = head;
for (int i = 0; i < LOOK && cur; ++i) { future[i] = cur; cur = cur->next; }
size_t fi = 0;
while (Node* n = future[fi]) {
    if (cur) {
        __builtin_prefetch(cur, 0, 0);
        future[fi] = cur;
        cur = cur->next;
    } else {
        future[fi] = nullptr;
    }
    sum += n->value;
    fi = (fi + 1) % LOOK;
}
```

This breaks the dependency chain by working on n while issuing loads for n+8.

### Hardware Prefetchers

Intel cores have four hardware prefetchers, all controlled via MSR 0x1A4 (per core):

| Bit | Prefetcher |
|-----|-----------|
| 0 | L2 stream prefetcher (off when set) |
| 1 | L2 adjacent-line prefetcher (off when set) |
| 2 | DCU (L1 streaming) prefetcher (off when set) |
| 3 | DCU IP-based prefetcher (off when set) |

All zeros = all on, the default. Read with `rdmsr 0x1A4 -p <cpu>`, write with `wrmsr -p <cpu> 0x1A4 <val>`. Requires `msr` kernel module.

Tuning matters when:

- Streaming a working set larger than LLC: HW prefetcher fills LLC with already-streamed lines, wasting bandwidth. Disable adjacent-line.
- Software prefetch is doing the job: HW + SW prefetch can race and bandwidth-limit. Disable HW DCU.

```bash
# Disable adjacent-line prefetcher on CPU 0
sudo wrmsr -p 0 0x1A4 0x2
# Restore
sudo wrmsr -p 0 0x1A4 0x0
```

AMD Zen has analogous controls in MSR 0xC0011022 and per-CCX bits.

### Streaming Stores (Non-Temporal)

`movntdq`/`vmovntpd` etc. write directly to a write-combining buffer, bypass cache. The store does not allocate the line in L1/L2/LLC.

```cpp
#include <immintrin.h>
void stream_zero(double* p, size_t n) {
    __m512d zero = _mm512_setzero_pd();
    for (size_t i = 0; i < n; i += 8) {
        _mm512_stream_pd(p + i, zero);
    }
    _mm_sfence();   // required before any reader sees these stores
}
```

When to use:

- Memset-like fills of regions that will not be re-read soon
- Producer in a producer/consumer queue when the consumer is on another core
- Streaming output of a transform (pixel processing, video encode)

Hidden costs:

- WC buffers are limited (4 to 6 per core). Mixing NT and normal stores can stall.
- Misaligned NT stores degrade or fault depending on instruction.
- `sfence` is mandatory before observers (regular stores do not see them as ordered).

Real numbers, copy 16 GB on Sapphire Rapids, 1 thread:

```
memcpy (rep movsb):       18 GB/s  (LLC pollution)
AVX-512 loop, normal:     26 GB/s
AVX-512 loop, streaming:  39 GB/s  (LLC clean, more BW available)
```

With multi-threading the gap widens, streaming does not contend for cache slots.

### Prefetch Tuning Heuristics

| Workload | Strategy |
|----------|----------|
| Linear scan, small struct | Trust HW prefetcher, no SW prefetch |
| Linear scan, large struct (skip) | SW prefetch `data[i+N]` with distance ~8 to 32 |
| Pointer chase | Queue ahead, prefetch the queue head |
| Hash lookup | Prefetch the bucket as soon as you hash the key |
| Tree walk | Prefetch both children (one will be wrong, throwaway is cheap) |
| Sequential write, no reread | NT stores |
| Random read of cold data | Prefetch with locality 0 |

### A Concrete Hash Lookup Example

```cpp
struct Slot { uint64_t key, val; };
constexpr size_t TBL = 1 << 24;       // 16M slots, 256 MB
Slot* tbl;

uint64_t lookup(const uint64_t* keys, size_t n, uint64_t* vals) {
    constexpr size_t LOOK = 16;
    uint64_t hits = 0;
    // Prime the prefetch queue
    for (size_t i = 0; i < std::min(LOOK, n); ++i) {
        size_t h = mix(keys[i]) & (TBL - 1);
        __builtin_prefetch(&tbl[h], 0, 0);
    }
    for (size_t i = 0; i < n; ++i) {
        if (i + LOOK < n) {
            size_t h2 = mix(keys[i + LOOK]) & (TBL - 1);
            __builtin_prefetch(&tbl[h2], 0, 0);
        }
        size_t h = mix(keys[i]) & (TBL - 1);
        if (tbl[h].key == keys[i]) { vals[i] = tbl[h].val; ++hits; }
    }
    return hits;
}
```

Throughput on Sapphire Rapids, 100M lookups, 256 MB table (LLC overflow):

```
No prefetch:         42 Mops/s
LOOK=8:              78 Mops/s
LOOK=16:             96 Mops/s
LOOK=32:             92 Mops/s   (overshoot, evictions)
```

### Junior to FAANG callout

Memcpy/memset are bandwidth tests in disguise. If your hot path is a copy, ask whether the copy is necessary at all (move, view, in-place, COW). Streaming stores are the right answer when the data is genuinely write-once. Software prefetch helps only when there is independent work to do during the latency.

### Senior at FAANG callout

You should know your service's bandwidth use at p50 and at p99 load. If you are at 60% of Stream Triad, the box is full and adding cores does nothing. If you are at 5%, you are latency-bound and prefetch + lookahead is on the table. Run `pcm-memory.x` in production once a week.

### Watch out for

- ECC scrubbing eats 1 to 3% of bandwidth
- DDR refresh consumes ~1% of bandwidth (8% during high-temperature refresh-2x mode)
- BIOS option "Sub-NUMA Clustering" splits a socket into virtual NUMA nodes for higher local BW, at cost of cross-cluster latency
