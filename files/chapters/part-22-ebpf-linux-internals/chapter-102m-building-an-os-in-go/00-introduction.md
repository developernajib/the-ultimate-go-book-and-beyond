# Chapter 102M: Building an Operating System Kernel in Go

Go was not designed as a systems-programming language in the 1970s Unix sense. It does not ship a freestanding mode by default. It has a garbage collector, a goroutine scheduler, and a runtime that assumes an operating system below it. These design choices make Go a poor fit for writing a kernel.

And yet, people write kernels in Go anyway. The reason is worth understanding: when you strip Go down to the parts that can run on bare metal (with `gccgo`, without the standard library, with assembly for the entry point and for CPU-specific operations), what remains is a clean, static, fast-compiling language with a decent type system and no C-style undefined behavior. For hobbyist OS work, for educational kernels, and for constrained embedded targets, that is a surprisingly good starting point.

This chapter walks through what it actually takes to build an OS kernel in Go in 2026. The running example is **go-dav-os**, a single-core 64-bit experimental kernel created by Davide Marro ([github.com/dmarro89/go-dav-os](https://github.com/dmarro89/go-dav-os)). The companion tutorial series ([github.com/dmarro89/go-os-tutorial](https://github.com/dmarro89/go-os-tutorial)) reconstructs the project step by step and is the best pedagogical material available for Go-kernel work.

### Why This Chapter Exists in a Go Book

Three audiences benefit from this material.

**First, curious engineers who want to demystify the stack under their services.** Every `go build` produces a binary that the kernel loads. Knowing how that kernel boots, how the CPU enters long mode, how interrupts get routed, and how paging is set up gives you a mental model for debugging everything above: why does a syscall take microseconds? Why does a goroutine park on a blocking read? What is actually happening when the scheduler yields?

**Second, engineers who work near the kernel.** eBPF (Chapter 102K) works because the kernel exposes specific hook points. Container runtimes (Chapter 102L) work because the kernel exposes namespaces and cgroups. Writing a tiny kernel yourself is the fastest way to understand why those abstractions exist and where their edges are.

**Third, engineers interviewing for systems-adjacent roles.** When Google, Meta, Cloudflare, or Netflix hire for infrastructure roles, the senior interviews often probe kernel-level understanding. Having built even a toy kernel is a rare and high-signal resume item, and explaining it well in an interview puts you in a small pool.

### What This Chapter Is Not

This chapter is not a production-OS tutorial. Nobody is going to ship a general-purpose operating system written in Go. The sections that follow do not cover SMP scheduling, networking stacks, a full filesystem driver ecosystem, or security isolation at a level you could trust with real workloads. The go-dav-os project itself is explicitly a "hobby learning project" in the author's own words, and you should treat what follows in the same spirit.

If you want a production-OS career path, learn C and Rust. If you want to understand what a kernel does so you can be a better Go engineer, this chapter is for you.

### What You'll Learn

- The minimum toolchain needed to compile Go for bare metal (`gccgo`, Multiboot2, QEMU)
- How a kernel image boots: GRUB, the Multiboot2 header, the 32-bit entry stub, the jump to 64-bit long mode
- How interrupts are set up: the IDT, the PIC, and the PIT
- How Go code runs without the Go runtime (what you lose: goroutines, the GC, `fmt`, what you keep: types, functions, control flow, slices if you implement an allocator)
- How to talk to the keyboard, drive a VGA text terminal, and build a minimal shell
- How to parse the Multiboot2 memory map, implement a page frame allocator, and enable paging
- How to implement an in-memory filesystem and a FAT16 driver
- Design choices inside go-dav-os that can apply to any Go-kernel work

### Prerequisites

- Solid understanding of pointers, memory layout, and stack-versus-heap (Chapters 5 and 7)
- Familiarity with a little x86-64 assembly (the book does not require you to write assembly from scratch, but you should read it without panic)
- Comfort with `docker run` for building (the toolchain is easier to containerize than to install natively on every developer laptop)

### Structure of This Chapter

1. **Why build an OS in Go?** The design trade-offs that make it interesting.
2. **Booting a kernel in Go** (rewritten from the tutorial Part 1 article). GRUB, Multiboot2, assembly entry, jump to long mode, VGA text output.
3. **Building a shell** (rewritten from the tutorial Part 2 article). PS/2 keyboard polling, scancode-to-character mapping, line reader, command dispatch.
4. **Memory and filesystems**. Page frame allocator, paging, in-memory FS, FAT16.
5. **Case study: go-dav-os v0.3.0.** How the community-maintained fork extended the tutorial into a usable hobby kernel.
6. **Interview questions** on kernel internals that apply to Go systems roles.

### Junior → FAANG: Why Kernel Concepts Matter for Application Engineers

The question "why should a Go application engineer care about OS kernels?" has a concrete answer: the kernel determines the performance ceiling, failure modes, and security properties of every program running on it. Go's runtime makes scheduling decisions based on the kernel's SCHED_OTHER policy. Go's memory allocator calls `mmap` and `brk` to get pages from the kernel. Go's goroutine stack growth triggers `mmap` for new stack pages. Understanding these kernel-level behaviors explains Go performance phenomena that are otherwise mysterious (GC pauses correlating with memory pressure, goroutine scheduling latency spikes under CPU contention).

Before reading this chapter, close the prerequisite gap of understanding x86-64 memory protection rings. Ring 0 is kernel mode: unrestricted access to hardware, privileged instructions, and kernel memory. Ring 3 is user mode: restricted to the CPU instructions that do not modify hardware state or memory mappings. The boundary crossing (from ring 3 to ring 0) happens on every syscall, interrupt, and exception. This crossing costs approximately 100-300 nanoseconds on modern hardware due to Spectre/Meltdown mitigations (kernel page-table isolation adds a TLB flush on the ring transition). Every Go program that calls `os.Read`, `net.Dial`, or any standard library function that touches the OS pays this cost.

The educational value of writing a toy kernel is that it makes the system call interface concrete. When you implement `write()` in your toy kernel, you understand that it is just a function that reads the buffer pointer from a CPU register, walks the page tables to validate the pointer is user-accessible, copies the bytes to a device output buffer, and returns the byte count in a register. This demystifies what Go's `os.Write` does at the hardware level and builds intuition for why syscall overhead exists.

Interview framing: "What happens between a Go program calling `fmt.Println` and characters appearing on a terminal?" The complete answer traces: `fmt.Println` calls `os.File.Write`, which calls the `write` syscall via `syscall.Write`, which transitions to ring 0 via the `SYSCALL` instruction, which invokes the kernel's `sys_write` handler, which calls the terminal driver's write function, which writes to the TTY buffer, which the terminal emulator reads via a file descriptor. Candidates who can trace this chain demonstrate kernel-level systems understanding.

### Senior @ FAANG: Kernel Internals as a Staff Engineer's Mental Model

At the staff level, kernel internals knowledge is not a trivia exercise but a first-principles tool for diagnosing production systems that exhibit behavior that higher-level abstractions do not explain. When a Go service exhibits periodic latency spikes every 10 minutes with no application-level explanation, the root cause is often the kernel: the GC triggering `mmap` calls that contend with concurrent page faults, the kernel's dirty page writeback thundering herd, or the CPU frequency governor dropping frequency during idle periods between request spikes. Diagnosing these requires reading kernel tracing output (`perf trace`, `ftrace`), not application metrics.

The OS-in-Go chapter's framing of Go's limitations (GC, runtime, no freestanding mode) is the foundation for understanding the tradeoffs in Go's runtime design. Go's GC requires scanning all live pointers, which requires the runtime to know the layout of every stack frame (via the `pclntab` data structure). The runtime has stop-the-world GC pauses (now very short, typically sub-millisecond, but nonzero). These are design decisions that make Go unsuitable for hard real-time kernels but acceptable for soft real-time applications. Staff engineers communicate these tradeoffs clearly when their organization considers using Go for latency-sensitive infrastructure.

The security implications of ring 0 code are the most consequential kernel concept for a FAANG systems engineer. Any code running in ring 0 (kernel modules, eBPF programs before the verifier review, device drivers) can access any physical memory address, disable interrupts, and modify page tables. This is why the eBPF verifier exists: it is the gate that prevents ring 0 code from having the expressive power to cause catastrophic damage. Understanding this boundary makes the eBPF verifier's constraints comprehensible as safety requirements, not arbitrary limitations, and informs the design of any system that extends kernel behavior.

---
