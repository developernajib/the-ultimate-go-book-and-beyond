## 102M.7 Case Study: go-dav-os v0.3.0

This section is an honest architectural review of the go-dav-os project as of v0.3.0 (February 2026). The goal is to give you a map of the codebase before you clone it, so the first hour of reading the source is productive instead of disorienting.

**Repository:** [github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os)
**Author:** Davide Marro ([medium.com/@davideraffaele.marro](https://medium.com/@davideraffaele.marro), [github.com/dmarro89](https://github.com/dmarro89))
**Tutorial project:** [github.com/dmarro89/go-os-tutorial](https://github.com/dmarro89/go-os-tutorial) (step-by-step reference, tagged per article)
**Medium series:**
- [Part 1: The Kernel](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-1-af287bfc402a)
- [Part 2: The Shell](https://levelup.gitconnected.com/create-an-operating-system-in-go-part-2-the-shell-69891e3e0ca1)

### The Thirty-Second Summary

go-dav-os is a single-core 64-bit x86 kernel written in Go with the minimum assembly required to bridge the CPU-level features (boot, mode switching, port I/O, IDT, syscall). It boots via GRUB, runs interactively in QEMU, supports an in-memory filesystem plus FAT16 on a 20 MB virtual disk, runs user programs in ring 3, and is the most complete open-source Go-on-bare-metal project you can clone and read in an afternoon.

### Directory Map

| Directory | Responsibility |
|-----------|----------------|
| `boot/` | Assembly entry, Multiboot2 header, long-mode setup, linker script |
| `kernel/` | Go entry point, main loop, top-level glue |
| `terminal/` | VGA text buffer, cursor, scroll, color attributes |
| `keyboard/` | PS/2 polling + interrupt-driven reader, Italian layout table |
| `interrupts/` | IDT construction, PIC remap, PIT setup, IRQ handlers |
| `memory/` | Multiboot2 memory map parser, bitmap page frame allocator, paging helpers |
| `filesystem/memfs/` | In-memory filesystem |
| `filesystem/fat16/` | FAT16 driver, BPB parser, cluster walking, read/write |
| `ata/` | IDE PIO disk driver |
| `shell/` | Line reader, tokenizer, command dispatch |
| `tasks/` | Ring-3 user-space task runner, syscall dispatcher |
| `Dockerfile` + `Makefile` | Reproducible build toolchain |

### What It Does Well

**Boots reliably.** The Multiboot2 header and the 32-to-64 switch have been iterated enough that the boot sequence is stable across QEMU, Bochs, and physical hardware (reportedly).

**Has a proper toolchain.** The Docker image pins `gccgo`, binutils, GRUB, and `grub-mkrescue` at compatible versions. `docker build && docker run` produces an ISO without any host-side setup beyond Docker itself.

**Commits are readable.** The author keeps the commit history clean and explanatory, so reading `git log --oneline` gives you a chronological tour of how each subsystem came together. This is more educational than most OS tutorials.

**Accepts small contributions.** The issue tracker and discussions board are active. New layouts, small bug fixes, and documentation improvements have been merged in practice. For someone wanting to contribute to an OS project without the 6-month ramp of Linux, go-dav-os is an accessible entry point.

**Has a roadmap.** The README and open issues outline what would make the kernel more capable: SMP (multi-core), networking, a VFS layer, FAT32 support, an ELF loader, and interrupt-driven everything (not just the keyboard).

### What It Does Not Do Yet

- **Multi-core.** Single CPU only. AP bring-up is the largest open item.
- **Networking.** No NIC driver, no TCP/IP stack. Adding a virtio-net driver is a high-value project.
- **A real scheduler.** The task runner loads and runs one user program at a time. Preemptive multitasking is not there yet.
- **ELF loading.** User programs are flat binaries. Adding ELF support unlocks building programs with a normal compiler toolchain.
- **Memory protection between user programs.** Each user program runs with the same user-mode pages mapped. There is no per-process address space yet.
- **A full VFS.** memfs and FAT16 live side by side without a common interface. A VFS layer would make adding filesystems much cheaper.

### Architecture Observations

**The Go-assembly boundary is well-placed.** Assembly is used only for what must be: the Multiboot2 header, the mode-switch dance, `inb`/`outb`, the IDT entry stubs, the ring-3 transition, and the syscall entry. Everything above those is Go. Most hobby kernels have more assembly than they need because the boundary was never deliberately drawn.

**State is mostly global.** A production kernel passes context explicitly (or through per-CPU data). go-dav-os uses package-level globals for the terminal state, the keyboard buffer, the page allocator bitmap, and so on. This is fine for single-core and simpler to reason about, but every multi-core feature will require rewriting these parts.

**The `unsafe` package is essential.** Go's type system cannot express "this uintptr is a pointer to a VGA cell" without `unsafe.Pointer` casts. Kernel Go has `unsafe` in every other file. A style-linter that rejects `unsafe` would reject most of the kernel. That is correct and expected.

**There is no sync package.** Without goroutines, without a scheduler, without multi-core, concurrency is limited to what an interrupt handler might do between instructions. The kernel disables interrupts in critical sections rather than using locks. Primitive, but correct for single-core.

### Things Worth Stealing for Your Own Kernel

- The Dockerfile toolchain. Reusing this saves weeks of `gccgo` fights.
- The IDT construction code. The CPU specifics of IDT entry format are tedious. The go-dav-os implementation is tight and readable.
- The ATA PIO driver. Straightforward, testable, and QEMU-friendly.
- The Multiboot2 tag walker. You will rewrite this three times if you don't steal one.

### What to Contribute Back

If you want to make a meaningful contribution in 2026-2027:

- **A US keyboard layout table.** Low-effort, high-visibility. Italian is the only layout in-tree.
- **An ELF64 loader.** Replaces flat binaries with something compilers produce.
- **A simple round-robin scheduler.** Makes multi-tasking real.
- **virtio-net plus a tiny ARP/ICMP stack.** Enables `ping` from the kernel.
- **A write-then-read test for FAT16.** The filesystem code benefits from explicit regression tests.

All of these have been mentioned in the project's discussions board as wanted.

### Comparing to Other Hobby Kernels

| Project | Language | Scope | Status |
|---------|----------|-------|--------|
| [xv6](https://pdos.csail.mit.edu/6.828/2024/xv6.html) | C (+ asm) | Teaching kernel, multi-core | Canonical |
| [Redox](https://www.redox-os.org/) | Rust | Production-aspirant, microkernel, drivers, GUI | Active |
| [Theseus](https://theseus-os.github.io/Theseus/) | Rust | Research, safe-language OS | Active |
| [MOROS](https://github.com/vinc/moros) | Rust | Hobbyist, interactive, shell + FS | Active |
| [go-dav-os](https://github.com/dmarro89/go-dav-os) | Go + asm | Hobbyist, interactive, shell + FS + ring 3 | Active |

The Rust OS scene is larger and older. The Go OS scene is tiny, and go-dav-os is the best hobby project in it as of 2026. That scarcity is an opportunity: a well-structured Go kernel contribution is visible and appreciated in a way that a Rust contribution blended into Redox's history would not be.

### Recommended Reading Order

If you want to learn from this project end-to-end:

1. Read the README to understand the build flow.
2. `docker build && docker run` to produce `build/dav-go-os.iso`, then `qemu-system-x86_64 -cdrom build/dav-go-os.iso`.
3. Interact with the shell, try `ls`, `cat`, `fatinit`, `run hello`.
4. Read `boot/` (assembly) alongside Section 102M.2 of this book.
5. Read `terminal/`, `keyboard/`, `shell/` alongside Section 102M.3.
6. Read `memory/`, `interrupts/` alongside Section 102M.4.
7. Read `filesystem/memfs/`, `filesystem/fat16/`, `ata/` alongside Section 102M.5.
8. Read `tasks/` alongside Section 102M.6.

By that point, you will have walked the entire stack from first byte at 0x7C00 to a ring-3 user program printing through a system call, all implemented in a language you already know well.

### Junior → FAANG: Reading Open-Source Systems Code as a Learning Practice

The go-dav-os case study demonstrates the discipline of reading existing systems code before contributing to or building on it. The recommended practice is to read the code in dependency order: entry point assembly first (to understand what state the runtime expects), memory management second (everything else depends on allocation), interrupt handling third (I/O and syscalls depend on interrupts), and higher-level drivers last. This reading order, from hardware up, is the reverse of how application engineers typically read code (from API down), and developing it takes deliberate practice.

The architectural gaps identified in the case study (single-core, no preemption, no process isolation except ring switching) are the productive learning targets. Pick one gap, understand why it is hard (multi-core requires IPI synchronization, preemption requires saving full CPU context at arbitrary points, process isolation requires per-process page tables), implement the simplest possible version, and document what you had to change. This exercise, implementing one OS feature at the hardware level, teaches more about the Linux kernel's implementation of that feature than any amount of reading.

For FAANG interview preparation, the case study is most valuable as a source of specific, accurate, first-hand knowledge. "I read the go-dav-os source and implemented per-process page tables as an extension to v0.3.0" is a memorable, specific, differentiating answer to "tell me about a low-level systems project you have worked on." The specificity (version number, specific feature, what you had to change) signals that the experience was real and detailed, not a surface-level tutorial.

### Senior @ FAANG: Open-Source Kernel Projects as Platform Engineering Reference Implementations

At the senior level, reading kernel project source code (go-dav-os, Linux, gVisor, ACRN, Redox) is a research activity for evaluating implementation approaches before making platform architecture decisions. The go-dav-os case study's honest identification of single-core limitations mirrors the analysis process a staff engineer applies when evaluating whether a production runtime is ready for a specific workload class: what assumptions does it make, what are the documented limitations, and what failure mode occurs when those assumptions are violated?

The architectural review format used in this section (component inventory, dependency graph, identified limitations, recommended extensions) is directly applicable to the ADR format used for internal infrastructure decisions at FAANG. When evaluating gVisor vs. Kata for a multi-tenant workload, the review covers: syscall coverage (what gVisor implements vs. what's missing), performance characteristics (which syscall classes are slower), security model (what isolation guarantees are provided and under what threat model), and operational complexity (how upgrades are managed, how failures manifest). This is the same structure as the go-dav-os case study, applied to production systems.

The "walk the entire stack" aspiration is what separates engineers who understand systems from engineers who operate them. At FAANG, the engineers who can walk from the first byte at boot to the last byte at userspace, and explain what happens at each transition, are the ones called in for the most difficult production incidents, the ones who write the ADRs that define the organization's infrastructure architecture, and the ones who mentor emerging systems engineers. This chapter's case study is one step on that walk.

---

---
