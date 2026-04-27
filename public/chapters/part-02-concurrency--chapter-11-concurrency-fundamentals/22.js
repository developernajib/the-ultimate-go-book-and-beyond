export default `# 22: Hardware Foundations of Go Concurrency

Go's concurrency model (goroutines, channels, the M:N scheduler) is not magic. Each design choice exists because of something real at the hardware or OS level. This section ties the hardware concepts from Chapter 168 directly to the Go concurrency mechanisms you use daily.

---

## Why Goroutines Are Cheap: Stack and Register Cost

An OS thread requires a stack. On Linux, the default stack is 8 MB per thread. On Windows, 1 MB. The kernel allocates this at thread creation. 10,000 OS threads = 10-80 GB of virtual memory committed to stacks. Even if the stacks are mostly empty, the kernel must track all of it.

A goroutine starts with a 2-8 KB stack. The Go runtime manages goroutine stacks in the Go heap. When a goroutine needs more stack space, the runtime copies the goroutine's stack to a larger allocation. There is no per-goroutine OS kernel allocation.

A context switch between OS threads saves the full x86-64 register file: 16 general-purpose registers, the program counter, the flags register, floating-point state, and SIMD registers. This is 168 to 512+ bytes, and it requires entering kernel mode: a ring transition.

A goroutine switch within the Go runtime saves a much smaller set: the goroutine's stack pointer, program counter, and a few key registers. No kernel mode transition. No TLB flush. The total cost is roughly 100-200 nanoseconds vs 1-10 microseconds for an OS context switch.

This is why you can write \`go f()\` for every incoming HTTP request without second-guessing yourself. With OS threads, spawning one per request is an anti-pattern past a few hundred concurrent connections. With goroutines, tens of thousands of concurrent goroutines is routine.

---

## GOMAXPROCS and Physical Cores

\`GOMAXPROCS\` controls how many OS threads the Go scheduler keeps active simultaneously. It defaults to the number of logical CPUs reported by the OS.

For CPU-bound work, setting \`GOMAXPROCS\` beyond the number of physical cores provides no benefit. You have N physical execution units. Adding more OS threads adds scheduling overhead without adding computation. In some cases (especially with SMT/hyperthreading), setting \`GOMAXPROCS\` to the number of physical cores improves throughput for CPU-intensive workloads by reducing cache contention between SMT siblings.

For I/O-bound work, \`GOMAXPROCS\` matters less because goroutines doing I/O are blocked, not running on an OS thread. A goroutine waiting for a network response has no OS thread. When the response arrives, the Go runtime wakes the goroutine and schedules it on an available P (processor in the Go scheduler's M:N model).

\`\`\`go
import "runtime"

// Check current setting
fmt.Println(runtime.GOMAXPROCS(0))  // 0 = query without changing

// Set to physical cores only (if on a hyperthreaded system)
runtime.GOMAXPROCS(runtime.NumCPU() / 2)
\`\`\`

---

## The Go Scheduler: M, P, G

The Go scheduler uses three entities:

- **G (goroutine):** The unit of work. Holds the goroutine's stack, program counter, and state.
- **M (machine/OS thread):** The OS thread. Executes Go code.
- **P (processor):** A context that holds a local run queue of goroutines. Each M must hold a P to run Go code.

The number of Ps equals \`GOMAXPROCS\`. There are always exactly that many Ps. There can be more Ms (OS threads) when goroutines block on syscalls, but only \`GOMAXPROCS\` Ps.

When a goroutine makes a blocking syscall:
1. The M detaches from its P (P stays, M blocks in the kernel)
2. Another M (from a pool or newly created) takes the P
3. Other goroutines continue running on the new M+P pair
4. When the syscall returns, the original M tries to reacquire a P
5. If no P is available, the goroutine goes to the global run queue and the M sleeps

This prevents one goroutine's long syscall from blocking all other goroutines. It is the Go answer to the classic problem of threads blocking on I/O.

---

## Goroutine Preemption and the Hardware Timer

Before Go 1.14, goroutines were only preempted at function call boundaries. A tight loop with no function calls would own the OS thread forever, starving other goroutines on that P. This was a known footgun for CPU-intensive goroutines.

\`\`\`go
// Before Go 1.14, this starved other goroutines on the same P
go func() {
    for {
        // tight loop, no function calls, no preemption points
    }
}()
\`\`\`

Go 1.14 added asynchronous preemption via UNIX signals. The Go runtime sends SIGURG to OS threads that have been running a goroutine for more than 10ms without a preemption point. The signal handler saves the goroutine's state and lets the scheduler preempt it.

This works because UNIX signals are delivered to a thread by the kernel, effectively the same mechanism as hardware interrupts at the OS level. The hardware timer fires, the kernel interrupts the thread, and the signal handler gets to run.

---

## Channels and Memory Ordering

A channel send happens-before the corresponding channel receive returns. This is a guarantee in Go's memory model. It means that all writes done by the goroutine before sending to a channel are visible to the goroutine that receives from that channel.

This guarantee is implemented using memory barriers. The channel send operation includes a store barrier. The receive includes a load barrier. Between them, the Go runtime ensures the memory ordering the model promises.

Understanding this matters when you structure concurrent code:

\`\`\`go
var data []int  // written before send, read after receive

go func() {
    data = computeData()  // write
    ch <- struct{}{}      // send (includes store barrier)
}()

<-ch             // receive (includes load barrier)
// data is fully visible here — this is guaranteed
process(data)
\`\`\`

Without the channel (or a mutex, or an atomic), the read of \`data\` would be a data race. The channel provides the happens-before relationship that makes it safe.

---

## sync.Mutex and the Futex

\`sync.Mutex\` is implemented in Go using atomic compare-and-swap operations and the OS's \`futex\` (fast userspace mutex) syscall on Linux.

The fast path (uncontended mutex):
1. \`Lock()\` does a CAS: if state is 0 (unlocked), set to 1 (locked) atomically
2. CAS succeeds with no syscall
3. \`Unlock()\` atomically stores 0 back to state

The slow path (contended mutex):
1. CAS fails because another goroutine holds the lock
2. The goroutine spins briefly (attempts to acquire a few more times without blocking)
3. If still contended, calls \`futex_wait\` syscall: kernel puts goroutine to sleep
4. \`Unlock()\` calls \`futex_wake\` syscall: kernel wakes one sleeping goroutine

The fast path costs ~10 nanoseconds. The slow path costs ~1000 nanoseconds (the syscall and context switch). Uncontended mutexes are effectively free relative to the work they protect. Highly contended mutexes serialize work and become bottlenecks.

Tools to detect contention:

\`\`\`bash
# Go mutex profile
go test -mutexprofile=mutex.prof ./...
go tool pprof mutex.prof
\`\`\`

---

## sync/atomic: Direct Hardware Instructions

\`sync/atomic\` operations map to single hardware atomic instructions on supported ISAs:

| Go operation | x86-64 instruction | ARM64 instruction |
|---|---|---|
| \`atomic.AddInt64\` | \`LOCK XADD\` | \`LDADD\` |
| \`atomic.LoadInt64\` | \`MOV\` with fence | \`LDAR\` |
| \`atomic.StoreInt64\` | \`MOV\` with fence | \`STLR\` |
| \`atomic.CompareAndSwapInt64\` | \`LOCK CMPXCHG\` | \`LDAXR / STLXR\` |

On ARM64, \`LDAR\` (Load-Acquire) includes a load barrier. \`STLR\` (Store-Release) includes a store barrier. These instructions enforce the ordering required by Go's memory model without a separate fence instruction.

On x86-64, the \`LOCK\` prefix makes the instruction atomic with respect to all other CPUs. It also acts as a full memory barrier.

This is why \`sync/atomic\` is correct across architectures without the programmer writing architecture-specific barrier code.

---

## The Race Detector at the Hardware Level

Go's race detector instruments every memory read and write at compile time, adding calls to the ThreadSanitizer (TSan) runtime. TSan uses shadow memory: for every 8 bytes of program memory, it maintains 32 bytes of shadow memory tracking which thread last accessed it and when.

On every memory access, the instrumented code checks whether the previous access was from a different goroutine and whether the two accesses are ordered by a happens-before relationship (channel, mutex, atomic). If they are not ordered and at least one is a write, it reports a race.

The race detector does not prevent races. It detects them at runtime in code that actually executes. Testing under the race detector does not guarantee a race-free program. It guarantees that races are detected in paths that were executed during the test. Good test coverage under \`-race\` is valuable, but it is not a substitute for correct concurrent design.

---

## Practical Memory Layout of a Go Process

\`\`\`
Virtual address space of a Go process on Linux amd64:

High addresses
┌──────────────────────────────────────────┐
│ Kernel space (not accessible)            │
├──────────────────────────────────────────┤
│ Goroutine stacks (allocated from heap)   │
│ (each goroutine stack is in the Go heap) │
├──────────────────────────────────────────┤
│ Go heap                                  │
│  - Object allocations                    │
│  - Goroutine stacks                      │
│  - Channel buffers                       │
│  - Goroutine G structs                   │
├──────────────────────────────────────────┤
│ OS thread stacks (one per M)             │
│ (fixed 8MB each, for OS-level Go threads)│
├──────────────────────────────────────────┤
│ Go runtime data (Ps, Ms, global queues)  │
├──────────────────────────────────────────┤
│ Go binary (code, data, BSS)              │
└──────────────────────────────────────────┘
Low addresses
\`\`\`

Goroutine stacks live in the Go heap, not in the OS's stack region. This is what allows them to be dynamic and to start small.

---

## Summary: Go Design Decisions Traced to Hardware

| Go feature | Hardware/OS reason |
|---|---|
| Goroutines start at 2-8 KB stack | OS thread stacks are 1-8 MB; starting small saves memory |
| M:N scheduler (not 1:1) | OS context switches cost 1-10 µs; Go scheduler costs ~100 ns |
| GOMAXPROCS defaults to logical CPUs | Each P needs an OS thread to make progress |
| Async preemption via SIGURG | Hardware timer drives OS preemption; Go mirrors this at runtime level |
| Channel ops include memory barriers | ARM and other weak-ordering ISAs require explicit barriers |
| sync.Mutex uses futex slow path | Blocking in kernel avoids busy-waiting; fast path avoids kernel at all |
| sync/atomic maps to single ISA instructions | CAS and load-acquire/store-release are hardware primitives |
| Race detector uses shadow memory | No hardware support for tracking access pairs; TSan emulates it |

The hardware is not an implementation detail you can ignore. It is the reason Go's concurrency model is designed the way it is. When you understand what a context switch costs, why memory ordering matters on ARM, and what a futex does, you can reason about the performance and correctness of your concurrent Go programs with confidence.
`;
