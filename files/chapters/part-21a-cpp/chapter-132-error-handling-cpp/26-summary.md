## Summary

Error handling in C++ is not a single mechanism but a toolkit. The language offers exceptions for automatic propagation, `noexcept` for performance-critical paths, `std::expected` for explicit value-or-error returns, and RAII for guaranteed cleanup. Industry leaders have built their own abstractions on top: Google's `absl::Status`, Meta's `folly::Try`, and countless internal variants.

The key principles that cut across all approaches:

1. **Destructors must never throw.** This is non-negotiable.
2. **Move operations should be `noexcept`.** The performance cost of not doing so is real and measurable.
3. **Choose the right mechanism for the context.** Exceptions for truly exceptional failures. Error codes or `std::expected` for expected failures. Asserts for programming bugs.
4. **RAII is the foundation.** Regardless of whether you use exceptions or error codes, RAII ensures resources are cleaned up.
5. **The strong guarantee is the gold standard** for operations that modify state. Copy-and-swap is the classic implementation technique.

Go's explicit error handling influenced the industry's move toward `std::expected` and similar types. C++'s RAII influenced Go's `defer`. The languages learn from each other. The best C++ engineers understand all the tools in the toolkit and choose based on the specific constraints of their system - latency, binary size, team conventions, and the nature of the errors being handled.

In the next chapter, we will explore memory safety and exploitation in C++ - examining undefined behavior, memory corruption vulnerabilities, and modern compiler/hardware hardening mechanisms.

### Junior → FAANG: Summary as an Error Handling Readiness Test

Before proceeding, verify you can answer: (1) what are the three exception safety guarantees? (2) when must a move constructor be `noexcept`? (3) what is the `ASSIGN_OR_RETURN` macro and why is it useful? (4) how do you handle errors in constructors without exceptions? (5) what is the difference between `absl::StatusOr` and `std::expected`? These five questions cover the minimum baseline for C++ error handling at L4/L5.

### Senior @ FAANG: Summary as an Org Error Handling Audit Framework

At the staff level, the summary is an audit checklist: does the codebase have a documented error handling policy? Are all move operations `noexcept`? Is `absl::Status` marked `[[nodiscard]]`? Are exception safety guarantees documented on public APIs? Is the error translation policy at gRPC boundaries documented and consistent? Each "no" is a tracked technical debt item. A staff engineer converts this audit into a quarterly health check for the C++ codebase's error handling infrastructure.

---

| [◀ Chapter 131: Modern C++ Features](../chapter-131-modern-cpp/00-introduction.md) | [Chapter 132: Error Handling in C++](00-introduction.md) | [Chapter 132B: Memory Safety and Exploitation](../chapter-132b-memory-safety-exploitation/00-introduction.md) ▶ |


