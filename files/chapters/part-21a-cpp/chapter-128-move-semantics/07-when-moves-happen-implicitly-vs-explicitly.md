## When Moves Happen Implicitly vs. Explicitly

Understanding when the compiler inserts moves automatically saves you from writing unnecessary `std::move` calls.

### Implicit Moves

Moves happen automatically in these contexts:

```cpp
#include <iostream>
#include <string>
#include <vector>
#include <utility>

std::string make_string() {
    std::string result = "hello";
    return result;             // 1. Return of local variable (implicit move or NRVO)
}

void example() {
    // 2. Initialization from a temporary (prvalue)
    std::string s = std::string("world");  // Move (or copy elision)

    // 3. Passing a temporary to a function
    std::vector<std::string> vec;
    vec.push_back(std::string("temp"));  // Move into vector

    // 4. Inserting a temporary into a container
    vec.emplace_back("constructed in place");  // No move at all - constructed directly

    // 5. Throwing and catching exceptions (C++14 and later)
    // The thrown object is implicitly moved if it is a local variable.

    // 6. Lambda captures with init-capture (C++14)
    auto ptr = std::make_unique<int>(42);
    auto lambda = [p = std::move(ptr)] {  // Explicit move into capture
        return *p;
    };

    // 7. Returning a parameter by value (C++20)
    // auto f = [](std::string s) -> std::string { return s; };
    // In C++20, the parameter 's' is implicitly moved on return.
}
```

### Explicit Moves

Use `std::move` explicitly when you have a named variable you want to move from:

```cpp
void explicit_moves() {
    std::string a = "hello";
    std::string b = std::move(a);      // Explicit: a is named lvalue

    std::vector<std::string> vec;
    std::string item = "world";
    vec.push_back(std::move(item));    // Explicit: item is named lvalue

    // Swapping is the classic use case
    std::string x = "first";
    std::string y = "second";
    // std::swap does this internally:
    // auto temp = std::move(x);
    // x = std::move(y);
    // y = std::move(temp);
    std::swap(x, y);
}
```

---

### Junior → FAANG: Building Intuition for Implicit Moves

Go engineers write code without thinking about copies vs. moves because Go handles it transparently. In C++, building an intuition for when the compiler moves automatically saves you from both under-optimization (not using moves when available) and over-optimization (adding `std::move` where it is already happening or where it prevents RVO).

The mental model: if the value category of the source is rvalue (temporary, or `std::move`-cast), and the destination type has a move constructor, the compiler moves. If the source is an lvalue and you want a move, you must use `std::move` explicitly. Returning a local variable is the one context where the compiler implicitly treats the local as an rvalue even though it is named.

### Senior @ FAANG: Implicit Move in C++20 and C++23 Improvements

At the staff level, the rules for implicit moves have been progressively expanded in C++20 and C++23. In C++20, implicit move applies in more contexts (return of rvalue references, throw expressions). In C++23, the rules were simplified and extended further.

A staff engineer reviewing code for a codebase adopting C++20 or C++23 should check: are there `std::move` calls in return statements that are now redundant (and potentially harmful by preventing RVO)? The compiler may now perform the move automatically, and the explicit `std::move` prevents the compiler from applying the preferred optimization. A clang-tidy modernize pass (`modernize-use-emplace`, `performance-unnecessary-copy-initialization`) catches many of these.

