## 102M.6 User Space, Ring 3, and System Calls

The boundary between kernel and user programs is what separates a toy OS from a real one. Until you have user space, everything runs in ring 0 with full hardware access and everything can crash the machine. Once you have user space, a bug in a user program is contained and the kernel keeps running.

go-dav-os takes the first step: a task runner that loads a tiny assembly program, switches to ring 3, runs the program, and re-enters the kernel through a `syscall` instruction. This section walks through the shape of that transition. The Medium tutorials do not cover this, and the go-dav-os source is the best reference.

### Rings and Privilege Levels

x86 defines four privilege levels (ring 0 through ring 3) but only two matter in practice:

- **Ring 0** (kernel): can execute any instruction, access any memory, do any I/O.
- **Ring 3** (user): cannot execute privileged instructions, cannot access kernel memory, cannot do I/O directly.

The CPU enforces the boundary at the page table level (the User/Supervisor bit) and at the segment level (the RPL field of CS). A user program that tries to execute `hlt` or `outb` or access a supervisor page gets a protection fault, which the kernel handles.

### The User-Space Code Segment

To run a user program, you need a GDT with at least four segment descriptors:

| Index | Selector | Purpose |
|-------|----------|---------|
| 0 | 0x00 | Null |
| 1 | 0x08 | Kernel code (ring 0) |
| 2 | 0x10 | Kernel data (ring 0) |
| 3 | 0x18 | User code (ring 3) |
| 4 | 0x20 | User data (ring 3) |

The user selectors have the RPL bits set: `0x18 | 3 = 0x1B` is what you actually load into `cs` when entering ring 3. Getting this right takes care because the CPU rejects invalid transitions with no helpful diagnostic, just a triple fault.

### Loading a User Program

In go-dav-os, a user program is a flat binary: the raw bytes of an assembly file's `.text` section, with no ELF header. The task runner reads the file from the filesystem, copies it into user-accessible memory (a page marked User and Executable in the page tables), and jumps to it with the right ring-3 stack.

The critical assembly sequence:

```asm
# enter_user_mode.s
# Arguments:
#   rdi = user entry point
#   rsi = user stack top

.global enter_user_mode
enter_user_mode:
    # Set up the IRETQ stack frame manually.
    # IRETQ pops: RIP, CS, RFLAGS, RSP, SS.
    push $0x23          # SS = user data selector (0x20 | 3)
    push %rsi           # user RSP
    pushfq              # RFLAGS
    orq $0x200, (%rsp)  # set IF (enable interrupts in user mode)
    push $0x1B          # CS = user code selector (0x18 | 3)
    push %rdi           # user RIP (entry point)
    iretq               # atomic transition to ring 3
```

`iretq` is the magic instruction. It pops five values off the stack (RIP, CS, RFLAGS, RSP, SS) and performs a privilege-level change if the new CS has a lower privilege than the current one. The CPU atomically switches to user mode, loads the new stack, and jumps to the new RIP. There is no "partially in ring 3" state.

### Back to the Kernel: The `syscall` Instruction

Once the user program is running, it cannot do anything useful without the kernel's help. It needs a way to print a character, exit, or read input. The mechanism is a **system call**.

x86-64 has a dedicated `syscall` instruction that is fast (no GDT lookup, no stack switch by CPU) and designed specifically for ring-3 to ring-0 transitions. Before a user program can call it, the kernel configures four MSRs (Model-Specific Registers):

- **IA32_STAR** (0xC000_0081): holds the CS/SS selectors used during `syscall` (kernel) and `sysret` (user).
- **IA32_LSTAR** (0xC000_0082): the RIP the CPU jumps to when `syscall` fires.
- **IA32_FMASK** (0xC000_0084): which RFLAGS bits are cleared on entry (usually IF to disable interrupts).
- **IA32_EFER** (0xC000_0080): set bit 0 (SCE) to enable `syscall` at all.

The entry point (the RIP in LSTAR) is your syscall dispatcher:

```asm
.global syscall_entry
syscall_entry:
    # rax = syscall number
    # rdi, rsi, rdx, r10, r8, r9 = arguments (System V AMD64 calling convention, slightly)
    # rcx = return address (the user's RIP before syscall)
    # r11 = saved RFLAGS

    # Save user context. Minimum: save rcx and r11 (needed for sysret).
    push %rcx
    push %r11

    # Switch to kernel stack (per-CPU, saved in TSS or a GS-relative location).
    # ... implementation specific ...

    call dispatch_syscall   # Go function

    pop %r11
    pop %rcx
    sysretq                 # atomic transition back to ring 3
```

On the Go side, `dispatch_syscall` is a switch:

```go
package kernel

//export dispatch_syscall
func DispatchSyscall(num uint64, a0, a1, a2 uint64) uint64 {
    switch num {
    case SYS_write:
        return syscallWrite(a0, a1, a2)
    case SYS_exit:
        syscallExit(a0)
        return 0
    case SYS_read:
        return syscallRead(a0, a1, a2)
    default:
        return uint64(ErrNoSys)
    }
}
```

### A Minimal User Program

The go-dav-os `run hello` command loads a small assembly binary that looks like:

```asm
.intel_syntax noprefix
.global _start

_start:
    mov rax, 1              # SYS_write
    mov rdi, 1              # fd = stdout
    lea rsi, [rip + msg]    # buf
    mov rdx, 13             # len
    syscall

    mov rax, 60             # SYS_exit
    xor rdi, rdi            # status = 0
    syscall

msg: .ascii "hello, user!\n"
```

When the user types `run hello`, the kernel:

1. Reads `hello` from the filesystem.
2. Allocates user-mode pages for code and stack.
3. Copies the binary into the code page.
4. Sets up the IRETQ frame and jumps to the entry point.
5. When the user calls `syscall`, control returns through the dispatcher.
6. `SYS_exit` calls back into the task runner, which cleans up the user-mode pages and returns to the shell.

The first time this works, it is indistinguishable from magic. You typed a command, your kernel loaded a user program, the user program printed output through your kernel's syscall interface, and then gracefully exited back to your shell.

### What Goes Wrong

- **TLB state after switching address spaces.** If the user program has its own PML4, switching back to the kernel's requires reloading CR3 and flushing the TLB.
- **Red zone.** x86-64 System V reserves 128 bytes below rsp for leaf-function use. The kernel entry code must either use `-mno-red-zone` (what we set in Section 102M.2) or avoid clobbering that region.
- **Stack alignment.** SysV AMD64 requires 16-byte stack alignment at the call instruction. Off-by-8 bugs cause weird crashes in any Go code that touches SSE registers.
- **Interrupt during syscall.** If an interrupt fires while the kernel syscall entry is mid-flight, you need to be sure the stack frame is consistent. Usually you disable interrupts until the kernel stack is selected.

### Pitfalls

- **Running Go GC in a kernel.** You do not have it. Any allocation inside the syscall path must be arena-style or explicit.
- **Linear address overlap.** Kernel and user share the virtual address space in most OSes. You map the kernel into every user address space at a fixed high range (like Linux's 0xFFFF_8000_00000000+) and protect it with the Supervisor bit.
- **Signal delivery, fork, exec.** None of these exist in go-dav-os. Adding them is an entire research direction.

### Senior-Track Observation

Tracing Sections 102M.2 through 102M.6 establishes a clear mental model for what a Go service's syscall path looks like on Linux: an `iretq`-style entry from user to kernel, a dispatcher in C, a kernel-mode handler that does I/O and returns, and a `sysret` back. Replacing the go-dav-os kernel with the Linux kernel is a scale question, not a concept question. That intuition is the single most valuable thing this chapter gives you for day-to-day Go engineering.

### What You Have After This Section

- The kernel boots, has a shell, has paging, has a filesystem, and can run ring-3 user programs.
- You understand the CPU-level privilege model, the `iretq` transition, and the `syscall`/`sysret` pair.
- You have a mental map of where Go runtime calls end up at the CPU level.

### Junior → FAANG: System Calls as the Go Runtime's Kernel Interface

Every Go program that interacts with the outside world (reading files, accepting network connections, acquiring locks via futex) crosses the user-kernel boundary via system calls. The toy OS's `SYSCALL`/`SYSRET` implementation is the hardware mechanism that Go's `syscall` package uses every time it calls `runtime.entersyscall`. Understanding the mechanism makes Go's syscall overhead concrete: approximately 100-300 ns per syscall on modern hardware with Spectre/Meltdown mitigations, rising to 500-700 ns on systems with strict KPTI (kernel page-table isolation) enabled.

The Linux syscall ABI for amd64 is the contract that Go's assembly stubs implement: syscall number in `rax`, arguments in `rdi, rsi, rdx, r10, r8, r9`, return value in `rax`. When you look at Go's `syscall/asm_linux_amd64.s`, you see exactly this register layout. Knowing the ABI helps when debugging with `strace` (which intercepts syscalls at exactly this boundary) and when reading Go runtime source code.

Go's `runtime.entersyscall` and `runtime.exitsyscall` are the scheduler hooks around every syscall. When a goroutine makes a blocking syscall, `entersyscall` decouples the goroutine from its OS thread (M) so the scheduler can reuse the thread for other goroutines. When the syscall returns, `exitsyscall` tries to re-acquire a processor (P) for the goroutine. If no P is available, the goroutine is parked and the OS thread may be returned to the thread pool. This mechanism is what allows Go to handle millions of concurrent connections with far fewer OS threads than connections, and understanding it makes the GOMAXPROCS and goroutine scheduler behavior comprehensible.

### Senior @ FAANG: Syscall Architecture and Security Implications at Scale

The syscall interface's security implications are the highest-stakes concern for systems engineers at FAANG. Every syscall is a potential attack vector: a bug in the kernel's syscall handler can allow a user-space program to escalate privileges, corrupt kernel memory, or bypass security boundaries. This is why seccomp exists: it filters the syscall interface to only the subset a specific workload needs, reducing the attack surface proportionally. The toy OS syscall implementation makes concrete why seccomp filters are effective: they run before the kernel dispatches to the handler, so a filtered syscall never reaches the vulnerable code path.

System call overhead is a performance concern for I/O-intensive Go services. A service that makes 1 million syscalls per second (a Go HTTP server with short-lived connections may easily reach this rate) spends 100-300 ms per second on syscall overhead alone. The mitigations are: batch syscalls where possible (using `writev` instead of multiple `write` calls, using `sendmsg` instead of `send` + `sendto`), use io_uring for high-throughput I/O (amortizing syscall cost across many operations), and tune GOMAXPROCS to minimize thread migration (which adds IPI cost to the syscall path).

The `vDSO` (virtual dynamically linked Shared Object) is the kernel's optimization for frequently called, read-only syscalls like `clock_gettime` and `gettimeofday`. The kernel maps a small shared library into every process's address space that implements these syscalls entirely in user space, reading from a kernel-maintained memory region (the vvar page). Go's `time.Now()` uses the vDSO on Linux, which is why it is much faster than a full syscall (approximately 10-30 ns instead of 100-300 ns). Staff engineers who understand the vDSO can explain why `time.Now()` performance varies across architectures (not all architectures have vDSO implementations for all functions) and why running Go inside a container with restricted vDSO access can cause performance degradation.

---

---
