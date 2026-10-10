## 102M.4 Memory Management: From Static BSS to a Real Heap

The two Medium tutorials stop before memory management is covered in depth. The go-dav-os project implements a full bitmap page frame allocator and 4-level paging, but the commit history and source are the only explanation. This section fills that gap with a more structured walkthrough than either reference offers.

### Phase 1: Static `.bss` Only (What You Start With)

After the boot sequence in Section 102M.2, your kernel has one stack (16 KB) and whatever global variables you declared in Go packages. Every variable lives in `.bss` or `.data`. You cannot `make([]byte, n)`, you cannot `new(Node)`, you cannot grow slices beyond their compiled capacity. The language still works, but the shape of the code is 1975-era C: fixed-size arrays, in-place updates, no dynamic data structures.

For a shell, this is enough. You already wrote one in Section 102M.3 with a fixed 128-byte line buffer and a static `commands` slice. The moment you want a growing command history, a process table of arbitrary size, or a real filesystem cache, you need a heap.

### Phase 2: The Multiboot2 Memory Map

GRUB gave you a pointer to the Multiboot information structure when it called your kernel (saved in `multiboot_info_ptr` during the boot stub). That structure contains a **memory map**: a list of physical address ranges, each tagged as available (usable by you), reserved (off-limits), ACPI (reclaimable), or bad memory.

The Multiboot2 info block is a list of 8-byte-aligned tags. You walk the list looking for tag type 6 (memory map). Each entry in the memory map is 24 bytes: start address (8 bytes), length (8 bytes), type (4 bytes), reserved (4 bytes).

```go
package mmap

import "unsafe"

type Entry struct {
    BaseAddr uint64
    Length   uint64
    Type     uint32
    _        uint32
}

const (
    TypeAvailable = 1
    TypeReserved  = 2
    TypeACPI      = 3
    TypeBadRAM    = 5
)

// ParseMemoryMap walks the Multiboot info structure and returns all available entries.
func ParseMemoryMap(mbInfoPtr uintptr) []Entry {
    var out [32]Entry
    count := 0

    // Multiboot info layout: 4 bytes total_size, 4 bytes reserved, then tags.
    total := *(*uint32)(unsafe.Pointer(mbInfoPtr))
    tagPtr := mbInfoPtr + 8
    end := mbInfoPtr + uintptr(total)

    for tagPtr < end {
        tagType := *(*uint32)(unsafe.Pointer(tagPtr))
        tagSize := *(*uint32)(unsafe.Pointer(tagPtr + 4))

        if tagType == 0 { // End tag
            break
        }

        if tagType == 6 { // Memory map
            entrySize := *(*uint32)(unsafe.Pointer(tagPtr + 8))
            _ = *(*uint32)(unsafe.Pointer(tagPtr + 12)) // entry_version
            entries := tagPtr + 16
            num := (uintptr(tagSize) - 16) / uintptr(entrySize)
            for i := uintptr(0); i < num; i++ {
                e := (*Entry)(unsafe.Pointer(entries + i*uintptr(entrySize)))
                if e.Type == TypeAvailable && count < len(out) {
                    out[count] = *e
                    count++
                }
            }
        }

        // Tags are 8-byte aligned.
        tagPtr += uintptr((tagSize + 7) &^ 7)
    }

    return out[:count]
}
```

Once you have the list of available ranges, you know how much physical RAM you can allocate from and where.

### Phase 3: The Bitmap Page Frame Allocator

A page frame allocator hands out 4 KB physical pages. The simplest implementation is a **bitmap**: one bit per page, where 1 means "allocated" and 0 means "free."

For 512 MB of RAM, you need 512 MB / 4 KB = 131,072 bits = 16 KB of bitmap. That fits easily in a static array.

```go
package pageframe

const (
    PageSize    = 4096
    BitmapPages = 1 << 17 // supports up to 512 MB of RAM
)

var bitmap [BitmapPages / 8]byte

func markUsed(page uint64)   { bitmap[page/8] |= 1 << (page % 8) }
func markFree(page uint64)   { bitmap[page/8] &^= 1 << (page % 8) }
func isUsed(page uint64) bool { return bitmap[page/8]&(1<<(page%8)) != 0 }

// Init marks all pages as used, then un-marks pages in the available regions.
// The kernel's own pages stay marked used to protect them from reallocation.
func Init(avail []Entry, kernelStart, kernelEnd uint64) {
    for i := range bitmap {
        bitmap[i] = 0xFF
    }
    for _, e := range avail {
        start := alignUp(e.BaseAddr, PageSize) / PageSize
        end := (e.BaseAddr + e.Length) / PageSize
        for p := start; p < end; p++ {
            markFree(p)
        }
    }
    kStart := kernelStart / PageSize
    kEnd := alignUp(kernelEnd, PageSize) / PageSize
    for p := kStart; p < kEnd; p++ {
        markUsed(p)
    }
}

func Alloc() (uint64, bool) {
    for i, b := range bitmap {
        if b == 0xFF {
            continue
        }
        for bit := 0; bit < 8; bit++ {
            if b&(1<<bit) == 0 {
                page := uint64(i)*8 + uint64(bit)
                markUsed(page)
                return page * PageSize, true
            }
        }
    }
    return 0, false
}

func Free(addr uint64) {
    markFree(addr / PageSize)
}

func alignUp(x, a uint64) uint64 { return (x + a - 1) &^ (a - 1) }
```

This allocator is O(N) in the worst case but fine for a hobby kernel. A production allocator would layer a buddy system or a slab allocator on top of this page layer for sub-page allocations.

### Phase 4: 4-Level Paging and Virtual Memory

The boot stub in Section 102M.2 set up just enough paging to get into long mode. For real virtual memory, you extend those tables.

x86-64 uses 4-level paging:
- **PML4** (Page Map Level 4): top level, 512 entries, each pointing to a PDPT
- **PDPT** (Page Directory Pointer Table): 512 entries, each pointing to a PD
- **PD** (Page Directory): 512 entries, each pointing to a PT or mapping a 2 MB huge page
- **PT** (Page Table): 512 entries, each mapping a 4 KB page

Each entry is 8 bytes and includes the physical address of the next level plus flags: Present (P), Read/Write (R/W), User/Supervisor (U/S), Page Size (PS, set for 2 MB huge pages), Execute Disable (NX), and more.

```go
package paging

const (
    Present  = 1 << 0
    Writable = 1 << 1
    User     = 1 << 2
    HugePage = 1 << 7
    NoExec   = 1 << 63
)

type Table [512]uint64

// MapPage maps a single 4 KB virtual page to a physical frame.
func MapPage(pml4 *Table, virt, phys uint64, flags uint64) {
    pml4Idx := (virt >> 39) & 0x1FF
    pdptIdx := (virt >> 30) & 0x1FF
    pdIdx   := (virt >> 21) & 0x1FF
    ptIdx   := (virt >> 12) & 0x1FF

    pdpt := ensureTable(pml4, pml4Idx, flags)
    pd   := ensureTable(pdpt, pdptIdx, flags)
    pt   := ensureTable(pd, pdIdx, flags)

    pt[ptIdx] = (phys & 0xFFFFFFFFFF000) | flags | Present
}

func ensureTable(parent *Table, idx uint64, flags uint64) *Table {
    entry := parent[idx]
    if entry&Present == 0 {
        frame, ok := pageframe.Alloc()
        if !ok {
            panic("out of memory while building page tables")
        }
        parent[idx] = frame | flags | Present
        t := (*Table)(unsafe.Pointer(uintptr(frame)))
        for i := range t {
            t[i] = 0
        }
        return t
    }
    return (*Table)(unsafe.Pointer(uintptr(entry & 0xFFFFFFFFFF000)))
}
```

After changes to the PML4, flush the TLB for that specific virtual address using the `invlpg` instruction (or reload CR3 for a full flush).

### Phase 5: A Simple Kernel Heap

Once you have a page frame allocator and paging, you can implement a bump allocator or a free-list allocator for sub-page allocations. The simplest working heap is a bump allocator within a fixed-size region:

```go
package heap

var (
    heapStart uintptr = 0xFFFF_8000_0000_0000 // a virtual address you mapped
    heapEnd   uintptr
    heapNext  uintptr
)

func Init(pages int) {
    heapEnd = heapStart + uintptr(pages)*pageframe.PageSize
    for va := heapStart; va < heapEnd; va += pageframe.PageSize {
        frame, _ := pageframe.Alloc()
        paging.MapPage(kernelPML4, uint64(va), frame, paging.Present|paging.Writable|paging.NoExec)
    }
    heapNext = heapStart
}

func Alloc(size uintptr) unsafe.Pointer {
    size = (size + 15) &^ 15 // align 16
    if heapNext+size > heapEnd {
        return nil
    }
    p := heapNext
    heapNext += size
    return unsafe.Pointer(p)
}
```

A bump allocator can never reclaim memory, which is fine for short-lived hobby-kernel workloads and absolutely not fine for production. Upgrading to a free-list (like K&R's `malloc`) or a slab allocator (like Linux's `kmalloc`) is a natural next step.

### What Changes Once You Have a Heap

Once `Alloc` works, the Go code on top can start looking like normal Go:

- Slices can grow with a helper that calls `Alloc` and copies.
- Maps can be implemented (very minimally) using hashed buckets.
- Linked lists, trees, and other dynamic structures all work.
- You still do not have garbage collection, so either use arena allocation (allocate, use, drop the whole arena) or manual `Free`.

The go-dav-os project keeps its allocator simple. Reading `memory/` in the repository will show you exactly how far the simple model takes you before you hit the next wall.

### Pitfalls

- **Forgetting to mark the kernel itself as used.** If `Init` does not mark the kernel's own pages, `Alloc` can hand back kernel code pages, which will explode the next time you execute from them.
- **TLB staleness.** After unmapping or remapping a virtual page, the TLB may still cache the old entry. Call `invlpg` (or `mov cr3, cr3`) after changes.
- **Aligned-to-size rules for huge pages.** A 2 MB huge page must be aligned to 2 MB boundaries in both virtual and physical address. Mixing 4 KB and 2 MB mappings in the same PD causes confusion.
- **Not zeroing newly allocated tables.** A freshly allocated frame contains whatever was there before. Always clear the 512 entries before treating it as a page table.

### Senior-Track Note

Everything above is CPU-local. A real OS runs across multiple CPU cores, each with its own TLB, its own interrupt state, and its own local page tables (often). Multi-core Go-kernel work is an open frontier: AP (Application Processor) bring-up requires assembly to wake each CPU out of real mode, and per-CPU data structures need careful synchronization even in a freestanding Go environment that has no `sync` package. The go-dav-os project is explicitly single-core. Multi-core is the largest open task in the roadmap.

### Junior → FAANG: Memory Management Concepts Applied to Go Programs

The bitmap page frame allocator and 4-level paging from this section are the hardware-level foundation for understanding Go's memory allocator and the Linux kernel's buddy allocator. Go's `runtime.mheap` requests memory from the OS in 64 MB arenas via `mmap`, then carves those arenas into `mspan` objects that serve specific size classes. The page frame allocator in the toy OS is conceptually the same as `mheap`: a bitmap (or free list) tracking which physical pages are available, with `alloc` and `free` operations. Building the toy version makes Go's heap allocator concrete rather than abstract.

The 4-level page table hierarchy (PML4 -> PDP -> PD -> PT) is the translation mechanism for every memory access in a Go program. When Go's GC scans the heap, it follows pointers through virtual addresses. The CPU translates each virtual address through the page table hierarchy to find the physical page, caching entries in the TLB. When Go's GC compacts memory (in theory, though Go does not implement a compacting GC), it would need to update page tables. Understanding this translation explains why TLB flushes are expensive (each `mmap` or `munmap` call requires TLB invalidation across all CPUs via an IPI) and why Go's allocator avoids returning pages to the OS aggressively.

The MMIO (memory-mapped I/O) pattern from the VGA framebuffer example is directly applicable to eBPF and kernel module development. When an eBPF program needs to access a hardware counter register or a network device's queue descriptor, it may use MMIO to read from an address that the hardware responds to rather than physical DRAM. Understanding that MMIO addresses are physical addresses mapped to device registers (via the kernel's `ioremap`) clarifies why eBPF programs cannot dereference arbitrary kernel pointers: the verifier must ensure the program only accesses memory in the BPF verifier's known-safe regions.

### Senior @ FAANG: Memory Subsystem Architecture for High-Performance Go Services

At the FAANG scale, memory management decisions affect Go service performance in measurable ways. The kernel's transparent huge pages (THP) feature automatically promotes 4 KB pages to 2 MB pages for large allocations. Go's heap, which makes large `mmap` allocations for arenas, benefits from THP because 2 MB pages reduce the number of TLB entries needed to cover the heap, which reduces TLB miss rates. However, THP's `khugepaged` daemon can cause latency spikes when it scans and promotes pages. Platform teams tune THP behavior per-workload: `always` for memory-bound services that benefit from TLB coverage, `madvise` for latency-sensitive services that want THP for specific `madvise(MADV_HUGEPAGE)` regions, and `never` for services with small working sets where THP adds zero benefit.

NUMA (Non-Uniform Memory Access) architecture means that on multi-socket servers, memory access latency depends on whether the memory is on the same NUMA node as the CPU. Go's allocator is not NUMA-aware by default: it may allocate memory on NUMA node 0 for a goroutine that runs on a CPU on NUMA node 1, adding 100-300 ns to every memory access. For memory-intensive Go services on multi-socket servers, pinning the Go process to a single NUMA node with `numactl --cpunodebind=0 --membind=0 <binary>` can improve p99 latency by 10-20%. This optimization requires understanding the physical memory topology, which the page frame allocator section makes concrete.

Memory pressure and the OOM killer interaction is a production reliability concern that requires kernel-level understanding. When the kernel's OOM killer fires, it selects the process to kill based on the OOM score (a function of memory usage, swap usage, and the process's `oom_score_adj`). Go processes with large heap sizes have high OOM scores and may be killed before smaller processes that are the actual cause of memory pressure. Platform teams tune `oom_score_adj` for critical services (setting it negative to make them less likely to be killed) and for disposable services (setting it positive to make them the first victims). Understanding which score to set and why requires understanding the OOM killer's selection algorithm, which is documented in the kernel's `mm/oom_kill.c`.

---

---
