## consteval and Immediate Functions

`consteval` declares an immediate function. The function exists only at compile time. A non-constant call is a compile-time error, not a runtime fallback. This single distinction makes `consteval` the right tool for compile-time-only computation, while `constexpr` remains the tool for code that *may* run at compile time.

## The Hard Difference

```cpp
constexpr int sq_relaxed(int x) { return x * x; }  // may run at runtime
consteval int sq_strict(int x) { return x * x; }   // must run at compile time

int n = read_int();
sq_relaxed(n);   // OK, runtime call
sq_strict(n);    // ERROR: not a constant expression
sq_strict(7);    // OK, evaluated at compile time, no code emitted
```

A `consteval` function emits no runtime body. The compiler may not even include its symbol in the object file. A `constexpr` function emits a runtime body that is also callable at compile time.

The mental model:

- Use `constexpr` when you want the function to be usable from generic code that may itself be either runtime or compile time.
- Use `consteval` when calling at runtime would be a bug.

## Replacing Template Metaprogramming

Pre-C++20 compile-time computation went through template recursion or constexpr-via-recursion. Both are awkward. `consteval` lets you write a normal function and get the same guarantee.

```cpp
// C++03 template metaprogramming.
template <int N> struct Fact { static constexpr int v = N * Fact<N-1>::v; };
template <> struct Fact<0> { static constexpr int v = 1; };
constexpr int x = Fact<10>::v;

// consteval version.
consteval int fact(int n) {
    int r = 1;
    for (int i = 2; i <= n; ++i) r *= i;
    return r;
}
constexpr int x = fact(10);
```

The consteval version is a normal function. It compiles faster because no template instantiation explosion happens. It debugs better because compiler errors point at the function body, not at a chain of partial specializations.

This is the pattern: **write the algorithm normally, mark it `consteval`, call it from a `constexpr` initializer.**

## Hidden constexpr Propagation

A function called from inside a `consteval` function must itself be reachable as a constant expression. The compiler propagates this transitively. You cannot call a runtime-only function from a `consteval` function, even on a path that is not taken.

```cpp
void log_to_file(const char*);   // runtime-only

consteval int validate(int x) {
    if (x < 0) log_to_file("negative");   // ERROR even if x >= 0 at the call site
    return x * 2;
}
```

The diagnostic is local. The fix is either to mark `log_to_file` `constexpr` (impossible if it touches the filesystem) or to restructure so the runtime-only path is unreachable to the constant evaluator.

`if consteval` (C++23) is the escape hatch.

```cpp
constexpr void maybe_log(const char* msg) {
    if consteval {
        // do nothing, this is compile time
    } else {
        log_to_file(msg);
    }
}
```

The runtime branch is not analyzed during constant evaluation, so calling `maybe_log` from a `consteval` function compiles.

### std::is_constant_evaluated

`std::is_constant_evaluated()` was the C++20 way to ask "am I in a constant context". It is a function returning `bool`, which has a footgun.

```cpp
constexpr int f(int x) {
    if (std::is_constant_evaluated()) return /* compile-time path */;
    else                              return /* runtime path */;
}
```

The footgun is that `if (std::is_constant_evaluated())` is a regular `if`, not a `constexpr if`. Both branches are compiled. If the compile-time branch contains a non-constant operation, it is still a valid runtime function (because the compile-time branch is unreachable at runtime). But if the runtime branch is invalid at compile time, the constant evaluation runs the **runtime** branch and fails. Confusing.

C++23 fixed it with `if consteval`.

```cpp
constexpr int f(int x) {
    if consteval {
        // analysed only as a constant expression
    } else {
        // analysed only at runtime
    }
}
```

This is now the canonical form. `std::is_constant_evaluated()` is still legal, mostly for portability with C++20.

## Real Use Cases

### Compile-Time Format String Checking

`std::format` validates the format string at compile time because its constructor is consteval-driven.

```cpp
auto s = std::format("{:d}", "hello");  // compile error: 'd' for non-integer
auto t = std::format("{} {}", 1);        // compile error: too few arguments
```

The `std::format_string<Args...>` type has a `consteval` constructor that parses the format string against the argument types. A bad string fails the consteval call, which surfaces as a clear diagnostic at the format site, not as a runtime exception.

#### Compile-Time Hashing

```cpp
consteval std::uint64_t fnv1a(std::string_view s) {
    std::uint64_t h = 0xcbf29ce484222325ULL;
    for (char c : s) {
        h ^= static_cast<std::uint8_t>(c);
        h *= 0x100000001b3ULL;
    }
    return h;
}

switch (fnv1a(input)) {
    case fnv1a("login"):  return handle_login();
    case fnv1a("logout"): return handle_logout();
    case fnv1a("status"): return handle_status();
}
```

String-keyed dispatch with no runtime hashing. The strings vanish from the binary unless the compiler decides to keep them as constants.

#### Type Registration

```cpp
consteval std::uint32_t type_id(std::string_view name) {
    return fnv1a(name) & 0xFFFFFFFF;
}

template <typename T> consteval std::uint32_t id_of();
template <> consteval std::uint32_t id_of<Foo>() { return type_id("Foo"); }
template <> consteval std::uint32_t id_of<Bar>() { return type_id("Bar"); }
```

A stable ID without RTTI overhead, computed once per type at compile time.

#### Embedded Resources

C++23 gave `#embed` for binary data, but `consteval` is the way to *transform* embedded data at compile time.

```cpp
consteval auto compress_table() {
    constexpr unsigned char raw[] = {
        #embed "table.bin"
    };
    // ... process raw into a smaller form
    std::array<std::uint16_t, kCompressedSize> out{};
    // ... fill out
    return out;
}

constexpr auto kTable = compress_table();
```

The processed table lands in `.rodata`. The raw bytes never reach the runtime image.

### Limits and Step Counters

Compilers cap the number of operations a constant evaluation may perform to prevent runaway compiles. Defaults around a few million steps. Tunables.

- Clang: `-fconstexpr-steps=N` (default 1048576)
- GCC: `-fconstexpr-ops-limit=N` (default 33554432)
- MSVC: `/constexpr:steps N`

A `consteval` function that exceeds the limit fails to compile with a "constant evaluation exceeded step limit" message. The fix is usually to factor the algorithm so the inner loop is shorter, not to raise the limit globally.

### Junior to FAANG / Senior at FAANG

A junior should reach for `consteval` instead of template metaprogramming for compile-time numeric work, write format-string-validating wrappers, and read compile-time errors that mention "not a constant expression".

A senior is expected to design APIs where misuse becomes a compile-time error (e.g., consteval-validated regex, consteval URL parsing, consteval SQL fragment validation), profile compile time when consteval-heavy code lands in widely-included headers, and decide between `consteval` and `constexpr` based on whether runtime callers are expected. They should know that `if consteval` is the modern replacement for `is_constant_evaluated`, that consteval propagation is transitive, and that the step limit is a real constraint, not an academic one.
