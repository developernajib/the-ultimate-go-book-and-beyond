## Summary

The C++ memory model gives programmers precise control over how concurrent memory accesses are ordered. This power comes with responsibility: incorrect ordering is undefined behavior that may work on one architecture and fail silently on another.

**Key takeaways**:

1. **`std::atomic` provides atomicity**, indivisible operations that prevent torn reads and writes. The fundamental operations are `load`, `store`, `exchange`, `compare_exchange`, and the `fetch_*` family.

2. **Memory orderings control visibility**. Relaxed provides only atomicity. Acquire/release provides pairwise synchronization between a publisher and consumer. Sequential consistency provides a global total order visible to all threads.

3. **Happens-before is the correctness criterion**. If operation A happens-before operation B, then A's side effects are visible to B. The happens-before relationship is built from sequenced-before (within a thread) and synchronizes-with (across threads via acquire/release).

4. **False sharing is a performance killer**. Align independent atomics to separate cache lines using `alignas(64)` or `std::hardware_destructive_interference_size`.

5. **Start with seq_cst, weaken only with evidence**. The performance difference between seq_cst and relaxed is often negligible compared to the cost of debugging a subtle ordering bug.

6. **Go takes the opposite approach**: all atomics are sequentially consistent, no weaker orderings available. This sacrifices micro-optimization potential for safety and simplicity.

7. **Lock-free programming is hard**. The ABA problem, memory reclamation, and subtle ordering bugs make lock-free code significantly harder to write correctly than lock-based code. Use lock-free structures from battle-tested libraries when possible. Write your own only when you have proven that locking is the bottleneck.

The next chapter builds on these foundations to explore lock-free and wait-free algorithms in depth, including hazard pointers, epoch-based reclamation, and the formal progress guarantees that distinguish lock-free from wait-free algorithms.

### Junior → FAANG: What to Take Away from This Chapter

The chapter's seven key takeaways map directly to interview questions. Know them, but also know why each one exists. The most testable: atomicity without ordering is not enough (relaxed atomics can still appear reordered to other threads), and seq_cst is the safe default.

The practical checklist for your first concurrent C++ code review: (1) every shared non-const variable is either atomic or protected by a mutex, (2) every atomic has an explicit ordering argument with a comment, (3) no `volatile` used for inter-thread communication, (4) no raw `new`/`delete` on shared pointers (use `shared_ptr` or hazard pointers), (5) ThreadSanitizer runs clean in CI.

### Senior @ FAANG: Chapter Synthesis for Staff-Level Application

This chapter's content is the prerequisite for understanding lock-free systems at scale. The summary's seven points are individually well-understood by L5 engineers. What distinguishes L6 and above is the ability to reason about their interactions: how does ABA interact with memory ordering? (You need sufficient ordering to guarantee the hazard pointer is visible before dereferencing.) How does false sharing interact with seqlocks? (False sharing between a seqlock's version counter and its data defeats the optimization.)

At staff level, this chapter's content becomes an input to platform decisions: what memory model do we guarantee for our internal libraries? Do we document the happens-before edges that our lock-free queues establish? Do we have a litmus test suite that validates our atomic algorithms on every target architecture? These are the questions that separate a codebase maintained by experts from one that requires experts to maintain.

The L7 signal: you can use this chapter to train a team. You can run a memory model workshop, set up a litmus test suite, and establish code review guidelines that catch ordering bugs before they reach production. The measure of mastery is not that you can write correct atomic code, it is that you can build an environment where your team writes correct atomic code.

---

| [◀ Chapter 133: Concurrency in C++](../chapter-133-concurrency-cpp/00-introduction.md) | [Chapter 134: Atomics and Memory Model](00-introduction.md) | [Chapter 135: Lock-Free Programming](../chapter-135-lock-free-programming/00-introduction.md) ▶ |
