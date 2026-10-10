## Part V: What FAANG Actually Uses in Production

Understanding what C++ standards are used at major technology companies matters for interview preparation, career decisions, and practical engineering.

### The Reality: C++17 Is the Baseline

As of 2025, most large-scale C++ codebases at Google, Meta, Apple, Amazon, and Microsoft standardize on C++17 with selective C++20 adoption. The reasons are practical:

**Compiler and toolchain readiness**. A feature being in the standard and a feature being production-ready across all three major compilers (GCC, Clang, MSVC) with optimized codegen are different things. C++17 has been stable across all compilers since approximately 2019. C++20 features achieved full support around 2022-2023. C++23 features are still being implemented.

**Build system support**. Modules, the most architecturally significant C++20 feature, requires build systems to understand module dependencies. CMake support for modules is experimental. Bazel (Google's build system) has limited module support. Most large codebases cannot adopt modules without significant build infrastructure work.

**Codebase migration cost**. A codebase with millions of lines of C++17 code cannot be migrated overnight. Companies adopt new standard features incrementally, often feature-by-feature through style guide updates.

### What Is Commonly Used in Production

**C++17 features used everywhere**:
- `std::optional`, `std::variant`, `std::string_view` - universal vocabulary types
- Structured bindings - universal in range-for loops
- `if constexpr` - universal in template code
- `std::filesystem` - widely used, though many codebases have legacy wrappers
- Nested namespaces, inline variables, CTAD - universal
- Parallel STL - used in some performance-critical paths, but many teams prefer custom thread pools

**C++20 features gaining adoption**:
- Concepts - increasingly used for new template code, replaces SFINAE
- Ranges - selective adoption. Some teams find the compile-time cost and debugging experience problematic
- `std::format` - adopted where available, but `fmt::format` (the library it was based on) has been in use for years
- `std::span` - widely adopted for API boundaries
- `std::jthread` and stop tokens - adopted in new code
- Three-way comparison - adopted for value types
- `consteval` and `constinit` - adopted in infrastructure code

**C++20 features with limited production adoption**:
- Coroutines - used at Meta (Folly), Google (internal frameworks), and in game engines, but the low-level API is painful without library support
- Modules - almost no large codebase has migrated. Build system support is the blocker

**C++23 features in production**: effectively none yet. Companies use equivalent functionality from internal libraries (Google's Abseil, Meta's Folly, Bloomberg's BDE) that predate standardization.

### Internal Alternatives Predate the Standard

Many "new" standard features were inspired by internal libraries that FAANG companies have used for years:

| Standard Feature | Prior Art |
|---|---|
| `std::optional` | `absl::optional`, `folly::Optional` |
| `std::variant` | `absl::variant`, `folly::dynamic` |
| `std::string_view` | `absl::string_view`, `folly::StringPiece` |
| `std::format` | `fmt::format` (now `std::format`), `absl::StrFormat` |
| `std::span` | `absl::Span`, `gsl::span` |
| `std::expected` | `absl::StatusOr`, `folly::Expected` |
| `flat_map/flat_set` | `absl::flat_hash_map`, `folly::sorted_vector_map` |
| `std::jthread` | Custom thread wrappers in every codebase |

This is why "what standard do they use?" is less important than "what features do they use?" The answer is: the functionality exists in production via library alternatives, regardless of the standard version the compiler targets.

### Interview Implications

In C++ interviews at FAANG, you are expected to know:

1. **C++17 features thoroughly** - `optional`, `variant`, `string_view`, structured bindings, `if constexpr`. These are assumed knowledge.
2. **C++20 concepts** - understanding what they are and how they improve template code. You may not be expected to write them from memory, but you should understand them.
3. **Move semantics, RAII, smart pointers** - these are C++11/14 but are the most tested topics.
4. **The existence of C++23/26 features** - knowing what is coming shows you are engaged with the language, but nobody expects you to use `std::mdspan` in a whiteboard interview.

The gap between "what exists in the standard" and "what you will use in your first week on the job" is real. Focus your study on C++17 and the foundational C++20 features.

### Company-Specific Notes

**Google**: Uses C++17 as the baseline with Abseil providing forward-compatible types. The Google C++ Style Guide is publicly available and prescriptive. Exceptions are banned. `absl::StatusOr` replaces both exceptions and `std::expected`. Modules are not in use. Coroutines are used internally in some infrastructure.

**Meta (Facebook)**: Uses C++17/20 with Folly as the foundational library. Coroutines are heavily used in Folly's async framework (`folly::coro`). Ranges adoption is growing. Meta tends to be more aggressive in adopting newer features than Google.

**Microsoft**: Uses C++17/20 extensively. MSVC is one of the three major compilers, so Microsoft teams often get early access to new features. Modules are used in some internal projects. The Windows kernel and Office have their own C++ dialects and patterns.

**Apple**: Uses C++17 with selective C++20 features in performance-critical systems (audio, graphics, ML frameworks). Objective-C++ interop constrains which features can be used in mixed-language codebases.

**Amazon**: C++17 baseline with a conservative adoption approach. Internal services use a mix of C++ and Java/Rust. AWS SDK for C++ uses modern C++11/14/17 features.

### Adoption Timeline Pattern

A consistent pattern emerges across all major companies:

| Standard | Year Standardized | Year of Broad FAANG Adoption |
|----------|------------------|------------------------------|
| C++11    | 2011             | 2014-2015                    |
| C++14    | 2014             | 2016-2017                    |
| C++17    | 2017             | 2019-2020                    |
| C++20    | 2020             | 2023-2024 (partial)          |
| C++23    | 2023             | 2026+ (projected)            |

The lag is roughly 2-4 years from standardization to production adoption, driven by compiler support maturity, toolchain integration, and the cost of codebase migration.

---
