## Summary

Templates are C++'s most powerful and complex feature. They enable zero-cost abstractions, compile-time computation, and extreme code reuse, but at the cost of complexity, compile times, and historically terrible error messages.

**Key takeaways:**

1. **Function templates** generate type-specific functions at compile time. Type deduction usually works automatically, and non-type template parameters add capabilities Go generics lack entirely.

2. **Class templates** create parameterized types. Each instantiation is a separate class with its own static members, virtual tables, and generated code.

3. **Template specialization** lets you override the generic implementation for specific types (full) or families of types (partial). Go has no equivalent. Prefer overloads over specialization for function templates.

4. **SFINAE** silently removes invalid overloads, enabling conditional compilation. C++17's `if constexpr` and C++20 concepts have largely replaced SFINAE in new code, but understanding SFINAE is essential for maintaining existing codebases.

5. **Type traits** are the vocabulary of template metaprogramming. Master `is_same`, `enable_if`, `decay`, `remove_reference`, and `conditional` as your core toolkit. Custom traits built with `void_t` and partial specialization extend the system to detect any compile-time property.

6. **Variadic templates** and fold expressions replace C-style variadic functions with type-safe, zero-overhead alternatives. Combined with `std::index_sequence`, they enable powerful tuple and pack manipulation.

7. **CRTP** achieves static polymorphism, virtual-function-like behavior without the vtable, enabling mixins and compile-time dispatch. Guard against misuse with private constructors and `static_assert`.

8. **Concepts** (C++20) make template constraints readable, composable, and produce clear error messages. They are the modern answer to SFINAE. Concept subsumption enables clean overload resolution for constrained templates.

9. **C++ templates vs Go generics** is a fundamental design tradeoff: monomorphization produces faster code at the cost of binary size and compile time. Go's dictionary approach compiles faster and produces smaller binaries at the cost of some runtime performance. Neither is universally better, the right choice depends on your constraints.

10. **Compile-time vs runtime polymorphism** is not a binary choice. Use templates when types are known at compile time and performance matters. Use virtual dispatch when you need heterogeneous collections or runtime extensibility. Use type erasure (`std::function`, `std::any`) or `std::variant` when you need both.

The evolution from raw SFINAE (C++11) through `if constexpr` (C++17) to concepts (C++20) shows the language steadily making templates more accessible. Modern C++ template code is dramatically more readable than the metaprogramming gymnastics of a decade ago. As a Go developer, you already understand the value of constraints on type parameters, C++ just gives you a much larger toolbox for expressing them.

---

### Junior → FAANG: The Three Rules for Template Sanity

1. **Prefer concepts over SFINAE.** For any C++20+ code, use `requires` and standard library concepts (`std::integral`, `std::invocable`, `std::ranges::range`) instead of `std::enable_if`.
2. **Overload, do not specialize, function templates.** Specializing function templates does not participate in normal overload resolution; overload function templates instead.
3. **Keep templates in headers.** Because the compiler must see the full definition to instantiate code per type, keep template definitions in headers unless using explicit instantiation declarations (`extern template`).

### Senior @ FAANG: Template Metaprogramming as a Platform Responsibility

At the staff level, generic programming is an architectural discipline. Unconstrained template instantiation creates silent compile-time regressions and binary bloat across thousands of downstream translation units. Enforce explicit concept boundaries, monitor build telemetry via `-ftime-trace` or Clang build analyzer, and prefer type erasure or non-template base implementations where runtime overhead is negligible compared to compilation debt.

---

| [◀ Chapter 128: Move Semantics](../chapter-128-move-semantics/00-introduction.md) | [Chapter 129: Templates and Generics](00-introduction.md) | [Chapter 130: STL Deep Dive](../chapter-130-stl-deep-dive/00-introduction.md) ▶ |

