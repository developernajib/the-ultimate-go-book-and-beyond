## Interview Questions

### Conceptual Questions

**Q1: What is the difference between `memory_order_acquire` and `memory_order_seq_cst`?**

Acquire prevents subsequent reads and writes from being reordered before the atomic load. Sequential consistency does the same, plus guarantees a single total order of all seq_cst operations across all threads. Acquire/release establishes pairwise ordering. Seq_cst establishes global ordering. The practical difference: with acquire/release on two independent atomics x and y, different threads can disagree about the order of stores to x and y. With seq_cst, all threads agree on one global order.

**Q2: Can you implement a mutex using only `std::atomic<bool>`? What memory orderings do you need?**

Yes. Lock: `exchange(true, memory_order_acquire)` in a loop until the old value is `false`. Unlock: `store(false, memory_order_release)`. The acquire on lock ensures all writes inside the critical section from the previous holder are visible. The release on unlock ensures all writes inside our critical section are visible to the next acquirer. This is a spinlock, functional but not fair and wastes CPU while spinning.

**Q3: Why does `compare_exchange_weak` exist? When would you choose it over `compare_exchange_strong`?**

On LL/SC architectures (ARM, POWER, RISC-V), a CAS is implemented as a load-linked/store-conditional pair. The store-conditional can fail spuriously if another core writes to any address in the same cache line, if an interrupt occurs, or if the LL/SC reservation is lost for any reason. `compare_exchange_strong` must loop internally to mask these spurious failures, adding overhead. `compare_exchange_weak` exposes the spurious failure, which is harmless if you already have a retry loop. On x86, both compile to the same `lock cmpxchg` instruction.

**Q4: Explain the ABA problem with a concrete example.**

A lock-free stack starts with top -> A -> B -> C. Thread 1 starts `pop()`, reads top=A and next=B, then gets preempted. Thread 2 pops A, pops B, frees B's memory, then pushes A back. Now the stack is top -> A -> C. Thread 1 resumes, sees top is still A, CAS succeeds, and sets top=B. But B was freed, we have a dangling pointer. The fix is to use tagged pointers (version counter), hazard pointers, or epoch-based reclamation.

**Q5: Is `volatile` a substitute for `std::atomic` in C++?**

No. `volatile` prevents the compiler from optimizing away reads/writes (useful for memory-mapped I/O), but provides no atomicity guarantees and no memory ordering. A `volatile int` increment is still a non-atomic load-add-store. In Java, `volatile` does provide happens-before semantics, but C++ `volatile` does not. Always use `std::atomic` for concurrent access.

### System Design Questions

**Q6: You need a high-throughput request counter for a web server that is read by a monitoring thread every second. How would you design it?**

Use a distributed counter with per-thread atomic counters aligned to separate cache lines (the `DistributedCounter` pattern). Each worker thread increments its own counter with `memory_order_relaxed`. The monitoring thread sums all per-thread counters. This eliminates contention entirely during the hot path. The sum is approximate (not a point-in-time snapshot), which is acceptable for monitoring. For exact snapshots, you would need to pause all threads briefly or use a more complex epoch-based approach.

**Q7: Design a thread-safe configuration system where config updates are rare but reads are extremely frequent (millions per second).**

Use RCU (Read-Copy-Update) semantics with `std::atomic<Config*>`:

1. Readers: `config.load(memory_order_acquire)` and use the pointer directly. No locking.
2. Writer: Create a new `Config` object, populate it, then `config.store(new_ptr, memory_order_release)`. Defer deletion of the old config until all readers have finished (using epoch-based reclamation or `shared_ptr`).
3. Alternative: Use a seqlock if the config is small and copyable.

This gives zero-overhead reads (one atomic load) and safe updates without blocking readers.

**Q8: How would you implement a lock-free work-stealing deque?**

A work-stealing deque (used in thread pools like Java's ForkJoinPool and Tokio) has one owner thread that pushes and pops from the bottom (LIFO) and multiple stealer threads that steal from the top (FIFO). The bottom index is only modified by the owner (relaxed stores are sufficient from the owner side). The top index is contended among stealers and uses CAS with acquire/release. The classic implementation is the Chase-Lev deque, which uses a circular buffer with atomic top and bottom indices. The key insight is that the owner can use relaxed operations for push/pop when the deque is not nearly empty, and only needs CAS when racing with stealers.

### Debugging Questions

**Q9: Your lock-free algorithm works on x86 but crashes on ARM. What is the most likely cause?**

x86 has a strong memory model (TSO, Total Store Order): loads are not reordered with loads, stores are not reordered with stores, and loads are not reordered with older stores. ARM has a weak memory model where all these reorderings are allowed. The most likely cause is using `memory_order_relaxed` where you need `acquire`/`release`. On x86, relaxed operations happen to provide stronger guarantees than the standard requires. On ARM, the CPU aggressively reorders, exposing the bug. Fix: review all relaxed operations and determine if they need acquire/release semantics.

**Q10: You see a lock-free counter occasionally returning slightly stale values in monitoring. Is this a bug?**

It depends on the requirements. If the counter uses `memory_order_relaxed` for both increments and reads, the reader may see a value that is slightly behind the "true" current value because relaxed ordering doesn't guarantee when stores become visible to other threads. For monitoring and statistics, this is typically acceptable and by design, the freshness window is usually under a microsecond. If exact point-in-time values are required, you need stronger ordering or a snapshot mechanism. The key question to ask: "Is approximate acceptable for this use case?"

### Junior → FAANG: How to Answer These Questions in a Real Interview

The interview format for atomics questions at FAANG is typically: "Here is some concurrent code. Is it correct? If not, fix it." You will not be asked to recite definitions. You will be asked to reason.

The structured approach: (1) identify every shared variable, (2) identify which threads read and write each, (3) check that every read-write pair has a happens-before edge, (4) check that every happens-before edge is established with the correct memory ordering. If you can walk an interviewer through this analysis on a 20-line code snippet, you pass the L4 atomics bar.

Practice tip: take the code examples in this chapter, remove the `memory_order` arguments, and ask yourself what would go wrong. Then add back the minimum orderings needed for correctness. This is the exact exercise FAANG interviews use.

### Senior @ FAANG: Bar-Raiser Question Signals for Atomics

At L5/L6 bar-raiser level, the atomics questions test whether you can teach, not just execute. The bar-raiser format: "explain to a junior engineer why this code has a bug even though it looks right." The expected answer demonstrates that you can communicate happens-before reasoning clearly, not just identify the bug.

The highest-signal questions at bar-raiser level are about tradeoffs, not definitions: "When would you choose a seqlock over a mutex? When would you choose neither?" "How would you detect memory ordering bugs on a fleet that has both x86 and ARM machines?" "What is the production story if a lock-free queue has an ABA bug that only manifests at p99.9 concurrency?" These questions test whether you have shipped concurrent systems, not just read about them.

For L6 interviews, have a war story ready: a time when a concurrent bug escaped review and was caught in production or pre-production, what the root cause was, and what process change you made to prevent recurrence. This is the evidence that separates L5 from L6.

---
