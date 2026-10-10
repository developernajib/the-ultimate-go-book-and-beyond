## C++ Evolution: C++23 and C++26

> **Junior to FAANG:** Use C++20 today, target C++23 if your toolchain supports it. Do not bet your design on C++26 features. They will slip.
>
> **Senior at FAANG:** Read WG21 papers selectively. Track only the proposals your codebase will actually adopt. Most papers die in committee.

This chapter is opinionated about which features are real, which are vaporware, and which are still landing. Paper numbers are the WG21 document IDs (Pxxxx) which are stable references, not version numbers. Status as of WG21 meetings through early 2026.

### What shipped in C++23

C++23 was the "fix the rough edges of C++20" release. Its big wins were quality-of-life features.

**`std::expected<T, E>` (P0323).** Result-style error handling. Replaces the awkward `std::variant<T, E>` or out-parameter patterns. Reaches `<expected>` in libstdc++ 12, libc++ 16, MSVC 19.33. Use it now.

```cpp
std::expected<Config, ParseError> load(std::string_view path);

if (auto cfg = load("server.toml")) {
    run(*cfg);
} else {
    log_error(cfg.error());
}
```

**`std::print` and `std::println` (P2093).** Finally, formatted output without `<iostream>`. Backed by `std::format` from C++20.

```cpp
std::println("port={}, host={}", port, host);
```

**`std::generator` (P2502).** Coroutine-based lazy iteration. Real, usable lazy sequences in the standard library at last.

```cpp
std::generator<int> fibs() {
    int a = 0, b = 1;
    while (true) {
        co_yield a;
        std::tie(a, b) = std::tuple{b, a + b};
    }
}
```

**Deducing `this` (P0847).** Member functions can deduce their object parameter, enabling perfect forwarding of `*this` and CRTP without the boilerplate. Significant for library authors.

```cpp
struct Printable {
    auto print(this auto&& self) {
        std::println("{}", self.format());
    }
};
```

**`if consteval` (P1938).** Distinguishes compile-time from runtime in `constexpr` functions.

**Multidimensional subscript `arr[i, j]` (P2128).** For matrix and tensor libraries. Replaces `arr(i, j)` operator-call hacks.

**Ranges improvements:** `views::zip`, `views::adjacent`, `views::chunk`, `views::slide`, `views::join_with`, `to<Container>`. Ranges in C++23 are finally usable for normal data manipulation.

**`std::flat_map` and `std::flat_set` (P0429).** Sorted-vector-backed associative containers. Cache-friendlier than `std::map` for small to medium sets where lookup dominates.

**`std::mdspan` (P0009).** Multidimensional view. Bridges to numerical computing and tensor work.

What did **not** make C++23: networking, executors (P0443R14 has been in committee for 7+ years), pattern matching, contracts, reflection, modules in a usable state.

### C++26: what is on track

C++26 freeze is expected at the February 2026 Sofia meeting (just past as of this writing) with publication later in 2026. Adoption in compilers will trail by 1-3 years. Some features land partially before the freeze.

#### Real and likely shipping

**Reflection (P2996, "static reflection for C++").** This is the most important addition since lambdas. It gives you compile-time introspection: list members of a class, get their types, names, and attributes, generate code based on that. Replaces the macro-and-codegen tooling that has cluttered C++ for decades.

```cpp
// Adopted C++26 syntax. The reflection operator is ^^ (two carets),
// changed from a single ^ late in the process to avoid clashing with
// Apple's blocks extension.
struct Point { int x; int y; };

constexpr auto members = std::meta::nonstatic_data_members_of(
    ^^Point, std::meta::access_context::current());
// Compile-time access to {x, y} with their types.
```

This is the first C++ standard reflection that actually shipped. Implementations in EDG and Clang are already prototyped. If you write serializers, ORMs, RPC bindings, or test frameworks today using macros, this will redefine your architecture.

**Contracts (P2900).** Pre/post-conditions and assertions as first-class language features. Replaces hand-rolled `assert` macros and library-level contract systems.

```cpp
int sqrt_int(int x)
    pre(x >= 0)
    post(r: r * r <= x && (r + 1) * (r + 1) > x)
{
    // ...
}
```

The semantic model is configurable per build mode: each assertion is evaluated under ignore, observe (check and continue), enforce (check and terminate), or quick_enforce. This shipped after years of debate. Adoption will be slow because legacy code does not have contracts.

**Pattern matching (P2688, P1371).** Long-awaited replacement for chained `if`/`else` and `std::visit` for `std::variant`. Did not make the C++26 freeze. Now targeting a later standard, realistically C++29.

```cpp
// Tentative syntax
auto area = shape match {
    Circle{r}        => 3.14 * r * r;
    Rectangle{w, h}  => w * h;
    Triangle{b, h}   => 0.5 * b * h;
};
```

**Senders and receivers / executors (P2300).** The successor proposal to P0443. Async composition primitive. This is the foundation for portable async I/O, GPU kernel launch, and structured concurrency. Targeted for C++26 but partial. Implementations: stdexec (NVIDIA reference), libunifex (Meta).

**`std::simd` (P1928).** Portable explicit SIMD. Maps to AVX/NEON/SVE. Less ergonomic than Highway or xsimd but standard. Ships in C++26.

**`std::linalg` (P1673).** BLAS-style linear algebra. Wraps vendor BLAS implementations. Niche but valuable for numerical code.

**Hazard pointers and RCU (P2530, P2545).** Lock-free programming primitives standardized. Used in HFT, kernels, and database engines for years via Folly and userspace RCU. Now standard.

#### Watch carefully, may slip

**Networking TS.** The networking proposal based on Boost.Asio has been stuck in committee since 2014. Current status is "blocked on executors". Realistic shipping date: C++29 or never as a TS. In practice, use Boost.Asio or stdexec.

**Modules.** Modules shipped in C++20. Adoption in 2026 is still poor. MSVC has the most complete implementation, GCC and Clang are catching up. Build system support (CMake, Bazel) is maturing but not yet smooth. Bet on modules for new code in 2027+. Mixing modules and headers in the same TU still has rough edges.

**Coroutines.** Shipped in C++20. The standard library only ships `std::generator` (C++23) and the low-level customization points. There is no `std::task`, no `std::async_main`. You bring your own executor. cppcoro, folly::coro, libunifex fill the gap. Status unchanged in C++26.

#### Vaporware or postponed

- **Garbage collection (P0933 and predecessors).** Quietly removed. Not coming back.
- **Static exceptions (P0709, "Zero-overhead deterministic exceptions").** Herb Sutter's proposal for value-based error handling. Stuck. `std::expected` partially fills this need.
- **C++ epochs / language versioning.** Discussed, not happening.

### What to bet on, what to ignore

Bet on:

1. **`std::expected`.** Use today.
2. **`std::print`.** Use today.
3. **Reflection (P2996).** Architect new code with it in mind for 2027-2028 adoption.
4. **Senders and receivers (P2300).** If you write async code, learn the model now via stdexec.
5. **Concepts and ranges.** If you have not adopted, do so. C++23 ranges are finally complete enough.
6. **Modules.** Pilot in a new project. Do not retrofit on a 10M-line codebase yet.

Ignore until further notice:

1. **Networking TS.** Use Boost.Asio.
2. **Pattern matching.** Use `std::visit` with overload helpers.
3. **`std::async` and `std::future`.** Use a real executor.
4. **Older proposals that have not progressed in 2+ years.** Most die quietly.

### How to track WG21 in practice

The committee meets three times a year. Each meeting publishes a mailing of papers. Links:

- isocpp.org/std/the-committee
- wg21.link/PXXXXR0 redirects to the latest revision of any paper.
- The "tony tables" are concise before/after summaries of changes per release.

Useful blogs and trackers: cppreference.com (canonical reference, lags by ~6 months), cor3ntin.github.io (Corentin Jabot's blog), Herb Sutter's blog (chair of WG21). Follow @cor3ntin on social platforms for paper status updates.

For staff-engineer-level work, you do not need to read every paper. You need to skim the "tony tables" of each release, the executor and reflection proposals (the two big ones), and any paper that touches a feature you actively use.

### Compiler support snapshot (early 2026)

| Feature | GCC | Clang | MSVC |
|--------------------------|----------|----------|----------|
| C++23 core | 13+ | 17+ | 19.36+ |
| `std::expected` | 12+ | 16+ | 19.33+ |
| `std::print` | 14+ | 18+ | 19.37+ |
| `std::generator` | 14+ | 18+ | partial |
| Modules (usable) | 14+ partial | 17+ partial | best |
| Coroutines | 11+ | 14+ | 19.28+ |
| Concepts | 10+ | 13+ | 19.30+ |
| Reflection (P2996) | preview | EDG demo | not yet |
| Senders (P2300, stdexec) | external | external | external |

For a serious C++ shop in 2026, the realistic baseline is GCC 13 / Clang 17 / MSVC 19.37 with `-std=c++23`. Use `-std=c++26` only on hobby code until your CI matrix supports it.

### A practical adoption roadmap

If you own a C++ codebase right now:

- **Q1 2026:** baseline to C++20 if not already. Adopt concepts in new code.
- **Q2 2026:** baseline to C++23 in non-shipping libraries. Roll out `std::expected` for new error paths.
- **Q4 2026:** evaluate modules in a non-critical service. Watch reflection landing in compilers.
- **2027:** baseline to C++23 across the codebase. Pilot reflection-based code generation to replace macro-driven serialization.
- **2028:** C++26 baseline likely available. Real reflection-driven refactors begin.

Codebases that ship libraries with ABI commitments (Boost, Qt, Abseil) trail this by 1-2 years. Codebases with full control of the build (Chrome, internal Google, internal Meta) lead it by 6-12 months.
