## Summary

Fundamental building blocks of C++, systematically compared with Go:

- **Variables and types**: C++ has more primitive types, multiple initialization syntaxes, and three levels of constness (`const`, `constexpr`, `consteval`). Use brace initialization to prevent narrowing.
- **References vs pointers**: References are non-null, non-resettable aliases. Use `const T&` for read-only parameters, `T&` for mutable parameters, and `T*` only when null is a valid value.
- **Control flow**: C++ switch falls through by default (opposite of Go). C++ has `while` and `do-while` in addition to `for`. The `if` and `switch` init statements from C++17 mirror Go's syntax.
- **Functions**: Overloading and default arguments give more flexibility than Go but add complexity. Lambdas require explicit capture specifications.
- **Namespaces**: Similar to Go packages but allow nesting, reopening, and can span multiple files.
- **Header files**: The textual inclusion model requires include guards, forward declarations, and the declaration/definition split. C++20 modules will eventually replace this.
- **Compilation model**: Four stages (preprocessor, compiler, assembler, linker) vs Go's single-command build. Knowing this pipeline is critical for debugging build errors.
- **Undefined behavior**: The single most important concept for Go developers learning C++. Go eliminates UB by design. C++ trades safety for performance. Always use sanitizers during development.
- **Type casting**: Four explicit casts replace Go's simple `T(expr)`. Prefer `static_cast`, use `dynamic_cast` for safe downcasting, avoid `reinterpret_cast` and `const_cast` unless absolutely necessary.

In the next chapter, we will build on these fundamentals to explore memory management in C++: stack vs heap, RAII, raw pointers, and smart pointers.

### Junior → FAANG: Checking Your Readiness to Move On

Before moving to the memory management chapter, verify you can answer these without looking anything up: (1) what happens when you fall through a switch case in C++? (2) what is the difference between a reference and a pointer? (3) what is undefined behavior and name three examples? (4) which of the four C++ casts is safest and why? (5) what is the One Definition Rule?

If any of these takes more than 30 seconds to answer, revisit that section. Shaky fundamentals compound: memory management builds on pointers and references, RAII builds on scope lifetimes, templates build on the type system. A gap now becomes a larger gap in two chapters.

### Senior @ FAANG: Fundamentals as Team Baseline Documentation

At the staff level, this chapter's content belongs in your team's C++ onboarding guide, adapted to your codebase's specific patterns. The summary here is generic. Your team's version should reference your specific style guide entries (e.g., "we use `int32_t` not `int` per style guide section 3.2"), your specific sanitizer CI configuration, and your specific namespace conventions.

Maintaining a living "C++ fundamentals for our team" document that references this chapter's topics but adds team-specific context reduces onboarding time for new engineers from weeks to days. A staff engineer writes and owns this document, reviews it on every major language standard adoption, and ensures every new team member completes a check-in exercise against it in their first two weeks.

---

| [◀ Chapter 124: Why C++ Still Matters](../chapter-124-why-cpp/00-introduction.md) | [Chapter 125: C++ Fundamentals](00-introduction.md) | [Chapter 126: Memory Management](../chapter-126-memory-management/00-introduction.md) ▶ |

