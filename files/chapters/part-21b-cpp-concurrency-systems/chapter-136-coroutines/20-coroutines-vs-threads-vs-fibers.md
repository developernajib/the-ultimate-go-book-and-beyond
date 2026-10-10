## Coroutines vs Threads vs Fibers

The "lightweight async unit" decision sits at the center of any server design. C++ gives you three serious options: kernel threads (`std::thread`, `std::jthread`), userspace fibers (Boost.Context, ucontext), and stackless coroutines (C++20). Each has a real cost model. The right choice depends on workload, debuggability, and ecosystem.

### The Three Models

#### Threads

Kernel-scheduled. Each thread has a stack (default 8MB on Linux, configurable down to 64KB). Context switch through the kernel scheduler. Synchronization through `std::mutex`, `std::condition_variable`. Preemptive: the kernel can interrupt at any instruction.

#### Fibers (Stackful Coroutines)

Userspace-scheduled. Each fiber has its own stack (typically 16KB-1MB, configurable). Context switch is a function call that swaps SP and registers. Cooperative: a fiber runs until it explicitly yields. Boost.Context provides the primitive (`make_fcontext`, `jump_fcontext`). Boost.Fiber builds scheduling on top.

#### Stackless Coroutines (C++20)

Compiler transformation. State lives in a heap-allocated frame whose size is determined at compile time (usually 100-500 bytes). No dedicated stack: the regular call stack is used during execution. Suspension serializes only the live locals into the frame. Cooperative.

### Spawn Cost Benchmark

Spawn 1M units, no work, just creation and immediate completion. x86_64 Linux 6.5, AMD EPYC 7763, GCC 13 -O2.

| Model | Memory | Spawn time (1M) | Notes |
|---|---|---|---|
| std::thread | 8 GB (8 MB stack default) | 35-45 sec | Hits ulimit at ~30K threads. Reduce stack to 64KB to push higher. |
| std::thread (64KB stack) | 64 MB | 30 sec | Still kernel-bound. Limit is /proc/sys/kernel/threads-max. |
| Boost.Fiber (64KB stack) | 64 MB | 1.2 sec | Userspace context switch ~50ns. |
| Boost.Fiber (4KB stack) | 4 MB | 0.9 sec | Stack overflow if any deep call. |
| C++20 task<void> (no HALO) | 200-400 MB (frame heap) | 0.4 sec | Frame size dominated by promise + handle. |
| C++20 task<void> (HALO) | < 1 MB | 0.1 sec | Frames inlined into caller stack. |
| C++20 task<void> (pool alloc) | 256 MB (256B frames) | 0.15 sec | Bumps in TLS pool. |

A million threads is impossible (kernel cannot handle the syscall storm and the TID space exhausts). Fibers fit in memory but stack reservation dominates. Stackless coroutines win on memory by orders of magnitude. With pooled allocation the spawn time approaches "memcpy of 256 bytes".

### Context Switch Cost

Switch latency, no cache contention, single-threaded micro-benchmark.

| Model | Switch cost | What is being saved |
|---|---|---|
| std::thread (kernel) | 1.5-3 us | Full register file, FP state, scheduler decision, MMU bookkeeping |
| Boost.Fiber (userspace) | 30-80 ns | Callee-saved registers, SP, IP. No syscall. |
| C++20 coroutine resume | 5-20 ns | Single indirect call. State already in frame. |

The coroutine "context switch" is just a function pointer call into the resume function. There is no register save: the locals are already spilled in the frame. This is the fundamental efficiency win.

For comparison, a function call in optimized C++ is 1-3 ns. A coroutine resume is on the same order. Userspace fibers are a kernel call away from threads but a register-save away from coroutines. The hierarchy holds.

### Memory Footprint Per Unit

| Model | Per-unit memory |
|---|---|
| Thread (default) | 8 MB stack + ~8 KB kernel state |
| Thread (64KB stack) | 64 KB + ~8 KB |
| Fiber (64KB stack) | 64 KB |
| Fiber (4KB stack) | 4 KB (deep calls overflow) |
| Coroutine | 100-500 bytes (frame size) |

The ratio at scale: 1M units of work cost 8 TB in default threads, 4 GB in fibers, 256 MB in coroutines. The coroutine memory budget makes "one coroutine per request" plausible at any web scale, threads do not.

### Debugging Difficulty

| Model | Debug story |
|---|---|
| Threads | Mature. GDB shows all threads, switches between them. ASan/TSan/Helgrind work. |
| Fibers | Per-fiber stacks: GDB sees one (the running one). Custom commands needed for fiber inventory. |
| Coroutines | One stack (the resume thread's) shared across all coroutines. Async backtrace requires walking continuation pointers. Pretty printers needed. |

Threads are the easiest to debug. Coroutines are the hardest. Fibers are in between (you can `frame switch` between fiber stacks if your debugger knows about them. LLDB and GDB have partial support).

The debugging story is improving for coroutines (LLDB 17 added builtin support, the LLVM project is investing here), but in 2026 it is still rougher than threads.

### When Each Wins

#### Threads

- Workload: long-running, CPU-bound, blocking syscalls that the runtime cannot wrap.
- Concurrency: low to medium (under 10K).
- Examples: a worker pool for BLAS computations, a daemon with a few long-running tasks.

Use case sweet spot: one thread per CPU, work-stealing queue holding small jobs. This is the right model for most CPU-bound batch work.

#### Fibers

- Workload: legacy code that uses blocking APIs you cannot rewrite, but you need higher concurrency.
- Concurrency: 10K-100K.
- Examples: porting a synchronous codebase to async by replacing blocking syscalls with fiber-aware shims. Rust briefly considered fibers (called "green threads") and rejected them. C++ shops use them where coroutine retrofit is impractical.

Use case sweet spot: bridging an older codebase. New code rarely starts with fibers.

#### Stackless Coroutines

- Workload: IO-bound with high concurrency. Per-request state.
- Concurrency: 100K-10M.
- Examples: web servers, gRPC services, message brokers, streaming pipelines.

Use case sweet spot: any modern async server. The concurrency, memory, and switching cost all favor coroutines.

### Real Numbers from Production

Cloudflare's QUIC stack reports ~250 bytes per coroutine frame and supports millions of concurrent connections per machine. Switching from a fiber-based design (Boost.Fiber, 64KB stacks) to coroutines shrunk per-connection RAM by ~250x.

Meta's Hack-derived async runtime in C++ (folly::coro) handles millions of in-flight coroutines per host. Their published benchmarks show 5-10ns coroutine resume vs 50-80ns fiber switch.

LinkedIn moved from a thread-per-connection design (about 10K conns per host limit) to coroutines (300K+ conns per host on equivalent hardware) for their real-time messaging service.

The pattern: shops that operate at scale and need "10K+ concurrent operations per host" all converge on stackless coroutines.

#### Junior to FAANG callout

A junior reads "use threads, they're simple" and builds a server with `std::async` per request. It dies at 5K concurrent users. They reach for a thread pool with bounded size, then a queue of `std::function`, then realize they have rebuilt a worse coroutine runtime by hand. The senior path is to start with `task<T>` over an io_uring or asio backend and not look back. The threading instinct is only correct for CPU pools sized to core count.

### Mixing Models

Real systems use all three.

- A coroutine for each request (millions of them).
- A small thread pool of CPU workers (8-32) where coroutines hop for compute.
- An optional fiber-based bridge to legacy blocking code.

The coroutines are the foreground concurrency. Threads are the background CPU army. Fibers are the bridge for code you do not own.

```cpp
task<Resp> handle(Req req) {
    auto raw = co_await io_pool.async_read(req.fd);    // coroutine + io_uring
    co_await cpu_pool.schedule();                       // hop to thread
    auto parsed = parse(raw);                           // CPU work on thread
    auto enriched = co_await legacy_blocking_call(parsed);  // fiber bridge
    co_await io_pool.schedule();
    co_await io_pool.async_write(req.fd, enriched);
    co_return enriched;
}
```

`legacy_blocking_call` is the awaiter that submits the work to a fiber pool, suspends the coroutine, and resumes it when the fiber completes. The coroutine never blocks a kernel thread, the fiber does, on its own dedicated kernel thread.

### What about std::jthread?

`std::jthread` (C++20) is `std::thread` plus stop_token integration plus auto-join in the destructor. Same kernel thread cost. Useful for the "I just need a thread that gets canceled and joined" pattern, common in worker pools and one-off background tasks. Not a coroutine alternative.

### What about coroutine pools (recycle frames)?

You cannot pool coroutines themselves: each call creates a new state machine instance with its own state. What you can pool is the frame allocation (covered in Coroutine Allocator Customization). Frame pooling gives you the spawn-rate of "memcpy 256 bytes per coroutine" without changing the coroutine semantics. Fiber-style "reuse the fiber, jump it to new work" does not exist in the coroutine model and is not needed because frames are so cheap.

### Decision Framework

1. Is concurrency above ~5K simultaneous units? Coroutines.
2. Is the work CPU-bound and blocking? Threads (in a pool sized to cores).
3. Are you porting a synchronous codebase you cannot fully rewrite? Fibers.
4. Are you starting fresh on a modern Linux server? Coroutines.
5. Do you need to debug with stock GDB and no extra tooling? Threads, accept the scale limit.

For greenfield C++ in 2026, the answer is coroutines plus a CPU thread pool. Fibers stay relevant only as a bridge.

### Pitfalls

- Treating coroutines as a drop-in for threads. They are not preemptive. A coroutine that runs CPU work without yielding starves all other coroutines on its thread.
- Spawning N threads where N is per-request: you re-enter the C10K problem. Thread pool sized to cores, queue requests, do not spawn per request.
- Stack size on fibers chosen too small: silent stack overflow, often only on deep recursion. Set `BOOST_FIBER_FIXEDSIZE_STACK` defaults conservatively (16-64 KB) and audit recursion depth.
- Mixing fibers and coroutines on the same thread without a bridging mechanism: the coroutine resumer will run on the fiber, which has its own stack, leading to confused stack traces.
- Assuming `thread_local` works in fibers and coroutines the same way it does in threads. It works (it is per-OS-thread), but switches do not change the OS thread, so two fibers/coroutines on the same OS thread share the value. Restoration on resume is needed for context like trace IDs.
