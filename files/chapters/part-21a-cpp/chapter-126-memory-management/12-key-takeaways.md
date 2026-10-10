## Key Takeaways

1. **Stack allocation is nearly free.** Use it whenever possible. The heap costs 10-50x more per allocation.

2. **RAII is the foundation of modern C++.** Every resource, memory, files, locks, connections, transactions, should be managed by an RAII wrapper. If you are writing `delete`, you are probably doing it wrong.

3. **Smart pointers replace raw ownership.** Use `unique_ptr` by default (single owner), `shared_ptr` only when ownership is genuinely shared, and `weak_ptr` to break cycles and implement observers.

4. **Memory bugs are the most dangerous bugs in C++.** Use sanitizers (ASan, MSan, TSan, UBSan) in your CI pipeline. Run Valgrind for thorough analysis.

5. **Virtual memory is an abstraction.** Understanding page tables, TLB misses, and page faults helps you write cache-friendly, performant code.

6. **Go's GC vs C++ manual management is a trade-off, not a winner.** Go wins on safety and developer productivity. C++ wins on latency, memory efficiency, and control. Choose based on your requirements.

7. **As a Go developer learning C++**, the biggest mindset shift is ownership. In Go, the GC owns everything. In C++, you must decide who owns every object, express that ownership in the type system (smart pointers), and ensure cleanup happens deterministically through RAII.

---

### Junior → FAANG: Ownership as the Mental Model for Systems Code

In garbage-collected environments like Go, developers don't have to assign explicit ownership to each allocated resource. In C++, every allocation must have a single owner (expressed via `std::unique_ptr` or stack lifetime) or clearly documented shared ownership (`std::shared_ptr`). When writing or reviewing code, always ask: *Who allocates this, who holds it, who deletes it, and under what condition?*

Before interviews, ensure you can trace the lifetime of any object through moves, copies, and function calls without relying on intuition. If an interviewer asks you to build a cache or connection pool, start by identifying ownership semantics before writing a single line of business logic.

### Senior @ FAANG: Establishing Memory Discipline Across Multi-Team Codebases

At staff level, memory safety and resource discipline cannot rely solely on developer vigilance. It requires automated governance:
1. **Toolchain enforcement**: Strict compiler flags (`-Wall -Wextra -Werror`), mandatory AddressSanitizer and UndefinedBehaviorSanitizer runs in pre-merge CI, and ThreadSanitizer runs on concurrency test suites.
2. **Zero-raw-ownership policy**: Ban owning raw pointers (`new`/`delete`) in production application code via clang-tidy lint checks (`cppcoreguidelines-owning-memory`, `modernize-make-unique`).
3. **Allocation profiling**: Continuous heap profiling in production staging to detect slow memory bloat, high allocation rates in request loops, and allocator lock contention before code hits customer traffic.

---

| [◀ Chapter 125: C++ Fundamentals](../chapter-125-cpp-fundamentals/00-introduction.md) | [Chapter 126: Memory Management](00-introduction.md) | [Chapter 127: Object-Oriented C++](../chapter-127-oop-cpp/00-introduction.md) ▶ |

