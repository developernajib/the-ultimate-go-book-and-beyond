# Chapter 125: C++ Fundamentals

> C++ is a language where you have to know what you are doing, and when you do, you can do almost anything.

If you have been writing Go for any length of time, you have internalized a world where the compiler catches most type errors, memory is garbage collected, and undefined behavior simply does not exist. C++ is a different animal. It hands you far more power and far more rope. This chapter builds your C++ foundation from the ground up, systematically mapping every concept back to what you already know from Go. By the end, you will be able to read and write basic C++ code, understand the compilation pipeline that turns source into binaries, and recognize the pitfalls that catch even experienced engineers.

---

### Junior → FAANG: Building Foundations That Do Not Crack Under Interview Pressure

The fundamentals in this chapter (types, references, control flow, functions, namespaces, compilation model) are tested implicitly in every C++ interview question. A candidate who is fuzzy on when a reference becomes dangling, or what undefined behavior actually means, will not survive a bar-raiser question about a subtle memory bug even if they know all the high-level architecture.

Concrete study approach: for each topic in this chapter, write a five-line code snippet that demonstrates the correct behavior, then write a five-line snippet that demonstrates the most common mistake. The act of writing both variants builds the diagnostic muscle that separates competent C++ engineers from dangerous ones.

Interview entry point: "what is undefined behavior and give me an example" is a common L4/L5 screen question. The answer must include: the compiler is allowed to assume UB never happens (enabling optimizations that break your assumptions), and common examples include signed integer overflow, null pointer dereference, reading uninitialized memory, and using an object after its lifetime ends.

### Senior @ FAANG: Fundamentals as the Baseline for Code Review Standards

At L6, your relationship to C++ fundamentals is not personal. It is institutional. You define what "correct C++" means for your team through code review guidelines, style guides, and automated checks.

**Codifying fundamentals in tooling.** The fundamentals covered in this chapter should be enforced by tooling, not by human review. Clang-tidy checks enforce: no raw owning pointers (`cppcoreguidelines-owning-memory`), no implicit narrowing conversions (`cppcoreguidelines-narrowing-conversions`), no C-style casts (`cppcoreguidelines-pro-type-cstyle-cast`), no `reinterpret_cast` without justification. A staff engineer defines which checks are mandatory in CI and which are advisory. The mandatory set should cover every class of bug that has caused a production incident in the last year.

**UB elimination as a quality metric.** A mature C++ codebase tracks UBSan (Undefined Behavior Sanitizer) coverage as a CI metric. Every new UBSan finding in CI should be treated as a P1 bug. At L6, you set this policy and ensure the team understands why: a single UB in production can manifest as arbitrary behavior months later under a different compiler optimization level, making it one of the highest-severity latent bugs possible.

**Fundamentals in the hiring bar.** At the L6 interview panel level, fundamentals questions serve as calibration. A candidate who cannot explain reference lifetime, the compilation model, or integer promotion rules is not ready for L5, regardless of how well they answer system design questions. The fundamentals form the floor, not the ceiling, of the C++ interview bar.
