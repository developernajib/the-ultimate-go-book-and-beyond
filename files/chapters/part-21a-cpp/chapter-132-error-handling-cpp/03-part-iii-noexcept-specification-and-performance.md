## Part III: `noexcept` - Specification and Performance

### Basic `noexcept`

The `noexcept` specifier tells the compiler that a function will not throw exceptions. If it does throw, `std::terminate` is called immediately - no stack unwinding.

```cpp
// Unconditionally noexcept
int add(int a, int b) noexcept {
    return a + b;
}

// noexcept is part of the type system since C++17
void (*fp1)() noexcept = nullptr;     // pointer to noexcept function
// void (*fp2)() = some_noexcept_fn; // OK: noexcept converts to potentially-throwing
// fp1 = some_throwing_fn; // ERROR: cannot convert throwing to noexcept
```

### Conditional `noexcept`

`noexcept(expression)` makes the `noexcept` guarantee conditional on a compile-time boolean:

```cpp
#include <type_traits>

template <typename T>
class Container {
public:
    // noexcept if T's move constructor is noexcept
    void push_back(T&& value) noexcept(
        std::is_nothrow_move_constructible_v<T>
    ) {
        // ... implementation
    }

    // noexcept if swapping T is noexcept
    void swap(Container& other) noexcept(
        std::is_nothrow_swappable_v<T>
    ) {
        std::swap(data_, other.data_);
        std::swap(size_, other.size_);
    }

    // Common pattern: noexcept if all sub-operations are noexcept
    Container(Container&& other) noexcept(
        std::is_nothrow_move_constructible_v<T>
    )
        : data_(std::exchange(other.data_, nullptr))
        , size_(std::exchange(other.size_, 0)) {}

private:
    T* data_ = nullptr;
    size_t size_ = 0;
};

// The noexcept operator (without specifier) tests expressions
template <typename T>
void example() {
    // noexcept(expr) returns true if expr is noexcept
    constexpr bool safe = noexcept(std::declval<T>().swap(std::declval<T&>()));
    static_assert(safe, "swap must be noexcept");
}
```

### Impact on Move Operations and `std::vector`

This is where `noexcept` becomes critical for performance. `std::vector::push_back` and `resize` need to move elements when reallocating. But they can only use move if the move constructor is `noexcept`. Otherwise, they fall back to copying (to preserve the strong exception guarantee).

```cpp
#include <vector>
#include <iostream>
#include <chrono>

class ThrowingMove {
public:
    ThrowingMove() = default;
    ThrowingMove(const ThrowingMove&) {
        // std::cout << "Copy\n";
    }
    ThrowingMove(ThrowingMove&&) {  // NOT noexcept
        // std::cout << "Move\n";
    }
};

class SafeMove {
public:
    SafeMove() = default;
    SafeMove(const SafeMove&) {
        // std::cout << "Copy\n";
    }
    SafeMove(SafeMove&&) noexcept {  // noexcept!
        // std::cout << "Move\n";
    }
};

// Benchmark: vector growth with noexcept vs without
template <typename T>
long long benchmark_vector_growth(int n) {
    auto start = std::chrono::high_resolution_clock::now();
    std::vector<T> v;
    for (int i = 0; i < n; ++i) {
        v.push_back(T{});
    }
    auto end = std::chrono::high_resolution_clock::now();
    return std::chrono::duration_cast<std::chrono::microseconds>(end - start).count();
}

int main() {
    constexpr int N = 1'000'000;

    auto throwing_time = benchmark_vector_growth<ThrowingMove>(N);
    auto safe_time = benchmark_vector_growth<SafeMove>(N);

    std::cout << "Without noexcept move: " << throwing_time << " us\n";
    std::cout << "With noexcept move:    " << safe_time << " us\n";
    std::cout << "Speedup: " << static_cast<double>(throwing_time) / safe_time << "x\n";

    // Typical output (varies by system):
    // Without noexcept move: 45000 us
    // With noexcept move:    12000 us
    // Speedup: 3.75x
}
```

**Rule of thumb:** Always mark move constructors and move assignment operators `noexcept` unless they genuinely can throw. The performance penalty for not doing so can be severe.

### `noexcept` and the Compiler

When the compiler sees `noexcept`, it can:

1. **Skip stack unwinding machinery.** No need to register cleanup handlers.
2. **Optimize more aggressively.** Dead code elimination, better register allocation.
3. **Enable move semantics** in standard containers.

However, `noexcept` is not just an optimization hint - it is a contract. Violating it calls `std::terminate`. Use it only when you are genuinely certain the function cannot throw.

---

### Junior → FAANG: `noexcept` as a Mandatory Annotation for Move Operations

The most important rule for `noexcept` at the junior level: all move constructors and move assignment operators should be `noexcept`. This is not optional. Without `noexcept`, `std::vector` uses copies during reallocation, silently degrading performance. With `noexcept`, `std::vector` uses moves, which is O(1) per element.

Second rule: swap functions should always be `noexcept`. They are used in copy-and-swap exception safety patterns, and a throwing swap defeats the purpose of the pattern.

### Senior @ FAANG: `noexcept` Policy and Conditional `noexcept`

At the staff level, `noexcept` policy is part of the API contract governance. A staff engineer defines the policy: (1) all move operations are `noexcept` (enforced by `static_assert(std::is_nothrow_move_constructible_v<T>)`), (2) all swap functions are `noexcept`, (3) no other function is `noexcept` unless it has been verified to never throw through all code paths (including all callees), and (4) conditional `noexcept` (`noexcept(noexcept(expr))`) is used for generic functions whose exception specification depends on the operations they call.

**Conditional `noexcept` in generic code.** A generic swap function that swaps two objects should be `noexcept` when both swaps are nothrow: `noexcept(noexcept(std::swap(a.first, b.first)) && noexcept(std::swap(a.second, b.second)))`. This preserves the nothrow guarantee for types that support it while not making an incorrect promise for types that do not. A staff engineer ensures that all generic functions in the team's library use conditional `noexcept` rather than unconditional `noexcept` or no specification.

