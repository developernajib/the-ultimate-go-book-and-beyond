## SFINAE and Tag Dispatch

### SFINAE: Substitution Failure Is Not An Error

SFINAE is one of the most important (and initially confusing) features of C++ templates. The rule is simple: if substituting a template argument into a template parameter causes an invalid type or expression, the compiler silently removes that overload from the candidate set instead of producing a hard error.

```cpp
#include <iostream>
#include <limits>
#include <stdexcept>
#include <type_traits>

// This overload is only available when T is an integer type
template <typename T>
typename std::enable_if<std::is_integral<T>::value, T>::type
SafeDivide(T a, T b) {
    if (b == 0) {
        throw std::domain_error("Division by zero");
    }
    return a / b;
}

// This overload is only available when T is a floating-point type
template <typename T>
typename std::enable_if<std::is_floating_point<T>::value, T>::type
SafeDivide(T a, T b) {
    if (b == T(0)) {
        return std::numeric_limits<T>::quiet_NaN();
    }
    return a / b;
}

int main() {
    std::cout << SafeDivide(10, 3) << "\n";    // calls integer version: 3
    std::cout << SafeDivide(10.0, 3.0) << "\n"; // calls float version: 3.33333
    std::cout << SafeDivide(10.0, 0.0) << "\n"; // returns NaN, no throw
    return 0;
}
```

When the compiler sees `SafeDivide(10, 3)`, it tries both overloads. For the floating-point overload, `std::is_floating_point<int>::value` is `false`, so `std::enable_if<false, int>::type` does not exist. That substitution failure silently removes the overload. The integer version succeeds, so it is chosen.

### The `enable_if` Helper (C++14)

C++14 provides `_t` and `_v` suffixes for cleaner syntax:

```cpp
// C++11 verbose
template <typename T>
typename std::enable_if<std::is_integral<T>::value, T>::type
Process(T value);

// C++14 clean
template <typename T>
std::enable_if_t<std::is_integral_v<T>, T>
Process(T value);

// C++17: constexpr if (often replaces SFINAE entirely)
template <typename T>
auto Process(T value) {
    if constexpr (std::is_integral_v<T>) {
        return value * 2;
    } else if constexpr (std::is_floating_point_v<T>) {
        return value * 2.5;
    } else {
        static_assert(sizeof(T) == 0, "Unsupported type");
    }
}
```

The `if constexpr` approach (C++17) is dramatically more readable. The branch that does not match is discarded at compile time, the code inside it is not even type-checked if the condition is false.

### SFINAE with `enable_if` in Different Positions

You can place `enable_if` in three positions, each with different trade-offs:

```cpp
// Position 1: Return type (most common pre-C++20)
template <typename T>
std::enable_if_t<std::is_integral_v<T>, T>
Abs(T value) {
    return value < 0 ? -value : value;
}

// Position 2: Extra defaulted template parameter
template <typename T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
T Abs2(T value) {
    return value < 0 ? -value : value;
}

// Position 3: Function parameter (least clean)
template <typename T>
T Abs3(T value, std::enable_if_t<std::is_integral_v<T>, int> = 0) {
    return value < 0 ? -value : value;
}
```

Position 2 is preferred when you have multiple overloads because it keeps the return type clean and does not affect the function signature seen by callers.

### The `void_t` Idiom

`std::void_t` (C++17, easily implemented in C++11) is a powerful SFINAE tool for detecting whether expressions are valid:

```cpp
// Detect if a type has a .serialize() method
template <typename T, typename = void>
struct HasSerialize : std::false_type {};

template <typename T>
struct HasSerialize<T, std::void_t<decltype(std::declval<T>().serialize())>>
    : std::true_type {};

// Detect if two types can be added
template <typename T, typename U, typename = void>
struct CanAdd : std::false_type {};

template <typename T, typename U>
struct CanAdd<T, U, std::void_t<decltype(std::declval<T>() + std::declval<U>())>>
    : std::true_type {};

struct MyClass {
    std::string serialize() const { return "data"; }
};

static_assert(HasSerialize<MyClass>::value);     // true
static_assert(!HasSerialize<int>::value);        // true
static_assert(CanAdd<int, double>::value);       // true
static_assert(!CanAdd<std::string, int>::value); // true (no string + int)
```

### Tag Dispatch

Tag dispatch uses empty tag types and function overloading to select implementations at compile time.

```cpp
namespace detail {
    // Tag types
    struct RandomAccessTag {};
    struct ForwardTag {};

    template <typename Iter>
    void AdvanceImpl(Iter& it, int n, RandomAccessTag) {
        it += n;  // O(1) random access
    }

    template <typename Iter>
    void AdvanceImpl(Iter& it, int n, ForwardTag) {
        for (int i = 0; i < n; ++i) {
            ++it;  // O(n) linear advance
        }
    }
}

template <typename Iter>
void Advance(Iter& it, int n) {
    using Category = typename std::iterator_traits<Iter>::iterator_category;
    if constexpr (std::is_same_v<Category, std::random_access_iterator_tag>) {
        detail::AdvanceImpl(it, n, detail::RandomAccessTag{});
    } else {
        detail::AdvanceImpl(it, n, detail::ForwardTag{});
    }
}
```

In modern C++ (C++17+), `if constexpr` has largely replaced tag dispatch for new code. In C++20, concepts make both patterns cleaner still. But you will encounter tag dispatch extensively in older codebases and the standard library itself.

### Evolution of Constraint Techniques

The same constraint can be expressed in increasingly readable ways across C++ standards:

```cpp
// C++11: SFINAE with enable_if
template <typename T>
typename std::enable_if<
    std::is_integral<T>::value && std::is_signed<T>::value,
    T
>::type
Negate_v1(T value) { return -value; }

// C++14: enable_if_t and _v helpers
template <typename T>
std::enable_if_t<std::is_integral_v<T> && std::is_signed_v<T>, T>
Negate_v2(T value) { return -value; }

// C++17: if constexpr (constraint moves inside the function)
template <typename T>
T Negate_v3(T value) {
    static_assert(std::is_integral_v<T> && std::is_signed_v<T>,
                  "T must be a signed integer");
    return -value;
}

// C++20: concepts (cleanest)
template <typename T>
    requires std::signed_integral<T>
T Negate_v4(T value) { return -value; }
```

Each generation brought dramatic readability improvements. If you are writing new code with C++20, use concepts. If maintaining older code, understand SFINAE.

---
