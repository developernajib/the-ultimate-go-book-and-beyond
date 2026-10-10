## constexpr Everything

C++ has been pushing computation from runtime to compile time since C++11. Each standard widens what `constexpr` can do. By C++23 the surface is large enough that significant fractions of real programs run during translation, including code that uses dynamic memory, virtual dispatch, and exceptions. The compiler tracks every allocation and every side effect to keep the constant-evaluation model sound.

### constexpr Functions

A `constexpr` function **may** run at compile time if all its inputs are constant expressions. It is a permission, not a requirement.

```cpp
constexpr int factorial(int n) {
    int r = 1;
    for (int i = 2; i <= n; ++i) r *= i;
    return r;
}

constexpr int x = factorial(10);    // compile-time, x is 3628800
int n = read_int();
int y = factorial(n);                // run-time, same function body
```

Since C++14 the body is unrestricted: loops, locals, mutations, multiple returns. Since C++20 it can call non-constexpr functions as long as those calls are not actually evaluated when the function is invoked in a constant-expression context. Since C++23 the function may even contain `goto`, `static` locals (with a constant initializer), and `try`/`catch` blocks.

### constexpr if

`if constexpr` is a compile-time branch inside a template. The discarded branch is not instantiated, so it can reference members or types that do not exist for the current template arguments.

```cpp
template <typename T>
auto stringify(const T& x) {
    if constexpr (std::is_arithmetic_v<T>) {
        return std::to_string(x);
    } else if constexpr (requires { x.to_string(); }) {
        return x.to_string();
    } else {
        return std::string{x};
    }
}
```

The eliminated branches still need to **parse**, so syntax errors are caught, but they are not type-checked against `T`. This replaces the tag-dispatch and SFINAE patterns that filled pre-C++17 generic code.

## consteval (Immediate Functions)

`consteval` declares an **immediate function**. It can only be called in a constant-expression context. A non-constant call is a hard error, not a fallback to runtime.

```cpp
consteval int square(int x) { return x * x; }

constexpr int a = square(7);   // OK, 49
int n = read_int();
int b = square(n);             // ERROR: not a constant expression
```

Use `consteval` when the function is a compile-time-only utility. Format-string validation, hash computation for string literals, type registration, embedded resource processing. The compiler never emits a runtime body for an immediate function.

### constinit

`constinit` requires that a variable be **constant-initialized** but does not make the variable itself constant. It eliminates the static-initialization-order fiasco for global state that is logically constant from the program's point of view but technically mutable.

```cpp
constinit std::atomic<int> counter = 0;       // initialized before main, no SIOF
constinit Logger logger{"main.log"};           // ERROR if Logger ctor is not constexpr
```

`constinit` is the right choice for global atomics, function-pointer tables, and configuration constants that need to be live before any dynamic initializer runs.

### constexpr Containers (C++20)

C++20 made `std::vector`, `std::string`, and most node-less containers constexpr-compatible. Their allocations are tracked by the compiler and must be **freed before the constant expression ends**. A leak at compile time is an error.

```cpp
constexpr std::vector<int> primes_below(int n) {
    std::vector<bool> sieve(n, true);
    sieve[0] = sieve[1] = false;
    for (int i = 2; i * i < n; ++i)
        if (sieve[i])
            for (int j = i * i; j < n; j += i) sieve[j] = false;

    std::vector<int> out;
    for (int i = 2; i < n; ++i) if (sieve[i]) out.push_back(i);
    return out;
}

constexpr auto p = primes_below(1000);   // computed at compile time
static_assert(p.size() == 168);
```

The catch is that **a constexpr vector cannot survive as a `constexpr` global**, because its dynamic allocation must be freed inside the constant expression. The pattern that works is to compute at compile time, then materialise into a `std::array` of known size.

```cpp
consteval auto primes_array() {
    constexpr auto v = primes_below(1000);
    std::array<int, v.size()> arr{};
    std::ranges::copy(v, arr.begin());
    return arr;
}

constexpr auto kPrimes = primes_array();   // lives at runtime
```

This idiom (compute with `vector`, return as `array`) is the bread-and-butter of compile-time data tables.

### constexpr Virtual

C++20 allowed `virtual` functions to be `constexpr`, including dynamic dispatch through a base pointer.

```cpp
struct Shape {
    constexpr virtual double area() const = 0;
    constexpr virtual ~Shape() = default;
};

struct Circle : Shape {
    double r;
    constexpr Circle(double r) : r(r) {}
    constexpr double area() const override { return 3.14159265 * r * r; }
};

constexpr double total_area() {
    Circle c{2.0};
    Shape* s = &c;
    return s->area();
}

static_assert(total_area() > 12.0);
```

The compiler tracks the dynamic type during constant evaluation. Vtable lookups happen in the abstract machine.

### constexpr Exceptions (C++26 Path)

C++23 introduced `try`/`catch` inside constexpr functions but exceptions could not actually be thrown during constant evaluation. C++26 (P3068) finishes the work by allowing throws. Today (2026) GCC 15 and Clang 19 implement the early form. Code that throws in a constexpr context surfaces the exception as a compile-time error message at the call site.

```cpp
constexpr int parse_digit(char c) {
    if (c < '0' || c > '9') throw std::invalid_argument("bad digit");
    return c - '0';
}

constexpr int x = parse_digit('5');   // OK, 5
// constexpr int y = parse_digit('z');  // compile error citing the throw
```

### How the Compiler Tracks Allocations

Constant evaluation runs in an abstract machine. The compiler maintains a heap of "constexpr-allocated" objects, each tagged with provenance. A pointer obtained from a constexpr `new` is valid only inside the same constant-expression evaluation. The rules.

1. Every `new` must be matched by a `delete` before the evaluation completes.
2. A pointer cannot escape the evaluation. You cannot store a constexpr-allocated pointer in a `constexpr` variable that outlives the call.
3. Reads through dangling pointers are diagnosed.
4. Reinterpret-cast, union type-punning, and pointer arithmetic past the end are still UB and are diagnosed at compile time.

This is why a `constexpr std::vector<int> v = ...;` at namespace scope is rejected. The vector's heap memory has no place to live once the constant expression finishes. `consteval` returning `std::array` works because arrays are non-allocating.

### std::is_constant_evaluated

A function that wants to take different paths at compile time vs runtime can ask. C++20 added `std::is_constant_evaluated()`, a function. C++23 added `if consteval`, a statement that pairs better with the type system.

```cpp
constexpr double sqrt_fast(double x) {
    if consteval {
        // Newton iteration, exact, always-convergent.
        double r = x;
        for (int i = 0; i < 50; ++i) r = 0.5 * (r + x / r);
        return r;
    } else {
        return std::sqrt(x);   // hardware sqrt at runtime
    }
}
```

The `if consteval` branch is a constant-expression context. The `else` branch is not, so it can call any runtime function. The two branches do not even need to compile in each other's context.

### Why constexpr Matters in Production

Compile-time computation moves work out of the runtime. The empirical wins.

**Tables.** Sine tables, CRC tables, Unicode property tables, bytecode dispatch tables. Generated as `constexpr` arrays, embedded in `.rodata`, zero startup cost.

**Format-string checking.** `std::format("{:d}", "hello")` is rejected at compile time because the formatter is `consteval`.

**Configuration.** Feature flags, build constants, type-id assignments, all computed once.

**Embedded.** A microcontroller with 32 KB of flash and no heap can run a parser for a fixed grammar at compile time and embed the resulting state machine.

**Reflection-adjacent code.** Until proper reflection lands in C++26, `consteval` plus structural reflection libraries (Boost.PFR, magic_enum) approximate it.

The cost is compile time. A pipeline that does heavy `constexpr` work shifts CPU from `cc1` invocations onto a single translation unit. Profile with `-ftime-trace` (Clang) or `/d1reportTime` (MSVC).

### Junior to FAANG / Senior at FAANG

A junior should mark pure functions `constexpr`, use `consteval` for compile-time-only utilities, write `if constexpr` instead of SFINAE, and recognize that `constexpr` containers must be released before the constant expression ends.

A senior is expected to budget compile-time cost, design APIs where the same function works at compile time and runtime via `if consteval`, push large lookup tables into `constexpr` to eliminate dynamic initialization, and know which compiler flags drive the constexpr step limit (Clang's `-fconstexpr-steps`, GCC's `-fconstexpr-ops-limit`). They should know when `constinit` removes a static-initialization hazard, why a `constexpr` virtual dispatch is not free of compile-time cost, and how to materialise a `constexpr vector` into a `constexpr array` to keep the data alive.
