## 07. CPU Scheduling and Context Switching

### The Scheduler's Job

The scheduler decides which task runs next and for how long. On a single core, only one task runs at any moment. The scheduler's goal is to share that core fairly and efficiently across all runnable tasks, while meeting latency requirements for interactive work and throughput requirements for batch work.

On a multicore system, the scheduler has N cores to distribute tasks across. This introduces the additional problems of load balancing (all cores should be busy if there is work to do) and cache affinity (a task running on the same core it ran on before will find its data still in L1/L2 cache).

---

### Cooperative vs Preemptive Scheduling

**Cooperative scheduling** relies on tasks to voluntarily yield the CPU. The current task runs until it explicitly calls a yield function or performs a blocking operation. If a task never yields, it owns the CPU forever. Early operating systems used cooperative scheduling. Early versions of the Go scheduler used cooperative scheduling within the runtime.

**Preemptive scheduling** uses the hardware timer to forcibly interrupt running tasks. When the timer fires, the kernel runs regardless of what user code is doing. The scheduler can switch to another task without the current task's cooperation. Modern OS schedulers are preemptive. Go added preemptive goroutine scheduling in 1.14 via signals.

The problem with purely cooperative scheduling is clear: one misbehaving task can starve all others. A tight loop with no yield points owns the CPU until the process ends or crashes.

---

### Round-Robin and Time Slices

The simplest preemptive scheduling algorithm is round-robin:

1. Maintain a ready queue of runnable tasks
2. Pick the first task, run it for one time slice (typically 1-100ms)
3. When the time slice expires, move the task to the back of the ready queue
4. Pick the next task

Every task gets a turn. No task starves. This works well when tasks are similar in resource requirements.

Linux's scheduler (CFS. Completely Fair Scheduler) is more sophisticated. It tracks how much CPU time each task has consumed and always schedules the task that has had the least CPU time proportional to its weight (priority). The time slice is not fixed, it is recalculated based on the number of runnable tasks and their weights.

---

### Context Switching in Detail

A context switch is the CPU saving the current task's state and loading another task's state. The saved state must be complete enough that the task can resume exactly where it left off.

What must be saved:
- All general-purpose registers
- The program counter (where to resume)
- The flags register (condition codes from the last ALU operation)
- The stack pointer
- Floating-point and SIMD registers (if in use)
- Control registers relevant to the task (segment registers, etc.)

On x86-64, a full context switch saves 168 bytes of registers plus floating-point state (up to 512 bytes with AVX-512 state). The kernel saves this into the PCB. Loading the next task restores from its PCB.

Additionally, the kernel must switch the page table (CR3 register on x86) when switching between processes (not threads). Switching the page table invalidates the TLB (Translation Lookaside Buffer, the cache for address translations), which causes the next round of memory accesses to take longer until the TLB warms up again.

Context switches between threads in the same process do not require a page table switch. This is one reason threads are cheaper to context-switch than processes.

---

### Hardware-Assisted Context Switching

The problem with naive context switching is the chicken-and-egg situation: to save the program counter to memory, you need to use a register as a scratch space. But using that register overwrites the value you need to save.

Two hardware solutions:

**Duplicate register sets:** Some CPUs (like the original Z80) have two sets of registers. The CPU switches which set is active. User code uses set A. Interrupt handlers use set B. Switching between them is a single instruction.

**Task State Segment (TSS):** On x86, when an interrupt or syscall occurs, the CPU automatically saves certain registers to a pre-configured memory region called the Task State Segment before jumping to the handler. This gives the handler a usable stack and preserved state without needing to use any register to bootstrap the save.

Modern x86-64 uses the TSS for the kernel stack pointer. When a privilege transition occurs, the CPU loads the kernel stack pointer from the TSS and then the handler can use the stack to save everything else.

---

### The Cost of a Context Switch

Context switching is not free. Costs include:

- **Direct cost:** Saving and restoring registers, switching page tables, TLB flush (100-1000 nanoseconds)
- **Indirect cost:** Cache pollution, the new task's working set may not be in cache. The first memory accesses after a switch are slower.
- **TLB miss cost:** After a page table switch, the TLB must be repopulated. Each miss requires a page table walk (multiple memory accesses).

For comparison, a function call within the same process takes 1-10 nanoseconds. A context switch costs 1-10 microseconds. A goroutine switch within the Go runtime costs ~100 nanoseconds (no kernel mode transition, no page table switch, smaller register set).

This cost is why Go's M:N scheduler exists. Most goroutine switches happen within the runtime without entering the kernel, at a fraction of the cost of OS context switches.

---

### Sleep and the Sleeping Queue

When a task calls `sleep()`, it does not sit in a tight loop checking the clock (that would waste CPU). Instead:

1. The task makes the `nanosleep` syscall
2. The kernel puts the task into a sleep queue sorted by wakeup time
3. The task's state changes to Blocked
4. The scheduler picks another task from the ready queue and runs it
5. When the hardware timer fires and the wakeup time has passed, the kernel moves the sleeping task back to the ready queue

The hardware timer is reused for both preemption and sleep wakeups. The kernel programs the timer to fire at the next needed wakeup time, checks which sleeping tasks need waking on each tick, and wakes them.

The sleep duration is a minimum, not a guarantee. After the sleep expires, the task enters the ready queue and waits for the scheduler to pick it. If the system is busy, it may wait much longer than the requested duration.

```go
// This sleeps for AT LEAST 100ms, possibly much longer under load
time.Sleep(100 * time.Millisecond)
```

---

### Work-Stealing in Go's Scheduler

The Go scheduler uses a work-stealing algorithm across OS threads:

Each OS thread (M) has a local run queue of goroutines. When a thread's local queue is empty, it steals goroutines from other threads' local queues. This balances load automatically without a global lock on every goroutine creation.

The scheduler has three levels:
- **G (goroutine):** The unit of work
- **M (machine/OS thread):** The OS thread that runs goroutines
- **P (processor):** A context holding a run queue, currently bound to one M

A goroutine that blocks on a syscall causes its M to detach from its P. Another M (possibly a new one from a thread pool) takes over the P and continues running goroutines. When the syscall returns, the original M tries to reacquire a P. If no P is available, the goroutine goes into the global run queue.

This design means that long-running syscalls do not starve other goroutines, a new thread takes over the P while the syscall blocks.

---

### Observing Scheduling

On Linux, you can observe context switches with:

```bash
# Context switches per process
cat /proc/<pid>/status | grep ctxt

# System-wide with vmstat
vmstat 1
# cs column = context switches per second
```

In Go, you can observe goroutine scheduling with the scheduler trace:

```bash
GODEBUG=schedtrace=1000 ./yourprogram
# Prints scheduler state every 1000ms
```

Output shows the number of goroutines, idle threads, and goroutines on each P's run queue.

---

**Watch:** [Concurrency Fundamentals. Time-Sharing, Preemption, and Scheduling](https://www.youtube.com/watch?v=3X93PnKRNUo)

**Watch:** [How sleep() Works. The Hardware Timer and Sleeping Queue](https://www.youtube.com/watch?v=e5g8eYKEhMw)

**Watch:** [Hardware-Assisted Context Switching](https://www.youtube.com/watch?v=1HHeyUVz43k)
