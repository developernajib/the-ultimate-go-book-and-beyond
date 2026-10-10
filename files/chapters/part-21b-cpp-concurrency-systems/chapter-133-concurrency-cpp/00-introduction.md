# Chapter 133: Concurrency in C++

> "Concurrency is not parallelism, but it enables parallelism." - Rob Pike

Modern software runs on machines with dozens of cores. A single-threaded program on a 64-core server wastes 98% of its compute capacity. C++ gives you the lowest-level threading primitives in any mainstream language - direct control over thread creation, synchronization, memory ordering, and cache-line placement. That power comes with responsibility. A single missing lock can corrupt data silently. A single lock ordering mistake can freeze your entire application.

Go made concurrency its defining feature with goroutines and channels. C++ took a different path: it standardized a threading library in C++11, added parallel algorithms in C++17, and introduced cooperative cancellation with `std::jthread` in C++20. Where Go hides complexity behind a runtime scheduler, C++ exposes every knob and expects you to understand what each one does.

This chapter covers the complete C++ concurrency toolkit. We start with raw threads and work up through mutexes, locks, condition variables, futures, and thread pools. We compare each mechanism with its Go equivalent. We cover the parallel STL algorithms that let you parallelize existing code with a single argument change. We close with the pitfalls that have ended careers at production companies: data races, deadlocks, and priority inversion. By the end, you will understand not just how to write concurrent C++, but how to write concurrent C++ that does not break at 3 AM under load.

---

### Junior → FAANG: The C++ Concurrency Mental Model Before Writing Any Code

Go engineers have a clear concurrency model: goroutines and channels are the primary tool, mutexes exist for specific performance needs. C++ concurrency requires building a mental model from scratch: threads are OS-scheduled units of execution (expensive to create, limited in number), mutexes protect shared state, condition variables coordinate threads waiting for conditions, and futures/promises enable async result passing.

Before writing any concurrent C++, answer three questions: (1) what data is shared between threads? (2) which mutex protects each piece of shared data? (3) what is the lock ordering (to prevent deadlocks)? Writing these answers down before coding is the habit that prevents the "data race that appeared under load" post-incident.

Interview entry point: "what is a data race?" The complete answer: two threads access the same memory location concurrently, at least one access is a write, and there is no synchronization between them. In C++, data races are undefined behavior (the compiler may generate arbitrary code). TSan (Thread Sanitizer) detects data races at runtime.

### Senior @ FAANG: Concurrency Architecture as a System Design Concern

At the staff level, concurrency is an architectural decision, not a per-function implementation detail. The key questions at design time: what is the synchronization granularity (per-object lock, per-subsystem lock, global lock), what is the acceptable lock contention under peak load, and what is the deadlock prevention strategy?

**Lock granularity trade-off.** Fine-grained locking (one lock per object) maximizes concurrency but increases the risk of deadlock (more lock orderings to manage) and adds per-lock overhead. Coarse-grained locking (one lock per subsystem) is easier to reason about and deadlock-free within the subsystem but serializes all operations. A staff engineer chooses the granularity based on measured contention, not guesswork.

**Concurrency architecture ADR.** For any new service that uses C++ threads, the ADR should cover: which threading model (thread pool, goroutine-equivalent via work-stealing, reactor pattern), what the synchronization strategy is (mutexes, lock-free, message passing), and what the concurrency testing strategy is (TSan in CI, stress testing, chaos testing). Without this document, each engineer makes independent concurrency decisions that may be individually correct but collectively deadlock.

**TSan as a required CI gate.** At the staff level, TSan is a mandatory CI gate, not an optional tool. A data race that passes code review will appear in production under load. TSan catches data races deterministically (in a given execution). A staff engineer ensures TSan runs on all unit tests and multi-threaded integration tests, and that any TSan finding is a blocking PR failure.

