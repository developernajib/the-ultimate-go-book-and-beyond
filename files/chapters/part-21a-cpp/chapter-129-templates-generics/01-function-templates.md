## Function Templates

### Basic Syntax

A function template is a blueprint that the compiler uses to generate concrete functions for each type you use it with. Where Go requires you to declare type parameters in square brackets, C++ uses angle brackets with the `template` keyword.

**In Go:**

```go
package main

import (
	"cmp"
	"fmt"
)

func Max[T cmp.Ordered](a, b T) T {
	if a > b {
		return a
	}
	return b
}

func main() {
	result := Max(3, 7)       // T inferred as int
	result2 := Max(3.14, 2.7) // T inferred as float64
	fmt.Println(result, result2)
}
```

**In C++:**

```cpp
template <typename T>
T Max(T a, T b) {
    return (a > b) ? a : b;
}

int main() {
    int result = Max(3, 7);          // T deduced as int
    double result2 = Max(3.14, 2.7); // T deduced as double

    // Explicit instantiation
    auto result3 = Max<long>(3, 7);  // Force T = long
    return 0;
}
```

The `template <typename T>` prefix tells the compiler that `T` is a placeholder type. You can use `class` instead of `typename`, they are interchangeable in this context (a historical artifact from early C++).

### Type Deduction

The C++ compiler deduces template arguments from the function arguments. This process is called **template argument deduction** and it is more sophisticated than Go's type inference.

```cpp
template <typename T, typename U>
auto Add(T a, U b) -> decltype(a + b) {
    return a + b;
}

int main() {
    auto r1 = Add(3, 4.5);       // T=int, U=double, returns double
    auto r2 = Add(1.0f, 2.0);    // T=float, U=double, returns double
    auto r3 = Add(std::string("hello "), std::string("world"));
    // T=std::string, U=std::string, returns std::string
    return 0;
}
```

The trailing return type `-> decltype(a + b)` tells the compiler to figure out the return type from the expression `a + b`. In C++14 and later, you can simplify this to just `auto`:

```cpp
template <typename T, typename U>
auto Add(T a, U b) {
    return a + b;  // return type deduced automatically (C++14)
}
```

### Deduction Contexts and Failures

Not all positions in a template are **deduction contexts**. Understanding where the compiler can and cannot deduce types prevents subtle bugs.

```cpp
template <typename T>
struct Identity { using type = T; };

// The return type is a NON-DEDUCED context
template <typename T>
typename Identity<T>::type Convert(T value) {
    return value;
}

// T can be deduced from the argument, but NOT from the return type
auto x = Convert(42);  // OK: T = int, deduced from argument

// Nested type on the LEFT side of :: is non-deduced
template <typename T>
void Foo(typename std::vector<T>::iterator it) {
    // T CANNOT be deduced here -- the compiler does not reverse-engineer
    // what vector type produces this iterator
}

// Fix: provide T explicitly
std::vector<int> v = {1, 2, 3};
// Foo(v.begin()); // ERROR: cannot deduce T
Foo<int>(v.begin());       // OK: T explicitly provided
```

Deduction also fails when arguments conflict:

```cpp
template <typename T>
T Max(T a, T b) { return (a > b) ? a : b; }

// Max(3, 4.5);  // ERROR: T deduced as int from first arg, double from second
Max<double>(3, 4.5);  // Fix 1: explicit template argument
// Fix 2: use two type parameters (as shown in Add above)
```

This is stricter than Go, where the compiler will not attempt to unify two different inferred types for the same parameter, it simply reports a type mismatch immediately with a clear message.

### Explicit Instantiation

Sometimes you want to control which instantiations exist, often to reduce compile times or to put template definitions in `.cpp` files instead of headers.

```cpp
// max.hpp
template <typename T>
T Max(T a, T b);

// max.cpp
template <typename T>
T Max(T a, T b) {
    return (a > b) ? a : b;
}

// Explicit instantiation definitions -- these generate actual code
template int Max<int>(int, int);
template double Max<double>(double, double);
template std::string Max<std::string>(std::string, std::string);
```

This is analogous to what Go does behind the scenes with its dictionary-based approach to generics, except in C++ you manually list the types. If someone tries to use `Max<float>` without an explicit instantiation in the `.cpp` file, they get a linker error.

You can also use `extern template` to suppress implicit instantiation in a translation unit, deferring it to the unit that explicitly instantiates:

```cpp
// header.hpp
template <typename T>
class HeavyTemplate { /* ... lots of code ... */ };

// Suppress instantiation in every .cpp that includes this header
extern template class HeavyTemplate<int>;
extern template class HeavyTemplate<double>;

// instantiate.cpp -- the ONE file that generates the code
template class HeavyTemplate<int>;
template class HeavyTemplate<double>;
```

This technique can dramatically reduce compile times in large projects where the same template is included in hundreds of translation units.

### Non-Type Template Parameters

Unlike Go generics, C++ templates can accept values, not just types.

```cpp
template <typename T, int N>
struct FixedArray {
    T data[N];

    constexpr int size() const { return N; }
};

FixedArray<double, 100> sensors;  // 100 doubles, no heap allocation
FixedArray<int, 4> quad;          // 4 ints on the stack

static_assert(sensors.size() == 100, "Size must be 100");
```

Go has no equivalent. You cannot parameterize a Go generic type on a constant value. This is one of the areas where C++ templates are strictly more powerful.

```go
// Go: you cannot do this
// type FixedArray[T any, N int] struct { ... }  // INVALID

// You must use a runtime parameter or predefined sizes
type FixedArray[T any] struct {
    data []T
}
```

C++20 expanded non-type template parameters to accept floating-point types and even literal class types:

```cpp
template <double Factor>
double Scale(double x) {
    return x * Factor;  // Factor is baked into the code at compile time
}

auto result = Scale<2.5>(10.0);  // 25.0, no multiplication at runtime
                                  // if the compiler constant-folds
```

### Multiple Template Parameters and Defaults

Templates can have multiple type and non-type parameters, with defaults:

```cpp
template <
    typename Key,
    typename Value,
    typename Compare = std::less<Key>,
    typename Allocator = std::allocator<std::pair<const Key, Value>>
>
class OrderedMap {
    // This is essentially how std::map is declared
};

// Use with defaults
OrderedMap<std::string, int> m1;

// Override the comparator
OrderedMap<std::string, int, std::greater<std::string>> m2;
```

Go generics have no equivalent of default template arguments. The closest Go gets is type inference: callers usually omit type arguments entirely and let the compiler infer them from the value arguments. The `~` syntax in Go constraints addresses a different problem, admitting all types with a given underlying type into the constraint's type set, not supplying a default.

---
