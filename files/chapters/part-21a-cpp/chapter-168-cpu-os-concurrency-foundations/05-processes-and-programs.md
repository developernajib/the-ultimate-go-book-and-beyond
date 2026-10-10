## 05. Processes and Programs

### A Program Is Not a Process

A program is a file on disk: an executable binary containing machine code, data sections, and metadata. It sits there doing nothing until something runs it.

A process is a running instance of a program. It has its own memory space, its own set of CPU registers, its own open file descriptors, its own security context. Multiple processes can run the same program simultaneously, each with its own address space and state, without interfering with each other.

When you type `ls` in a terminal, the shell creates a new process, loads the `ls` binary into it, and tells the CPU to start executing from the entry point. When `ls` finishes, the process exits and its resources are released.

---

### The Process Control Block (PCB)

The kernel tracks every process with a data structure called the Process Control Block (PCB), or task_struct in Linux's implementation. The PCB contains everything the kernel needs to manage and resume a process:

- **Process ID (PID):** Unique identifier
- **Process state:** Running, ready, blocked, zombie
- **CPU register values:** Saved when the process is not running (the complete register file snapshot)
- **Program counter:** Where execution resumes
- **Memory maps:** Which virtual addresses are valid and where they map in physical memory
- **Open file descriptors:** Table of open files, sockets, pipes
- **Signal handlers:** What code to run when signals arrive
- **Credentials:** UID, GID, effective UID (the security identity)
- **Resource limits:** Maximum stack size, maximum open files, CPU time limits
- **Parent PID:** Which process created this one

When the CPU switches from one process to another, the kernel saves the current process's register state into its PCB and loads the next process's register state from its PCB.

---

### Process States

A process is not always running. It cycles through states:

```
          ┌──────────────────────────────────────────────────────────┐
          │                                                          │
  [New]──>│ Ready ──scheduler──> Running ──exits──> [Terminated]     │
          │  ^                      │                                │
          │  │    preempted         │  blocks on I/O, sleep, lock    │
          │  └──────────────────────┤                                │
          │                        v                                 │
          │                     Blocked ──I/O done──> Ready          │
          └──────────────────────────────────────────────────────────┘
```

- **Ready:** Has everything it needs. Waiting for CPU time.
- **Running:** Currently executing on a CPU core.
- **Blocked:** Waiting for something external (I/O, a lock, a timer). Not scheduled while blocked.
- **Terminated:** Has exited but the PCB still exists until the parent calls `wait()`.

The distinction between Ready and Blocked is critical for understanding concurrency. A blocked process wastes no CPU time. The scheduler simply skips it until the thing it is waiting for completes.

---

### Process Address Space

Every process has its own virtual address space. On 64-bit Linux, the address space is 128 TB for user space. The process sees a private, flat array of addressable memory locations.

The address space is divided into regions:

```
High addresses
┌─────────────────────────────────┐
│         Kernel space            │  Not accessible from user mode
├─────────────────────────────────┤
│           Stack                 │  Grows downward; local variables, return addresses
│              ↓                  │
│         (unused gap)            │
│              ↑                  │
│           Heap                  │  Grows upward; dynamically allocated memory
├─────────────────────────────────┤
│    BSS (uninitialized data)     │  Global/static vars initialized to zero
├─────────────────────────────────┤
│    Data (initialized data)      │  Global/static vars with non-zero initial values
├─────────────────────────────────┤
│    Text (code)                  │  Executable instructions; read-only
└─────────────────────────────────┘
Low addresses (0x0000...)
```

Each region is backed by either physical RAM or disk (via memory-mapped files). The kernel's page table maps virtual addresses to physical frames. Two processes at virtual address `0x7fff...` are pointing at different physical memory.

---

### Isolation Is Hardware-Enforced

The separation between process address spaces is not just convention, it is enforced by the CPU's Memory Management Unit (MMU). Every memory access goes through the MMU, which translates the virtual address to a physical address using the current page table. If the virtual address is not mapped in the current process's page table, the MMU raises a page fault. The kernel's page fault handler either maps the page (if it is a valid mapping that was not yet loaded) or sends a segmentation fault signal to the process.

The kernel switches the page table pointer (CR3 register on x86) when switching between processes. After the switch, the same virtual address in the new process translates to a different physical address. The processes cannot see each other's memory.

---

### File Descriptors

A file descriptor (FD) is an integer that represents an open file, socket, pipe, or device. The kernel maintains a file descriptor table per process. When you open a file, the kernel allocates a new entry in the table and returns the index (the file descriptor number).

Standard file descriptors:
- 0: stdin
- 1: stdout
- 2: stderr

When a process forks, the child inherits copies of the parent's file descriptor table. Both processes have file descriptors pointing to the same underlying file descriptions in the kernel, so writing from one process affects what the other reads from the same FD.

---

### What Happens When a Process Exits

When a process calls `exit()` or returns from `main()`:
1. The C runtime calls destructors and `atexit` handlers
2. `exit()` makes the `exit` syscall
3. The kernel closes all file descriptors
4. The kernel releases all memory (unmaps the address space, frees physical frames)
5. The process enters zombie state: the PCB still exists but no code is running
6. The parent receives a SIGCHLD signal and calls `wait()` to collect the exit status
7. The kernel removes the PCB

A zombie process holds no resources except the PCB entry. It persists until the parent reads the exit status. If the parent exits without calling `wait()`, the zombie is adopted by init (PID 1), which calls `wait()` on its behalf.

---

### Go Processes

A Go program runs as a single process. Inside that process, the Go runtime creates multiple OS threads (controlled by `GOMAXPROCS`). Goroutines are scheduled onto these OS threads by the Go runtime's M:N scheduler. From the kernel's perspective, the Go process is one process with multiple threads. From Go's perspective, there are potentially thousands of goroutines mapped onto a small number of threads.

The address space layout of a Go process follows the same structure as any other process. The Go heap is in the heap region. Goroutine stacks are also allocated from the heap (since goroutines can have many stacks and they need to be able to grow). The Go runtime's global data sits in the data/BSS regions.

---

**Watch:** [A Program is NOT a Process](https://www.youtube.com/watch?v=7ge7u5VUSbE)
