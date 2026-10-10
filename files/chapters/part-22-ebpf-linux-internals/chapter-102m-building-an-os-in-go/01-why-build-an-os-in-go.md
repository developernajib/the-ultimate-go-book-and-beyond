## 102M.1 Why Build an OS in Go?

Writing a kernel is a canonical "learn the stack" project. For decades, the default choice was C, because C is what Unix was written in and because C's ABI is what CPUs understand. More recently, Rust has become a strong second choice (the Linux kernel started accepting Rust drivers in 2022, and hobby Rust kernels like Redox and Theseus are serious efforts).

Go was never on that list. Until enthusiasts started putting it there anyway.

### The Problem With Go for Kernels

Go assumes a host OS exists. The standard library calls into `syscall` for everything from `os.Open` to `time.Now` to `runtime.ReadMemStats`. The runtime assumes a preemptible scheduler with threads it can park and wake. The GC assumes memory it can manage. The goroutine stack-growth mechanism assumes a host that can give it more pages.

On bare metal, none of that exists. You have the CPU, a few megabytes of memory mapped by the bootloader, and whatever you can make work with assembly.

### What's Left if You Strip Go Down

Surprisingly, quite a lot.

- **The type system.** Structs, interfaces, pointers, slices (if you implement an allocator), type safety at compile time.
- **Functions, control flow, switches, for-loops.** All the imperative constructs work without a runtime.
- **The `unsafe` package.** Enough to cast a memory-mapped address into a Go struct and read VGA registers.
- **`gccgo`.** The GCC front-end for Go, which supports freestanding output (no Go runtime linked) via `-fno-go-runtime` and similar flags.
- **Go assembly syntax, or standard `.s` files for architecture-specific code.**

What you lose, and must implement yourself:
- Any form of dynamic allocation (`make`, `new`, heap escape) until you wire up a page allocator.
- Goroutines, channels, the scheduler.
- The GC.
- `fmt`, `os`, `net`, `io`, and essentially all of the standard library.
- Panic recovery.
- Map and slice growth semantics (slices with fixed backing arrays still work, growing them requires an allocator).

You end up writing a subset of Go that feels more like freestanding C with better types and nicer syntax.

### Why Bother When Rust and C Exist?

Three honest reasons.

**1. Familiarity.** A Go engineer already knows Go. Writing a kernel in C means learning C's toolchain, its undefined behavior minefield, and its error-handling conventions simultaneously. Rust has a steep learning curve even for experienced systems programmers. Go-with-assembly lets you focus on OS concepts (paging, interrupts, scheduling) rather than language concepts.

**2. Readability.** Go kernel code is short. The go-dav-os codebase is under 10k lines and a new reader can understand a subsystem in an afternoon. A comparable C kernel (for example, the classic xv6 at 8k lines) takes longer because C patterns are less self-describing.

**3. Educational value.** The point of a hobby OS is learning, not shipping. Any language that lets you iterate fast is a net win. `gccgo` compiles the kernel in seconds. QEMU boots it in under a second. You see the change on screen. That feedback loop is priceless.

### The Trade-offs, Named Honestly

- **No ecosystem.** There are no Go drivers for network cards, no Go filesystem libraries you can drop in, no Go USB stacks. Every subsystem is bespoke.
- **Assembly is non-negotiable.** You will write or paste assembly for the boot stub, for CPU control registers, for I/O port operations, and for any syscall glue.
- **Tooling is rough.** `gccgo` for freestanding is not a mainstream path. Expect weird linker errors, undocumented flag combinations, and Docker-based toolchains because pinning `gccgo` on your laptop is painful.
- **No future in production.** Nobody is going to ship a commercial OS in Go. The effort does not compound into a career the way a similar Rust effort might.

If those trade-offs are fine because you are doing this for fun or for learning, read on.

### What go-dav-os Demonstrates

The go-dav-os project is notable because it took a "build an OS in Go" tutorial (originally targeting a 32-bit architecture) and pushed it into interesting territory:

- 64-bit long mode from the start
- Multiboot2 boot with a proper memory map
- An IDT with working interrupt handlers
- A PS/2 keyboard driver
- A bitmap page frame allocator
- Both an in-memory filesystem and a FAT16 driver (for persistence across reboots)
- A debug shell with real commands
- Ring 3 user-space support: a task runner that loads small assembly programs and enters them via `syscall`

As of v0.3.0 (February 2026), the project has 182 stars, 20 forks, and a small but active contributor community. It is not a production OS. It is a proof that Go-plus-assembly can take you further than you might expect, and a reference you can read to understand how each layer fits together.

The next sections walk through the core ideas, rewritten and expanded from the companion tutorial series by the project's author, Davide Marro.

### Junior → FAANG: Positioning OS Development Knowledge in Your Career

Building an OS in Go is not a prerequisite for a FAANG application, but understanding why someone would do it (and what they learn from it) is a differentiator. The learning value is precision: when you implement a page frame allocator, you understand exactly what `malloc` does at the hardware level. When you implement interrupt handling, you understand why goroutine preemption points exist and why calling a non-preemptible assembly function inside Go can cause scheduler latency. These insights come from the kernel-building exercise and pay dividends in every subsequent systems debugging session.

The language comparison in this section (C vs. Rust vs. Go for kernel work) is an interview topic. The interviewer version is: "Would you choose Go for a new embedded systems project?" The correct answer is nuanced: Go is appropriate for embedded systems where a Linux kernel is present and the target has sufficient RAM (the Go runtime requires at least 2-4 MB). Go is inappropriate for bare-metal systems without an OS (no freestanding support), hard real-time systems (GC pauses), or memory-constrained targets below 1 MB RAM. Knowing these constraints and articulating them clearly is the junior-level competence signal.

First-job habit derived from OS work: when you encounter a surprising performance behavior in a Go program, first hypothesize at the hardware level. Is it a cache miss pattern? A TLB invalidation? A context switch rate? Then confirm with `perf stat` or `perf record`. The OS development experience trains this mental model of "hardware up" reasoning rather than "framework down" reasoning.

### Senior @ FAANG: Language Choice for Systems Infrastructure at Scale

At the senior level, the "why Go for OS work" question generalizes to "what are Go's fitness criteria for different classes of systems software?" Go is well-suited for: orchestration systems (Kubernetes is written in Go), observability infrastructure (Prometheus, Grafana Alloy, Vector are written in Go), eBPF control planes (the Go runtime overhead is acceptable because the control plane is not on the hot path), and network proxies where the bottleneck is I/O rather than CPU.

Go is poorly suited for: hot-path data plane code that cannot tolerate GC pauses (use C or Rust for the XDP or DPDK data plane), memory-constrained embedded targets below the runtime's minimum footprint, and hard real-time systems where deterministic latency is a safety requirement. Staff engineers communicate these fitness boundaries in ADRs when the organization considers rewriting existing C or C++ infrastructure in Go. The ADR must address: what is the GC pause budget for this system, does Go meet it? What is the memory overhead budget, does Go meet it? If yes to both, Go is a reasonable choice and the developer productivity benefits are real.

The Rust comparison is increasingly relevant as Linux kernel Rust support matures. For systems that require memory safety but cannot tolerate GC (kernel drivers, networking stacks, TLS libraries), Rust is the correct language choice. Staff engineers at FAANG who have evaluated both can articulate the tradeoff: Go has better developer productivity for high-level systems (faster compilation, simpler concurrency), Rust has better safety guarantees for low-level systems (no GC, compile-time memory safety, no data races by construction). Knowing when each applies and being able to defend the choice with benchmarks and safety analysis is L6-level technical leadership.

---

---
