# Chapter 131: Modern C++ Features (C++17/20/23)

> C++ evolves not by revolution but by the relentless accumulation of features that solve real problems encountered by millions of developers.

Every three years since 2011, the C++ standards committee ships a new version of the language. Each release adds features that would have seemed alien to C++03 programmers: algebraic types, coroutines, concepts, reflection proposals, monadic error handling. The pace of change is staggering. A C++ developer who stopped paying attention in 2014 would barely recognize modern C++23 code.

Yet in practice, adoption follows a predictable curve. Most production codebases at major technology companies use C++17 as their baseline, with selective adoption of C++20 features like concepts and ranges where compiler support is stable. C++23 features are experimental in production. Understanding which features exist, which are production-ready, and which are still settling is as important as understanding the features themselves.

This chapter walks through the significant features of C++17, C++20, and C++23, with complete code examples for each. We then preview C++26 proposals that will reshape the language again. Finally, we address the practical reality: what FAANG companies actually use in production today, and why the answer is more conservative than you might expect.

---

### Junior → FAANG: Which Modern C++ Features to Prioritize

The chapter covers three standards (C++17, C++20, C++23) and previews C++26. For an engineer at the beginning of their C++ career, the priority order is: (1) C++17 features that are already available everywhere (structured bindings, `std::optional`, `std::variant`, `if constexpr`), (2) C++20 features that most FAANG codebases are adopting (concepts, `std::format`, ranges basics, `std::span`), (3) C++23 and C++26 as awareness-level knowledge.

Do not let breadth substitute for depth. A candidate who can explain `std::optional` vs. `absl::StatusOr` with concrete trade-offs is more valuable than a candidate who can name every C++23 feature without explaining any of them.

### Senior @ FAANG: Standard Adoption Policy and the "Production Gap"

At the staff level, the gap between what is in the standard and what is in production is a governance concern. FAANG companies are typically 2 to 4 years behind the latest standard in their internal codebases, for good reasons: compiler support must be stable, build systems must support the new features, and the engineering cost of migration must be justified by measurable benefits.

**Standard version adoption ADR.** When proposing to adopt C++20 features in a codebase currently at C++17, the ADR must cover: which compiler version is required (Clang 16 for full C++20 support), what CI infrastructure changes are needed, which C++20 features are approved for use (not all features are immediately appropriate: coroutines may require framework support, modules require build system changes), and which features are deferred to a later phase. The ADR gates each phase on CI green status and measured build time impact.

**Feature flag rollout for language standard adoption.** In a large monorepo, language standard adoption can be rolled out per-directory or per-target using build system flags. This allows early adopters to experiment with new features while the majority of the codebase remains at the stable standard version. A staff engineer designs this rollout mechanism and defines the criteria for graduating from early adopter to organization-wide adoption.

