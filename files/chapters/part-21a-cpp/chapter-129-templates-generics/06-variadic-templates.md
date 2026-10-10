## Variadic Templates

### Parameter Packs

Variadic templates accept a variable number of type or value parameters. They are the foundation of type-safe variadic functions in C++.

```cpp
// Base case: no arguments
void Print() {
    std::cout << "\n";
}

// Recursive case: peel off the first argument, recurse on the rest
template <typename T, typename... Args>
void Print(const T& first, const Args&... rest) {
    std::cout << first;
    if constexpr (sizeof...(rest) > 0) {
        std::cout << ", ";
    }
    Print(rest...);
}

int main() {
    Print(1, 2.5, "hello", 'x', true);
    // Output: 1, 2.5, hello, x, 1
    return 0;
}
```

`typename... Args` declares a **parameter pack**. `Args...` in the function parameter list expands it. `sizeof...(rest)` returns the number of remaining arguments at compile time.

### Fold Expressions (C++17)

Fold expressions collapse a parameter pack using an operator, eliminating the need for recursion.

```cpp
// Sum all arguments
template <typename... Args>
auto Sum(Args... args) {
    return (args + ...);  // Unary right fold: a1 + (a2 + (a3 + a4))
}

// Check if all arguments are positive
template <typename... Args>
bool AllPositive(Args... args) {
    return ((args > 0) && ...);  // Unary right fold with &&
}

// Print all arguments with a separator
template <typename... Args>
void PrintAll(const Args&... args) {
    ((std::cout << args << " "), ...);  // Comma fold expression
    std::cout << "\n";
}

int main() {
    std::cout << Sum(1, 2, 3, 4, 5) << "\n";       // 15
    std::cout << Sum(1.5, 2.5, 3.0) << "\n";        // 7.0

    std::cout << AllPositive(1, 2, 3) << "\n";       // 1 (true)
    std::cout << AllPositive(1, -2, 3) << "\n";      // 0 (false)

    PrintAll("hello", 42, 3.14, 'x');                // hello 42 3.14 x
    return 0;
}
```

The four fold expression forms:

| Form | Syntax | Expansion |
|---|---|---|
| Unary right fold | `(pack op ...)` | `a1 op (a2 op (... op aN))` |
| Unary left fold | `(... op pack)` | `((a1 op a2) op ...) op aN` |
| Binary right fold | `(pack op ... op init)` | `a1 op (a2 op (... op (aN op init)))` |
| Binary left fold | `(init op ... op pack)` | `(((init op a1) op a2) op ...) op aN` |

The binary forms are essential when the pack might be empty:

```cpp
// Unary fold with empty pack: ill-formed (except for &&, ||, and comma)
// template <typename... Args>
// auto BadSum(Args... args) { return (args + ...); }
// BadSum();  // ERROR: empty fold with +

// Binary fold with empty pack: uses the init value
template <typename... Args>
auto SafeSum(Args... args) {
    return (args + ... + 0);  // Binary right fold: returns 0 for empty pack
}

auto zero = SafeSum();  // OK: returns 0
```

### Practical Example: Type-Safe Printf

Here is a type-safe replacement for C's `printf` that catches type mismatches at compile time:

```cpp
#include <iostream>
#include <string>
#include <string_view>
#include <stdexcept>

void TypeSafePrintf(std::string_view fmt) {
    // Base case: no more arguments. Check for leftover format specifiers.
    for (size_t i = 0; i < fmt.size(); ++i) {
        if (fmt[i] == '{' && i + 1 < fmt.size() && fmt[i + 1] == '}') {
            throw std::runtime_error("Too few arguments for format string");
        }
    }
    std::cout << fmt;
}

template <typename T, typename... Args>
void TypeSafePrintf(std::string_view fmt, const T& value, const Args&... args) {
    for (size_t i = 0; i < fmt.size(); ++i) {
        if (fmt[i] == '{' && i + 1 < fmt.size() && fmt[i + 1] == '}') {
            std::cout << value;
            TypeSafePrintf(fmt.substr(i + 2), args...);
            return;
        }
        std::cout << fmt[i];
    }
    // If we get here, there were more arguments than placeholders.
    throw std::runtime_error("Too many arguments for format string");
}

int main() {
    TypeSafePrintf("Hello, {}! You are {} years old.\n", "Alice", 30);
    // Output: Hello, Alice! You are 30 years old.

    TypeSafePrintf("Coordinates: ({}, {})\n", 3.14, 2.71);
    // Output: Coordinates: (3.14, 2.71)
    return 0;
}
```

Go's `fmt.Printf` achieves type safety through reflection at runtime. The C++ version catches errors at compile time when all arguments are known.

### Perfect Forwarding with Parameter Packs

Variadic templates combined with perfect forwarding let you write factory functions that pass arguments through without copying.

```cpp
template <typename T, typename... Args>
std::unique_ptr<T> MakeUnique(Args&&... args) {
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
}

struct Connection {
    std::string host;
    int port;
    bool ssl;
    Connection(std::string h, int p, bool s)
        : host(std::move(h)), port(p), ssl(s) {}
};

auto conn = MakeUnique<Connection>("localhost", 8080, true);
```

This is exactly how `std::make_unique` is implemented in the standard library. The `Args&&...` with `std::forward<Args>(args)...` preserves value categories (lvalue/rvalue) of each argument through the forwarding chain.

### Index Sequences and Tuple Operations

`std::index_sequence` enables compile-time iteration over tuples and fixed-size structures:

```cpp
#include <cstddef>
#include <iostream>
#include <tuple>
#include <utility>

// Print a tuple using index_sequence
template <typename Tuple, size_t... Is>
void PrintTupleImpl(const Tuple& t, std::index_sequence<Is...>) {
    ((std::cout << (Is == 0 ? "" : ", ") << std::get<Is>(t)), ...);
}

template <typename... Args>
void PrintTuple(const std::tuple<Args...>& t) {
    std::cout << "(";
    PrintTupleImpl(t, std::index_sequence_for<Args...>{});
    std::cout << ")\n";
}

// Transform each element of a tuple
template <typename F, typename Tuple, size_t... Is>
auto TransformTupleImpl(F&& f, const Tuple& t, std::index_sequence<Is...>) {
    return std::make_tuple(f(std::get<Is>(t))...);
}

template <typename F, typename... Args>
auto TransformTuple(F&& f, const std::tuple<Args...>& t) {
    return TransformTupleImpl(std::forward<F>(f), t,
                               std::index_sequence_for<Args...>{});
}

int main() {
    auto t = std::make_tuple(1, "hello", 3.14);
    PrintTuple(t);  // (1, hello, 3.14)

    auto doubled = TransformTuple([](auto x) {
        if constexpr (std::is_arithmetic_v<decltype(x)>) {
            return x * 2;
        } else {
            return x;  // non-arithmetic types pass through
        }
    }, std::make_tuple(1, 2.5, 3));
    PrintTuple(doubled);  // (2, 5, 6)
    return 0;
}
```

---

### Junior → FAANG: Variadic Templates as the Foundation of `emplace` and `make_unique`

The practical entry point for variadic templates is understanding why `std::make_unique<T>(args...)` works with any number and type of arguments. It uses variadic templates to forward all arguments to T's constructor. When you use `std::vector::emplace_back(args...)`, the same mechanism is at work.

You do not need to write variadic templates to use them effectively. The skill is recognizing the `Args&&... args` and `std::forward<Args>(args)...` pattern in library code and understanding that it is a perfect forwarding wrapper for any number of arguments.

### Senior @ FAANG: Variadic Templates and Fold Expressions in Library Design

At the staff level, variadic templates appear in two critical library design patterns: type-safe heterogeneous containers and compile-time algorithm composition.

**Fold expressions for compile-time aggregation.** C++17 fold expressions eliminate the recursive variadic template specialization that was required in C++11/14. `(... + args)` folds a `+` over all arguments at compile time. A staff engineer uses fold expressions for: summing sizes of multiple types, logical ANDing multiple concept constraints, and building bitsets from enum values. Each use replaces multi-level recursive specialization with a single readable expression.

**Variadic templates and compile-time type lists.** Advanced library design often requires manipulating type lists at compile time: filtering types that satisfy a concept, transforming types (adding `const`), or indexing into a list. These operations use variadic templates as the representation. A staff engineer evaluating whether to implement custom type list metaprogramming should first check if Boost.Mp11 (a C++11-compatible metaprogramming library) already provides the needed operations, rather than reinventing them.

