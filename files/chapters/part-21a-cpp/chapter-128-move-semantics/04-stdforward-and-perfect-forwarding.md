## `std::forward` and Perfect Forwarding

### The Forwarding Problem

Suppose you want to write a wrapper function that passes its arguments to another function, preserving the value category (lvalue/rvalue) of each argument. This is essential for factory functions, `emplace` methods, and any generic code that delegates to another function.

```cpp
#include <iostream>
#include <string>
#include <utility>

void target(const std::string& s) {
    std::cout << "target(const string&): " << s << "\n";
}

void target(std::string&& s) {
    std::cout << "target(string&&): " << s << "\n";
}

// BROKEN: Always calls the lvalue overload
template<typename T>
void broken_wrapper(T&& arg) {
    // 'arg' is a NAMED variable, so it is an LVALUE inside this function,
    // even if T&& was deduced as an rvalue reference.
    target(arg);  // ALWAYS calls target(const string&)
}

// CORRECT: Preserves the original value category
template<typename T>
void perfect_wrapper(T&& arg) {
    target(std::forward<T>(arg));  // Forwards as lvalue or rvalue
}

int main() {
    std::string name = "Alice";

    std::cout << "--- Broken wrapper ---\n";
    broken_wrapper(name);                    // Should call lvalue overload
    broken_wrapper(std::string("Bob"));      // Should call rvalue overload, but doesn't

    std::cout << "\n--- Perfect wrapper ---\n";
    perfect_wrapper(name);                   // Calls lvalue overload ✓
    perfect_wrapper(std::string("Bob"));     // Calls rvalue overload ✓

    return 0;
}
```

Output:
```
--- Broken wrapper ---
target(const string&): Alice
target(const string&): Bob

--- Perfect wrapper ---
target(const string&): Alice
target(string&&): Bob
```

### How `std::forward` Works

`std::forward<T>` is a conditional cast:

- If `T` is deduced as an lvalue reference (`T = std::string&`), `std::forward<T>(arg)` returns an lvalue reference. No move.
- If `T` is deduced as a non-reference type (`T = std::string`), `std::forward<T>(arg)` returns an rvalue reference. Move is possible.

Here is a simplified implementation:

```cpp
template<typename T>
constexpr T&& my_forward(std::remove_reference_t<T>& t) noexcept {
    return static_cast<T&&>(t);
}
```

When `T = std::string&`, the return type is `std::string& &&` which collapses (by reference collapsing rules) to `std::string&`. When `T = std::string`, the return type is `std::string&&`.

### Universal References (Forwarding References)

The `T&&` in a template function like `template<typename T> void f(T&& arg)` is not an rvalue reference. It is a **forwarding reference** (also called a **universal reference** by Scott Meyers). It can bind to both lvalues and rvalues.

The deduction rules:
- If an lvalue of type `X` is passed, `T` is deduced as `X&`, and `T&&` becomes `X& &&` which collapses to `X&`.
- If an rvalue of type `X` is passed, `T` is deduced as `X`, and `T&&` stays `X&&`.

```cpp
template<typename T>
void f(T&& arg) {
    // If called with lvalue: T = X&,  arg type is X&
    // If called with rvalue: T = X,   arg type is X&&
}

int main() {
    int x = 42;
    f(x);    // T = int&,  arg is int&  (lvalue)
    f(42);   // T = int,   arg is int&& (rvalue)
}
```

**Important**: `T&&` is only a forwarding reference when `T` is deduced in that specific context. These are NOT forwarding references:

```cpp
void g(int&& x);                    // Rvalue reference, NOT forwarding reference
                                     // (no template deduction)

template<typename T>
class Foo {
    void h(T&& x);                  // Rvalue reference, NOT forwarding reference
                                     // (T is already known from class instantiation)
};

template<typename T>
void k(std::vector<T>&& v);         // Rvalue reference, NOT forwarding reference
                                     // (T is deduced for vector, not for &&)
```

### Perfect Forwarding in Practice: `make_unique`

The standard library's `std::make_unique` is a textbook example:

```cpp
template<typename T, typename... Args>
std::unique_ptr<T> my_make_unique(Args&&... args) {
    return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
}

// Usage:
struct Widget {
    Widget(int id, std::string name) {
        std::cout << "Widget(" << id << ", " << name << ")\n";
    }
};

int main() {
    std::string name = "gear";

    // Perfect forwarding preserves:
    // - 'name' as lvalue (copied into Widget)
    // - std::string("sprocket") as rvalue (moved into Widget)
    auto w1 = my_make_unique<Widget>(1, name);
    auto w2 = my_make_unique<Widget>(2, std::string("sprocket"));
}
```

### Variadic Perfect Forwarding

Perfect forwarding extends naturally to variadic templates:

```cpp
#include <iostream>
#include <string>
#include <tuple>
#include <utility>

template<typename Func, typename... Args>
decltype(auto) invoke_and_log(Func&& func, Args&&... args) {
    std::cout << "Calling function with " << sizeof...(Args) << " arguments\n";
    return std::forward<Func>(func)(std::forward<Args>(args)...);
}

int main() {
    auto result = invoke_and_log(
        [](int x, const std::string& s) {
            return s + " = " + std::to_string(x);
        },
        42,
        std::string("answer")
    );
    std::cout << result << "\n";
    return 0;
}
```

---

### Junior → FAANG: Perfect Forwarding as a Template Author Skill

Perfect forwarding is not something most C++ engineers write every day, but it appears in every generic container, every factory function, and every `emplace` API. Understanding it as a user (calling `emplace_back(args...)`) precedes understanding it as an author (writing `template<typename... Args> void construct(Args&&... args)`).

The key rule: `std::forward<T>` preserves the value category of the original argument. `std::move` unconditionally makes it an rvalue. Use `std::forward` in forwarding functions, `std::move` in functions that take ownership.

Interview question: "why do we use `std::forward` instead of `std::move` in a perfect forwarding function?" Answer: `std::move` always casts to rvalue, which would be incorrect for lvalue arguments (they should stay as lvalues). `std::forward<T>` is a conditional cast: it casts to rvalue only if the deduced type `T` is an rvalue reference.

### Senior @ FAANG: Forwarding in Library APIs and the Cost of Universal Interfaces

At the staff level, perfect forwarding in a library API is a usability and performance feature, but it comes with costs: longer compile times, harder-to-read error messages, and SFINAE complexity.

**Constraining forwarding templates.** Unconstrained `template<typename T> void f(T&&)` accepts any argument, which can lead to surprising overload resolution. C++20 concepts allow constraining forwarding templates: `template<std::convertible_to<Widget> T> void f(T&&)`. This produces readable error messages and catches type errors at the call site rather than deep in the template instantiation. A staff engineer requires concepts constraints on all forwarding templates in the codebase.

**Variadic forwarding and `emplace` patterns.** The `emplace` pattern (construct in place, forwarding constructor arguments) is the gold standard for eliminating copies in container insertion. A staff engineer advocates for `emplace` APIs in all new containers and data structures, and uses code review to catch `push_back(T{args...})` patterns that construct and then copy/move when `emplace_back(args...)` would construct in place.

