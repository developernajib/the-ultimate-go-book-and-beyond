## Huge Pages and TLB Optimization

Modern CPUs use a Translation Lookaside Buffer (TLB) to cache virtual-to-physical address translations. With 4KB pages, a 256GB dataset requires 67 million page table entries. TLB misses become a serious performance bottleneck.

### Page Size Comparison

| Page Size | TLB Entries | Coverage (typical TLB) | TLB Miss Rate |
|-----------|-------------|------------------------|---------------|
| 4 KB | 1536 (L1+L2) | ~6 MB | High for large datasets |
| 2 MB | 1536 | ~3 GB | Low for most workloads |
| 1 GB | 4 (typical L1) | ~4 GB | Minimal |

### Using Huge Pages on Linux

Linux exposes huge pages through `mmap` with `MAP_HUGETLB` (2 MB pages) or via the `/dev/hugepages` filesystem for pre-allocated 1 GB pages. Using huge pages reduces TLB pressure by covering the same virtual address range with far fewer TLB entries, which is critical for large in-memory data structures like hash tables or ring buffers where TLB misses, each costing 50-100 cycles for a page-table walk, dominate latency.
```cpp
#include <cstdio>
#include <cstdlib>
#include <cstring>

#ifdef __linux__
#include <sys/mman.h>

void* allocate_huge_pages(size_t size) {
    // Method 1: mmap with MAP_HUGETLB
    void* ptr = mmap(
        nullptr,
        size,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
        -1, 0
    );

    if (ptr == MAP_FAILED) {
        // Fallback: try madvise with regular pages
        ptr = mmap(
            nullptr, size,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1, 0
        );
        if (ptr != MAP_FAILED) {
            madvise(ptr, size, MADV_HUGEPAGE);  // Hint to use THP
        }
    }

    return (ptr == MAP_FAILED) ? nullptr : ptr;
}

void huge_page_example() {
    constexpr size_t HUGE_PAGE_SIZE = 2 * 1024 * 1024;  // 2 MB
    constexpr size_t ALLOC_SIZE = 256 * HUGE_PAGE_SIZE;  // 512 MB

    void* mem = allocate_huge_pages(ALLOC_SIZE);
    if (!mem) {
        perror("Huge page allocation failed");
        return;
    }

    // Use the memory
    std::memset(mem, 0, ALLOC_SIZE);

    printf("Allocated %zu MB with huge pages at %p\n",
           ALLOC_SIZE / (1024 * 1024), mem);

    munmap(mem, ALLOC_SIZE);
}

// 1 GB huge pages (requires boot-time reservation)
void* allocate_1gb_pages(size_t size) {
    void* ptr = mmap(
        nullptr, size,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_1GB,
        -1, 0
    );
    return (ptr == MAP_FAILED) ? nullptr : ptr;
}
#endif
```

### Transparent Huge Pages (THP)

THP is the kernel's attempt to use 2MB pages automatically. It works well for some workloads but can cause latency spikes during compaction.

```bash
# Check current THP status
cat /sys/kernel/mm/transparent_hugepage/enabled

# Options: always, madvise, never
# For latency-sensitive applications:
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled

# Reserve explicit huge pages (2MB each):
echo 1024 > /proc/sys/vm/nr_hugepages     # Reserve 2 GB

# Reserve 1GB pages (must be done at boot):
# Kernel parameter: hugepagesz=1G hugepages=4
```

### Huge Page Allocator for C++

Custom allocators replace the default heap allocator for a specific container or object graph, enabling allocation strategies such as pool allocation, arena allocation, or NUMA-aware placement. Providing a conforming allocator type hooks into the standard library's allocator-aware container interface without modifying container code.
```cpp
#ifdef __linux__
#include <sys/mman.h>
#include <memory_resource>

class HugePageResource : public std::pmr::memory_resource {
    static constexpr size_t HUGE_PAGE = 2 * 1024 * 1024;

protected:
    void* do_allocate(size_t bytes, size_t alignment) override {
        // Round up to huge page boundary
        size_t alloc_size = (bytes + HUGE_PAGE - 1) & ~(HUGE_PAGE - 1);

        void* ptr = mmap(nullptr, alloc_size,
                         PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                         -1, 0);
        if (ptr == MAP_FAILED) {
            throw std::bad_alloc();
        }
        return ptr;
    }

    void do_deallocate(void* p, size_t bytes, size_t /*alignment*/) override {
        size_t alloc_size = (bytes + HUGE_PAGE - 1) & ~(HUGE_PAGE - 1);
        munmap(p, alloc_size);
    }

    bool do_is_equal(const memory_resource& other) const noexcept override {
        return this == &other;
    }
};

void huge_page_pmr_example() {
    HugePageResource huge_resource;
    std::pmr::monotonic_buffer_resource arena(
        2 * 1024 * 1024,  // Initial chunk
        &huge_resource     // Backed by huge pages
    );

    std::pmr::vector<double> data(&arena);
    data.resize(100'000);  // Backed by huge pages, TLB-friendly
}
#endif
```

---
