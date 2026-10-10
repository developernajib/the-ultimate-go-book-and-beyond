## 7. Page Migration and AutoNUMA Balancing

Once memory is placed, it is not necessarily stuck. The kernel can move pages between nodes, either automatically (AutoNUMA balancing) or on explicit request (`move_pages`). Migration is not free. A page migration involves a TLB shootdown, a memory copy, and an update to the page tables. At scale this can be measured.

### AutoNUMA Balancing

The kernel runs a background task (since 3.13, mature since 4.x) that periodically scans page tables, sets PTE bits to "fault next access", and uses the resulting NUMA hint faults to track which CPU is accessing which page. If a page is consistently accessed from a remote node, the kernel migrates it.

Control knobs:

```bash
# Master enable:
cat /proc/sys/kernel/numa_balancing       # 0 or 1
echo 1 > /proc/sys/kernel/numa_balancing

# Scan interval (ms):
cat /proc/sys/kernel/numa_balancing_scan_period_min_ms
cat /proc/sys/kernel/numa_balancing_scan_period_max_ms

# Pages scanned per round:
cat /proc/sys/kernel/numa_balancing_scan_size_mb
```

When AutoNUMA helps:

- Workloads whose access patterns shift slowly. Once the kernel has migrated data, the new placement is correct for a long window.
- Mixed workloads where it is hard to manually predict the right placement.

When AutoNUMA hurts:

- Steady-state pinned workloads. The kernel still scans and faults, costing CPU. For HFT, batch databases, and pinned-thread services, you almost always want `numa_balancing=0`.
- Workloads with rapid access pattern changes. The kernel chases its tail, migrating pages back and forth.

### Disabling for Performance Workloads

```bash
# Disable globally:
sudo sysctl -w kernel.numa_balancing=0

# Or in /etc/sysctl.d/99-numa.conf:
# kernel.numa_balancing = 0
```

ScyllaDB, Aerospike, kdb+, and most HFT environments disable AutoNUMA. They place memory deterministically and do not want the kernel second-guessing them.

### Explicit Migration with move_pages

```cpp
#include <numaif.h>
#include <vector>
#include <cstring>

// Migrate a region's pages to a target node.
int migrate_to_node(void* base, size_t bytes, int target_node) {
    size_t page_size = 4096;
    size_t num_pages = (bytes + page_size - 1) / page_size;
    std::vector<void*> pages(num_pages);
    std::vector<int> nodes(num_pages, target_node);
    std::vector<int> status(num_pages, -1);
    for (size_t i = 0; i < num_pages; ++i) {
        pages[i] = static_cast<char*>(base) + i * page_size;
    }
    return move_pages(0, num_pages, pages.data(),
                      nodes.data(), status.data(), MPOL_MF_MOVE);
}
```

`MPOL_MF_MOVE` migrates pages mapped exclusively by this process. `MPOL_MF_MOVE_ALL` migrates pages shared with other processes (requires CAP_SYS_NICE).

After the call, `status[i]` tells you the actual node each page ended up on. Pages that could not be migrated will have a negative errno.

### Cost of Migration

A 2 MB hugepage migration takes roughly 50 to 200 microseconds. A 4 KB page migration takes 10 to 30 microseconds dominated by the TLB shootdown IPI to all CPUs that might have a TLB entry for that page. If your service migrates millions of pages, this adds up to seconds of total CPU. Always measure.

### Transparent Huge Pages and Migration

THP (Transparent Huge Pages) creates 2 MB pages on the fly. The interaction with NUMA migration:

- Migrating a 2 MB hugepage is one operation, not 512 small operations. This is faster per byte.
- However, the kernel may split a hugepage to migrate part of it, defeating the THP purpose.
- AutoNUMA can interact with THP in ways that produce unstable performance. Many production systems set `madvise` mode rather than `always`:

```bash
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

This means THP only applies to regions where the application explicitly requested it via `madvise(MADV_HUGEPAGE)`. Predictable. The full chapter on hugepages comes later.

### Reading Per-Process NUMA State

```bash
cat /proc/$PID/numa_maps
```

Sample line:

```
7f1234567000 default file=/usr/lib/x86_64-linux-gnu/libc.so.6 mapped=512 mapmax=200 N0=512 kernelpagesize_kB=4
```

Decoded:

- Virtual address: `7f1234567000`
- Policy: `default`
- File backing: `libc.so.6`
- `mapped=512`: 512 pages currently resident
- `N0=512`: all 512 are on node 0
- `kernelpagesize_kB=4`: 4K pages

For your application's anonymous memory:

```
7fff00000000 default heap mapped=1048576 N0=524288 N1=524288
```

Half on node 0, half on node 1. If you expected all on node 0, something is wrong (likely first-touch from a thread on node 1, or AutoNUMA migrated some).

### Programmatic Per-Page Inspection

```cpp
#include <numaif.h>
#include <vector>
#include <cstdio>

void inspect(void* base, size_t bytes) {
    constexpr size_t PS = 4096;
    size_t n = (bytes + PS - 1) / PS;
    std::vector<void*> pages(n);
    std::vector<int> status(n, -1);
    for (size_t i = 0; i < n; ++i)
        pages[i] = static_cast<char*>(base) + i * PS;
    move_pages(0, n, pages.data(), nullptr, status.data(), 0);

    int counts[8] = {0};
    int errs = 0;
    for (auto s : status) {
        if (s < 0) ++errs;
        else if (s < 8) ++counts[s];
    }
    for (int i = 0; i < 8; ++i)
        if (counts[i]) std::printf("node %d: %d pages\n", i, counts[i]);
    if (errs) std::printf("errors: %d\n", errs);
}
```

This is the function to call from a debug command in your service to verify placement at runtime.

### Junior to FAANG

A junior trusts AutoNUMA. A FAANG engineer disables it on dedicated workloads, places memory explicitly, and verifies placement after every deployment.

### Senior at FAANG

Staff engineers think about migration cost as part of the workload. A service that scales horizontally by adding nodes does not pay for migration on each scale event because each new instance starts fresh. A service that resizes its working set in place pays migration cost on each resize, and that cost can be larger than the resize itself.

---
