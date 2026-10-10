## Type Traits

Type traits are compile-time predicates and transformations that let you inspect and manipulate types. The `<type_traits>` header is the foundation of template metaprogramming.

### Common Type Traits

Type traits provide compile-time queries and transformations, allowing templates to inspect type properties and select optimal representations without runtime overhead:
```cpp
#include <type_traits>

// Type category checks
static_assert(std::is_integral_v<int>);            // true
static_assert(std::is_integral_v<char>);           // true
static_assert(!std::is_integral_v<double>);        // true
static_assert(std::is_floating_point_v<double>);   // true
static_assert(std::is_pointer_v<int*>);            // true
static_assert(std::is_array_v<int[5]>);            // true
static_assert(std::is_class_v<std::string>);       // true
static_assert(std::is_enum_v<std::byte>);          // true

// Type comparisons
static_assert(std::is_same_v<int, int32_t>);       // true on most platforms
static_assert(!std::is_same_v<int, long>);         // often true

// Type properties
static_assert(std::is_const_v<const int>);
static_assert(std::is_trivially_copyable_v<int>);
static_assert(std::is_default_constructible_v<std::string>);
```

### Type Relationship Traits

Beyond simple category checks, type traits can query relationships between types:

```cpp
// Inheritance relationship
static_assert(std::is_base_of_v<std::exception, std::runtime_error>);

// Convertibility
static_assert(std::is_convertible_v<int, double>);
static_assert(!std::is_convertible_v<std::string, int>);

// Invocability (C++17)
static_assert(std::is_invocable_v<decltype(strlen), const char*>);
static_assert(std::is_invocable_r_v<size_t, decltype(strlen), const char*>);

// Assignability
static_assert(std::is_assignable_v<std::string&, const char*>);
static_assert(!std::is_assignable_v<const int&, int>);  // const prevents assignment
```

### Type Transformations

These traits do not check properties, they produce new types.

```cpp
// remove_reference: strips & and && from types
static_assert(std::is_same_v<
    std::remove_reference_t<int&>,
    int
>);
static_assert(std::is_same_v<
    std::remove_reference_t<int&&>,
    int
>);

// remove_const: strips const
static_assert(std::is_same_v<
    std::remove_const_t<const int>,
    int
>);

// decay: simulates pass-by-value transformation
// Arrays decay to pointers, functions decay to function pointers,
// top-level const/volatile and references are removed
static_assert(std::is_same_v<
    std::decay_t<int[5]>,
    int*
>);
static_assert(std::is_same_v<
    std::decay_t<const int&>,
    int
>);

// conditional: compile-time ternary for types
static_assert(std::is_same_v<
    std::conditional_t<true, int, double>,
    int
>);
static_assert(std::is_same_v<
    std::conditional_t<(sizeof(void*) == 8), int64_t, int32_t>,
    int64_t  // true on 64-bit platforms
>);

// common_type: finds the common type between multiple types
static_assert(std::is_same_v<
    std::common_type_t<int, double>,
    double
>);
static_assert(std::is_same_v<
    std::common_type_t<int, long, double>,
    double
>);
```

### Building Custom Type Traits

You can build your own type traits using partial specialization.

```cpp
// Check if a type is a std::vector
template <typename T>
struct is_vector : std::false_type {};

template <typename T, typename Alloc>
struct is_vector<std::vector<T, Alloc>> : std::true_type {};

template <typename T>
inline constexpr bool is_vector_v = is_vector<T>::value;

// Check if a type has a .size() method
template <typename T, typename = void>
struct has_size : std::false_type {};

template <typename T>
struct has_size<T, std::void_t<decltype(std::declval<T>().size())>>
    : std::true_type {};

template <typename T>
inline constexpr bool has_size_v = has_size<T>::value;

static_assert(is_vector_v<std::vector<int>>);         // true
static_assert(!is_vector_v<std::deque<int>>);          // true
static_assert(has_size_v<std::string>);                // true
static_assert(!has_size_v<int>);                       // true
```

The `std::void_t` trick is one of the most important idioms in pre-C++20 template metaprogramming. It tests whether an expression is valid: if `T` does not have a `.size()` method, the `decltype` expression is invalid, SFINAE kicks in, and the primary template (which inherits from `false_type`) is selected.

Go has no compile-time type introspection. The closest mechanism is reflection (`reflect` package), which operates entirely at runtime.

### Composing Type Traits

You can build complex compile-time logic by composing traits:

```cpp
// A type is "serializable" if it's arithmetic, a string, or has a serialize method
template <typename T>
inline constexpr bool is_serializable_v =
    std::is_arithmetic_v<T> ||
    std::is_same_v<std::decay_t<T>, std::string> ||
    has_size_v<T>;  // simplified; real code would check for serialize()

// Conditional type selection based on properties
template <typename T>
using storage_type = std::conditional_t<
    std::is_trivially_copyable_v<T> && sizeof(T) <= 16,
    T,                    // Store small trivial types by value
    std::unique_ptr<T>    // Store large/complex types by pointer
>;
```

---
