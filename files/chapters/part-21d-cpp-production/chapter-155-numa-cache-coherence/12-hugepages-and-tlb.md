## 12. Huge Pages and the TLB

Every memory access goes through the Translation Lookaside Buffer (TLB). A TLB miss costs a page table walk. A page table walk on x86-64 is up to four memory accesses (five with 5-level paging). On a working set larger than the TLB can cover, the application can spend more time walking page tables than running its actual logic.

### TLB Sizes (Modern Server Parts)

| CPU | dTLB L1 | dTLB L2 | iTLB L1 |
|---|---|---|---|
| Intel Sapphire Rapids | 96 entries (4K), 32 (2M), 4 (1G) | 2048 unified | 256 (4K), 32 (2M) |
| Intel Granite Rapids | similar, slightly larger L2 | ~3072 unified | similar |
| AMD Zen 4 (EPYC) | 96 (4K), 64 (2M), 8 (1G) | 3072 unified | 512 (4K), 64 (2M) |
| Apple M4 | exact numbers undocumented, in the hundreds for L1, low thousands for L2 | | |
| Ampere AmpereOne | 64 (4K), 32 (2M) | 2048 unified | similar |

### Coverage Math

With 4K pages and a 2048-entry L2 dTLB: 8 MB coverage. If your hot working set is 30 MB, most accesses miss L2 dTLB.

With 2M pages: 4 GB coverage. Most server working sets fit. With 1G pages: 2 TB coverage. Almost any working set fits.

The trade-off: huge pages reduce TLB misses but waste memory if the working set is sparse, and complicate fragmentation. They are not free.

### Measuring dTLB Misses

```bash
perf stat -e dTLB-load-misses,dTLB-loads,dTLB-store-misses,dTLB-stores ./prog
perf stat -e dtlb_load_misses.walk_completed,dtlb_load_misses.walk_pending ./prog
```

On Intel, `walk_completed` tells you how many TLB misses caused a page walk. If this number is in the millions per second on a hot path, hugepages will help.

### Allocating Huge Pages

There are three common approaches.

**1. Transparent Huge Pages (THP).** The kernel opportunistically promotes 4K pages to 2M when it can. Configure in `/sys/kernel/mm/transparent_hugepage/`:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

`madvise` mode applies THP only to regions that explicitly request it:

```cpp
#include <sys/mman.h>
char* p = static_cast<char*>(mmap(nullptr, size, PROT_READ|PROT_WRITE,
                                  MAP_PRIVATE|MAP_ANONYMOUS, -1, 0));
madvise(p, size, MADV_HUGEPAGE);
```

THP is convenient but has unpredictable failure modes (compaction stalls, split events). Production databases often disable it (`never`) and use explicit hugepages.

**2. Explicit hugetlbfs.** Pre-reserve hugepages at boot or runtime, then `mmap` from them:

```bash
# Reserve 2048 pages of 2 MB (4 GB total):
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2048 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages

# Mount hugetlbfs:
mkdir -p /mnt/huge
mount -t hugetlbfs -o pagesize=2M none /mnt/huge
```

```cpp
int fd = open("/mnt/huge/myfile", O_CREAT|O_RDWR, 0600);
ftruncate(fd, size);
char* p = mmap(nullptr, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
```

**3. Anonymous MAP_HUGETLB.** Skip the filesystem:

```cpp
char* p = mmap(nullptr, size, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);
```

For 1 GB pages, add `MAP_HUGE_1GB`:

```cpp
char* p = mmap(nullptr, size, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|MAP_HUGE_1GB,
               -1, 0);
```

1 GB pages must usually be reserved at boot via kernel parameter `hugepages=N default_hugepagesz=1G`, because runtime allocation requires 1 GB of contiguous physical memory which is hard to find on a fragmented system.

### NUMA-Aware Huge Page Allocation

The per-node sysfs entries above are how you reserve hugepages on a specific node. Combine with `mbind`:

```cpp
char* p = mmap(nullptr, size, PROT_READ|PROT_WRITE,
               MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB, -1, 0);
unsigned long mask = 1UL << target_node;
mbind(p, size, MPOL_BIND, &mask, 64, MPOL_MF_STRICT);
// Touch a page to force allocation:
p[0] = 0;
```

If the target node has no free hugepages, the call fails. Capacity-plan accordingly.

### When 1 GB Pages Are Worth It

For working sets larger than 4 GB and access patterns that span many gigabytes (large in-memory database, ML model weights, key-value caches), 1 GB pages eliminate dTLB misses entirely for that range.

A real measurement on a key-value store with a 16 GB working set:

| Configuration | dTLB miss rate | p99 latency |
|---|---|---|
| 4 K pages | 8.2 percent of loads | 2.4 ms |
| 2 M (THP) | 0.6 percent | 1.1 ms |
| 1 G (hugetlbfs) | 0.04 percent | 0.7 ms |

The cost is reservation rigidity: 16 GB of 1 GB pages is 16 pages. If one is not used, that is 1 GB wasted.

### TLB Shootdowns

When a thread on CPU A unmaps or modifies a page table entry, every other CPU that might have a TLB cache of that mapping must invalidate. This is done via an inter-processor interrupt (IPI), called a TLB shootdown. The cost is roughly 1 to 10 microseconds depending on socket count.

Frequent unmaps (heap allocator returning memory to the kernel, mmap/munmap cycles) cause many shootdowns. For HFT and database workloads, configure the allocator to never return memory to the kernel:

```bash
# glibc:
MALLOC_TRIM_THRESHOLD_=-1 MALLOC_MMAP_THRESHOLD_=131072 ./prog

# jemalloc:
MALLOC_CONF=retain:true ./prog
```

This keeps freed memory in the process's heap, eliminating the shootdown traffic.

### Putting It Together

A production database engine on a dual-socket box might configure:

- 64 GB of 2 MB hugepages reserved at boot, evenly split across nodes.
- Buffer pool allocated from hugetlbfs, each shard on its own node.
- THP set to `never` to avoid surprises.
- Allocator tuned to retain freed memory.
- `numa_balancing=0`.

This combination cuts both TLB misses and migration cost to near zero in steady state.

### Junior to FAANG

A junior enables THP and hopes. A FAANG engineer measures dTLB miss rate, picks 2M or 1G based on working set size, allocates per node, and verifies with `/proc/PID/numa_maps` that the pages landed where expected.

### Senior at FAANG

Staff engineers compute the TLB coverage requirement from the working set at design time, choose a page size, capacity-plan the hugepage reservation, and embed the requirement in the host bootstrap. The application code does not get to choose at runtime, because the choice has been made and validated against the workload's bandwidth and latency targets.

---
