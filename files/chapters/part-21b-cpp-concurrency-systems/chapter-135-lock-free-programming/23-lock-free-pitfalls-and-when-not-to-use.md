## Lock-Free Pitfalls and When Not to Use

Lock-free programming is the most over-applied technique in concurrent systems. The mythology says lock-free is faster than mutex-based code. Sometimes true, frequently false, often catastrophically false when the contention profile is wrong. This chapter catalogs the failure modes.

### Pitfall 1: Lock-Free Is Slower at Low Contention

A `std::mutex` on an uncontended lock costs about 25 ns to acquire and release on x86. A lock-free CAS costs 8-15 ns. Looks like a 2-3x win for lock-free.

Now add the cost of the algorithm. A Treiber stack pop:
- Load head: 4 ns
- Read head->next: 4 ns (one cache miss possible)
- CAS: 12 ns
- Memory reclamation overhead (HP protect, EBR pin): 8-25 ns

Total: 28-45 ns. A `std::stack` under `std::mutex` does:
- Mutex acquire: 25 ns
- Pop the back: 5 ns
- Mutex release: 5 ns

Total: 35 ns. The mutex-based code is competitive. Under low contention, the lock-free version is sometimes slower because the reclamation overhead dominates.

The lock-free win shows up under contention, where the mutex's parking and waking cost (futex syscall, kernel scheduler involvement) explodes to thousands of nanoseconds. At 50% lock holding probability, the mutex queue goes to 200-500 ns per op while the lock-free queue holds at 35-50 ns. The crossover is around 5-15 percent contention.

Implication: if your lock holding probability is below 5 percent, mutex-based is fine and simpler. Profile before optimizing.

### Pitfall 2: Priority Inversion Becomes Livelock

A mutex with priority inheritance handles priority inversion gracefully. The high-priority thread donates its priority to the lock holder, the holder finishes quickly, the high-priority thread proceeds.

A lock-free CAS loop has no such mechanism. The high-priority thread spins forever while a low-priority thread that performs the conflicting operations gets scheduled out. The spinning consumes the high-priority thread's quantum, the low-priority thread starves further, and the system livelocks.

In real-time systems with priority scheduling, lock-free is often worse than priority-inheriting mutexes. Audio kernels, RT-Linux configurations, and avionics use priority-inheriting locks (PI-mutexes) precisely because lock-free has no priority awareness.

The exception is wait-free, which by definition cannot livelock. But wait-free has its own costs (helping overhead, complex code).

### Pitfall 3: Backoff Policies Are Hard

Naive CAS retry: hammer the cache line until you win. This is catastrophic at high contention because every failed CAS invalidates every other thread's cached line. Throughput collapses below mutex-based performance.

Exponential backoff helps. Sleep for 2^attempts microseconds (capped). But the right cap depends on the workload: too short and you continue thrashing, too long and you starve under low contention.

```cpp
int backoff_us = 1;
while (!cas_succeeds()) {
    for (int i = 0; i < backoff_us * 100; ++i) cpu_relax();
    backoff_us = std::min(backoff_us * 2, 1024);
}
```

Choosing 1024 us as the cap is arbitrary. Too low and you over-spin under heavy contention. Too high and tail latency suffers. Tuning requires production traces.

Folly's `RWSpinLock` uses adaptive backoff that tracks recent contention and adjusts the cap dynamically. The implementation is 200 lines of careful code, much of it dedicated to handling backoff.

A junior engineer writes a CAS loop with no backoff, runs a low-contention benchmark, declares victory. In production at 16x the load, the same code wedges the system.

### Pitfall 4: Memory Reclamation Cost Is Often Underestimated

Books and papers describe lock-free algorithms as if memory reclamation is a footnote. It is not. Reclamation is half the algorithm.

Hazard pointers add 30-50 ns per protected access. EBR adds 10-20 ns per critical section. RCU adds the synchronize_rcu cost (microseconds to milliseconds) on the writer side. None of this appears in textbook benchmarks of "the algorithm itself".

A complete cost model:
- Lock-free op fast path: 30-40 ns
- Hazard protect overhead: 30-50 ns
- Scan amortized: 5-10 ns
- Total: 65-100 ns per op

Compare to a mutex-based equivalent at low contention (35 ns). The reclamation overhead alone makes lock-free 2-3x slower at low contention.

The right framing: lock-free buys you scalability, not latency. If you do not need to scale to 16+ threads, the latency cost of reclamation is wasted.

### Pitfall 5: Debugging Is an Order of Magnitude Harder

A mutex-based bug has clear symptoms: a deadlock, a race detected by TSan, a test that fails reproducibly. Single-step in gdb, find the offending line, fix it.

A lock-free bug:
- Manifests once in 10^9 operations.
- Disappears under TSan (the instrumentation changes timing).
- Disappears under gdb (the breakpoint changes timing).
- Disappears with `printf` (the I/O changes timing).
- Manifests on ARM but not x86.
- Manifests at 3 AM on Tuesday but not in QA.

Heisenbugs are the norm. The cost of debugging a single lock-free bug is often 10-50 engineer-hours. Multiply across the lifetime of the data structure.

The standard FAANG-internal advice is to have at least two senior engineers review every lock-free change. Companies that use lock-free heavily (Cloudflare, ScyllaDB, Jane Street) staff dedicated concurrent systems teams whose job is to maintain these structures.

### Pitfall 6: ABA Strikes Where You Did Not Expect

You wrote a lock-free queue, tested it, deployed it. Three months later it corrupts under high load. The bug: a counter you assumed was monotonic actually wraps around 2^32. The wrap exposes ABA on a tagged pointer that was supposed to be safe.

Or: your hazard pointer count was 2 per thread, sufficient for the original algorithm. A maintenance change added a third dereferenceable pointer in one operation. Now there is a window where a node is freed despite being in use.

ABA bugs are notoriously easy to introduce when modifying lock-free code. Every change to a lock-free structure must reanalyze ABA exposure. Senior engineers maintain checklists.

### Pitfall 7: False Sharing Steals Performance Silently

Two atomics on the same cache line. Each thread thinks it owns its line. Actually every modification on either invalidates both. Throughput halves or quarters.

Compilers do not detect this. TSan does not report it. The only signal is performance below expectations. Use `perf c2c` or VTune's HitM analysis to find it.

Cache lines are 64 bytes on most x86, 128 bytes on Apple Silicon, 256 bytes on some ARM server chips. Alignment requirements differ. A binary that runs on x86 may have hidden false sharing on ARM.

```cpp
// Bug: prod_idx and cons_idx share a cache line
struct Queue {
    std::atomic<size_t> prod_idx;
    std::atomic<size_t> cons_idx;
    // ...
};

// Fix: pad to cache line
struct Queue {
    alignas(64) std::atomic<size_t> prod_idx;
    alignas(64) std::atomic<size_t> cons_idx;
    // ...
};
```

`std::hardware_destructive_interference_size` (C++17) reports the cache line size for the build target. Use it instead of hardcoded 64.

### Pitfall 8: The Compiler Removes Your Code

Lock-free code uses inline assembly, atomics, and ordering subtleties the optimizer struggles with. A relaxed atomic load in a hot loop can be hoisted out of the loop entirely.

```cpp
while (!flag.load(std::memory_order_relaxed)) {
    // Spin
}
```

The compiler may legally rewrite this as:

```cpp
if (!flag.load(std::memory_order_relaxed)) {
    while (true) {}  // Infinite loop
}
```

Because relaxed ordering imposes no memory consistency, and from this thread's perspective the value of `flag` cannot change (there are no synchronizing operations in the loop body). The compiler proves the loop is dead and hoists.

The fix: use `acquire` ordering or insert `std::atomic_signal_fence(std::memory_order_seq_cst)` to prevent hoisting.

This is real. Bugs of exactly this kind have shipped in production from teams that do not deeply understand the memory model.

### Pitfall 9: The Hardware Lies

CAS instructions are not free. On x86 they take 20-40 cycles uncontended and 200-500 cycles under contention. On ARMv8 LL/SC pairs can fail spuriously, requiring retry loops in the implementation.

Memory fences cost. A `mfence` on x86 is around 25-50 cycles. A `dmb ish` on ARM is around 10-30 cycles. If your algorithm uses 5 fences per operation, you are paying 100-200 cycles in barrier overhead alone.

Cache coherence traffic kills throughput at scale. A single contended cache line saturates at around 50-100 Mops globally regardless of thread count. More threads only add latency.

The textbook claim "wait-free queue has O(1) per operation" obscures the constant factor. The constant is 50-200 cycles uncontended and unbounded under coherence saturation.

### When Lock-Free Is the Right Choice

After all the warnings, lock-free is sometimes correct. The criteria:

1. Contention is high (>15 percent of operations encounter another thread).
2. Latency tail (p99, p999) matters more than median.
3. The data structure is simple enough that bugs are rare or detectable (queue, stack, simple map).
4. You have the engineering bandwidth to maintain it.
5. You have profiled and confirmed the mutex-based version is the bottleneck.

If all five hold, lock-free wins. If any fail, use mutexes.

### Real War Stories

**Story 1: Logging library livelock.** A FAANG team rewrote their logger from `std::mutex` to a lock-free MPSC queue. Median throughput improved 4x. Three weeks later, the service started exhibiting 10-second hangs in production. Cause: a producer thread crashed mid-enqueue (after exchange, before publishing the next pointer). The consumer's "queue empty" detection treated this as transient and spun forever. Adding a timeout saved the service. The lesson: lock-free assumes producers complete their operations. Crashes break the assumption.

**Story 2: Treiber stack ABA at scale.** A trading firm used a Treiber stack with tagged pointers (16-bit tag). At 5M ops/sec per stack, the tag wrapped every 13 milliseconds. A specific contention pattern produced ABA at the wrap, corrupting orders. Caught after a 9-figure loss. Fix: 64-bit tag with cmpxchg16b.

**Story 3: Hazard pointer scan storm.** A streaming video service used hazard pointers for their hot path metadata cache. With 200 threads, scan time grew to 200 microseconds per retire under load. p99 latency on the hot path exploded from 50 microseconds to 5 milliseconds. Fix: switch to EBR with per-thread retire bags. The lesson: hazard pointer scan cost grows linearly in thread count.

**Story 4: Compiler hoisting the spin.** A senior engineer wrote a busy-wait on a relaxed atomic. The code worked in debug builds. In release builds with -O2, GCC hoisted the load and produced an infinite loop. Caught only because a CI machine timed out. Fix: change to acquire ordering. The lesson: relaxed ordering is dangerous in busy-wait.

**Story 5: NUMA queue collapse.** A team built an MPSC queue, benchmarked on a single-socket machine at 200 Mops/s. Deployed to a dual-socket production server. Throughput dropped to 35 Mops/s. Cause: producers on one socket, consumer on the other, every node travels across QPI on dequeue. Fix: per-NUMA queues with work stealing. The lesson: benchmarks must match production topology.

### "If You Have to Ask, Use a Mutex"

The folklore rule, often attributed to senior systems engineers at Google. Its meaning is sharper than it sounds.

If you cannot derive the memory ordering rules from first principles, you cannot debug a lock-free bug. If you cannot debug it, you should not ship it. Engineers who can ship lock-free code in production are rare, and the cost of teaching the skill is high.

Use a mutex by default. When the mutex is provably the bottleneck (profile it), and only then, consider lock-free, and only after consulting someone who has shipped lock-free code in production before.

### When to Reach for Lock-Free Without Hesitation

A few cases where lock-free is so dominant that the mutex alternative is unworkable:

- SPSC ring buffer for audio or video pipelines. Wait-free, dead simple, faster than any mutex.
- Read-mostly cache with rare writes. RCU plus copy-on-write is a 100x throughput improvement over reader-writer locks.
- Per-thread work-stealing deque. Chase-Lev's work stealing is the standard scheduler primitive.
- Concurrent counter (multiple threads incrementing). `std::atomic<int>::fetch_add` is so much faster than a mutex that it is not worth considering alternatives.

For everything else, prove the need before reaching for the technique.

### Senior at FAANG: The Cost-Benefit Conversation

At code review, the question is never "is this lock-free correct?" The question is "is the operational cost of this lock-free worth the throughput gain?"

Operational cost includes:
- On-call burden when bugs surface in production.
- Engineering hours to maintain the code across changes.
- Test infrastructure (TSan, Relacy, stress harnesses).
- Onboarding cost for new team members.

A 2x throughput gain rarely justifies a 5x maintenance cost. Production lock-free code requires a clear performance argument, demonstrated under realistic workload, that the mutex alternative cannot meet the SLO.

The default answer to "should we use lock-free?" at most teams is no. Reserve it for the small set of structures where the math works out.
