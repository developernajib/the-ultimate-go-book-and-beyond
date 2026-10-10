## TLB and Hugepages

A TLB miss on x86 walks the page tables: 4 levels for 4K pages, 3 for 2M, 2 for 1G. Each walk is 4 memory accesses minimum, 100+ ns if any walk-level misses cache. For a working set of 4 GB at 4K pages, you need 1M TLB entries, you have 64. TLB misses become the bottleneck before bandwidth does.

### TLB Sizes (x86, per core)

| uarch | L1 dTLB (4K) | L1 dTLB (2M) | L1 iTLB | L2 sTLB |
|-------|-------------|--------------|---------|---------|
| Skylake | 64 | 32 | 128 | 1536 |
| Icelake | 64 | 32 | 128 | 2048 |
| Sapphire Rapids | 96 | 32 | 128 | 2048 |
| Zen 3 | 64 | 64 | 64 | 2048 |
| Zen 4 | 72 | 72 | 64 | 3072 |

L2 sTLB is shared between code and data (note: same structure, distinct from the LLC's role). A miss in L2 sTLB triggers a page walk.

### Coverage Math

```
4K  pages, 64 L1 entries  -> 256 KB coverage
2M  pages, 32 L1 entries  -> 64  MB coverage
1G  pages, 4  entries     -> 4   GB coverage
```

A 1 GB heap with 4K pages: every random access has high TLB miss probability. Same heap with 2M pages: most accesses hit. With 1G pages: TLB cost is essentially zero.

### Measuring TLB Misses

```bash
perf stat -e \
  dTLB-load-misses,dTLB-loads,\
dTLB-store-misses,iTLB-load-misses,\
dtlb_load_misses.walk_completed_4k,\
dtlb_load_misses.walk_completed_2m_4m,\
dtlb_load_misses.walk_completed_1g,\
dtlb_load_misses.walk_pending,\
dtlb_load_misses.walk_active \
  ./binary
```

`walk_active` divided by `cycles` gives the fraction of cycles spent walking pages. Above 5% means hugepages will help.

### Allocating 2M Pages

#### Transparent Hugepages (THP)

Kernel-managed, opportunistic. Glibc's malloc allocates from anonymous mappings, kernel can collapse runs of 4K to 2M.

Modes (`/sys/kernel/mm/transparent_hugepage/enabled`):

```
[always] madvise never
```

`always`: kernel tries everywhere. Can cause stalls during khugepaged collapses and allocation latency spikes (200ms+ on heavy fragmentation).
`madvise`: only when the program asks (`madvise(addr, len, MADV_HUGEPAGE)`). Recommended for production.
`never`: off.

```cpp
#include <sys/mman.h>
void* p = mmap(nullptr, sz, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
madvise(p, sz, MADV_HUGEPAGE);
// touch every 2M boundary to force collapse
for (size_t i = 0; i < sz; i += 2*1024*1024) ((char*)p)[i] = 0;
```

`/sys/kernel/mm/transparent_hugepage/defrag`:

```
[always] defer defer+madvise madvise never
```

`always`: synchronous compaction on alloc. Latency death.
`defer+madvise`: kick `khugepaged` async, plus sync for `MADV_HUGEPAGE`. Best general default.

#### Explicit Hugepages (hugetlbfs / MAP_HUGETLB)

Reserved at boot or via sysctl. No fragmentation risk.

```bash
echo 1024 > /proc/sys/vm/nr_hugepages   # reserve 1024 * 2M = 2 GB
cat /proc/meminfo | grep -i huge
```

```cpp
void* p = mmap(nullptr, 2*1024*1024,
               PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB,
               -1, 0);
if (p == MAP_FAILED) { /* handle, fallback to 4K */ }
```

For 1G pages: `MAP_HUGETLB | MAP_HUGE_1GB`. Must have `nr_hugepages_1G` reserved and CPU support (`pdpe1gb` in `/proc/cpuinfo`).

#### jemalloc and tcmalloc

Both have hugepage modes:

```
# jemalloc 5.x
MALLOC_CONF=metadata_thp:auto,thp:always

# tcmalloc (Google)
TCMALLOC_HUGE_REGION_RELEASE_RATE=...
# also use TCMALLOC_USE_HUGE_PAGES=1
```

### Real Numbers

Search-index lookup, 8 GB working set, random access pattern, Sapphire Rapids:

```
4K  pages: 380 ns/lookup, dTLB walk 12% of cycles
2M  THP:   210 ns/lookup, dTLB walk 1.4% of cycles
1G  pages: 165 ns/lookup, dTLB walk 0.1% of cycles
```

35% improvement just from THP, another 20% from 1G.

For a JIT/code-cache, iTLB matters too:

```bash
perf stat -e iTLB-load-misses,itlb_misses.walk_completed
```

JIT'd code in 2M code pages cuts iTLB pressure dramatically. The kernel can map executable mmaps as THP. Java's `-XX:+UseTransparentHugePages` and `-XX:+UseLargePagesInMetaspace` use this. C++ JIT engines (LuaJIT, V8) need explicit opt-in.

### Fragmentation

External fragmentation kills 2M page allocation success. After hours of small allocs and frees, the kernel may be unable to find contiguous 2M-aligned regions. Symptoms:

- `AnonHugePages` in `/proc/meminfo` stops growing
- `khugepaged` busy in top
- `compact_stall` in `/proc/vmstat` rising
- Latency spikes during allocation

Mitigations:

- Pre-allocate at startup, never free
- `MAP_POPULATE` to fault in eagerly
- Use hugetlbfs reservations (immune to fragmentation)
- `echo 1 > /proc/sys/vm/compact_memory` (manual compaction, expensive)
- For 1G pages, only boot-time reservation is reliable

### Latency vs Throughput Tradeoff

THP raises throughput but introduces latency cliffs:

- `khugepaged` runs in background, evicts pages to coalesce, can stall a process briefly
- Synchronous compaction on alloc can take 100+ ms

For low-tail-latency services:

```bash
# Disable sync compaction
echo defer > /sys/kernel/mm/transparent_hugepage/defrag

# Lower khugepaged aggressiveness
echo 10000 > /sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs
echo 60000 > /sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs
```

Or skip THP and use explicit hugetlbfs allocations for the regions you care about. p99.9 stability beats p50 throughput.

### Runtime Detection

```cpp
#include <fstream>
size_t hugepage_size_kb() {
    std::ifstream f("/proc/meminfo");
    std::string k; size_t v; std::string unit;
    while (f >> k >> v >> unit) {
        if (k == "Hugepagesize:") return v;
    }
    return 4;
}

bool has_thp() {
    std::ifstream f("/sys/kernel/mm/transparent_hugepage/enabled");
    std::string s; if (!std::getline(f, s)) return false;
    return s.find("[always]") != std::string::npos
        || s.find("[madvise]") != std::string::npos;
}
```

### RAII Hugepage Region

```cpp
class HugeRegion {
    void* p_ = nullptr; size_t sz_ = 0;
public:
    HugeRegion(size_t bytes) : sz_(bytes) {
        p_ = mmap(nullptr, bytes, PROT_READ|PROT_WRITE,
                  MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|MAP_POPULATE,
                  -1, 0);
        if (p_ == MAP_FAILED) {
            p_ = mmap(nullptr, bytes, PROT_READ|PROT_WRITE,
                      MAP_PRIVATE|MAP_ANONYMOUS|MAP_POPULATE, -1, 0);
            if (p_ == MAP_FAILED) throw std::bad_alloc{};
            madvise(p_, bytes, MADV_HUGEPAGE);
        }
    }
    ~HugeRegion() { if (p_) munmap(p_, sz_); }
    void* data() noexcept { return p_; }
    size_t size() const noexcept { return sz_; }
    HugeRegion(const HugeRegion&) = delete;
    HugeRegion& operator=(const HugeRegion&) = delete;
};
```

### Junior to FAANG callout

If your service uses more than ~64 MB of hot data and accesses it randomly, you are TLB-bound and you do not know it. Run `perf stat -e dtlb_load_misses.walk_active,cycles` for 30 seconds in production. If walk_active is over 3% of cycles, hugepages will pay off.

### Senior at FAANG callout

The decision is not "hugepages: yes/no". It is "explicit hugetlbfs for the steady-state arena, THP off for everything else, with `khugepaged` rate-limited so it does not stall the request thread". Know your fragmentation profile by running `cat /sys/kernel/debug/extfrag/extfrag_index` periodically and graphing it.

### Caveats

- KVM guests: ensure host has hugepages enabled too, and the guest's hugepages are backed by host hugepages (`hugepages` in libvirt XML)
- Containers: cgroup memory limits count hugepages differently. `hugetlb` cgroup controls explicit hugetlbfs.
- Page table walks under nested virtualization are 2x worse: every guest TLB miss does both guest and host walks. EPT/NPT helps but does not eliminate.
