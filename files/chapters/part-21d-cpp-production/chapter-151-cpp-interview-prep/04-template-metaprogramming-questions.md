## Template Metaprogramming Questions

Templates are C++'s most powerful and most misunderstood feature. These 15 questions test the depth of understanding interviewers expect at senior level, not just knowing the syntax, but understanding what the compiler does with your templates and why.

---

### Q1. What is template specialization? What is partial specialization?

**Full specialization** provides a completely custom implementation of a template for a specific type argument.

**Partial specialization** provides a custom implementation for a subset of type arguments (e.g., pointer types, reference types, pairs with a specific first element).

```cpp
// Primary template
template<typename T>
struct Serialize {
    static std::string to_json(const T& val) {
        return std::to_string(val);
    }
};

// Full specialization for bool
template<>
struct Serialize<bool> {
    static std::string to_json(bool val) {
        return val ? "true" : "false";
    }
};

// Partial specialization for any pointer type
template<typename T>
struct Serialize<T*> {
    static std::string to_json(const T* ptr) {
        if (!ptr) return "null";
        return Serialize<T>::to_json(*ptr);
    }
};

// Partial specialization for std::vector<T>
template<typename T>
struct Serialize<std::vector<T>> {
    static std::string to_json(const std::vector<T>& v) {
        std::string result = "[";
        for (size_t i = 0; i < v.size(); ++i) {
            if (i) result += ",";
            result += Serialize<T>::to_json(v[i]);
        }
        return result + "]";
    }
};
```

**Interview note**: function templates cannot be partially specialized, only class/struct templates. The workaround for function templates is overloading or delegating to a class template.

---

### Q2. What is SFINAE? Give a working example.

**SFINAE**, Substitution Failure Is Not An Error. When the compiler substitutes template arguments and the substitution produces an invalid type or expression in the immediate context of the declaration, it discards that overload instead of issuing a compiler error.

This mechanism enables compile-time conditional overload selection.

```cpp
#include <type_traits>
#include <iostream>

// Enable this overload ONLY for integral types
template<typename T>
typename std::enable_if<std::is_integral<T>::value, std::string>::type
describe(T val) {
    return "integer: " + std::to_string(val);
}

// Enable this overload ONLY for floating-point types
template<typename T>
typename std::enable_if<std::is_floating_point<T>::value, std::string>::type
describe(T val) {
    return "float: " + std::to_string(val);
}

// SFINAE to detect whether a type has a .size() method
template<typename T, typename = void>
struct has_size : std::false_type {};

template<typename T>
struct has_size<T, std::void_t<decltype(std::declval<T>().size())>>
    : std::true_type {};

static_assert(has_size<std::vector<int>>::value);
static_assert(!has_size<int>::value);
```

SFINAE was C++11's primary tool for compile-time type constraints. It is notoriously difficult to read and debug. C++20 Concepts (Q5) replace it with a far cleaner syntax.

---

### Q3. What are variadic templates? Show a `sum` function.

Variadic templates accept zero or more template arguments of any types. They are the mechanism behind `std::tuple`, `std::variant`, `std::make_unique`, and `std::apply`.

```cpp
#include <type_traits>

// Base case: zero arguments
template<typename T = int>
T sum() { return T{0}; }

// Recursive case: peel off one argument at a time
template<typename First, typename... Rest>
First sum(First first, Rest... rest) {
    return first + sum<First>(rest...);
}

// C++17 fold expression, cleaner:
template<typename... Args>
auto sum_fold(Args... args) {
    return (args + ...);  // unary right fold: arg0 + (arg1 + (arg2 + 0))
}

int main() {
    auto s1 = sum(1, 2, 3, 4, 5);         // 15
    auto s2 = sum_fold(1.0, 2.5, 3.5);    // 7.0
    auto s3 = sum_fold(1, 2, 3);           // 6
}
```

Variadic templates with `sizeof...(Args)` give the count. `std::forward<Args>(args)...` expands the pack with perfect forwarding. The `...` on the right of an expression expands the pack, each element participates in the expansion independently.

---

### Q4. What is `std::enable_if`? What replaces it in C++20?

`std::enable_if<Condition, T>` is a type trait that provides `::type = T` only if `Condition` is true. When placed in the return type or a template parameter, it uses SFINAE to enable or disable an overload.

```cpp
// enable_if in return type (C++11 style)
template<typename T>
std::enable_if_t<std::is_integral_v<T>, T> double_it(T x) { return x * 2; }

// enable_if in template parameter (alternative style)
template<typename T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
T double_it(T x) { return x * 2; }
```

**C++20 replaces `enable_if` with Concepts**, cleaner, better error messages, shorter syntax:

```cpp
// C++20 Concepts:
template<std::integral T>
T double_it(T x) { return x * 2; }

// Or with requires clause:
template<typename T>
    requires std::integral<T>
T double_it(T x) { return x * 2; }

// Or abbreviated function template:
auto double_it(std::integral auto x) { return x * 2; }
```

The concept version produces a readable error ("T does not satisfy std::integral") instead of SFINAE's wall of nested template errors.

---

### Q5. What are C++20 concepts? Write a `Sortable` concept.

A **concept** is a named predicate on template arguments evaluated at compile time. It constrains which types are accepted by a template, with clear error messages when the constraint is not met.

```cpp
#include <concepts>
#include <algorithm>
#include <vector>

// Define a Sortable concept:
// A type T is Sortable if it supports < comparison and can be iterated
template<typename T>
concept Sortable = requires(T container) {
    // Requires these expressions to be valid:
    { container.begin() } -> std::input_or_output_iterator;
    { container.end()   } -> std::input_or_output_iterator;
    // Elements support less-than:
    requires std::totally_ordered<typename T::value_type>;
};

// Use the concept as a constraint:
template<Sortable Container>
void sort_container(Container& c) {
    std::sort(c.begin(), c.end());
}

// Or with requires clause:
template<typename C>
    requires Sortable<C>
void sort_container(C& c) {
    std::sort(c.begin(), c.end());
}

// Standard library concepts:
// std::integral, std::floating_point, std::copyable, std::movable
// std::invocable<F, Args...>, std::ranges::range<R>

template<std::invocable<int> F>
void apply_to_42(F&& f) {
    f(42);
}

apply_to_42([](int x) { return x * 2; });  // OK
// apply_to_42(42);                         // ERROR: int is not invocable
```

---

### Q6. What is CRTP? Show a mixin example.

**CRTP**, Curiously Recurring Template Pattern. A derived class passes itself as a template argument to its base class. This enables the base class to call methods on the derived class without virtual dispatch, achieving static polymorphism.

```cpp
#include <iostream>
#include <chrono>

// CRTP mixin: adds timing capability to any class
template<typename Derived>
class Timed {
public:
    void measure(const char* label) {
        auto start = std::chrono::high_resolution_clock::now();
        static_cast<Derived*>(this)->run();  // calls derived's run(), no virtual
        auto end   = std::chrono::high_resolution_clock::now();
        auto us = std::chrono::duration_cast<std::chrono::microseconds>(end - start);
        std::cout << label << ": " << us.count() << " µs\n";
    }
};

// CRTP mixin: adds equality and comparison operators from just one method
template<typename Derived>
class Comparable {
public:
    bool operator!=(const Derived& o) const {
        return !(static_cast<const Derived*>(this)->operator==(o));
    }
    bool operator>(const Derived& o) const { return o < *static_cast<const Derived*>(this); }
    bool operator<=(const Derived& o) const { return !(o < *static_cast<const Derived*>(this)); }
    bool operator>=(const Derived& o) const { return !(*static_cast<const Derived*>(this) < o); }
};

struct Point : Comparable<Point>, Timed<Point> {
    int x, y;
    bool operator==(const Point& o) const { return x == o.x && y == o.y; }
    bool operator<(const Point& o)  const { return x < o.x || (x == o.x && y < o.y); }
    void run() { /* some operation */ }
};

Point a{1, 2}, b{3, 4};
bool ne = (a != b);   // calls Comparable's operator!= which calls operator==
bool gt = (b > a);    // calls Comparable's operator>
a.measure("run");     // calls Timed's measure, which calls Point::run
```

CRTP is used in Abseil, Boost, and LLVM extensively. The key advantage over virtual: the derived method calls are resolved at compile time, enabling full inlining.

---

### Q7. What is `std::type_traits`? Give five examples.

`<type_traits>` provides compile-time queries and transformations on types. They are the building blocks of generic programming.

```cpp
#include <type_traits>

// 1. Type predicates (::value is bool)
static_assert(std::is_integral_v<int>);          // true
static_assert(std::is_pointer_v<int*>);          // true
static_assert(!std::is_const_v<int>);            // true
static_assert(std::is_same_v<int, int>);         // true
static_assert(std::is_base_of_v<Base, Derived>); // true if Derived extends Base

// 2. Type transformations (::type is the result type)
std::remove_const_t<const int>         // → int
std::remove_reference_t<int&>          // → int
std::add_pointer_t<int>                // → int*
std::decay_t<const int&>               // → int (array/function decay, remove cv-ref)
std::underlying_type_t<MyEnum>         // → int (or whatever the underlying type is)

// 3. Conditional types
std::conditional_t<true,  int, double>  // → int
std::conditional_t<false, int, double>  // → double

// 4. Enable/disable based on properties
template<typename T>
void process(T val) {
    if constexpr (std::is_trivially_copyable_v<T>) {
        std::memcpy(&dest, &val, sizeof(T));  // fast path for trivial types
    } else {
        dest = val;  // copy constructor
    }
}

// 5. Checking callable properties
static_assert(std::is_invocable_v<decltype([](int){return 0;}), int>);
using R = std::invoke_result_t<decltype([](int x) { return x*2.0; }), int>;
static_assert(std::is_same_v<R, double>);
```

---

### Q8. What is a fold expression (C++17)? Show `(args + ...)`

Fold expressions compactly apply a binary operator to a parameter pack, eliminating the need for recursive template instantiation.

```cpp
// Unary right fold: (arg0 op (arg1 op (arg2 op ...)))
template<typename... Args>
auto sum(Args... args) { return (args + ...); }

// Unary left fold: ((arg0 op arg1) op arg2 op ...)
template<typename... Args>
auto sum_left(Args... args) { return (... + args); }

// Binary right fold with init: (arg0 op (arg1 op (arg2 op init)))
template<typename... Args>
auto sum_with_init(Args... args) { return (args + ... + 0); }

// Practical examples:
template<typename... Args>
void print_all(Args... args) {
    (std::cout << ... << args);  // left fold: prints each arg in order
}

template<typename Func, typename... Args>
void apply_all(Func f, Args... args) {
    (f(args), ...);  // comma fold: calls f(arg) for each arg
}

template<typename T, typename... Types>
bool is_any_of(T val, Types... types) {
    return ((val == types) || ...);  // logical OR fold
}

bool b = is_any_of(42, 1, 2, 42, 100);  // true
```

---

### Q9. What is `if constexpr`? How does it differ from `#ifdef`?

`if constexpr` is evaluated at compile time: only the taken branch is instantiated. The discarded branch must be syntactically valid but is not compiled for the current template instantiation.

`#ifdef` is a preprocessor directive: the discarded branch is not even parsed. It applies to non-template code and cannot use template arguments.

```cpp
// if constexpr: can reference T-specific members in the dead branch
// without compile error, as long as they're valid for some T
template<typename T>
std::string stringify(T val) {
    if constexpr (std::is_arithmetic_v<T>) {
        return std::to_string(val);
    } else if constexpr (std::is_same_v<T, std::string>) {
        return val;
    } else {
        // For all other T: must have .to_string() method
        return val.to_string();  // only checked when T is not arithmetic or string
    }
}

// #ifdef: purely textual, knows nothing about types
#ifdef ENABLE_LOGGING
    log_message("processing");  // compiled only if macro is defined
#endif
```

Key difference: `if constexpr` branches still must be syntactically valid C++. The compiler parses all branches but only type-checks and instantiates the taken one. `#ifdef` is completely invisible to the compiler, even syntactically broken code inside a false `#ifdef` block causes no error.

---

### Q10. What is template argument deduction? What is CTAD?

**Template argument deduction** is the compiler's ability to infer template arguments from function call arguments or constructor arguments. You do not need to specify `<T>` explicitly.

```cpp
template<typename T>
void print(T val);

print(42);        // T deduced as int
print(3.14);      // T deduced as double
print("hello");   // T deduced as const char*
```

**CTAD**, Class Template Argument Deduction (C++17). Before C++17, class templates required explicit template arguments (e.g., `std::pair<int, double>(1, 2.0)`). CTAD allows the compiler to deduce them from constructor arguments.

```cpp
// Before C++17:
auto p = std::make_pair(1, 2.0);  // make_pair was needed

// C++17 CTAD:
std::pair p{1, 2.0};              // deduced as std::pair<int, double>
std::vector v{1, 2, 3};          // deduced as std::vector<int>
std::tuple t{1, 2.0, "hello"};  // deduced as std::tuple<int, double, const char*>

// Custom deduction guide: tells the compiler how to deduce for a constructor
template<typename T>
struct Stack {
    std::vector<T> data_;
    Stack() = default;
    Stack(std::initializer_list<T> il) : data_(il) {}
};

// Deduction guide (not needed here, but shows the syntax):
template<typename T>
Stack(std::initializer_list<T>) -> Stack<T>;

Stack s{1, 2, 3};  // deduced as Stack<int>
```

---

### Q11. What is the difference between `typename` and `class` in templates?

In a template parameter list, `typename` and `class` are **interchangeable** for specifying a type parameter. There is no semantic difference.

```cpp
template<typename T> void f(T);   // identical
template<class    T> void f(T);   // identical
```

**The one difference**: when accessing a dependent type inside a template, you must use `typename` (not `class`) to tell the compiler the name is a type:

```cpp
template<typename Container>
void process(const Container& c) {
    typename Container::value_type element;  // "typename" required: dependent type
    // Container::value_type might be a static member or a type, typename disambiguates
}

// In C++20, typename is sometimes deduced automatically in common contexts
template<typename T>
void f() {
    T::nested_type* p;  // C++20 may infer this is a type in some contexts
}
```

The style convention: most codebases use `typename` for type parameters (it is more self-documenting) and `class` only when `typename` cannot be used (legacy code or emphasis that a class type is required, though this is not enforced).

---

### Q12. What is `decltype(auto)` and when do you need it?

`auto` in a return type always strips references and const. `decltype(auto)` preserves the exact type of the expression, including references.

```cpp
int x = 42;
int& get_x() { return x; }

auto        f1() { return get_x(); }  // returns int  (reference stripped)
decltype(auto) f2() { return get_x(); }  // returns int& (reference preserved)

// Generic forwarding wrapper, MUST use decltype(auto) to preserve references
template<typename Func, typename... Args>
decltype(auto) invoke_and_return(Func&& f, Args&&... args) {
    return std::forward<Func>(f)(std::forward<Args>(args)...);
    // If f returns int&, this returns int&
    // If f returns int,  this returns int
    // auto would always return int, breaking callers that need a reference
}

std::vector<int> v = {1, 2, 3};
decltype(auto) elem = invoke_and_return(
    [&](int i) -> int& { return v[i]; }, 1);
elem = 99;  // modifies v[1] because elem is int&, not a copy
```

---

### Q13. What is a policy-based class? Show a design example.

A **policy-based class** uses template parameters to inject behaviors (policies) into a class, allowing compile-time configuration without virtual dispatch. This is Andrei Alexandrescu's design pattern from "Modern C++ Design."

```cpp
// Policies are types that implement a specific interface

// Locking policies:
struct SingleThreaded {
    struct Lock { Lock(SingleThreaded&) {} };  // no-op lock
};

struct MultiThreaded {
    std::mutex mu;
    struct Lock {
        std::unique_lock<std::mutex> lk;
        explicit Lock(MultiThreaded& mt) : lk(mt.mu) {}
    };
};

// Storage policies:
template<typename T>
struct HeapStorage {
    T* allocate(size_t n) { return new T[n]; }
    void deallocate(T* p) { delete[] p; }
};

template<typename T, size_t N>
struct StackStorage {
    T buf[N];
    T* allocate(size_t) { return buf; }
    void deallocate(T*) {}
};

// Policy-based container:
template<
    typename T,
    typename ThreadingPolicy = SingleThreaded,
    template<typename> class StoragePolicy = HeapStorage
>
class Container : private ThreadingPolicy, private StoragePolicy<T> {
    T*     data_;
    size_t size_;
public:
    explicit Container(size_t n)
        : data_(StoragePolicy<T>::allocate(n)), size_(n) {}

    T& operator[](size_t i) {
        typename ThreadingPolicy::Lock guard{static_cast<ThreadingPolicy&>(*this)};
        return data_[i];
    }
};

// Single-threaded, heap-allocated (default)
Container<int> c1(100);

// Multi-threaded, heap-allocated
Container<int, MultiThreaded> c2(100);
```

---

### Q14. What is `std::variant` and `std::visit`?

`std::variant<T1, T2, ...>` is a type-safe union: it holds exactly one value of one of the listed types at a time. Unlike a C union, it tracks which type is active and calls the correct constructor/destructor.

`std::visit` applies a callable to the currently active value, dispatching at runtime to the correct type.

```cpp
#include <variant>
#include <string>
#include <iostream>

using Value = std::variant<int, double, std::string>;

Value v = 42;
v = 3.14;
v = std::string("hello");

// Check which type is active:
if (std::holds_alternative<std::string>(v)) {
    std::cout << std::get<std::string>(v) << "\n";
}

// std::visit with overloaded visitor (C++17 overload pattern):
struct Visitor {
    void operator()(int i)              const { std::cout << "int: " << i << "\n"; }
    void operator()(double d)           const { std::cout << "dbl: " << d << "\n"; }
    void operator()(const std::string& s) const { std::cout << "str: " << s << "\n"; }
};

std::visit(Visitor{}, v);

// Lambda-based visitor with overload deduction guide:
template<typename... Ts>
struct overloaded : Ts... { using Ts::operator()...; };
template<typename... Ts>
overloaded(Ts...) -> overloaded<Ts...>;

std::visit(overloaded{
    [](int i)              { std::cout << "int: " << i; },
    [](double d)           { std::cout << "dbl: " << d; },
    [](const std::string& s) { std::cout << "str: " << s; }
}, v);
```

`std::variant` is the C++ equivalent of Go's interface values for discriminated unions, but type-safe at compile time with no heap allocation.

---

### Q15. What is compile-time recursion? Compute factorial at compile time.

Compile-time recursion was the original way to compute values at compile time before `constexpr` (pre-C++11). It uses template specialization as the base case.

```cpp
// Classic TMP (template metaprogramming) factorial, C++03 style:
template<unsigned N>
struct Factorial {
    static constexpr unsigned value = N * Factorial<N-1>::value;
};

template<>
struct Factorial<0> {
    static constexpr unsigned value = 1;
};

static_assert(Factorial<5>::value == 120);
static_assert(Factorial<10>::value == 3628800);

// Modern constexpr approach (C++14+), cleaner:
constexpr unsigned factorial(unsigned n) {
    return n == 0 ? 1 : n * factorial(n - 1);
}

static_assert(factorial(5) == 120);

// C++20: guaranteed compile-time with consteval:
consteval unsigned factorial_ct(unsigned n) {
    return n == 0 ? 1 : n * factorial_ct(n - 1);
}

// Compile-time Fibonacci with memoization via template:
template<unsigned N>
struct Fib {
    static constexpr unsigned value = Fib<N-1>::value + Fib<N-2>::value;
};
template<> struct Fib<0> { static constexpr unsigned value = 0; };
template<> struct Fib<1> { static constexpr unsigned value = 1; };

static_assert(Fib<10>::value == 55);
```

The interview insight: TMP-style compile-time recursion is Turing-complete (the compiler is executing a purely functional language at compile time). C++17 `constexpr` functions and C++20 `consteval` make it approachable, prefer them over TMP for new code.

---
