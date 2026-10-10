## Virtual Memory: What Every Programmer Should Know

Virtual memory is the abstraction layer between your program and physical RAM. Every address your program uses is a **virtual address** that gets translated to a physical address by the CPU's Memory Management Unit (MMU).

### Why Virtual Memory Exists

Without virtual memory:
- Every program would need to know its exact physical memory location
- Programs could read/write each other's memory (no isolation)
- You could not run programs larger than physical RAM
- Memory fragmentation would be severe

With virtual memory:
- Every process gets its own contiguous address space (the illusion of having all memory to itself)
- The OS can map virtual pages to any physical frame
- Pages not currently in use can be swapped to disk
- Memory isolation is enforced by hardware

### Page Tables

Virtual memory works by dividing both virtual and physical address spaces into fixed-size **pages** (typically 4 KB on x86-64).

```
    Virtual Address Translation
    
    Virtual Address: 0x00007F4A_12345678
    
    +----------------+----------+----------+-----------+
    | PML4 Index     | PDP Index| PD Index | PT Index  | Page Offset |
    | (9 bits)       | (9 bits) | (9 bits) | (9 bits)  | (12 bits)   |
    +----------------+----------+----------+-----------+
          |               |          |           |            |
          v               v          v           v            |
    +----------+   +----------+  +--------+  +--------+      |
    | PML4     |-->| PDPT     |->| PD     |->| PT     |      |
    | Table    |   | Table    |  | Table  |  | Table  |      |
    | (512     |   | (512     |  | (512   |  | (512   |      |
    |  entries)|   |  entries)|  | entries)|  | entries)|      |
    +----------+   +----------+  +--------+  +--------+      |
                                                  |           |
                                                  v           |
                                            Physical Frame ---+
                                            Base Address       |
                                                  +            |
                                            Page Offset -------+
                                                  =
                                            Physical Address
```

Each page table entry contains:
- **Physical frame number**: where the page lives in RAM
- **Present bit**: is the page in RAM? (if not, accessing it triggers a page fault)
- **Read/Write bit**: is the page writable?
- **User/Supervisor bit**: can user-mode code access this page?
- **Accessed bit**: has the page been read recently? (used for page replacement)
- **Dirty bit**: has the page been written to? (must be written back before eviction)

### Translation Lookaside Buffer (TLB)

Walking the four-level page table for every memory access would be catastrophically slow. The TLB is a small, fast cache in the CPU that stores recent virtual-to-physical translations.

```
    Memory Access with TLB
    
    CPU generates virtual address
         |
         v
    +----------+
    | TLB      |  Check: is translation cached?
    | Lookup   |
    +----------+
      |       |
     Hit     Miss
      |       |
      v       v
    Fast!   Walk page table (slow)
    ~1 ns   ~10-100 ns
              |
              v
           Update TLB with new entry
           (may evict old entry)
```

TLB performance matters enormously:
- A TLB hit costs ~1 CPU cycle
- A TLB miss costs ~10-100 cycles (page table walk)
- A TLB miss that triggers a page fault costs ~1,000,000+ cycles (disk I/O)

**Huge pages** (2 MB or 1 GB instead of 4 KB) reduce TLB misses by covering more memory per entry. This is why databases and high-performance systems use huge pages.

```cpp
// Linux: allocating huge pages
#include <sys/mman.h>
#include <cstdio>

void* hugePageAlloc(size_t size) {
    void* ptr = mmap(nullptr, size,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                     -1, 0);
    if (ptr == MAP_FAILED) {
        perror("mmap with huge pages failed");
        return nullptr;
    }
    return ptr;
}
```

### Page Faults

A page fault occurs when the CPU accesses a virtual address whose page is not currently in physical RAM.

**Types of page faults:**

1. **Minor (soft) page fault**: Page exists but is not yet mapped. The OS maps it without disk I/O. Example: first access to a newly `mmap`'d region.

2. **Major (hard) page fault**: Page was swapped to disk. The OS must read it back from disk. This is extremely slow (~1-10 ms, or millions of CPU cycles).

3. **Invalid page fault**: Access to an address that does not exist in the process's virtual address space. This causes a segmentation fault (SIGSEGV), your program crashes.

```cpp
// Demonstrating page faults
#include <cstring>
#include <iostream>

void pageFaultDemo() {
    // Allocate 1 GB -- the OS does NOT actually allocate physical memory yet
    // It just reserves virtual address space (overcommit)
    size_t size = 1ULL << 30;  // 1 GB
    char* data = new char[size];
    
    // No physical memory allocated yet (on Linux with overcommit).
    // Accessing the memory triggers page faults as pages are mapped on demand.
    
    // Touch every page (force allocation of all 262,144 pages)
    for (size_t i = 0; i < size; i += 4096) {
        data[i] = 1;  // Minor page fault for each new page
    }
    
    delete[] data;
}
```

### Copy-on-Write (COW)

Copy-on-write is an optimization where the OS shares physical pages between processes until one of them writes.

```
    Before fork():
    
    Parent Process
    Virtual Pages: [A] [B] [C] [D]
                    |   |   |   |
    Physical RAM:  [A] [B] [C] [D]
    
    After fork(): Pages shared, marked read-only
    
    Parent Process                 Child Process
    Virtual: [A] [B] [C] [D]     Virtual: [A] [B] [C] [D]
              |   |   |   |                |   |   |   |
              +---+---+---+-------+--------+---+---+---+
                  |   |   |       |
    Physical:    [A] [B] [C]     [D]
                 (all marked read-only)
    
    Child writes to page B:
    
    Parent Process                 Child Process
    Virtual: [A] [B] [C] [D]     Virtual: [A] [B'] [C] [D]
              |   |   |   |                |    |    |   |
    Physical: [A] [B] [C] [D]            [B']
              (shared) (shared)    (private copy of B, writable)
```

This is how `fork()` is efficient, the child process starts with a copy of the parent's address space, but physical memory is only duplicated for pages that are actually modified. This is also how Redis performs background saves: `fork()` the process, the child writes the snapshot while the parent continues serving requests. Modified pages are COW-duplicated.

```cpp
#include <unistd.h>
#include <sys/wait.h>
#include <iostream>
#include <cstring>

void cowDemo() {
    // Allocate a large buffer
    size_t size = 100 * 1024 * 1024;  // 100 MB
    char* data = new char[size];
    memset(data, 'A', size);  // Touch all pages
    
    pid_t pid = fork();
    
    if (pid == 0) {
        // Child process: all 100 MB is shared with parent via COW
        // Physical memory usage: ~0 extra (all pages shared)
        
        // Writing to 1 page triggers a COW copy of just that page
        data[0] = 'B';  // Only 4 KB is actually copied
        
        _exit(0);
    } else {
        wait(nullptr);
    }
    
    delete[] data;
}
```

**Go comparison:** Go's runtime interacts with virtual memory in several ways:
- Goroutine stacks are backed by virtual memory and grow on demand
- The Go heap allocator reserves large virtual address ranges and maps pages as needed
- `mmap` is used internally for large allocations
- Go does not use `fork()` (goroutines are green threads, not processes), so COW is less relevant
- Go's GC can advise the OS to reclaim unused pages (`madvise(MADV_DONTNEED)`)

### Memory-Mapped Files

Memory-mapped I/O (`mmap`) maps a file directly into the process's virtual address space. Instead of calling `read()`/`write()`, you access the file through pointers. The OS handles loading pages from disk on demand (via page faults) and writing dirty pages back.

```cpp
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <iostream>
#include <cstring>
#include <stdexcept>

class MemoryMappedFile {
    void* data_ = nullptr;
    size_t size_ = 0;
    int fd_ = -1;
    
public:
    MemoryMappedFile(const char* path, size_t size)
        : size_(size) {
        fd_ = open(path, O_RDWR | O_CREAT, 0644);
        if (fd_ < 0) throw std::runtime_error("Cannot open file");
        
        // Ensure file is large enough
        if (ftruncate(fd_, size) < 0) {
            close(fd_);
            throw std::runtime_error("Cannot resize file");
        }
        
        // Map the file into memory
        data_ = mmap(nullptr, size_, PROT_READ | PROT_WRITE,
                      MAP_SHARED, fd_, 0);
        if (data_ == MAP_FAILED) {
            close(fd_);
            throw std::runtime_error("mmap failed");
        }
    }
    
    // RAII: unmap and close on destruction
    ~MemoryMappedFile() {
        if (data_ && data_ != MAP_FAILED) {
            msync(data_, size_, MS_SYNC);  // Flush changes to disk
            munmap(data_, size_);
        }
        if (fd_ >= 0) close(fd_);
    }
    
    // No copy
    MemoryMappedFile(const MemoryMappedFile&) = delete;
    MemoryMappedFile& operator=(const MemoryMappedFile&) = delete;
    
    void* data() { return data_; }
    size_t size() const { return size_; }
};

void mmapDemo() {
    MemoryMappedFile file("data.bin", 1024 * 1024);  // 1 MB file
    
    // Write to the file by writing to memory
    char* ptr = static_cast<char*>(file.data());
    strcpy(ptr, "Hello, memory-mapped world!");
    
    // Read from the file by reading memory
    std::cout << ptr << "\n";
    
    // Changes are automatically persisted to disk
    // (by the OS, asynchronously, or on msync/munmap)
}
```

This is how databases like SQLite, LMDB, and MongoDB's WiredTiger engine work internally. The OS's virtual memory system becomes your buffer pool.

### Memory Overcommit

On Linux, the default behavior is to allow processes to allocate more virtual memory than physical RAM. The OS assumes that most allocated pages will never actually be touched.

```cpp
void overcommitDemo() {
    // This may "succeed" even if you only have 8 GB of RAM
    // because Linux overcommits by default
    char* huge = new char[100ULL * 1024 * 1024 * 1024];  // 100 GB
    
    // No physical memory is used yet. Pages are mapped to a shared zero page.
    // Accessing a page triggers a minor fault and allocates a physical frame.
    
    // If the system runs out of physical memory + swap when you touch pages,
    // the OOM killer will terminate a process (possibly yours).
    
    huge[0] = 'A';  // Now 1 physical page (4 KB) is allocated
    
    delete[] huge;
}
```

This is why Go programs can start with a large virtual address space reservation (hundreds of GB) without actually using that much physical memory. The Go heap manager reserves virtual space upfront and maps physical pages as needed.

---
