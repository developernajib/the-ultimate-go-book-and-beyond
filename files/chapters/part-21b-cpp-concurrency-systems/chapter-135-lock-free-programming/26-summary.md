## Summary

Lock-free programming replaces locks with atomic operations, primarily CAS loops, to build data structures where system-wide progress is guaranteed regardless of thread scheduling. The Treiber stack and Michael-Scott queue are foundational structures. The ABA problem and memory reclamation (hazard pointers, epoch-based reclamation, tagged pointers) are the central challenges that make lock-free code far harder than it appears.

Wait-free algorithms provide even stronger per-thread progress guarantees at the cost of complexity and overhead. RCU optimizes the common case of read-heavy workloads by making readers pay zero synchronization cost.

The most important lesson: **measure before you optimize.** Lock-free code is complex, error-prone, and difficult to test. Use it only when profiling proves that lock contention is the bottleneck, and prefer well-tested libraries (Folly, Boost.Lockfree, libcds) over hand-rolled implementations. When building for Go, use the runtime's channels and GC, they eliminate entire categories of bugs that C++ programmers must solve manually.

### Junior → FAANG: What to Carry Forward from This Chapter

The three things to memorize from this chapter for your first FAANG interview: (1) lock-free means system-wide progress, not per-thread progress, (2) ABA is the canonical lock-free bug and requires tagged pointers or hazard pointers to fix, (3) measure before choosing lock-free over a mutex.

The library-first habit: for production code at your first job, use Folly or TBB lock-free containers rather than implementing your own. Understanding why they are correct (the ABA handling, the reclamation strategy, the memory ordering) is more valuable than implementing your own.

### Senior @ FAANG: Chapter Synthesis at Staff Level

This chapter's content is the prerequisite for owning lock-free infrastructure at scale. The synthesis question for staff engineers: if you were starting a new high-throughput service today, what lock-free infrastructure would you choose, and what would you monitor in production to validate correctness and performance?

The expected answer: Folly `MPMCQueue` for bounded producer-consumer, `atomic<shared_ptr>` or Folly RCU for read-mostly configuration, per-CPU sharded counters for metrics. In production, monitor: CAS retry rate (high retry rate signals contention that sharding would fix), p99.9 operation latency (outliers signal starvation), and memory reclamation lag (stale hazard pointers blocking free).

At L7/Principal level, the lock-free chapter connects to fleet-level decisions: which allocator (tcmalloc, jemalloc, mimalloc) is deployed org-wide, whether the org has a standard RCU library, and whether the CI infrastructure includes TSan on ARM. These are infrastructure decisions that affect every team's ability to write correct concurrent code.

---

| [◀ Chapter 134: Atomics and Memory Model](../chapter-134-atomics-memory-model/00-introduction.md) | [Chapter 135: Lock-Free Programming](00-introduction.md) | [Chapter 136: Coroutines (C++20)](../chapter-136-coroutines/00-introduction.md) ▶ |
