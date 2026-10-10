## Summary

C++ concurrency is a precision instrument. It gives you exact control over thread creation, synchronization, memory ordering, and cache behavior. That control comes at the cost of complexity and the risk of subtle, catastrophic bugs.

**Key takeaways:**

- Use `std::jthread` over `std::thread` for automatic joining and cooperative cancellation.
- Never call `lock()` and `unlock()` directly. Always use RAII guards: `lock_guard`, `unique_lock`, `shared_lock`, or `scoped_lock`.
- Use `scoped_lock` when acquiring multiple mutexes to prevent deadlocks.
- Always use the predicate overload of `condition_variable::wait()` to handle spurious wakeups.
- Prefer `std::async` with explicit `std::launch::async` policy for simple parallel tasks.
- Use thread pools for production systems. Creating threads per task does not scale.
- Parallel STL algorithms offer easy parallelism with a single argument change.
- Data races are undefined behavior in C++. Use ThreadSanitizer to detect them.
- Go's goroutines and channels are fundamentally different from C++ threads - they solve different problems at different abstraction levels.

The right concurrency model depends on your constraints. C++ threads win when you need deterministic latency, zero runtime overhead, and total control. Go goroutines win when you need simplicity, safety, and massive concurrency with minimal code. Understanding both lets you choose correctly for each system you build.

### Junior → FAANG: The Three Habits That Prevent Most Concurrency Bugs

From this chapter, commit three habits to muscle memory: (1) always use lock guard wrappers, never raw lock/unlock. (2) always use TSan in test builds for multi-threaded code. (3) always document which mutex protects which data. These three habits, consistently applied, prevent the majority of the concurrency bugs that appear in production C++ services.

### Senior @ FAANG: Concurrency Governance as a Reliability Multiplier

At the staff level, a team that has strong concurrency governance (TSan in CI, Clang thread safety annotations, documented lock ordering, TSan-verified test suite) produces concurrency bugs at a dramatically lower rate than a team that does not. The investment in governance (typically a few engineer-weeks to set up, a few hours per quarter to maintain) pays back in prevented incidents that would otherwise cost days of on-call time and engineer-hours to investigate. A staff engineer makes the business case for this investment and owns the ongoing governance.

---

| [◀ Chapter 169: Computer Hardware and Software Foundations](../../part-21a-cpp/chapter-169-computer-hardware-and-software-foundations/00-introduction.md) | [Chapter 133: Concurrency in C++](00-introduction.md) | [Chapter 134: Atomics and Memory Model](../chapter-134-atomics-memory-model/00-introduction.md) ▶ |

