# Chapter 132: Error Handling in C++

> "Exceptions are the worst form of error handling, except for all the others that have been tried." - Adapted from Churchill, by every C++ committee member

Error handling is the fault line that divides C++ codebases. Some teams ban exceptions entirely (Google's style guide famously did for years). Others embrace them as the only mechanism that can guarantee constructor failures propagate. Meta invented `folly::Expected`. Microsoft ships structured exception handling in Windows. The standard committee added `std::expected` in C++23. Meanwhile, Go chose a radically different path: explicit error returns on every call.

The diversity exists because there is no universally correct answer. The right error handling strategy depends on your latency requirements, binary size constraints, team conventions, and how much you trust your call chain to handle failures. A game engine rendering frames in 16 milliseconds has different needs than a batch data pipeline processing terabytes overnight.

This chapter covers every major approach to error handling in modern C++. We start with the language's built-in mechanism - exceptions - and work through their safety guarantees. We then cover the `noexcept` specifier and its performance implications. Next come error codes, `std::expected`, and industry patterns from Google and Meta. We examine RAII-based cleanup strategies, constructor error handling, and close with a detailed comparison to Go's approach. By the end, you will understand not just the mechanisms, but when and why to choose each one.

---

### Junior → FAANG: Matching Error Handling Mechanism to Context

The single most important skill in C++ error handling is not knowing the mechanisms (exceptions, error codes, `absl::StatusOr`), but knowing which mechanism a given codebase uses and following that convention consistently. Nothing is more dangerous than a mixed error handling strategy: exceptions in one layer, error codes in another, with no clear policy for how they interact.

Before writing any error handling code in a new C++ project, find the answer to: does this codebase use exceptions (check for `try/catch` blocks, check if `-fno-exceptions` is set in the build system), or does it use error return values (check for `absl::Status`, `std::expected`, or `std::error_code` return types)? Match what you find.

Interview entry point: "how would you handle an error in a constructor?" The complete answer: exceptions (throw from constructor, no partially-constructed object persists), or factory function that returns `std::expected<T, Error>` (the preferred approach in exception-disabled codebases like those compiled with `-fno-exceptions`).

### Senior @ FAANG: Error Handling Policy as an Organizational Consistency Requirement

At the staff level, error handling is not a per-engineer choice. It is an organizational policy that determines how errors propagate across service boundaries.

**Error handling ADR.** The ADR for error handling policy covers: (1) are exceptions enabled (build system flag check)? (2) what is the canonical error return type for functions that can fail (absl::StatusOr, std::expected, or a project-specific type)? (3) how are errors translated at service boundaries (gRPC status codes, HTTP status codes)? (4) what is the policy for unrecoverable errors (abort, terminate, or panic equivalent)? (5) how are error handling violations enforced (clang-tidy checks, code review)?

**Cross-boundary error propagation.** When a C++ service calls another service via gRPC, errors cross two boundaries: the C++ error type (`absl::Status`) to the gRPC status code, and the gRPC status code back to the calling service's error type. A staff engineer defines the error translation policy: which internal error codes map to which gRPC status codes, how error messages are sanitized before leaving the service (no internal stack traces, no sensitive data in gRPC status messages), and how the receiving service re-exposes the error to its callers.

**Consistent error handling as a reliability metric.** A codebase with inconsistent error handling (some errors dropped silently, some propagated as crashes, some logged and swallowed) has a reliability problem. A staff engineer audits the codebase's error handling consistency by searching for: silently discarded `absl::Status` returns (Abseil marks `Status` as `[[nodiscard]]` by default), unchecked `std::expected` values, and `catch (...)` blocks that log and continue. Each finding is a potential silent failure mode in production.

