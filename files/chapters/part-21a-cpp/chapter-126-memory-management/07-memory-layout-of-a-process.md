## Memory Layout of a Process

Understanding how a program is laid out in memory helps you reason about performance, security, and debugging.

```
    Virtual Address Space of a Process
    
    +---------------------------+  0xFFFFFFFF (high address, 32-bit)
    |                           |
    |      Kernel Space         |  (inaccessible from user code)
    |                           |
    +---------------------------+  0xC0000000 (typical Linux 32-bit)
    |                           |
    |      Stack                |  Grows DOWNWARD
    |      (local variables,    |     |
    |       return addresses,   |     |
    |       function params)    |     v
    |                           |
    +---------------------------+
    |                           |
    |      (unmapped gap)       |  Guard page / gap between stack and heap
    |                           |
    +---------------------------+
    |                           |
    |      Memory-mapped region |  Shared libraries, mmap'd files
    |                           |
    +---------------------------+
    |           ^               |
    |           |               |
    |      Heap                 |  Grows UPWARD
    |      (malloc, new,        |
    |       dynamic allocation) |
    |                           |
    +---------------------------+
    |      BSS Segment          |  Uninitialized global/static variables
    |      (zero-initialized)   |  (int globalArr[1000]; -- takes no space in binary)
    +---------------------------+
    |      Data Segment         |  Initialized global/static variables
    |      (int x = 42;)       |  (stored in the executable file)
    +---------------------------+
    |      Text (Code) Segment  |  Executable machine code
    |      (read-only,          |  Shared between processes running same binary
    |       executable)         |
    +---------------------------+  0x00000000 (low address)
```

### Segment Details

Each variable type maps to a specific memory segment: the compiled function body lives in the read-only text segment, initialized globals in the data segment, zero-initialized globals in BSS (which adds no size to the binary), stack-allocated locals on the current thread's stack, and `new`-allocated objects on the heap. Recognizing which segment a variable occupies is essential for diagnosing segfaults, stack overflows, and heap corruption.
```cpp
#include <iostream>

// TEXT segment: this function's compiled code lives here
int computeSquare(int x) { return x * x; }

// DATA segment: initialized global
int globalInit = 42;

// BSS segment: uninitialized global (zero-initialized by OS)
int globalUninit;
int globalArray[10000];  // 40 KB in BSS -- takes 0 bytes in the executable file

// DATA segment: initialized static
static int moduleVar = 100;

int main() {
    // STACK: local variables
    int localVar = 10;
    int localArr[100];
    
    // HEAP: dynamically allocated
    int* heapVar = new int(99);
    
    std::cout << "Text (code):    " << (void*)&computeSquare << "\n";
    std::cout << "Data (init):    " << (void*)&globalInit << "\n";
    std::cout << "BSS (uninit):   " << (void*)&globalUninit << "\n";
    std::cout << "Stack (local):  " << (void*)&localVar << "\n";
    std::cout << "Heap (dynamic): " << (void*)heapVar << "\n";
    
    delete heapVar;
    return 0;
}
```

Typical output (addresses will vary due to ASLR):

```
Text (code):    0x401150
Data (init):    0x404040
BSS (uninit):   0x404060
Stack (local):  0x7ffd12345678
Heap (dynamic): 0x5555557890a0
```

Notice how the addresses cluster: code and data segments are near the bottom, the heap is in the middle, and the stack is near the top of the address space.

### Checking Memory Layout on Linux

`/proc/<pid>/maps` shows the virtual address ranges, permissions (`r`, `w`, `x`, `p`/`s`), and backing file for every mapped region of a running process. Cross-referencing the addresses in a crash report against this map instantly identifies whether a fault occurred in the code segment, the heap, the stack, or a shared library.
```bash
# View memory map of a running process
cat /proc/<pid>/maps

# Example output:
# 00400000-00402000 r-xp  /path/to/binary     <- Text (code)
# 00402000-00403000 r--p  /path/to/binary     <- Read-only data
# 00403000-00404000 rw-p  /path/to/binary     <- Data + BSS
# 00a00000-00a21000 rw-p  [heap]              <- Heap
# 7f0000000000-...  r-xp  /lib/libc.so        <- Shared libraries
# 7ffd00000000-...  rw-p  [stack]             <- Stack

# View with more detail
pmap <pid>

# Or inspect the binary itself
size ./myapp
# text    data    bss     dec     hex     filename
# 2048    512     40000   42560   a640    ./myapp
```

**Go comparison:** Go programs have the same basic memory layout, but with significant differences:
- Go uses contiguous growable stacks (goroutine stacks start at 2 KB and grow as needed via contiguous stack copying)
- The Go heap is managed by a custom allocator (`mspan`, `mcache`, `mcentral`, `mheap`)
- Go's runtime itself takes significant memory (several MB for the GC, scheduler, etc.)

---

### Junior → FAANG: Memory Layout as a Debugging Mental Model

When you see a crash with a specific address (e.g., a segfault at address `0x0000000000000008`), the memory layout map tells you what region that address is in. Address `0x8` is in the unmapped zero page, meaning a null pointer dereference with a small offset (e.g., accessing the second field of a null-pointer struct). An address in the range `0x7fff...` is on the stack, meaning a stack overflow or use of a destroyed stack frame. An address in the range returned by `mmap` is on the heap.

Practice: run a small C++ program under GDB or LLDB, print the addresses of a stack variable, a heap allocation, a global, and a function, and locate each in `/proc/<pid>/maps`. This builds the spatial intuition that makes crash dumps readable.

Interview note: "explain the difference between stack and heap allocation" is a basic C++ interview question, but "explain the performance difference and when each is appropriate" is the L5 version. Stack allocation is O(1) (just a pointer decrement), does not involve the kernel after the initial stack page mapping, and has excellent cache locality (the stack is typically hot in L1). Heap allocation involves the allocator (which may have a lock or a bin lookup) and allocates memory that may be cold in cache.

### Senior @ FAANG: Memory Layout in Security, Performance, and Crash Analysis

At the staff level, memory layout knowledge is applied in three domains: security hardening, performance optimization, and production crash analysis.

**ASLR and position-independent code.** Address Space Layout Randomization (ASLR) randomizes the base address of each memory segment (stack, heap, shared libraries, executable) on each process launch. To be ASLR-compatible, executables must be compiled as Position-Independent Executables (PIE) with `-fPIE -pie`. Shared libraries must be compiled with `-fPIC`. A staff engineer ensures these flags are set in the production build system and are not disabled by any team's custom build configuration. Disabling PIE or PIC for "performance reasons" is almost never justified and significantly weakens ASLR protection.

**Huge pages for memory-intensive services.** For a C++ service with a working set of tens of GB (a large in-memory cache, an embedding store), TLB misses on 4KB pages become a measurable overhead. Switching to 2MB huge pages via `madvise(MADV_HUGEPAGE)` or explicit huge page allocation reduces TLB pressure. A staff engineer evaluates huge pages with profiling data (`perf stat -e dTLB-load-misses`), not intuition, and documents the measured improvement before adding the operational complexity of huge page configuration.

**Crash dump analysis as a staff skill.** When a production C++ service crashes, the crash dump contains the process's memory layout at the time of crash: the call stack, the heap state, the register values, and (if core dumps are enabled) a snapshot of memory. A staff engineer is able to load a core dump into GDB (`gdb ./binary core`), navigate the call stack, inspect the state of objects at the time of crash, and write a root-cause analysis within hours. This skill is often what separates L5 from L6 in incident response.

