## C++ Core Guidelines Checker and the Lifetime Profile

The C++ Core Guidelines, started by Bjarne Stroustrup and Herb Sutter in 2015, are the closest thing C++ has to a Rust-borrow-checker-equivalent. The **Lifetime profile** in particular formalizes a set of static rules a compiler can check to rule out common memory-safety bugs.

By 2026 the Lifetime profile is partially implemented in MSVC and clang, with active work to align both. It is not sound. It is not as strong as Rust. It is the best the C++ language has natively without resorting to external verification tooling.

### The Guidelines Support Library (GSL)

The GSL is a header-only library providing types and functions the Guidelines reference:

```cpp
#include <gsl/gsl>

void process(gsl::span<const int> data, gsl::not_null<Logger*> logger);

void caller(std::vector<int>& v) {
    Logger l;
    process(v, &l);                  // implicit span construction
}
```

Key types:

- `gsl::span<T>` is a non-owning view of a contiguous range. Replaces raw pointer + length pairs. Standardized as `std::span` in C++20.
- `gsl::not_null<T*>` declares a pointer that must never be null. The constructor checks, downstream code can assume non-null.
- `gsl::owner<T*>` annotates a raw pointer that owns its target. The static analyser knows it requires deletion or move.
- `gsl::czstring` and `gsl::cwzstring` for C-style null-terminated strings, distinguishing them from arbitrary char pointers.

GSL types do not change runtime behavior materially. They give the static analyser semantic information that lets it reason about ownership and lifetime.

### The Lifetime profile (Sutter)

Herb Sutter's "Lifetime safety: Preventing common dangling" paper (P1179) describes a set of static rules:

1. Every pointer or reference has a **set of possible owners** at every program point.
2. Operations that modify ownership (delete, move, reassignment, return) update the set.
3. Dereferencing a pointer whose owner set is empty (i.e. dangling) is an error.
4. Returning a pointer to a local is an error because the local goes out of scope.

The analyser computes these owner sets per-statement using local dataflow plus annotations on function signatures. A function signature's annotations tell callers what the function does to its arguments and return value.

```cpp
auto& first(std::vector<int>& v);    // returns reference borrowed from v
gsl::owner<int*> alloc();            // returns owning pointer
void register_observer(Subject& s, gsl::not_null<Observer*> o);
```

Without explicit annotation, the analyser uses heuristics: methods named `data`, `c_str`, `begin`, `end` borrow from the receiver, methods named `release` transfer ownership, etc.

### Real bugs the profile catches

```cpp
std::string_view bad() {
    std::string s = "hello";
    return s;                        // returning view into local
}                                    // s destroyed, view dangles

const char* worse() {
    std::string s = compute();
    return s.c_str();                // same bug, more idiomatic
}

std::span<int> sneaky(std::vector<int> v) {  // by-value param
    return v;                        // span of moved-from local
}
```

The Lifetime profile flags all three. The same bug class shows up across millions of lines of production C++ and is the leading cause of UAF CVEs in C++ codebases.

### Implementations in 2026

#### MSVC

Microsoft has integrated the Lifetime profile into the MSVC analyser, enabled with `/W4 /analyze:plugin EspXEngine.dll` and the `--cpp-core-check-lifetime` profile. By 2026 it covers most local lifetime bugs but lacks full inter-procedural analysis. False positives are notable on heavy template code and on legacy patterns the Guidelines did not anticipate.

#### clang

clang's `-Wlifetime` flag (still experimental in clang 19 in 2026) implements a subset. Active development through the LLVM Lifetime Analysis working group. The clang implementation is closer to the published spec than MSVC's.

#### CppCoreCheck

CppCoreCheck is the MSVC ruleset enforcing other Core Guidelines rules (bounds, type safety, owner semantics) beyond just Lifetime. Integrates with Visual Studio's Code Analysis dialog.

### The honest assessment

The Lifetime profile is a **best-effort heuristic**, not a sound type system. Differences from Rust:

| Property | Rust borrow checker | C++ Lifetime profile |
| --- | --- | --- |
| Soundness | Proved (RustBelt) | Not proved, heuristic |
| Annotation burden | Lifetimes in function signatures | Optional, inferred where possible |
| Coverage | Whole language (safe subset) | Local + signature-annotated |
| False negatives | None in safe code | Known classes |
| Cross-translation-unit | Yes via crate metadata | Limited |
| Adoption | Built into the compiler | Optional analyser plugin |

The Lifetime profile is a pragmatic improvement over no checker at all. It catches real bugs. It does not eliminate the bug class.

### Annotating signatures

The annotations the Lifetime profile understands:

```cpp
[[gsl::Owner(int)]] class my_int_holder { ... };
[[gsl::Pointer(int)]] class my_int_view { ... };

[[clang::lifetimebound]] const T& front(const std::vector<T>& v);
```

`[[clang::lifetimebound]]` is the clang-specific way to mark a parameter whose lifetime constrains the return value. The standard committee has discussed `[[lifetime]]` attributes but has not yet adopted them.

### Span and bounds checking

`std::span<T>` plus the bounds profile catches buffer overflows the type system would otherwise miss:

```cpp
void copy_first_n(std::span<const int> src, std::span<int> dst, size_t n) {
    Expects(n <= src.size());
    Expects(n <= dst.size());
    for (size_t i = 0; i < n; i++) dst[i] = src[i];
}
```

`Expects` is a contract-style precondition. Combined with `gsl::at(span, i)` (bounds-checked element access), you can drive most array-bound bugs out of new code. Existing code with raw pointer + length pairs needs refactoring to benefit.

### CI integration

Realistic pipeline for a project adopting the Core Guidelines:

```
- clang-tidy with bugprone-*, cppcoreguidelines-*, modernize-* checks
- MSVC /analyze with CppCoreCheck and Lifetime plugins
- clang -Wlifetime -Werror=lifetime
- include-what-you-use to keep headers honest
- AddressSanitizer + UBSan in test builds
```

The clang-tidy `cppcoreguidelines-*` checks are the cheapest entry point. They flag specific patterns (raw `new`/`delete`, pointer arithmetic, narrowing conversions, missing initializers). Suppressions accumulate, but they at least force the suppressions to be visible in source.

### The owner annotation

`gsl::owner<T*>` is the type-level encoding of "this raw pointer owns its target":

```cpp
class buffer {
    gsl::owner<char*> data_;
    size_t size_;
public:
    buffer(size_t n) : data_(new char[n]), size_(n) {}
    ~buffer() { delete[] data_; }
    buffer(const buffer&) = delete;
    buffer& operator=(const buffer&) = delete;
};
```

The analyser knows `data_` must be deleted exactly once. Failing to delete in the destructor is a leak, double-delete is detected if the analyser sees the second delete on the same path.

The honest limitation: `gsl::owner` annotates intent. It does not enforce. A bug that bypasses the analyser still compiles and runs. Compare with `std::unique_ptr<T>`, which enforces at the type level and should be preferred everywhere `gsl::owner` is tempting.

### Where the profile falls short

- **Containers**. Iterators into a container are invalidated by reallocation. The profile catches the simple cases (returning iterator after `push_back` on the local). It misses more complex cases.
- **Coroutines**. Lifetime of locals across `co_await` points is subtle, the profile is still catching up.
- **Virtual dispatch**. Cross-class lifetime is hard to track without whole-program info.
- **Exceptions**. Stack unwinding paths multiply the analysis cost.
- **Templates**. Lifetime conclusions depend on instantiation arguments. The profile typically analyses post-instantiation, which works but produces per-instantiation diagnostics.

### What to do today

For new C++ code in 2026:

1. Use `std::span`, `std::string_view`, `std::array`, `std::unique_ptr`, `std::shared_ptr`. Reach for raw owning pointers only with explicit `gsl::owner` annotation.
2. Enable clang-tidy `cppcoreguidelines-*` and `bugprone-*` checks.
3. Enable MSVC `/analyze:plugin EspXEngine.dll` or clang `-Wlifetime` where the platform supports it.
4. Treat the Lifetime profile diagnostics as warnings to fix, not noise to suppress.
5. Combine with ASan + UBSan in test builds and fuzzing for the parts that touch untrusted input.

For existing C++ code:

1. Adopt the profile in advisory mode first to baseline the warnings.
2. Burn down by category, starting with the highest-stakes modules.
3. Refactor toward smart pointers and span types, do not just suppress.
4. Recognize that the profile is a tool for hardening, not for assurance arguments. Combine with sound static analysis if the stakes warrant it.

> **Senior at FAANG.** The Lifetime profile gets you maybe 60 percent of the way to Rust's safety story for C++ code that is already idiomatic modern C++. For C++03 codebases it gets you maybe 20 percent because the legacy patterns confuse the analyser. The profile is not magic. It is a good static checker that is improving each release. Treat it as a partner to fuzzing and sanitisers, not a replacement for either.
