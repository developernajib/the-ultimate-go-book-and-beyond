## 04. Virtual Memory and Paging

Every process running on a modern OS believes it has exclusive access to a large, contiguous address space. That is a lie maintained by the operating system and the CPU's Memory Management Unit. Understanding this lie, and its implementation, explains a wide class of performance and correctness behaviors.

### Why Virtual Memory Exists

Virtual memory solves three distinct problems that arise when multiple programs share a single physical memory.

#### Problem 1: Not Enough Physical Memory

In the 32-bit era, CPUs could address up to 4GB of memory (2^32 bytes). Most machines had far less. In 64-bit systems, each process can address up to 128TB (AMD64: 47 address bits, ARM64: typically 48 bits), but physical DRAM rarely exceeds 1-2TB even on server hardware. Programs need to run even when their combined working set exceeds physical RAM.

Virtual memory solves this by allowing the OS to evict cold pages to disk (swap). A process that rarely uses its entire address space can run on a machine with less physical RAM than its virtual address space.

#### Problem 2: Memory Fragmentation

Suppose you have 4GB of DRAM and two programs: one using 2GB and another using 1GB. When the first exits, it leaves a 2GB hole. You want to start a new 2GB program. The physical memory has 3GB free, but it is fragmented, 2GB in one place, 1GB in another. Without virtual memory, you cannot run the new program.

Virtual memory solves this by mapping non-contiguous physical pages to a contiguous virtual address space. The program sees addresses 0x0000 through 0x7FFF as sequential, but the underlying physical frames may be scattered across DRAM.

#### Problem 3: Security and Isolation

Without virtual memory, every process can read and write any physical address. Process A can overwrite process B's data. A buggy process can corrupt the OS kernel. Virtual memory enforces isolation: each process gets its own address space and cannot access another process's physical frames. Any attempt generates a protection fault, which the OS handles by terminating the offending process (segfault / access violation).

### Pages and Frames

Physical memory is divided into fixed-size blocks called frames. Virtual address space is divided into same-size blocks called pages. A page is typically 4KB (4096 bytes). Some architectures support huge pages of 2MB or 1GB.

The OS maintains a page table for each process. The page table maps virtual page numbers to physical frame numbers.

```
Virtual Address (64-bit, x86-64):
Bits 47-39: PML4 index (9 bits)
Bits 38-30: PDPT index (9 bits)
Bits 29-21: PD index   (9 bits)
Bits 20-12: PT index   (9 bits)
Bits 11-0:  Page offset (12 bits = 4096 byte page)
```

x86-64 uses a 4-level page table (PML4 structure). Each level is an array of 512 entries (9 bits). A 5-level page table (PML5) extends the virtual address space to 57 bits, supporting 128PB.

Each page table entry contains:
- Physical frame number.
- Present bit (is this page in physical RAM?).
- Read/write bit.
- User/supervisor bit.
- Accessed and Dirty bits (set by hardware on access/write).
- No-Execute (NX) bit.

### The MMU and Address Translation

The Memory Management Unit (MMU) is a hardware component inside the CPU that performs virtual-to-physical address translation. On every memory access, the MMU walks the page table to find the physical address.

Walking a 4-level page table requires 4 memory accesses. At 60-100 ns per DRAM access, a cold page table walk costs 240-400 ns. This overhead would be devastating if done on every instruction.

### The TLB

The Translation Lookaside Buffer (TLB) is a small, fast cache for page table entries. It holds the most recently used virtual-to-physical translations. TLB capacity is small, typically 64 entries for L1 TLB, 1,024-4,096 for L2 TLB.

On a TLB hit: the MMU reads the physical address directly from the TLB. Cost: near-zero (< 1 ns).
On a TLB miss: the MMU performs a full page table walk. Cost: 240-400 ns (plus 1+ µs if page table entries are not in cache).

TLB thrashing occurs when a program accesses more unique pages than the TLB can hold, causing continuous TLB misses. With 4KB pages and a 64-entry L1 TLB, only 256KB of memory can be covered by L1 TLB simultaneously. A program that touches 1000 different 4KB pages in a short loop will have TLB misses on most accesses.

Huge pages (2MB) give each TLB entry 512x more coverage. With a 64-entry L1 TLB using 2MB pages, 128MB of address space is covered. This is why databases and JVM-based systems use transparent huge pages.

### Page Faults

A page fault occurs when the CPU tries to access a virtual address whose page table entry has the Present bit clear.

**Minor page fault**: the page exists in memory or is anonymous (never written) and can be satisfied without disk I/O. Example: first access to a mmap'd anonymous region. The OS just maps a physical frame to the virtual address and sets the Present bit. Cost: a few microseconds.

**Major page fault**: the page was swapped out to disk. The OS must read the page from swap before the process can continue. Cost: 1-10 milliseconds, depending on the storage device.

**Invalid fault (segfault)**: the address is not mapped at all. The OS sends SIGSEGV to the process.

### Demand Paging and Overcommit

Linux uses demand paging: allocating virtual address space does not immediately allocate physical frames. Calling `malloc(1GB)` or `make([]byte, 1<<30)` succeeds even if the machine has 512MB of free RAM. Physical frames are allocated only when the process first writes to a page.

Overcommit is the OS policy that allows the total committed virtual memory across all processes to exceed physical RAM plus swap. Linux has three overcommit modes:
- 0 (heuristic): the kernel allows most overcommit but rejects obviously unreasonable requests.
- 1 (always): overcommit is always allowed. Unsafe, but used in some HPC workloads.
- 2 (never): total committed memory cannot exceed swap + a percentage of physical RAM.

The risk of overcommit: when physical memory actually runs out, the OOM killer terminates processes. See Section 5.

### Code Example: Observing Page Faults in Go

```go
package main

import (
    "fmt"
    "os"
    "runtime"
    "strconv"
)

func readPageFaults() (minor, major uint64) {
    // Read from /proc/self/status on Linux.
    // VmMinFlt and VmMajFlt are not in /proc/self/status -     // use /proc/self/stat fields 10 and 12 instead.
    data, err := os.ReadFile("/proc/self/stat")
    if err != nil {
        return 0, 0
    }
    fields := make([]string, 0, 52)
    start, inField := 0, false
    for i, c := range data {
        if c == ' ' || c == '\n' {
            if inField {
                fields = append(fields, string(data[start:i]))
                inField = false
            }
        } else {
            if !inField {
                start = i
                inField = true
            }
        }
    }
    toUint := func(s string) uint64 {
        v, _ := strconv.ParseUint(s, 10, 64)
        return v
    }
    if len(fields) < 12 {
        return 0, 0
    }
    return toUint(fields[9]), toUint(fields[11])
}

func main() {
    if runtime.GOOS != "linux" {
        fmt.Println("page fault reading only implemented for Linux")
        return
    }

    minBefore, majBefore := readPageFaults()

    // Allocate 64MB of anonymous memory and write to every page.
    const size = 64 * 1024 * 1024
    buf := make([]byte, size)
    for i := 0; i < size; i += 4096 {
        buf[i] = 1 // touch each 4KB page
    }
    _ = buf

    minAfter, majAfter := readPageFaults()
    fmt.Printf("minor faults: %d (expected ~%d)\n",
        minAfter-minBefore, size/4096)
    fmt.Printf("major faults: %d\n", majAfter-majBefore)
}
```

On a cold run you should see approximately 16,384 minor page faults (64MB / 4KB), confirming that Linux allocates physical frames lazily on first write. Major faults should be 0 unless the system is swapping.

### Huge Pages in Go

Go's runtime does not use huge pages by default on Linux. You can enable transparent huge pages (THP) system-wide via:

```bash
echo always > /sys/kernel/mm/transparent_hugepage/enabled
```

Or advise the kernel for a specific mmap region in Go:

```go
//go:build linux

package main

import (
    "syscall"
    "unsafe"
)

// HintHugePage advises the kernel to back buf with 2MB huge pages.
// buf must be 2MB-aligned and sized to a multiple of 2MB.
func HintHugePage(buf []byte) error {
    const MADV_HUGEPAGE = 14
    _, _, errno := syscall.Syscall(
        syscall.SYS_MADVISE,
        uintptr(unsafe.Pointer(&buf[0])),
        uintptr(len(buf)),
        MADV_HUGEPAGE,
    )
    if errno != 0 {
        return errno
    }
    return nil
}
```

Huge pages reduce TLB pressure significantly for large buffers. A 256MB buffer backed by 4KB pages needs 65,536 TLB entries. The same buffer backed by 2MB huge pages needs only 128.

**Watch:** [But, what is Virtual Memory?](https://www.youtube.com/watch?v=A9WLYbE0p-I), recommended for visual learners.
