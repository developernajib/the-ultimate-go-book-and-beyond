## 04. CPU Privilege Rings: Kernel Mode and User Mode

### Why Privilege Levels Exist

If application code could execute any instruction and access any memory address, a buggy program could corrupt the kernel, overwrite another process's memory, or talk directly to hardware devices. The CPU prevents this with hardware-enforced privilege levels called rings.

x86 defines four rings (0 through 3). In practice, most operating systems use two:

- **Ring 0 (kernel mode):** The kernel runs here. All instructions are available. The CPU can modify the page table, configure interrupt handlers, access I/O ports, and adjust the privilege level itself.
- **Ring 3 (user mode):** Application code runs here. Privileged instructions cause a fault. The process cannot directly access hardware or other processes' memory.

The current privilege level is tracked in a hardware register (the CS register on x86 contains the Current Privilege Level in its low two bits). The CPU checks this register on every privileged instruction attempt.

---

### The Mode Bit in Practice

You can think of the privilege level as a mode bit. When the bit indicates kernel mode, the CPU runs with full access. When it indicates user mode, the CPU enforces restrictions.

The mode bit cannot be changed by user code. Only specific hardware-controlled transitions can change it. This is the hardware guarantee that makes the OS's security model possible.

When your application starts, the CPU is in user mode. The kernel set it there before handing control to your process.

---

### System Calls: Crossing the Boundary

When your application needs a service that requires privilege, reading a file, allocating memory, creating a socket, it performs a system call. A system call is a controlled entry point into the kernel.

On x86-64 Linux, system calls use the `SYSCALL` instruction:

1. The application loads the system call number into `rax` and arguments into `rdi`, `rsi`, `rdx`, `r10`, `r8`, `r9`
2. `SYSCALL` saves the return address and flags, switches to ring 0, and jumps to the kernel's system call handler
3. The kernel validates the arguments, performs the operation, and puts the return value into `rax`
4. `SYSRET` switches back to ring 3 and returns to the instruction after the `SYSCALL`

The kernel validates every argument. If user space passes a kernel memory address as a destination buffer for a read, the kernel rejects it. The hardware cannot protect arbitrary bad arguments, only the software can check those.

In Go, most syscalls go through the `syscall` or `golang.org/x/sys/unix` package. The Go runtime wraps them and handles the calling convention. When you call `os.Open()`, it eventually becomes a `read` or `openat` syscall.

---

### Interrupts

Interrupts are signals that tell the CPU to stop what it is doing and handle an event. There are two kinds:

**Hardware interrupts** come from devices. A keyboard press sends an interrupt. A network packet arriving sends an interrupt. A disk I/O completing sends an interrupt. The CPU finishes the current instruction, saves its state, switches to kernel mode, and jumps to the interrupt handler registered for that interrupt number.

**Software interrupts** (also called traps or exceptions) are raised by the CPU itself when something requires kernel attention. A divide-by-zero causes a trap. Accessing an invalid memory address causes a page fault trap. On older x86 systems, the `INT 0x80` instruction was used for system calls (it raises software interrupt 0x80).

The Interrupt Descriptor Table (IDT) maps interrupt numbers to handler addresses. The kernel installs this table at boot. User code cannot modify it.

---

### The Hardware Timer Interrupt

The hardware timer is a critical component for preemptive multitasking. Without it, a process that never yields would own the CPU forever.

The timer is a hardware component that fires an interrupt at a configurable frequency (typically 100-1000 Hz on Linux, controlled by the HZ kernel configuration). Every time this interrupt fires:

1. The CPU is in whatever ring it was in, kernel or user
2. The interrupt fires and the CPU switches to ring 0
3. The kernel's timer interrupt handler runs
4. The scheduler decides whether to continue the current process or switch to another
5. If switching, the scheduler saves the current process state and restores another

This mechanism is preemption. The current process has no say. The timer fires, the kernel runs, the scheduler decides, and execution might resume in a completely different process. From the preempted process's perspective, the CPU just ran normally and then continued (its state was fully saved and restored).

Go adopted asynchronous preemption in Go 1.14. Before that, goroutines were only preempted at function call boundaries (cooperative within the Go runtime). The runtime now uses UNIX signals to preempt goroutines that are running tight loops with no function calls.

---

### Drivers and Kernel Mode Code

Device drivers run in ring 0. This is why a buggy driver can crash the entire OS. The driver has full hardware access. A write to the wrong memory address corrupts kernel data structures with no protection.

Some operating systems move drivers to user space (microkernels). The driver runs in ring 3 and communicates with the kernel via message passing. A crashing driver cannot take down the kernel. The tradeoff is performance: every hardware access requires a context switch to the kernel and back.

Linux uses a monolithic kernel with all drivers in ring 0. The performance is better, and system stability depends on driver quality.

**CrowdStrike incident (2024):** A faulty update to a kernel-mode security driver caused a BSOD on millions of Windows machines worldwide. This is the direct consequence of drivers running in ring 0, a fault in the driver brings down the entire OS. User-mode drivers would have prevented the crash, but Windows has been slow to move endpoint security software out of kernel mode.

---

### Context: What Switches on a Syscall vs an Interrupt

A syscall is a deliberate, synchronous transition. The process intends to call into the kernel.

An interrupt is asynchronous. The CPU is executing user code and the interrupt fires in the middle of an instruction cycle.

Both transition to ring 0. Both save some CPU state. But an interrupt saves more: the full interrupted instruction context must be preserved so the interrupted code can resume transparently. A syscall only needs to save what the kernel might clobber.

On x86-64, `SYSCALL` saves the return address and flags into `rcx` and `r11`. The kernel saves and restores additional registers as needed. Hardware interrupt handlers use a separate interrupt stack (the IST mechanism) to avoid corrupting the current stack.

---

**Watch:** [CPU Privilege Rings and the Mode Bit](https://www.youtube.com/watch?v=H4SDPLiUnv4)
