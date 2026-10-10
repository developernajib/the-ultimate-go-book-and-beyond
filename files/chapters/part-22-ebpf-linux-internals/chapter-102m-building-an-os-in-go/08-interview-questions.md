## 102M.8 Interview Questions

These questions show up in senior systems-engineering interviews at FAANG-equivalent companies when your resume mentions kernel-level work, OS internals, or systems programming in Go. The answer shape matters: explain the CPU-level mechanism first, then name the Go-level or Linux-level abstraction that hides it.

### Q1: What is the difference between a thread and a goroutine, from the kernel's perspective?

**What FAANG expects:** a precise, multi-layer answer covering scheduling entity, stack, context switch, and who schedules what.

**Answer:** An OS thread is a kernel-scheduled entity with its own stack (typically 1 to 8 MB), a fixed identity the kernel tracks in a task_struct, and a context switch that costs a few microseconds because it involves a ring transition, a register save, and TLB and cache effects. A goroutine is a user-space scheduling entity managed by Go's runtime on top of a smaller pool of OS threads (M:N scheduling). Each goroutine starts with a small stack (2 KB) that grows on demand, and a context switch between goroutines costs hundreds of nanoseconds because it is a user-mode function call with no ring transition. The kernel sees only the OS threads Go asks for. It never sees goroutines. Building even a toy kernel (as in this chapter) makes the distinction concrete: the kernel schedules threads because that is what the hardware supports. The language runtime schedules goroutines because that is what the ergonomics demand.

**Follow-ups:**
- When does a goroutine require the kernel to become involved?
- What does GOMAXPROCS actually control?
- Why do blocking syscalls still cost you a full OS thread?

### Q2: Walk me through what happens from the moment you power on the machine to the moment `main()` runs in a Go program.

**What FAANG expects:** a structured tour covering BIOS/UEFI, bootloader, kernel load, kernel init, user-mode setup, dynamic linker (if any), runtime init, then `main()`.

**Answer:** Power-on triggers the BIOS or UEFI firmware, which runs POST, initializes hardware, and loads a bootloader from disk. On a GRUB-based system, the bootloader loads the kernel image into memory, validates headers (Multiboot2 for Linux-compatible kernels), and jumps to the kernel entry point in 32-bit protected mode. The kernel switches to 64-bit long mode, sets up paging, initializes the IDT and GDT, brings up APs (other CPU cores), mounts the root filesystem, runs early userspace (initramfs), and eventually executes `init` (systemd on most Linux distros). Your Go binary is spawned as a child process of a shell or service manager. The kernel loads the ELF binary, maps its segments, and jumps to the entry point. For a Go binary, that is `_rt0_amd64_linux`, which calls `runtime.rt0_go`, which initializes the Go runtime (memory allocator, GC, goroutine scheduler, the main M and P), creates goroutine 1 for `main`, and finally calls `main.main`. Every layer in that chain is what this chapter replaced with a hobby kernel so you can see the mechanics first-hand.

**Follow-ups:**
- Which part of that chain is different on a container?
- What is the minimum kernel a Go binary needs to run?
- How does `go build -ldflags="-s -w"` change what the kernel loads?

### Q3: Why does x86-64 have four privilege rings but Linux only uses two?

**What FAANG expects:** the CPU-level mechanism (CPL, DPL, RPL), the historical rationale (Multics), and the pragmatic reason Linux collapsed to two.

**Answer:** x86 inherited four rings from Intel's 1982 286 design, which was inspired by Multics. The CPU enforces the boundary through the current privilege level (CPL, low two bits of CS), the descriptor privilege level (DPL, in each segment descriptor), and the requestor privilege level (RPL) on segment selectors. In theory, rings 1 and 2 could host drivers or middleware between user and kernel. In practice, Linux (and every other modern OS) uses only ring 0 (kernel) and ring 3 (user), because the complexity of a four-ring model never paid for itself. Modern hypervisors (VT-x, AMD-V) added a layer below ring 0 for the virtualization host, so the effective hierarchy is host, kernel, user, and the two middle rings are essentially dead. Writing a hobby kernel as in this chapter, you never bother with ring 1 or 2. The `iretq` machinery for switching between ring 0 and ring 3 is the only path worth implementing.

**Follow-ups:**
- How is a hypervisor's "ring -1" implemented in hardware?
- What is SMEP and SMAP, and why do modern kernels enable them?
- Can a user program see the GDT?

### Q4: When you call `write(fd, buf, len)` from Go, trace the path from Go source to disk block.

**What FAANG expects:** a bottom-up narrative that names the Go runtime entry, the syscall instruction, the kernel VFS layer, the filesystem, the page cache, the block layer, the driver, and the controller.

**Answer:** In Go, `os.File.Write` calls `syscall.Write`, which calls `runtime.entersyscall`, then the `SYSCALL` instruction with RAX=1 (on Linux amd64). The CPU transitions to ring 0 at the address stored in IA32_LSTAR, which is Linux's `entry_SYSCALL_64`. That entry saves the user context, switches to the kernel stack, and dispatches through `sys_call_table` to `ksys_write`. `ksys_write` resolves the file descriptor to a `struct file`, which has a `file_operations` vtable. For a regular file on ext4, that vtable's `write_iter` points to `ext4_file_write_iter`. ext4 checks permissions, updates metadata, and writes data into the page cache (not the disk, yet). On `fsync` or under memory pressure, the dirty pages are flushed to the block layer, which queues a `bio` request. The block layer orders requests (elevator, deadline, or none with SSDs) and passes them to the block driver (virtio-blk on a VM, nvme on a real NVMe SSD). The driver programs the device's DMA registers, the device reads memory and writes storage, and an interrupt signals completion, which bubbles back up the chain. The same mechanics at ring-transition level are what Sections 102M.5 and 102M.6 of this chapter implemented in miniature.

**Follow-ups:**
- Where can a `write` silently block for seconds?
- What does `O_DIRECT` change about this path?
- How does `io_uring` shortcut parts of it?

### Q5: You are asked to implement a page fault handler. What bug classes does it need to handle?

**What FAANG expects:** demand paging, copy-on-write, stack growth, invalid access (SIGSEGV), and the difference between a "normal" fault and a "real" one.

**Answer:** A page fault fires whenever the CPU walks the page tables and finds a not-present entry or a permission violation. The kernel's handler reads CR2 (the faulting address), decodes the error code (present/not-present, read/write, user/kernel, instruction fetch), and decides what to do. Legitimate faults include demand paging (the page is backed by a file but not yet read in, so the kernel reads it and returns), copy-on-write (the page is shared read-only after fork, the handler allocates a new page, copies, and returns), stack growth (the fault is just below the current stack and inside the growable region, so the kernel extends the stack), and memory-mapped file access (lazy I/O into mmap regions). Illegitimate faults are the signal-generating cases: writing to a read-only page (SIGSEGV), executing from a non-executable page (SIGSEGV + DEP message), accessing an unmapped address (SIGSEGV). A handler must distinguish these, must not itself fault (so it has to be resident in memory and on a separate stack), and must leave the faulting instruction's RIP on the kernel stack for restart on return. Everything in Chapter 102M.4's paging section is prerequisite understanding for writing this handler.

**Follow-ups:**
- How does Linux's `mmap` fit into this?
- What is the cost of a minor vs major page fault?
- Why does a kernel-mode page fault sometimes kill the whole system?

### Q6: Ring 3 cannot execute `hlt`. How does a user-mode program wait for I/O efficiently?

**What FAANG expects:** the `epoll`, `io_uring`, and `select` alternatives, plus the syscall cost story.

**Answer:** User-mode programs delegate waiting to the kernel through syscalls like `epoll_wait`, `select`, `poll`, or `io_uring_enter`. Each of these puts the calling thread into a kernel-maintained wait queue and allows the scheduler to run other threads or idle the CPU. When the expected event fires (data arriving on a socket, timer expiring, file descriptor ready), the kernel wakes the waiter. The user program never executes `hlt` itself. It asks the kernel to wait for it. Each syscall costs ~100 ns plus the scheduler's wake-up latency, which is why high-throughput servers batch events (`epoll_wait` returns many ready FDs in one call) or use `io_uring` (submits many I/Os and reaps many completions in one syscall). The go-dav-os task runner does not implement any of this yet. Its user programs run to completion without blocking, and adding proper waiting semantics is a multi-week project on top of the current design.

**Follow-ups:**
- What is the difference between `select` and `epoll` at scale?
- How does `io_uring` avoid syscalls for individual operations?
- Why do modern Linux systems prefer `io_uring` over `epoll` for disk I/O?

### Q7: You have to convince a skeptical staff engineer that writing part of a kernel in Go is a defensible idea. Make the case.

**What FAANG expects:** intellectual honesty. The easy answer is "you shouldn't," and a strong candidate acknowledges that before making the narrower case.

**Answer:** Writing a production kernel in Go is a bad idea, because Go assumes a host OS, carries a GC and scheduler, and has no track record in freestanding environments. Writing a hobby or educational kernel in Go is a defensible idea, because the subset of the language that works freestanding is clean, the compile-edit-test loop is fast, and the type system catches whole classes of bugs that C versions of the same kernel would ship. The most honest narrow case is educational: Go-plus-assembly is a better teaching language than C for the subset of people who already know Go, because they can focus on OS concepts (interrupts, paging, rings, scheduling) rather than on language concepts. Projects like [go-dav-os](https://github.com/dmarro89/go-dav-os) demonstrate the approach works in practice, and the code is short enough that a new reader can internalize it. For actual production OS work, pick C or Rust, know why, and move on.

**Follow-ups:**
- What is the one technical limitation of Go you would hit first in a larger Go-kernel project?
- How would you argue for or against Rust vs C for the same project?
- Are there any production embedded Go projects that would change your answer?

### Junior → FAANG: Interview Question Preparation for Kernel-Level Roles

The interview questions in this section require a specific answer format: CPU-level mechanism first, then the abstraction. When answering Q1 (goroutine vs. thread), do not start with "a goroutine is lighter weight." Start with: "An OS thread is a kernel-managed execution context with its own stack, task struct, and scheduler entry. A goroutine is a user-space execution context managed by Go's runtime scheduler. The runtime multiplexes goroutines onto OS threads using a work-stealing M:N scheduler, where M goroutines run on N OS threads." Then add the practical consequence: "This is why you can have millions of goroutines but only GOMAXPROCS OS threads running Go code simultaneously."

Practice the answer to Q3 (page tables) until the three-level answer is automatic: purpose (virtual-to-physical address translation), structure (PML4/PDP/PD/PT on x86-64, or in Go's address space, the arena-based heap), and consequence (TLB cache reduces lookup overhead, TLB misses add 100-300 cycles to memory access). The consequence is what differentiates a hardware-knowledgeable answer from a book-knowledge answer: you understand why page tables matter for performance, not just what they are.

The "embedded Go" question is a filter for candidates who have thought about Go's applicability beyond web services. The correct answer acknowledges tinygo as the only credible path to truly embedded Go (no garbage collector runtime, compiles to ARM Cortex-M), and notes that mainline Go with a Linux kernel is viable for embedded Linux targets where the RAM budget allows the runtime's overhead (typically 10-50 MB). Examples include single-board computers (Raspberry Pi, BeagleBone) running embedded Linux, where Go is a productive choice for application code.

### Senior @ FAANG: Bar-Raiser Signals for OS Internals Interviews

Bar-raiser interviewers for systems roles probe whether your kernel knowledge is theoretical or earned through implementation. The tell-tale sign of theoretical knowledge is correct but surface-level answers ("goroutines are user-space threads") without the implementation details that only come from building or deeply reading the runtime. The tell-tale sign of implementation knowledge is specific detail: "The Go runtime's goroutine stack starts at 2 KB and grows via `morestack`, which is injected by the compiler at function entry points when the stack guard page is touched. The growth doubles the stack, copies the frames, and updates all pointers. This is why goroutines are cheaper to create than OS threads (2 KB vs. 1-8 MB default stack size) but why very deep recursion in Go can still cause stack overflows."

The preemption question is a bar-raiser filter for Go runtime knowledge. Go 1.14 introduced asynchronous preemption via signals (`SIGURG`): the runtime sends `SIGURG` to OS threads running long-running goroutines, and the signal handler saves the CPU state and yields to the scheduler. Before Go 1.14, preemption was cooperative (only at function call sites), which caused latency spikes when goroutines ran tight loops without function calls. Knowing this history and the implementation mechanism demonstrates that you have read the Go runtime internals, not just the documentation.

System design questions that draw on OS internals knowledge: "Design a Go service that must handle 1 million concurrent persistent WebSocket connections." The OS-level concerns are: file descriptor limits (`ulimit -n`, `/proc/sys/fs/file-max`), socket buffer memory (each socket has a 4-128 KB kernel buffer, 1M sockets = 4-128 GB kernel memory), and epoll scalability (single epoll instance scales to millions of file descriptors, but `epoll_wait` latency grows with the number of ready events). A candidate who can quantify these constraints and explain which are tunable (buffer sizes via `sysctl net.core.rmem_max`) versus which are architectural limits (file descriptor count per process) is demonstrating the hardware-up reasoning that OS internals study builds.

---

---
