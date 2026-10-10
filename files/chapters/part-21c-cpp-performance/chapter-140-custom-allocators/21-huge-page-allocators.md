## Huge Page Allocators

Modern x86-64 CPUs can map memory in 4 KiB, 2 MiB, or 1 GiB pages. The TLB has fixed entry counts (~64 entries for 4KiB pages, ~32 for 2MiB on recent Intel). A working set larger than (TLB entries * page size) suffers TLB misses. With 4KiB pages, that ceiling is ~256 KiB. With 2MiB pages, ~64 MiB. With 1GiB pages, ~32 GiB. For any modern server workload, hugepages are not optional if you care about memory-access latency.

The catch: getting hugepages reliably is harder than it should be. Two mechanisms exist on Linux. They behave differently. Allocators handle them differently.

### hugetlbfs vs Transparent Huge Pages

hugetlbfs is the explicit interface. The kernel reserves a fixed pool of hugepages at boot or on demand. Applications request hugepages via `mmap(MAP_HUGETLB)` or by mapping files in `/dev/hugepages`. Allocations either succeed at hugepage granularity or fail. Reservations come out of a global pool sized via `vm.nr_hugepages` or `hugepagesz=2M hugepages=N` boot args.

THP (Transparent Huge Pages) is the implicit interface. The kernel opportunistically promotes 4KiB pages to 2MiB when conditions are right (alignment, contiguity, defragmentability). `khugepaged` runs in the background and merges 4KiB regions. From the application's perspective, allocation is normal `mmap` of 4KiB pages and the kernel may or may not promote them.

| Property | hugetlbfs | THP |
|---------------------|---------------------------------|----------------------------------|
| Allocation | Explicit | Opportunistic |
| Failure mode | Returns error | Falls back to 4KiB silently |
| Latency | Predictable | Variable (khugepaged work) |
| Memory pinning | Cannot be swapped | Can be split back to 4KiB |
| Boot reservation | Required | Not required |
| Production use | Trading, HFT, fixed workloads | Most servers |

Trading systems use hugetlbfs because they cannot tolerate THP's promotion latency. Most other production code uses THP because it requires no operational overhead.

### MAP_HUGETLB Allocator

The simplest hugepage allocator wraps `mmap` with the right flags.

```cpp
#include <sys/mman.h>
#include <unistd.h>
#include <stdexcept>

class HugePageArena {
    void* base_ = nullptr;
    size_t size_ = 0;
    std::byte* next_ = nullptr;
    std::byte* end_ = nullptr;

    static constexpr size_t HUGEPAGE_SIZE = 2 * 1024 * 1024;

public:
    explicit HugePageArena(size_t bytes) {
        const size_t rounded = (bytes + HUGEPAGE_SIZE - 1) & ~(HUGEPAGE_SIZE - 1);
        void* p = mmap(nullptr, rounded, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
        if (p == MAP_FAILED) {
            throw std::runtime_error("MAP_HUGETLB failed: configure /proc/sys/vm/nr_hugepages");
        }
        base_ = p;
        size_ = rounded;
        next_ = static_cast<std::byte*>(p);
        end_ = next_ + rounded;
    }

    ~HugePageArena() {
        if (base_) munmap(base_, size_);
    }

    [[nodiscard]] void* allocate(size_t bytes, size_t alignment) {
        std::byte* aligned = reinterpret_cast<std::byte*>(
            (reinterpret_cast<uintptr_t>(next_) + alignment - 1) & ~(alignment - 1));
        if (aligned + bytes > end_) throw std::bad_alloc();
        next_ = aligned + bytes;
        return aligned;
    }

    HugePageArena(const HugePageArena&) = delete;
    HugePageArena& operator=(const HugePageArena&) = delete;
};
```

Pre-reserve hugepages at boot:

```bash
# 2MiB pages, 1024 of them = 2 GiB pool.
echo 1024 > /proc/sys/vm/nr_hugepages

# Or for 1 GiB pages:
echo 4 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages
```

For 1 GiB pages, use `MAP_HUGETLB | MAP_HUGE_1GB`.

```cpp
constexpr int MAP_HUGE_1GB_FLAG = 30 << MAP_HUGE_SHIFT;
void* p = mmap(nullptr, size, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_1GB_FLAG, -1, 0);
```

1 GiB pages remove TLB misses for the entire arena up to 32 GiB on a single core. Worth it for in-memory databases and HFT tick stores.

### THP via madvise

For workloads that prefer THP, allocate normally and hint.

```cpp
void* p = mmap(nullptr, size, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
madvise(p, size, MADV_HUGEPAGE);
```

`khugepaged` will eventually merge backing 4KiB pages. The promotion is opportunistic. To force a specific page to be promoted now, touch every 4KiB sub-page sequentially with the THP setting `madvise=always`. Even then promotion is not guaranteed, allocation must be 2MiB-aligned and contiguous.

System-wide THP policy in `/sys/kernel/mm/transparent_hugepage/enabled`:

- `always`: try to promote everything.
- `madvise`: promote only `MADV_HUGEPAGE` regions.
- `never`: disabled.

Production guidance: set system policy to `madvise` and explicitly `MADV_HUGEPAGE` the regions you care about. `always` causes long stalls in `khugepaged` and unexpected memory inflation.

### jemalloc THP Strategy

Jemalloc's modern strategy interacts carefully with THP.

```bash
MALLOC_CONF="\
metadata_thp:always,\
thp:always,\
dirty_decay_ms:30000,\
muzzy_decay_ms:30000"
```

`metadata_thp:always` enables THP for jemalloc's internal metadata (rtree pages, arena headers). This is almost always a win.

`thp:always` enables THP for user allocations. The risk is RSS bloat: a 2MiB region that is mostly free still consumes 2MiB of physical memory. Jemalloc's purge timers (`dirty_decay_ms`, `muzzy_decay_ms`) interact with THP because `MADV_DONTNEED` on a 2MiB page reclaims the whole page, `MADV_FREE` may split it.

For RSS-tight workloads, prefer `thp:never` and rely on `metadata_thp:always` for the metadata win without the user-data inflation.

### TCMalloc TEMERAIRE

Modern TCMalloc's hugepage-aware page heap (TEMERAIRE) is hugepage-native by design. Spans are allocated from hugepage-aligned regions. The page heap tracks each hugepage's "filled-ness" and prefers to allocate from already-partial hugepages so that empty hugepages can be released as a unit.

The OSDI '21 paper reports ~5-7% fleet-wide reductions in TLB miss cost across Google production with no application changes. The pattern is "hugepage-friendly allocator design," not just a flag. The page heap explicitly avoids fragmenting hugepages.

To enable in open-source TCMalloc:

```bash
# Modern builds enable HPAA by default. Verify:
TCMALLOC_HPAA_USE_HPAA=true ./binary
```

In recent (2024-2025) builds the hugepage-aware allocator is the default. Older builds need the explicit flag.

### Per-Arena Hugepage Strategy in jemalloc

For mixed workloads, dedicate one arena to hugepages and route hot allocations to it.

```cpp
extent_hooks_t hugepage_hooks = /* hooks that mmap with MAP_HUGETLB */;

unsigned arena_id;
size_t sz = sizeof(arena_id);
extent_hooks_t* p = &hugepage_hooks;
mallctl("arenas.create", &arena_id, &sz, &p, sizeof(p));

// Allocate from this arena:
int flags = MALLOCX_ARENA(arena_id);
void* mem = mallocx(size, flags);
```

Hot data structures (caches, indexes) go through the hugepage arena. Cold or short-lived allocations stay in the default arenas. RSS stays bounded because cold data does not pin hugepages.

### Benchmark Deltas

Numbers from public benchmarks and documented production deployments. Your mileage will vary.

| Workload | 4KiB pages | 2MiB THP | 2MiB hugetlbfs | 1GiB hugetlbfs |
|-------------------------------------|------------|----------|----------------|----------------|
| Random pointer chase, 10 GiB heap | baseline | -25% | -28% | -35% |
| In-memory database scan, 50 GiB | baseline | -15% | -18% | -22% |
| HPC stencil, 64 GiB | baseline | -10% | -12% | -15% |

Headroom comes from TLB miss reduction. Workloads with low TLB pressure (small working set, sequential access with prefetch) benefit less. Always measure on your workload before committing.

### Pitfalls

- Hugepages do not swap. A 1 TiB hugepage allocation that exceeds RAM will OOM the process even if swap exists.
- THP can be split back to 4KiB by the kernel under memory pressure. Latency-sensitive code should pin with hugetlbfs instead of relying on THP.
- `mlock` interacts strangely with hugepages. Locking a 2MiB-aligned region locks all 4KiB sub-pages even if only a few are touched. Use `MAP_HUGETLB` and accept that hugepages are inherently locked.
- NUMA + hugepages requires care. `numactl --membind` or `mbind` on the hugepage region. Otherwise the kernel allocates from whichever node has free hugepages, defeating NUMA locality.
- Containers may not see hugepages. The container needs `--cap-add=IPC_LOCK` and access to `/dev/hugepages`. Kubernetes supports hugepages as a resource type (`hugepages-2Mi: 2Gi`).

### Junior to FAANG

A junior engineer hears "hugepages are faster" and sets THP to `always`, then files a bug when memory usage doubles. A FAANG-grade engineer reserves a hugetlbfs pool sized to the workload, picks 1 GiB pages for in-memory databases and 2 MiB for general allocations, configures their allocator to be hugepage-aware (TCMalloc's TEMERAIRE, jemalloc's metadata_thp), measures TLB miss rate before and after with `perf stat -e dTLB-load-misses`, and treats hugepage exhaustion as an oncall-actionable alert. They also know that `MAP_POPULATE` on hugepage mappings forces immediate page-table population so the first access does not page-fault.
