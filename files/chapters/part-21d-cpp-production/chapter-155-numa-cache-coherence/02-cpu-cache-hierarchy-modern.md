## 2. The CPU Cache Hierarchy on Modern Hardware

Cache sizes are not constants. They change every two years, and the relationship between L2 and LLC has been redesigned twice in the last five years across both major x86 vendors. If you are tuning code that needs to fit in cache, you need to know the cache of the actual machine, not the cache of your laptop.

### The Generic Picture

Every modern CPU has, at minimum:

- An L1 data cache (L1d) and L1 instruction cache (L1i), private to each core, around 32 to 64 KB each, with 4 to 5 cycles of access latency.
- An L2 cache, private to each core (or shared by a small cluster), 512 KB to 4 MB, with 12 to 15 cycles of access latency.
- A last level cache (LLC, sometimes still called L3), shared across cores or a chiplet, 16 MB to 384 MB, with 30 to 80 cycles of access latency.
- DRAM, attached to a memory controller that lives on a specific NUMA node, with 80 to 200 nanoseconds of access latency local, and 130 to 350 nanoseconds remote.

The numbers above are the generic picture. The reality varies sharply by microarchitecture.

### Intel Sapphire Rapids (Xeon 4th Gen, 2023)

- Up to 60 cores per socket, mesh interconnect.
- L1d: 48 KB per core, 12-way, 5-cycle latency.
- L1i: 32 KB per core, 8-way.
- L2: 2 MB per core, private, non-inclusive of L1, 16-cycle latency.
- LLC: 1.875 MB per core, distributed across mesh tiles, non-inclusive. So a 60-core part has roughly 112.5 MB of LLC, but you cannot count on a given line being in any particular slice.
- The mesh routes coherence traffic by hashing the physical address to a slice. A core fetching a line owned by a remote slice pays a mesh hop penalty (roughly 5 to 15 extra cycles depending on distance).

### Intel Granite Rapids (Xeon 6, 2024-2025)

Granite Rapids moves to a tiled chiplet design with up to 128 P-cores per socket. Per-core L2 grows to 3 MB. LLC stays distributed across tiles. The on-package interconnect is still a mesh, but the latency between far tiles is higher than on monolithic Sapphire Rapids. AMX (Advanced Matrix Extensions) is more capable, which matters for ML inference.

### AMD Zen 4 (EPYC Genoa, Ryzen 7000, 2022)

- Chiplet design. A socket has up to 12 CCDs (core complex dies), each with up to 8 cores.
- L1d: 32 KB per core, 8-way.
- L2: 1 MB per core, private, inclusive.
- L3: 32 MB per CCD, shared by the 8 cores in that CCD. This is the LLC.
- L3 is local to a CCD. A core on CCD0 cannot directly access L3 on CCD1. To share data across CCDs, the line must go through the IO die over Infinity Fabric. This makes a single EPYC socket behave like multiple NUMA-like domains internally. AMD calls this "NPS" (Nodes Per Socket), and you can configure it in BIOS to expose CCDs as separate NUMA nodes.

### AMD Zen 5 (EPYC Turin, Ryzen 9000, 2024)

Same chiplet philosophy, up to 16 CCDs in Turin Dense (192 cores total with 12 cores per CCD on Zen 5c). L3 per CCD is still 32 MB on most SKUs, 96 MB on the X3D variants with stacked cache. The cross-CCD penalty is still real and still substantial.

### Apple M4 (2024)

- Performance cores have 192 KB L1d and 128 KB L1i. Yes, these are huge L1 caches by x86 standards.
- Cache line is 128 bytes, not 64. This trips up portable C++ code that hardcodes 64.
- Shared LLC (System Level Cache) sits next to the memory controller and is shared with the GPU.
- No NUMA in the traditional sense on a single chip, but on Mac Pro and Ultra parts the two dies are connected by UltraFusion and behave like NUMA from a latency perspective.

### Ampere AmpereOne (Arm server, 2024)

- 192 single-threaded cores per socket (no SMT).
- L1d: 64 KB per core.
- L2: 2 MB per core, private.
- System Level Cache (SLC): 64 MB shared, separate from L2.
- Mesh interconnect with very predictable latency, which is why hyperscalers use these parts for tail-latency-sensitive serving.

### Inclusive vs Non-Inclusive vs Exclusive LLC

This distinction matters for coherence and for working set sizing.

- **Inclusive** (older Intel, pre-Skylake server): everything in L1 and L2 is also in L3. Snoops can be filtered at L3, which is fast, but L3 effective capacity is reduced because it duplicates the inner caches.
- **Non-Inclusive** (Skylake-X and later Intel server, AMD Zen): L3 is not guaranteed to hold copies of L1/L2 lines. Snoops require either a snoop filter or a coherence directory. L3 effective capacity is higher.
- **Exclusive / Victim** (some AMD parts, ARM Cortex designs): L3 only holds lines that have been evicted from L2. The total cache is the sum, not a hierarchy with overlap.

If your hot working set is 30 MB on a Zen 4 part with 32 MB L3 per CCD, you fit on one CCD. If it is 50 MB, you do not, and crossing CCDs becomes part of the inner loop's cost. This is invisible from `top`. You only see it in `perf stat`.

### On-Die Interconnect

- **Ring** (older Intel, up to Broadwell): all cores and LLC slices on one or two bidirectional rings. Simple, predictable, but does not scale past about 24 cores.
- **Mesh** (Skylake-X, Ice Lake, Sapphire Rapids, Granite Rapids): a 2D grid of tiles. Each tile holds a core, an LLC slice, or a memory controller. Latency depends on Manhattan distance.
- **Infinity Fabric** (AMD): packet-switched fabric connecting CCDs through a central IO die. Cross-CCD bandwidth is bounded by the IO die's bandwidth.
- **Custom mesh / NoC** (Ampere, Graviton): vendor-specific, generally optimized for predictability over peak bandwidth.

### Reading the Hierarchy on Linux

```bash
lscpu --caches
getconf -a | grep CACHE
# more detailed:
ls /sys/devices/system/cpu/cpu0/cache/
cat /sys/devices/system/cpu/cpu0/cache/index3/size
cat /sys/devices/system/cpu/cpu0/cache/index3/shared_cpu_list
```

In C++ you can portably get a hint with C++17's `std::hardware_destructive_interference_size`, but be aware that this is a compile-time constant and will be wrong for cross-platform binaries. On GCC/libstdc++ it is currently 64 even when compiling for Apple Silicon, which is wrong (M-series uses 128). At runtime, query `sysconf(_SC_LEVEL1_DCACHE_LINESIZE)` on Linux.

```cpp
#include <unistd.h>
#include <cstdio>

int main() {
    long line = sysconf(_SC_LEVEL1_DCACHE_LINESIZE);
    long l1 = sysconf(_SC_LEVEL1_DCACHE_SIZE);
    long l2 = sysconf(_SC_LEVEL2_CACHE_SIZE);
    long l3 = sysconf(_SC_LEVEL3_CACHE_SIZE);
    std::printf("line=%ld L1d=%ld L2=%ld L3=%ld\n", line, l1, l2, l3);
}
```

### Junior to FAANG

A junior caches a 64 in a constant called `CACHE_LINE_SIZE` and ships it. A FAANG engineer queries the runtime, picks a sane default for the build target, and adds a static assert that fires when the build target is wrong (for example, building for Apple Silicon with a hardcoded 64).

### Senior at FAANG

Staff engineers build their working set sizing into the data structure choice. If a hash table's bucket array does not fit in L2, you do not have a hash table problem, you have a memory hierarchy problem, and the fix is either to shard the table per core (so each shard fits in L2) or to use a layout that streams predictably (so the L2 prefetcher hides the misses). The choice depends on access pattern, not on table size in isolation.

---
