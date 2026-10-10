## Attributes and C++23

C++ attributes (`[[ ... ]]`) annotate declarations, statements, and expressions with information the compiler can use for diagnostics, optimization, or ABI hints. The set has grown each standard. C++23 added `[[assume]]`, the most powerful runtime-optimization hint in the language.

### [[nodiscard]]

Marks a return value as important. Calling the function and discarding the result triggers a warning.

```cpp
[[nodiscard]] int* allocate();
[[nodiscard("must be checked")]] bool try_lock();   // C++20: with reason

allocate();           // warning: ignoring return value
try_lock();           // warning: must be checked
```

Apply to factory functions, error-returning APIs, and anything that allocates. The standard library marks `std::async`, `std::vector::empty`, `std::launder`, and most error-returning calls. Apply yours liberally. The cost is zero. The benefit is catching bugs at compile time.

`[[nodiscard]]` on a type makes every function returning that type implicitly nodiscard.

```cpp
struct [[nodiscard]] Result { /* ... */ };
Result compute();
compute();   // warning even though compute itself is not nodiscard
```

## [[likely]] and [[unlikely]]

Branch-prediction hints on labels in `if`, `for`, `while`, `switch`. The compiler arranges code layout so the hot path is the fall-through and the cold path is the jump.

```cpp
if (ptr == nullptr) [[unlikely]] {
    return error_code::null;
}

for (auto&& x : v) {
    if (x.invalid()) [[unlikely]] continue;
    process(x);
}

switch (op) {
    case kAdd: [[likely]]   return a + b;
    case kSub:              return a - b;
    case kErr: [[unlikely]] throw error{};
}
```

The hint affects code layout and basic-block ordering, not the speculation heuristic of the CPU itself. On modern Intel/AMD chips, `[[likely]]` and `[[unlikely]]` shave a few cycles per branch by keeping the hot path in the I-cache and avoiding a taken branch. Profile-guided optimization (PGO) is more effective and should be preferred when the workload is profile-able. Use the attributes for paths PGO cannot reach (rare error handlers in long-tail latency code).

## [[no_unique_address]]

Allows the compiler to overlap an empty subobject with another field, reducing the type's size. Critical for empty-base-optimization (EBO) on data members.

```cpp
template <typename Allocator>
struct vector_storage {
    [[no_unique_address]] Allocator alloc;
    void* data;
    std::size_t size;
};

// sizeof(vector_storage<std::allocator<int>>) == 16 on 64-bit
// without [[no_unique_address]] it would be 24.
```

`std::vector`, `std::function`, and most STL types use `[[no_unique_address]]` to compress empty allocators, deleters, and comparators. In your own code, apply it to fields of empty types whose semantics you do not need to be addressable.

The C++23 standard tightened the rules. Two `[[no_unique_address]]` fields of the same type still occupy distinct addresses (the compiler must assign different offsets), but each may overlap with a non-`[[no_unique_address]]` field of a different type.

MSVC also supports `[[msvc::no_unique_address]]` because the standard attribute changes ABI, and Microsoft did not want a silent ABI break across compiler versions. New code targeting MSVC should use the namespaced form.

### [[fallthrough]]

Suppresses warnings on intentional `switch` fall-through. Without it, modern compilers warn on case-to-case fall-through to catch missing `break` bugs.

```cpp
switch (state) {
    case kInit:
        prepare();
        [[fallthrough]];
    case kReady:
        run();
        break;
    case kDone:
        finalise();
        break;
}
```

Place `[[fallthrough]];` as a null statement immediately before the next `case`. Forgetting it triggers `-Wimplicit-fallthrough`.

### [[deprecated]]

Marks an entity as deprecated. Each use produces a warning.

```cpp
[[deprecated("use parse_v2 instead")]] int parse_v1(const char* s);
[[deprecated]] using OldType = NewType;

class [[deprecated]] LegacyApi { /* ... */ };
```

The optional message guides users to the replacement. Useful during multi-release deprecation cycles. Pair with `#pragma warning(disable: ...)` only at the boundary where the legacy code is still used internally.

### [[carries_dependency]]

A relic of `memory_order_consume` that almost no compiler implements correctly. Can be ignored in 2026. The committee is moving toward removing or revising consume semantics. Do not use this attribute.

### [[noreturn]]

Marks a function that never returns: it throws, calls `std::abort`, or loops forever. The compiler can omit return-handling code at call sites and improve dead-code analysis.

```cpp
[[noreturn]] void panic(const char* msg) {
    std::println(stderr, "fatal: {}", msg);
    std::abort();
}

int parse_or_die(std::string_view s) {
    if (auto v = parse(s)) return *v;
    panic("bad input");
    // no return needed, compiler knows panic does not come back
}
```

### [[maybe_unused]]

Suppresses unused-entity warnings on parameters, locals, types, and functions. Useful for parameters that exist for an interface contract but are not always used.

```cpp
void on_event([[maybe_unused]] EventId id, const Payload& p) {
    // id may or may not be referenced depending on build config
    process(p);
}
```

### [[assume]] (C++23)

The big new one. `[[assume(expr)]]` tells the compiler that `expr` is true at this program point. The compiler may use this fact for optimization. Violating the assumption is undefined behavior.

```cpp
void process(int* p, std::size_t n) {
    [[assume(n > 0)]];
    [[assume(p != nullptr)]];
    [[assume(n % 4 == 0)]];

    for (std::size_t i = 0; i < n; ++i) p[i] *= 2;
}
```

The assumptions enable.

1. Loop unrolling (knowing `n` is a multiple of 4).
2. Vectorisation without runtime guards.
3. Removal of null checks inside the loop.
4. Stronger range analysis on `i`.

The optimizer **does not check** the assumption at runtime. If the assumption is wrong, behavior is undefined. The expression must be free of side effects: the standard allows the compiler to discard the expression entirely, which means a `[[assume(f())]]` where `f` is a runtime function does not call `f`.

Real codegen impact (Godbolt-class examples). A loop iterating `n` times with `[[assume(n % 16 == 0)]]` and SIMD-friendly types vectorises 16-wide on AVX-512 with no scalar tail. Without the assume, the compiler emits a vectorised body **plus** a scalar tail to handle the residual, blowing up code size and adding a hard-to-predict branch.

A division by a constant `[[assume(d > 0)]]` lets the compiler emit reciprocal-multiplication codegen instead of `idiv`, which on x86-64 saves dozens of cycles per division.

`[[assume]]` competes with `__builtin_assume` (Clang), `__assume` (MSVC), and `__builtin_unreachable()` (GCC's idiom). C++23 unifies them.

## When Not to Use [[assume]]

- The condition is checkable cheaply at runtime. Use `assert` and a debug build.
- The condition is part of an API contract. Use a precondition check or `[[expects]]` (C++26 contracts).
- The compiler can already prove it. Redundant assumptions can confuse the optimizer.

`[[assume]]` is for hot inner-loop hints where the runtime check would itself be the bottleneck.

### Vendor Extensions

Compilers carry their own attribute namespaces. Common ones.

```cpp
[[gnu::always_inline]]      // GCC, Clang
[[gnu::cold]]
[[gnu::hot]]
[[gnu::flatten]]
[[clang::lifetimebound]]    // Clang only
[[msvc::forceinline]]       // MSVC
[[msvc::no_unique_address]]
```

Cross-compiler code uses `__has_cpp_attribute` to gate them.

```cpp
#if __has_cpp_attribute(gnu::always_inline)
#  define ALWAYS_INLINE [[gnu::always_inline]]
#elif __has_cpp_attribute(msvc::forceinline)
#  define ALWAYS_INLINE [[msvc::forceinline]]
#else
#  define ALWAYS_INLINE inline
#endif
```

### Junior to FAANG / Senior at FAANG

A junior should mark factory functions and error-returning APIs `[[nodiscard]]`, hint cold paths with `[[unlikely]]`, suppress unused-parameter warnings with `[[maybe_unused]]`, and apply `[[no_unique_address]]` to empty allocator/deleter members.

A senior is expected to use `[[assume]]` to extract vectorization and division-by-constant wins on hot paths, audit the compiler's resulting codegen on Godbolt or `objdump`, weigh `[[assume]]` against runtime asserts in safety-critical code, design APIs whose return types are themselves `[[nodiscard]]`, and integrate vendor attributes through `__has_cpp_attribute`. They should know why `[[carries_dependency]]` is moribund, why `[[no_unique_address]]` was an ABI break on MSVC, and why PGO usually beats manual `[[likely]]` placement.
