# Chapter 124: Why C++ Still Matters

> "C++ is my favorite garbage collected language because it produces so little garbage." - Bjarne Stroustrup, creator of C++

If you have spent your career writing Go, you may wonder why anyone would voluntarily choose a language where a missing semicolon can cause a segfault, where build times are measured in minutes instead of milliseconds, and where the specification runs over 1,800 pages. The answer is that C++ remains the foundational language of nearly every performance-critical system you interact with daily. The browser rendering this book, the database storing your application's data, the operating system scheduling your goroutines, the machine learning framework training the model behind your AI features, and the game engine powering the titles on your Steam library are all written in C++.

This chapter explains where C++ dominates, why FAANG companies invest heavily in it, how it compares honestly to Go and Rust, what modern C++ looks like compared to the language you may have encountered in a university course, and how to set up a toolchain and write your first program. By the end, you will understand when to reach for C++ and when Go or Rust is the better choice.

---

### Junior → FAANG: Understanding Why C++ Is Still Hired For

Most junior engineers first encounter C++ in a data structures course, then never touch it again. That mental model, C++ as "a harder C," is a liability when you interview at companies that run C++ in production at massive scale. The entry-level gap is not syntax. It is domain awareness.

Start by building a mental map of where C++ actually lives: browsers, databases, ML runtimes, compilers, game engines, HFT. When an interviewer asks "why C++ for this system?", your answer needs to cite concrete constraints: GC-pause sensitivity, cache-line control, SIMD, deterministic destructors. "Because it's fast" is not an answer. It is a placeholder.

First-job habit: before touching any C++ service at a new team, read the ADR or design doc that explains why C++ was chosen over Go, Java, or Rust. That document tells you what trade-offs the original authors cared about, and those trade-offs are your operating constraints.

Interview entry point: know at least two open-source C++ projects per FAANG company (Abseil, gRPC for Google, Folly, RocksDB for Meta, LLVM for Apple). You should be able to say what each does in one sentence and why a Go engineer would care.

### Senior @ FAANG: Platform Positioning and Language Portfolio Governance

At the L6/L7 level, the question is not "can you write C++?" but "when does your team own C++ and who decides?" This is a governance and platform-thinking problem.

**Language portfolio decisions.** Staff engineers influence or own the choice of language for new systems. The decision matrix for C++ versus Go involves: latency SLO tightness (sub-millisecond GC-pause budget), memory budget (C++ custom allocators vs. Go's bump-the-pointer allocator), team hiring pipeline (Go engineers are easier to hire at most companies), and FFI surface area (C++ is the native ABI for most OS and hardware libraries). A bar-raiser expects you to articulate this matrix, not just say "C++ is faster."

**ADR framing.** When writing an Architecture Decision Record for a new C++ service, the record must capture: what GC-pause SLO ruled out Go, what hardware access requirement ruled out a managed language, what the rewrite cost would be in N years if the team's C++ expertise erodes, and what the security risk is (memory safety CVEs dominate C++ codebases). The ADR is not advocacy for C++. It is a documented trade-off with explicit revisit criteria.

**Maturity model for C++ codebases.** A senior engineer evaluating a C++ codebase should ask: Is undefined behavior caught by sanitizers in CI? Is there a policy on smart pointer ownership conventions (unique vs. shared)? Is the build system hermetic (Bazel with a pinned toolchain)? Is there a clang-tidy baseline enforced on every PR? Absence of these signals a codebase that will accumulate memory safety debt.

**Bar-raiser signal.** In a staff-level interview, the question "why does Google keep writing C++ instead of rewriting in Rust?" is a test of whether you understand migration economics, ABI stability, toolchain maturity, and organizational inertia, not just language features. The expected answer covers: 35M+ lines cannot be rewritten atomically, C++/Rust interop is still maturing, Rust's compile times affect developer productivity at monorepo scale, and the incremental adoption path (new modules in Rust, existing C++ with hardened sanitizer coverage) is the realistic strategy.

**L7 concern: language ecosystem ownership.** At the L7/Principal level you may own the decision of which C++ standard version is adopted org-wide, which version of Abseil or Boost is vendored, and how the migration from C++17 to C++20 modules happens. These decisions affect build times, binary sizes, and the ability to hire engineers with matching skills. The org-wide impact of a bad language-ecosystem decision dwarfs any individual service's performance gain.
