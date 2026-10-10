## C++26 Coming Features

C++26 is the standard set to ratify in 2026 and ship through 2027. It is the largest single release since C++20, with reflection, contracts, senders/receivers (std::execution), and dozens of library additions. Pattern matching did not make the cut and is covered below as an outlook item. This is the inventory based on papers adopted as of the most recent committee meetings and the implementations already shipping in mainline compilers.

### Reflection (P2996)

Static reflection over types, members, functions, and namespaces. The first standardized compile-time reflection facility in C++.

```cpp
#include <meta>

struct Point { int x; int y; };

constexpr auto members_of_point() {
    return std::define_static_array(
        std::meta::nonstatic_data_members_of(
            ^^Point, std::meta::access_context::current()));
}

template <typename T>
constexpr auto field_names() {
    std::vector<std::string_view> names;
    constexpr auto ctx = std::meta::access_context::current();
    template for (constexpr auto m :
                  std::meta::nonstatic_data_members_of(^^T, ctx)) {
        names.push_back(std::meta::identifier_of(m));
    }
    return names;
}
```

The `^^Type` operator (the **reflection operator**) yields a `std::meta::info` value. Operations like `nonstatic_data_members_of`, `identifier_of`, `type_of`, `value_of` query the reflection. The `template for` is a compile-time expansion construct.

What it enables.

- Automatic serialization: walk the members, format each.
- ORM mappers without macros.
- Compile-time enum-to-string and string-to-enum (replacing `magic_enum`).
- Generated visitor implementations.
- Type-safe dependency injection containers.

EDG, Clang, and GCC have implementations of P2996 in branches as of 2026. The syntax is frozen with the C++26 draft. Production usage waits for shipping compilers.

### Pattern Matching (P2688) - Not in C++26

A structured `match` expression (sometimes called `inspect`). Replaces nested `if`/`switch`/`std::visit` chains.

```cpp
auto describe = [](const Shape& s) -> std::string {
    return s match {
        Circle{.r = let r}        => std::format("circle r={}", r),
        Square{.side = let s}     => std::format("square s={}", s),
        Triangle{a, b, c} if a == b && b == c => "equilateral",
        _                         => "other",
    };
};
```

Supports type patterns (`Circle{...}`), structured-binding patterns, guard clauses (`if`), wildcards (`_`), and binding (`let`). Works on `std::variant`, `std::optional`, `std::tuple`, and class types.

Behind the scenes it lowers to `std::visit` for variants and direct member access for structs. The motivating use cases are AST walkers, network protocol decoders, and any code that today uses `std::visit` with a `overloaded` lambda set.

Status: did not make C++26. Still actively under design and now targeting a later standard, likely in a constrained form first, with full destructuring patterns following.

### Contracts (P2900)

Pre-conditions, post-conditions, and assertions as first-class language features.

```cpp
int sqrt_floor(int n)
    pre (n >= 0)
    post (r: r * r <= n && (r + 1) * (r + 1) > n)
{
    int r = 0;
    while ((r + 1) * (r + 1) <= n) ++r;
    contract_assert(r >= 0);
    return r;
}
```

Three contract kinds: `pre`, `post`, `contract_assert`. Each is a Boolean expression over the function's parameters and (for `post`) the return value `r`.

Contract evaluation has three modes selected at translation time: `ignore` (no codegen), `enforce` (call the violation handler on failure, default), `observe` (call handler but continue). The handler is a customization point. Production uses fail-fast in debug builds, telemetry-only in release.

Contracts replace `assert` with a richer model. They participate in optimization: a `pre (p != nullptr)` lets the compiler treat `p` as non-null after the call, similar to `[[assume]]` but visible at the contract definition site.

The committee has churned on contracts for a decade. P2900 is the consensus design after several false starts (P0542 was withdrawn from C++20). Implementation prototypes exist in GCC and Clang branches.

### Execution / Senders and Receivers (P2300)

`std::execution` is the standard async framework. Senders describe lazy work. Receivers consume completion. Schedulers control where work runs.

```cpp
##include <execution>

namespace ex = std::execution;

auto sched = thread_pool.scheduler();

auto work = ex::schedule(sched)
          | ex::then([] { return read_file("data.txt"); })
          | ex::then([](std::string s) { return parse(s); })
          | ex::then([](Parsed p) { return process(p); });

auto [result] = std::this_thread::sync_wait(std::move(work)).value();
```

`schedule` produces a sender that completes on the given scheduler. `then` chains transformations. `let_value`, `when_all`, `let_error`, `stopped_as_error` cover the rest of the structured-concurrency vocabulary.

Awaitable integration with coroutines is bidirectional: `co_await` over a sender works, and a `task<T>` is itself a sender. The model unifies callbacks, futures, and coroutines under one type system.

Reference implementation: NVIDIA's `stdexec`. Tracks the latest paper draft. GCC and libstdc++ are implementing the standardized form for shipping in C++26.

### Linear Algebra (P1673)

`std::linalg` brings BLAS-like operations into the standard library. Built on `std::mdspan`.

```cpp
##include <linalg>

std::array<double, 9> a_data, b_data, c_data;
std::mdspan A{a_data.data(), 3, 3};
std::mdspan B{b_data.data(), 3, 3};
std::mdspan C{c_data.data(), 3, 3};

std::linalg::matrix_product(A, B, C);   // C = A * B
std::linalg::scaled(2.0, A);            // 2 * A as a view
std::linalg::matrix_vector_product(A, x, y);
```

The implementation may dispatch to a vendor BLAS (MKL, OpenBLAS, Accelerate) for performance. The interface is generic over scalar type and `mdspan` layout.

This finally gives standard C++ a portable numeric foundation that does not require Eigen, Armadillo, or hand-rolled kernels.

## std::hive (P0447)

A bucketed container for stable iterators across insertion and erasure, optimized for many-element scenarios with frequent insertions/erasures and non-contiguous iteration. The replacement for `std::list` in performance-sensitive code.

```cpp
##include <hive>

std::hive<Particle> particles;
auto h1 = particles.insert(Particle{...});
particles.erase(h1);    // does not invalidate other iterators
```

Built on a chunked vector model. Insertion is O(1) amortized. Iteration is sequential through chunks. Erasure marks slots for reuse. Better cache behavior than `std::list` and stable iterator/pointer semantics that `std::vector` cannot provide.

## std::optional<T&> (P2988)

An optional reference. Long debated, finally adopted.

```cpp
std::optional<int&> first_match(std::vector<int>& v, int target);

if (auto x = first_match(vec, 42)) {
    *x = 0;   // mutates the element through the reference
}
```

Replaces the `T*` idiom for "maybe a reference" return values with a type that does not invite null-pointer arithmetic. The reference is stored as a pointer internally, so size and cost are identical.

## Networking TS Revival

The Networking TS based on Asio (P2762 and successors) was withdrawn in 2020 over disagreement on integration with `std::execution`. C++26 is on track to ship a redesigned networking library built on senders. TCP, UDP, address resolution, timers. Standardized socket API at last.

Status: design ongoing, consensus emerging, but not guaranteed for the C++26 deadline. May slip to C++29.

## Other Adopted Features

- **`std::inplace_vector`** (P0843): a vector with fixed compile-time capacity, no allocation.
- **`std::function_ref`** (P0792): non-owning callable wrapper (lighter than `std::function`).
- **`std::submdspan`**: slicing for `std::mdspan`.
- **Concurrent containers**: `std::concurrent_queue` and friends (papers in flight).
- **SIMD**: `std::simd` (P1928) for portable vector types.
- **Erroneous behavior for uninitialized reads**: P2795 makes reading uninitialized storage produce a defined-but-implementation-specific value plus a diagnostic, replacing one of the most common UB-driven security bugs.
- **`#embed`** (already in C23, brought into C++26): include binary files as initializer data.
- **`std::dims`** convenience aliases for `std::extents`.

## Tooling Forecast

The release will pressure build systems harder than C++20 did.

- **Reflection** requires the compiler to expose internal type metadata to user code. Linkers must preserve information that historically was stripped. Debug formats may need extension.
- **Modules + reflection** intersect in the question of "can you reflect across a module boundary". The answer being designed is yes, but it requires BMIs to carry richer metadata.
- **Contracts** add a runtime ABI surface (the violation handler). Cross-library compatibility requires the handler to be unambiguously selected.
- **Senders** integrate with coroutines and existing thread pools, which means runtime libraries (folly, libunifex, asio) need to be reconciled or wrapped.

Compile times will rise. Reflection in particular trades compile time for runtime simplicity. Production codebases will land reflection behind module boundaries to amortise cost.

## Compiler Tracking (Early 2026)

| Feature | Earliest implementation |
|---|---|
| Reflection | Clang fork (P2996), EDG, GCC branch |
| Pattern matching | Clang prototype (`-fpattern-matching`) |
| Contracts | GCC 14 branch, Clang 19 branch |
| std::execution | NVIDIA stdexec (production-quality), libstdc++ in flight |
| std::linalg | Reference impl based on BLAS, partial GCC 15 |
| std::hive | plf::colony (the proposal author's library) |
| std::inplace_vector | Boost.Container has equivalent today |
| std::simd | libstdc++ experimental, Clang/Intel forks |

Targeting C++26 in production at the moment means picking features available in your toolchain and waiting on the rest. By 2027 the main compilers will catch up to the ratified standard.

## Junior to FAANG / Senior at FAANG

A junior in 2026 should track which C++26 features have shipped in the team's compiler, avoid using bleeding-edge feature flags in production code, and understand the conceptual shape of reflection, pattern matching, and senders.

A senior is expected to drive C++26 adoption strategically: pick features that retire bespoke infrastructure (reflection retiring `magic_enum` and macro-driven serialization, senders retiring custom `task<T>` libraries), evaluate ABI implications of contracts, prototype against reference implementations (NVIDIA stdexec, Clang reflection branch), and feed real-world feedback into the committee process. They should know which papers are still moving (networking, executors policy), which have stabilised, and how to design today's APIs so they can absorb tomorrow's reflection and pattern-matching features without source breakage.
