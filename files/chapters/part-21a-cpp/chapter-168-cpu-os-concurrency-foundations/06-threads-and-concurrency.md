## 06. Threads and Concurrency

### Concurrency vs Parallelism

These terms are related but not the same.

**Concurrency** is about dealing with multiple things at once. Multiple tasks are in progress simultaneously, but they may not be running at the same physical moment. A single-core CPU can be concurrent: the OS switches rapidly between processes, giving each a turn. From the outside, they appear to run together. Inside the CPU, only one instruction executes at any clock cycle.

**Parallelism** is about doing multiple things at the same physical moment. This requires multiple execution units, multiple CPU cores, or multiple CPUs. Two goroutines running in parallel are executing simultaneously on two different cores.

You can have concurrency without parallelism (time-sharing on one core). You can have parallelism without useful concurrency (multiple cores all computing the same thing with no coordination). Good concurrent design scales to parallelism when cores are available.

---

### Processes vs Threads

A process is a unit of isolation. It has its own address space, file descriptor table, and security context. Creating a process is expensive because the OS must set up all of these.

A thread is a unit of execution. Threads within the same process share the same address space, the same file descriptor table, and the same security context. Each thread has its own:
- Stack
- Registers (register file snapshot, saved during context switches)
- Thread-local storage

Creating a thread is cheaper than creating a process because the address space already exists. The OS only needs to allocate a stack and a PCB entry for the new thread.

The shared address space is both the strength and the weakness of threads. Sharing means threads can communicate via shared memory with no syscall overhead. It also means one thread can corrupt another thread's stack, read its private data, or interfere with its memory allocations if the code is buggy.

---

### What the OS Sees

The kernel scheduler does not distinguish between processes and threads in its fundamental scheduling algorithm. It schedules tasks. On Linux, both processes and threads are represented as `task_struct` instances. A thread is a task that shares its address space with other tasks (the `CLONE_VM` flag to `clone()`).

When you create a thread in Go (which the runtime does via `clone()` on Linux), the kernel creates a new task that shares the memory map of the process. The scheduler puts it in the ready queue alongside all other tasks.

---

### Simultaneous Multithreading (SMT / Hyperthreading)

A physical CPU core normally executes one instruction stream. Simultaneous Multithreading (SMT), called Hyperthreading by Intel, duplicates parts of the CPU to allow two instruction streams to share one physical core.

Each SMT thread (logical processor) has its own register file and program counter. They share the execution units (ALU, FPU, load/store units) and cache. When one logical processor is stalled waiting for memory, the other can use the execution units.

A CPU with 8 physical cores and 2-way SMT appears to the OS as 16 logical processors. The OS scheduler treats them as 16 independent CPUs. The performance benefit of SMT depends on the workload: compute-intensive work that saturates the execution units gains little. I/O-bound or memory-bound work that leaves execution units idle gains more.

For Go programs: `GOMAXPROCS` defaults to the number of logical processors. On a system with 8 cores and SMT, `GOMAXPROCS` defaults to 16. Setting `GOMAXPROCS` to 8 (physical cores only) can sometimes improve throughput for CPU-bound workloads because it reduces cache contention between SMT siblings.

---

### The Illusion of Concurrency on One Core

Before multicore CPUs were common, operating systems still provided concurrency through time-sharing. The hardware timer fires every 10-100ms, the scheduler runs, and the CPU switches to a different process. From the user's perspective, multiple programs run simultaneously. Inside the CPU, they take turns.

The fetch-decode-execute cycle does not know about this. It just runs the current process's instructions until the timer fires. The kernel saves the complete register state, loads another process's registers, and the cycle continues in the new context. Neither process can tell that this happened.

This mechanism works the same way today, even on multicore systems. Each core independently runs the fetch-decode-execute cycle. The OS scheduler distributes processes across cores and preempts them when their time slice expires.

---

### Data Parallelism vs Task Parallelism

Two approaches to using multiple cores:

**Data parallelism:** Divide a dataset into chunks and process each chunk on a separate core with the same operation. A map operation over a large slice can process different index ranges on different goroutines simultaneously.

```go
func parallelSum(nums []int) int {
    n := runtime.GOMAXPROCS(0)
    if n <= 0 {
        n = 1
    }
    chunks := (len(nums) + n - 1) / n
    sums := make([]int, n)
    var wg sync.WaitGroup
    for i := 0; i < n; i++ {
        // In Go 1.22+, loop variables are per-iteration scoped
        start := i * chunks
        end := start + chunks
        if end > len(nums) {
            end = len(nums)
        }
        if start >= len(nums) {
            break
        }
        wg.Add(1)
        go func(idx, s, e int) {
            defer wg.Done()
            for _, v := range nums[s:e] {
                sums[idx] += v
            }
        }(i, start, end)
    }
    wg.Wait()
    total := 0
    for _, s := range sums {
        total += s
    }
    return total
}
```

**Task parallelism:** Different goroutines perform different operations concurrently. An HTTP server handles each request in a separate goroutine. The requests are independent tasks, not chunks of one dataset.

---

### Thread Creation Cost and Go's M:N Model

Creating an OS thread allocates a kernel task_struct, allocates the thread stack (default 2-8 MB), and initializes thread-local storage. On Linux, this takes several microseconds and a few KB to MB of memory for the stack.

If you create 10,000 OS threads, you consume gigabytes of stack memory before the threads even do anything. The OS scheduler must manage 10,000 tasks. Context switching between them is expensive.

Go's goroutines avoid this by using an M:N scheduler: M goroutines are multiplexed onto N OS threads. Typical programs run with N equal to `GOMAXPROCS` (number of CPU cores). Goroutines start with 2-8 KB stacks that grow on demand.

The Go runtime's scheduler (not the OS scheduler) handles goroutine switching. Switching between goroutines on the same OS thread is cheaper than an OS context switch: the Go scheduler saves a smaller register set and does not need to enter kernel mode.

This is why you can have 100,000 goroutines in a Go program without issue. Each is a small Go-managed structure, not an OS thread.

---

### When More Threads Does Not Mean More Speed

Adding goroutines or threads does not automatically improve performance. Common mistakes:

1. **CPU-bound work with more goroutines than cores:** The extra goroutines compete for the same cores. Context switching overhead increases. Throughput stays flat or decreases.

2. **Excessive contention on shared state:** If all goroutines lock the same mutex, they serialize. You get the complexity of concurrency with none of the parallelism.

3. **Memory bandwidth saturation:** On many-core systems, all cores share memory bandwidth. Adding more cores can saturate the memory bus, and additional parallel work provides no benefit.

4. **NUMA effects:** On systems with multiple CPU sockets (Non-Uniform Memory Access), a core accessing memory attached to a different socket pays higher latency. Goroutines migrating between NUMA nodes can hurt performance.

The right number of goroutines for CPU-bound work is `GOMAXPROCS`. For I/O-bound work, you can have more because goroutines block on I/O and yield the OS thread to other goroutines.

---

**Watch:** [Threads on Multicore. Concurrency vs Parallelism](https://www.youtube.com/watch?v=5sw9XJokAqw)
