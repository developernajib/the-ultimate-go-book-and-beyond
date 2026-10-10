## Interview Questions

### Conceptual

1. **What is the difference between lock-free and wait-free?** Lock-free guarantees system-wide progress (at least one thread always makes progress). Wait-free guarantees per-thread progress (every thread completes in bounded steps). Wait-free is strictly stronger.

2. **Explain the ABA problem with a concrete example.** Thread A reads pointer P=X. Thread B pops X, frees it, allocates new node at same address X, pushes it. Thread A's CAS on P succeeds (P still equals X), but X now points to different data. The stack is corrupted.

3. **Why can't you just use `delete` after a successful CAS in a lock-free pop?** Another thread may have loaded the same pointer before the CAS and is about to dereference it. Deleting the node causes use-after-free. You need deferred reclamation (hazard pointers, EBR, or GC).

4. **When would you choose RCU over a reader-writer lock?** When reads vastly outnumber writes and read latency must be minimal. RCU readers pay zero synchronization cost, while reader-writer locks still require atomic operations for the read-side lock. The trade-off is that RCU writers must copy the entire data structure.

5. **Why is lock-free programming harder on ARM than x86?** x86 has a strong memory model (Total Store Order) that provides implicit acquire/release semantics on regular loads and stores. ARM has a weak memory model that requires explicit barriers. Bugs in memory ordering may never manifest on x86 but fail on ARM.

### Coding

6. **Implement a lock-free stack with safe memory reclamation.** Choose one: reference counting, hazard pointers, or epoch-based reclamation. Explain why you chose it.

7. **Write a CAS loop to atomically update a struct field.** Given `std::atomic<Config*> current_config`, write a function that atomically updates the `timeout` field using copy-on-write.

8. **Design a lock-free hash map for a read-heavy workload.** Describe the high-level approach. (Answer: RCU for the bucket array, lock-free linked lists per bucket, or a split-ordered list with lock-free insert/delete.)

### System Design

9. **A metrics system processes 10 million counter increments per second across 32 cores. How would you design the counter?** Use per-thread (or per-core) counters with padding to avoid false sharing (like `WaitFreeCounter` in Section 4). Sum on read. This is wait-free for writes and lock-free for reads.

10. **You are building a concurrent memory allocator. Which lock-free techniques would you use?** Thread-local free lists (no synchronization for common case), lock-free transfer of chunks between threads using CAS, size-class segregation to avoid fragmentation. This is how tcmalloc and jemalloc work.

### Junior → FAANG: Structuring Answers to Lock-Free Interview Questions

Questions 1-5 are definitional and concept-testing. The structured answer format: define the term clearly, give a concrete example, state when you would or would not use it. For ABA (question 3), always include the fix: "The solution is tagged pointers or hazard pointers, which ensure a freed node cannot be reused while any thread holds a reference to its address."

Questions 6-10 are design questions. Use the framework: state the requirements (throughput, progress guarantee, memory overhead), propose a solution, justify it with the requirement mapping, name a production implementation you would reach for first (Folly, TBB, Abseil). "I would implement this with a per-thread counter using `alignas(64)` to prevent false sharing" is a specific, testable answer. "I would use an atomic" is not.

### Senior @ FAANG: Bar-Raiser Signals in Lock-Free Interview Answers

At L6 bar-raiser level, the follow-up questions after the candidate's answer reveal depth. For question 9 (10M counter increments per second): after the candidate says "per-CPU counters," ask "how does the reader aggregate across threads in a snapshot?" The expected answer: either a fence-less sum (eventually consistent, acceptable for metrics), or a round of `fetch_add(0, seq_cst)` to drain store buffers before summing (expensive but exact). The candidate who knows both options and can articulate the tradeoff is L5+.

For question 10 (memory allocator): the bar-raiser follow-up is "how does your allocator behave during a thread's exit?" Thread-local free lists must be returned to the global pool when a thread exits. The mechanism (a thread-local destructor via `thread_local` RAII or a pthread key destructor) and its interaction with the lock-free global transfer is where L6 depth shows.

The highest-signal answer in any lock-free interview: "I would use Folly's X / TBB's Y / Abseil's Z for this, because they have been validated at FAANG scale. I would only write a custom implementation if measurement showed a specific gap that existing libraries don't address, and I would submit it through the same validation process they use." This answer demonstrates engineering maturity, not just theoretical knowledge.

---
