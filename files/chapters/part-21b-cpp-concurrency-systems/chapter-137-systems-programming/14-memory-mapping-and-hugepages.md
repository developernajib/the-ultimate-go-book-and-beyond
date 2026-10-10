## Memory Mapping, Hugepages, and NUMA

> **Senior @ FAANG**: Memory is not "RAM". It is a hierarchy of TLBs, caches, NUMA nodes, page sizes, and dirty/clean states the kernel can throw away. The difference between a 99p latency of 200 µs and 2 ms is almost always a hugepage decision or a NUMA decision.

### 1. `mmap`. The One Allocator to Rule Them All

`malloc` itself uses `mmap` for large allocations (>`MMAP_THRESHOLD`, default 128 KiB, dynamic in glibc). Knowing `mmap` directly gives you control glibc cannot.

```cpp
void* p = mmap(nullptr, length, prot, flags, fd, offset);
```

#### 1.1 Critical flags

| Flag | Meaning / when you actually use it |
|------|------------------------------------|
| `MAP_PRIVATE` | COW mapping, writes do not propagate. Default for executables. |
| `MAP_SHARED` | Writes go back to the file. The only way to share memory between unrelated processes via a path. |
| `MAP_SHARED_VALIDATE` | Like `MAP_SHARED` but errors on unknown flags (4.15+). Use this. |
| `MAP_ANONYMOUS` | Not file-backed, zero-filled pages. Pair with `MAP_PRIVATE` for `malloc`-like, with `MAP_SHARED` for `fork`-shared anonymous. |
| `MAP_HUGETLB` | Use explicit hugetlbfs hugepages (must be reserved via `nr_hugepages` sysctl). |
| `MAP_HUGE_2MB`, `MAP_HUGE_1GB` | Pick the size when multiple are configured. |
| `MAP_POPULATE` | Pre-fault pages now. Avoids first-touch latency on `MAP_PRIVATE\|MAP_ANONYMOUS`. |
| `MAP_LOCKED` | mlock-on-create. Better: separate `mlock2(MLOCK_ONFAULT)`. |
| `MAP_NORESERVE` | Don't reserve swap. Required for sparse 1 TB virtual address arenas. |
| `MAP_FIXED_NOREPLACE` | Map at exact addr, fail if occupied (4.17+). The only safe `MAP_FIXED`. |
| `MAP_STACK` | Hint that this is a stack (architectures that need executable-stack info). |
| `MAP_SYNC` | Direct-access (DAX) durability for pmem on `MAP_SHARED_VALIDATE`. |
| `MAP_UNINITIALIZED` | Skip zeroing, only on embedded kernels with `CONFIG_MMAP_ALLOW_UNINITIALIZED`. |

`MAP_FIXED` (without `_NOREPLACE`) silently unmaps anything that was there, never use it from a library, you can clobber the linker's address space.

#### 1.2 `MAP_PRIVATE` vs `MAP_SHARED` semantics

```cpp
// Shared anonymous between forked processes:
int fd = memfd_create("ring", MFD_CLOEXEC | MFD_ALLOW_SEALING);
ftruncate(fd, ring_size);
fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW); // size frozen
auto* ring = mmap(nullptr, ring_size, PROT_READ|PROT_WRITE,
                  MAP_SHARED, fd, 0);
// Now fork(); both sides see the same ring.
```

`memfd_create(2)` + sealing is the modern replacement for `shm_open`/`tmpfs`. The seal `F_SEAL_FUTURE_WRITE` (5.1+) is how Wayland and CRIU pin compositor buffers.

### 2. Hugepages. The TLB Argument

A 4 KB page maps 4 KB of address space per TLB entry. A modern x86 dTLB has ~64 entries for 4K pages, so 256 KB of working set fits without TLB misses. Bump that to 2 MB pages: now ~32 entries × 2 MB = 64 MB. For 1 GB pages: a handful of entries cover hundreds of GB.

A TLB miss costs **~20-100 ns** for a 4-level page-walk on x86 (more on 5-level, more under virtualization with nested EPT). A workload thrashing the TLB at 1 M misses/sec wastes 20-100 ms of CPU per second.

#### 2.1 Three ways to get hugepages

**(a) Transparent Hugepages (THP)**, automatic, in-kernel:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
```

- `always`: kernel coalesces eligible regions into 2 MB pages opportunistically. Good for batch jobs, **dangerous for latency-sensitive services**, `khugepaged` runs in the background and `MADV_COLLAPSE` operations cause IPI stalls.
- `madvise`: only when you explicitly call `madvise(addr, len, MADV_HUGEPAGE)`. **This is the FAANG default for production.**
- `never`: disable entirely.

```cpp
posix_memalign(&buf, 2*1024*1024, size);  // 2 MB-align
madvise(buf, size, MADV_HUGEPAGE);
// Touch first byte of each 2 MB to force allocation up-front.
for (size_t i = 0; i < size; i += 2*1024*1024) ((char*)buf)[i] = 0;
```

**(b) Explicit hugetlbfs**, reserved at boot, never swapped, never split:

```bash
echo 1024 > /proc/sys/vm/nr_hugepages          # 1024 × 2 MB = 2 GiB
mount -t hugetlbfs none /dev/hugepages -o pagesize=2M
```

```cpp
int fd = open("/dev/hugepages/buf", O_CREAT|O_RDWR, 0600);
ftruncate(fd, size);
void* p = mmap(nullptr, size, PROT_READ|PROT_WRITE,
               MAP_SHARED | MAP_HUGETLB | MAP_HUGE_2MB, fd, 0);
```

Hugetlbfs pages are **non-pageable, non-COW, non-mergeable**, exactly what DPDK, SPDK, KVM, and TigerBeetle want.

**(c) `MAP_HUGETLB` anonymous**, same guarantees, no fs path:

```cpp
mmap(nullptr, size, PROT_READ|PROT_WRITE,
     MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|MAP_HUGE_1GB, -1, 0);
```

For 1 GB pages, configure `default_hugepagesz=1G hugepagesz=1G hugepages=N` on the kernel command line, runtime allocation almost always fails due to fragmentation.

#### 2.2 THP pitfalls (read carefully)

- **Compaction stalls**: when memory is fragmented, the page allocator tries to compact before failing back to 4K. Set `/sys/kernel/mm/transparent_hugepage/defrag` to `defer+madvise` for production.
- **`fork()` cost**: COW on a 2 MB hugepage that is split to 4K pages is up to 512× the work of a 4K COW.
- **NUMA migration**: THP pages can migrate between nodes via auto-NUMA balancing (`/proc/sys/kernel/numa_balancing`). Disable it on dedicated workloads.
- **Memory bloat**: a single dirty byte holds a 2 MB page. RSS counters lie unless you read `AnonHugePages` in `smaps`.

### 3. `madvise(2)`. The Communication Channel With the VM

| Advice | Effect |
|--------|--------|
| `MADV_DONTNEED` | Free the pages **now**. Next access re-zeroes (anonymous) or re-reads (file-backed). The standard "shrink" primitive for arenas. |
| `MADV_FREE` | Lazy free, kernel may reclaim under pressure, until then reads see old contents. Faster than `DONTNEED`, used by jemalloc/tcmalloc. |
| `MADV_REMOVE` | Punch a hole in tmpfs/hugetlbfs. Equivalent to `fallocate(FALLOC_FL_PUNCH_HOLE)` for `MAP_SHARED`. |
| `MADV_HUGEPAGE` | "Please coalesce to THP." |
| `MADV_NOHUGEPAGE` | "Don't ever THP this region", for latency-critical small mappings. |
| `MADV_COLLAPSE` | Force synchronous THP collapse (6.1+). Predictable cost vs khugepaged. |
| `MADV_COLD` | Mark pages as inactive, next reclaim picks them. Hint for cache-like data. |
| `MADV_PAGEOUT` | Reclaim **immediately**, write to swap if dirty (5.4+). The "shrink" hammer. |
| `MADV_RANDOM` / `MADV_SEQUENTIAL` | Toggle readahead heuristics for file-backed mappings. |
| `MADV_DONTFORK` | Excluded from child after `fork()`. Useful for DMA buffers. |
| `MADV_WIPEONFORK` | Child sees zeros. OpenSSL CSPRNG state uses this. |
| `MADV_GUARD_INSTALL` | Install guard pages without VMA bloat (6.13+). |

### 4. `mlock`. Page Pinning for Latency

Pages can be evicted to swap or simply unmapped (file-backed clean pages). For low-latency code, both are unacceptable, a single major fault is 50 µs to 50 ms.

```cpp
// Lock the whole heap and stack, current and future:
mlockall(MCL_CURRENT | MCL_FUTURE | MCL_ONFAULT);

// Per-region:
mlock2(buf, size, MLOCK_ONFAULT);  // lock only after first touch
```

`MLOCK_ONFAULT` is the modern win: lazy population (no upfront 50 GB write) but pinned once present. Combine with `RLIMIT_MEMLOCK` configured via `setrlimit` or `LimitMEMLOCK=infinity` in systemd units. For containers, the cgroup v2 `memory.swap.max=0` is a complementary but not equivalent guarantee.

### 5. NUMA. When Pages Live On the Wrong Socket

On a 2-socket EPYC or Xeon, cross-socket memory access is ~1.5-2× the latency of local. On 4-socket and AMD multi-die systems it gets worse.

#### 5.1 Inspect topology

```bash
numactl -H
# available: 2 nodes (0-1)
# node 0 cpus: 0-31,64-95
# node 0 size: 257804 MB
# node distances:
# node   0   1
#   0:  10  21
```

Per-process placement:

```bash
numactl --cpunodebind=0 --membind=0 ./hft_engine
```

#### 5.2 Programmatic control with libnuma

```cpp
#include <numa.h>
#include <numaif.h>

if (numa_available() < 0) { /* not numa */ }

// Bind this thread to node 0 CPUs and node 0 memory:
struct bitmask* nodes = numa_bitmask_alloc(numa_num_configured_nodes());
numa_bitmask_setbit(nodes, 0);
numa_bind(nodes);   // both cpu and mem
numa_bitmask_free(nodes);

// Allocate explicitly on a node:
void* p = numa_alloc_onnode(size, /*node=*/1);

// Move existing pages:
unsigned long node_mask = 1UL << 1;
mbind(p, size, MPOL_BIND, &node_mask, sizeof(node_mask)*8, MPOL_MF_MOVE);
```

Or the lower-level `set_mempolicy(2)` / `mbind(2)` / `move_pages(2)` directly. `move_pages` is the only way to migrate **specific pages** without unmapping.

#### 5.3 First-touch policy

Linux's default `MPOL_DEFAULT` allocates pages on the **node of the CPU that first writes to them**. This is why parallel initializers matter: if your loader runs on node 0 and zero-fills a 100 GB buffer, then 16 worker threads on node 1 process it, you eat cross-socket traffic for the entire run. Fix: parallelize the initial touch under the same affinity scheme as the workers ("first-touch parallel init").

### 6. Putting It Together. A Production Allocator Sketch

```cpp
// huge_arena.hpp, fixed-size, NUMA-pinned, hugepage-backed arena
class HugeArena {
public:
    HugeArena(size_t bytes, int numa_node)
        : size_(round_up(bytes, 2*1024*1024)), node_(numa_node)
    {
        base_ = mmap(nullptr, size_, PROT_READ|PROT_WRITE,
                     MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|MAP_HUGE_2MB|MAP_POPULATE,
                     -1, 0);
        if (base_ == MAP_FAILED) throw std::system_error(errno, std::system_category());

        unsigned long mask = 1UL << numa_node;
        if (mbind(base_, size_, MPOL_BIND, &mask, sizeof(mask)*8,
                  MPOL_MF_MOVE | MPOL_MF_STRICT) != 0)
            throw std::system_error(errno, std::system_category());

        if (mlock2(base_, size_, MLOCK_ONFAULT) != 0)
            throw std::system_error(errno, std::system_category());
    }
    ~HugeArena() { munmap(base_, size_); }

    void* base() const { return base_; }
    size_t size() const { return size_; }
private:
    void*  base_;
    size_t size_;
    int    node_;
};
```

This single class encapsulates: hugepages (TLB), populate (no first-fault), mbind (NUMA), mlock-on-fault (no swap, no major fault), strict (fail rather than fall back to 4K). That is the trifecta every HFT, database, and storage engine engineer reproduces in some form.

### 7. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `malloc(2GB)` and forget | `mmap(MAP_HUGETLB \| MAP_POPULATE) + mbind + mlock2` |
| Trust THP `[always]` | Set to `madvise`, opt in per region. |
| `shm_open` for IPC | `memfd_create` + `F_ADD_SEALS`. |
| Ignore NUMA | First-touch parallel init + explicit `mbind`. |
| Use `mlock` everywhere | `mlock2(MLOCK_ONFAULT)` only on hot regions. |
| `MAP_FIXED` | `MAP_FIXED_NOREPLACE` always. |
| Read `RSS` from `/proc/self/status` | Read `Pss` from `smaps_rollup` for shared mappings. |

Memory mapping is where systems engineering gets brutally honest: the kernel will give you what you ask for, including the wrong thing, very quickly.
