## Interview Questions

These are the questions a senior engineer at a company with a large C++ codebase might be asked, or might ask, about Carbon. They are not Carbon-coding questions because no one is hiring for Carbon coding skill in 2026. They are language-design and strategy questions, where Carbon is the test case for whether the candidate can reason about programming language tradeoffs at a senior level.

### Question 1: Why does Carbon exist when Rust exists?

**What the interviewer wants**: a precise articulation of the C++ interop problem at scale, not a dismissive comparison.

**Strong answer**: Rust and Carbon are not direct competitors. Rust solves the problem of writing safe systems code from scratch. Carbon solves the problem of migrating an existing C++ codebase to a successor language without a multi-year rewrite. The bottleneck Carbon attacks is C++ to non-C++ interop, which Rust treats as a secondary concern through tools like cxx and bindgen. For a 30-million-line C++ codebase, the friction of Rust interop is the dominant cost of migration. Carbon makes that cost negligible by adopting C++ ABI and template visibility, in exchange for delaying memory safety. That trade is right for a narrow set of codebases and wrong for most.

**Weak answer**: "Carbon is Google's Rust" or "Carbon is unsafe so it is bad".

### Question 2: Carbon plans to add safety later. Why is that controversial?

**What the interviewer wants**: understanding of why retrofitting safety is hard, not a recital of the design intent.

**Strong answer**: Adding safety to a language that started without it is a path very few languages have walked successfully. Once a codebase has been written in the unsafe form, every subsequent safety tightening either breaks existing code (politically expensive) or gets opt-in adoption (which most teams skip). The Rust path of safe-by-default works because the language never had a phase where unsafe was default. Carbon's bet is that with disciplined design and migration tooling, the evolutionary path is achievable. The skepticism is empirical: history shows it is rarely achieved at scale. The honest position is "we hope this works, we are designing for it, we cannot guarantee it".

### Question 3: What does "definition-site checked generics" mean and why does it matter?

**What the interviewer wants**: technical depth on type checking, not just naming the feature.

**Strong answer**: In C++ templates, the compiler accepts any template definition without verifying that the body uses only operations supported by the type parameter. Errors surface at instantiation, deep in caller code, with multi-page diagnostics referencing the template internals. Definition-site checking inverts this: the compiler verifies at the function definition that the body uses only operations the constraint permits, before any caller exists. The error, when there is one, is on the function being defined, not on a caller. The cost is that constraints must be explicit (you cannot rely on duck typing). The benefit is dramatically better error messages and a stable contract for callers. Rust traits, Swift protocols, and Carbon generics all take this approach. C++20 concepts move partway, but instantiation-time checking remains.

### Question 4: How does Carbon's class model differ from C++'s and why?

**What the interviewer wants**: knowledge of multiple inheritance, virtual dispatch, and why simplification has costs.

**Strong answer**: Carbon allows single inheritance of state and multiple implementation of interfaces, in the Rust trait pattern. C++ allows multiple inheritance of state, which produces the diamond problem and requires virtual base classes to disambiguate. Carbon's choice eliminates a class of layout and ambiguity bugs at the cost of forcing engineers who relied on multiple state inheritance to refactor. For most codebases this is a net positive because multiple state inheritance is rare and usually accidental. For codebases that depend on it (some game engines, some older Google code), the migration cost is real. Virtual dispatch in Carbon is explicit through the virtual and override keywords, required rather than optional, eliminating the accidental-non-override bug.

### Question 5: Carbon does not use exceptions. What are the consequences?

**What the interviewer wants**: appreciation of the trade and of what fills the gap.

**Strong answer**: Errors are values, returned through result-style types and propagated through an explicit operator. The pros: predictable performance, no invisible control flow, no exception-safety analysis required, ABI does not pay an exception tax. The cons: error-handling boilerplate is more visible and needs to be threaded through call chains, which can be syntactically heavier. The Carbon position aligns with Google's long-standing internal C++ style of banning exceptions. For codebases that already do not use exceptions, the migration cost is low. For codebases that depend on exceptions for control flow, refactoring to result types is part of the migration work and is not free.

### Question 6: How would you decide whether your team should adopt Carbon?

**What the interviewer wants**: a decision framework, not a yes-or-no.

**Strong answer**: As of early 2026, no team should adopt Carbon for production. The evaluation framework for the future is: codebase size in the tens of millions of lines, heavy templates that frustrate Rust interop, long-lived investment, performance-sensitive, no critical-safety certification dependencies. If those conditions hold, the next question is whether Carbon has reached signals like a 1.0 release, demonstrated production use, working safe subset, mature tooling. If the signals are not there, the default is to stay on modern C++ and watch. If the signals are there, a phased pilot starting with leaf modules is the right adoption path, with explicit success criteria and a kill switch.

### Question 7: Compare Carbon, Cpp2/CppFront, Hylo, and Rust. Which slot does each occupy?

**What the interviewer wants**: clear understanding that these projects are not all competing for the same slot.

**Strong answer**: Rust is the safe systems language for greenfield code, mature and production-ready. Cpp2 is a syntactic skin over C++, no new semantics, available today, for teams that want better C++ syntax without a new language. Hylo is a research language using mutable value semantics, mathematically clean, very early, not aimed at C++ interop. Mojo is ML-focused, targets accelerator code, occupies the Python-plus-C++ ML niche. Carbon is for large existing C++ codebases that need a successor with free interop. Modern C++ is the right answer for most teams that do not fit any of the above special cases. A senior engineer should be able to point any given codebase at one of these answers with reasoning.

### Question 8: What signals would tell you Carbon is succeeding or failing?

**What the interviewer wants**: ability to track real progress versus social signal.

**Strong answer**: Success signals include a published 1.0 with stability commitment, at least one non-Google production deployment at scale, a working safe subset specification, mature language server and debugger, demonstrated migration tooling that handles real C++ codebases. Failure signals include extended pause in design proposals, Google internal teams shifting commitment to Rust, a stalled toolchain that does not reach feature completeness, no external adopters years past 1.0. Star count, social media mentions, and Hacker News activity are noise rather than signal. The right cadence to check is once a quarter, by reading the carbon-lang README and recent design proposal merges. If a candidate cites "Carbon has X stars on GitHub" as a success signal, they have not engaged with the technical substance.

---

### How to Use These Questions

If you are preparing to be asked about Carbon in an interview, work through these questions out loud and time yourself. Each one should take two to four minutes to answer at the depth shown. If you are interviewing someone, these questions separate candidates who can think about language design tradeoffs from candidates who have read a marketing page.

A senior C++ engineer being interviewed in 2026 is probably not being asked to write Carbon code. They might well be asked one of these questions to test whether they can hold a design conversation at the right level. Knowing the answers is a real-world signal of senior-level judgment, not just trivia.

---
